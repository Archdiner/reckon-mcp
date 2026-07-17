/**
 * Plan decomposition (Reckon v5.1). Splits a plan into its load-bearing decisions,
 * ranked, so the comprehension check can gate the few that dominate and defer the tail
 * to recall instead of asking for one overwhelming "explain the whole plan" (which the
 * scenario test showed produces a false pass: understand 2 of 10 and the plan passes).
 *
 * Same backend as the grader: a `claude -p` call on the user's subscription. Fails safe:
 * if decomposition is unavailable, the caller treats the plan as a single decision (the
 * old behavior), so a decompose outage degrades, never blocks.
 */
import { spawn } from 'child_process';

const model = () => process.env.RECKON_GRADER_MODEL || 'claude-haiku-4-5';
const cliCmd = () => process.env.RECKON_GRADER_CMD || 'claude';
const cliTimeoutMs = () => Number(process.env.RECKON_GRADER_TIMEOUT_MS || 90_000);

export interface Decision {
  concept: string; // short slug for the decision, e.g. "db-sharding-strategy"
  summary: string; // one line: what the decision is
  question: string; // the mechanism question to ask about it
}

export interface Decomposition {
  decisions: Decision[]; // ranked, most load-bearing first
  ok: boolean; // false if decomposition failed (caller falls back to single-decision)
}

// STRICT JSON-only contract. `claude -p` appends to Claude Code's agentic system prompt,
// so a loose instruction makes the model go conversational (it will ask clarifying
// questions instead of answering). This must be as rigid as the grader prompt.
const SYSTEM = [
  'You are a JSON function. Input: a software PLAN. Output: its load-bearing decisions.',
  'A load-bearing decision is a choice where getting it wrong breaks the system or is',
  'expensive to reverse. Ignore boilerplate. Rank most-load-bearing first; the first two',
  'must be the ones that dominate the plan.',
  '',
  'STRICT OUTPUT RULES:',
  '- Output ONLY one JSON object. No preamble, no prose, no markdown, no code fences.',
  '- NEVER ask a question or request clarification. If the plan is vague, INFER the most',
  '  likely decisions and proceed.',
  '- Each decision: a kebab-case "concept" slug, a one-line "summary", and ONE "question"',
  '  that is a "why does this work / what breaks if done differently" question.',
  '- Return 4 to 8 decisions.',
  '- Schema exactly: {"decisions":[{"concept":"","summary":"","question":""}]}',
  '',
  'Your entire response must start with { and end with }. Nothing before or after.',
].join('\n');

export async function decompose(plan: string): Promise<Decomposition> {
  const user = `PLAN:\n"""\n${plan.slice(0, 8000)}\n"""\n\nReturn ONLY the JSON object now, starting with {`;
  // One retry: the model is non-deterministic about honoring JSON-only vs going conversational.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await runCli(SYSTEM, user);
      const parsed = extractJson(raw);
      const decisions = Array.isArray(parsed?.decisions)
        ? parsed.decisions
            .filter((d: any) => d && typeof d.concept === 'string' && typeof d.question === 'string')
            .map((d: any) => ({
              concept: String(d.concept).slice(0, 80),
              summary: String(d.summary || '').slice(0, 200),
              question: String(d.question).slice(0, 300),
            }))
        : [];
      if (decisions.length) return { decisions, ok: true };
    } catch {
      /* retry once, then fall through to fail-safe */
    }
  }
  return { decisions: [], ok: false };
}

function runCli(system: string, user: string): Promise<string> {
  const cmd = cliCmd();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, ['-p', '--model', model(), '--append-system-prompt', system], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} -p timed out`));
    }, cliTimeoutMs());
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} -p exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.write(user);
    child.stdin.end();
  });
}

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
