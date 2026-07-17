/**
 * The isolated grader (Reckon v5). This is the trust mechanism.
 *
 * A SEPARATE model call — a different, cheaper model (Haiku) than whatever wrote the
 * code — that sees ONLY (ground truth + the human's explanation + the rubric). It never
 * sees the main session. That blindness defeats sycophancy/self-preference: grading is a
 * comparison against the artifact, not a defense of the author's own work.
 *
 * BACKEND: `claude -p` ONLY (validated in E2E-FINDINGS.md — 94% efficacy, 0 false-
 * pass/fail). It uses the user's existing Claude Code SUBSCRIPTION auth — no API key,
 * ever. Reckon ships to Claude Code users; requiring a separate ANTHROPIC_API_KEY would
 * be a non-starter. If the CLI is unavailable we fail-open LOUDLY (never block the human,
 * but mark the result ungraded so it can't masquerade as a real pass).
 */
import { spawn } from 'child_process';
import { RigorLevel, graderSystemPrompt, planGraderSystemPrompt, gatePasses, DIMENSIONS } from './rubric.js';

// Read at CALL time, not module-load time (ESM hoists imports before test env setup).
// A different model than the main coding agent, on purpose ("don't self-judge").
const graderModel = () => process.env.RECKON_GRADER_MODEL || 'claude-haiku-4-5';
const cliCmd = () => process.env.RECKON_GRADER_CMD || 'claude'; // overridable for tests
const cliTimeoutMs = () => Number(process.env.RECKON_GRADER_TIMEOUT_MS || 90_000);

export interface GradeInput {
  groundTruth: string;
  explanation: string;
  rigor: RigorLevel;
  assisted: boolean;
}

export interface GradeResult {
  pass: boolean;
  hole: string;
  scores: Record<string, number>;
  overlap: 'low' | 'medium' | 'high' | 'unknown';
  ungraded: boolean; // true if we failed open — the caller MUST surface this loudly
  note: string;
}

function emptyScores(): Record<string, number> {
  return Object.fromEntries(DIMENSIONS.map((d) => [d.key, 0]));
}

/** Clamp any dimension score to the valid 0..2 range (defensive). */
function clampScores(raw: Record<string, number>): Record<string, number> {
  const out = emptyScores();
  for (const d of DIMENSIONS) {
    const v = Number(raw[d.key]);
    out[d.key] = Number.isFinite(v) ? Math.max(0, Math.min(2, Math.round(v))) : 0;
  }
  return out;
}

function userContent(input: GradeInput): string {
  return [
    'GROUND TRUTH (the plan/diff — the reference; the human did NOT write this):',
    '"""',
    input.groundTruth.slice(0, 8000),
    '"""',
    '',
    "THE HUMAN'S EXPLANATION (grade this):",
    '"""',
    input.explanation.slice(0, 4000),
    '"""',
    input.assisted ? '\n(NOTE: the human had the source open — be extra alert to restatement/echo.)' : '',
  ].join('\n');
}

export async function grade(input: GradeInput): Promise<GradeResult> {
  const system = graderSystemPrompt(input.rigor);
  const user = userContent(input);

  let raw: string;
  try {
    raw = await gradeViaCli(system, user);
  } catch (err: any) {
    return failOpen(`grader backend error: ${err?.message || err}`);
  }

  const parsed = extractJson(raw);
  if (!parsed || parsed.scores === undefined) return failOpen('grader output unparseable');

  const scores = clampScores(parsed.scores || {});
  const modelPass = parsed.pass === true;
  const gate = gatePasses(scores, input.rigor); // deterministic backstop over the model's scores
  const pass = modelPass && gate;

  return {
    pass,
    hole: pass ? '' : String(parsed.hole || 'Explain the underlying mechanism — the why, not the what.'),
    scores,
    overlap: parsed.overlap || 'unknown',
    ungraded: false,
    note: String(parsed.note || ''),
  };
}

/** LOUD fail-open: pass so we never block, but flagged so it can't look like a real grade. */
function failOpen(note: string): GradeResult {
  return { pass: true, hole: '', scores: emptyScores(), overlap: 'unknown', ungraded: true, note };
}

export interface PlanGradeResult {
  pass: boolean;
  hole: string;
  covered: string[];
  missing: string[];
  ungraded: boolean;
  note: string;
}

/**
 * Grade a plan explanation that must cover N named load-bearing decisions. Coverage of
 * EVERY named decision is required (the false-pass fix). Fails open LOUD like grade().
 */
export async function gradePlan(input: {
  groundTruth: string;
  explanation: string;
  rigor: RigorLevel;
  decisions: { concept: string; summary: string }[];
}): Promise<PlanGradeResult> {
  const system = planGraderSystemPrompt(input.rigor, input.decisions);
  const user = [
    'PLAN (ground truth; the human did NOT write this):',
    '"""', input.groundTruth.slice(0, 8000), '"""',
    '',
    "THE HUMAN'S EXPLANATION (grade coverage of every listed decision):",
    '"""', input.explanation.slice(0, 6000), '"""',
  ].join('\n');

  let raw: string;
  try {
    raw = await gradeViaCli(system, user);
  } catch (err: any) {
    return { pass: true, hole: '', covered: [], missing: [], ungraded: true, note: `plan grader error: ${err?.message || err}` };
  }
  const parsed = extractJson(raw);
  if (!parsed || parsed.pass === undefined) {
    return { pass: true, hole: '', covered: [], missing: [], ungraded: true, note: 'plan grader output unparseable' };
  }
  const missing = Array.isArray(parsed.missing) ? parsed.missing.map(String) : [];
  // Deterministic backstop: if the model says pass but left any decision missing, it fails.
  const pass = parsed.pass === true && missing.length === 0;
  return {
    pass,
    hole: pass ? '' : String(parsed.hole || 'Explain the mechanism of the decision you skipped.'),
    covered: Array.isArray(parsed.covered) ? parsed.covered.map(String) : [],
    missing,
    ungraded: false,
    note: String(parsed.note || ''),
  };
}

/** The only backend: the Claude Code CLI, on the user's subscription auth (no API key). */
function gradeViaCli(system: string, user: string): Promise<string> {
  const cmd = cliCmd();
  return new Promise((resolve, reject) => {
    // Strip the environment: the grader must not load the user's MCP servers, plugins, or
    // project settings. It only judges text. Stripping cuts ~7s of startup per call AND
    // keeps the grader truly isolated (it cannot see the user's tools).
    const child = spawn(
      cmd,
      ['-p', '--model', graderModel(), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--append-system-prompt', system],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} -p timed out after ${cliTimeoutMs()}ms`));
    }, cliTimeoutMs());

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e); // e.g. ENOENT if the claude CLI isn't on PATH
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} -p exited ${code}: ${err.slice(0, 200)}`));
    });

    child.stdin.write(user);
    child.stdin.end();
  });
}

/** Pull the JSON object out of the model response, tolerant of stray prose/fences. */
function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
