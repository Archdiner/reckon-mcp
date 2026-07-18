/**
 * Plan decomposition (Reckon v5.1). Splits a plan into its load-bearing decisions,
 * ranked, so the comprehension check can gate the few that dominate and defer the tail
 * to recall instead of asking for one overwhelming "explain the whole plan" (which the
 * scenario test showed produces a false pass: understand 2 of 10 and the plan passes).
 *
 * Same injected backend as the grader (an `LlmBackend`): decompose.ts never spawns a
 * process or names a provider. Fails safe: if decomposition is unavailable, the caller
 * treats the plan as a single decision (the old behavior), so a decompose outage
 * degrades, never blocks.
 */
import { LlmBackend } from './llm.js';

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
//
// v5.1: we return CLUSTERS, not atomic decisions. A plan's ~6-10 fine-grained decisions
// are grouped into 2-4 coherent sub-problems (e.g. "data layer" bundles schema + indexing
// + pooling). The whole plan is then covered in one bounded explanation with no deferral,
// which is the UX a ship-fast user needs: a few big chunks, not ten atomic asks.
const SYSTEM = [
  'You are a JSON function. Input: a software PLAN. Output: its load-bearing decisions,',
  'GROUPED into coherent sub-problems (clusters).',
  'A load-bearing decision is a choice where getting it wrong breaks the system or is',
  'expensive to reverse. Ignore boilerplate. Group related decisions into a natural',
  'sub-problem a developer would reason about as one unit (e.g. data layer, auth, infra).',
  'Rank most-dominant first.',
  '',
  'STRICT OUTPUT RULES:',
  '- Output ONLY one JSON object. No preamble, no prose, no markdown, no code fences.',
  '- NEVER ask a question or request clarification. If the plan is vague, INFER and proceed.',
  '- Return 2 to 4 clusters (never more). Each must be a real sub-problem, not one decision.',
  '- Each cluster: a kebab-case "concept" slug, a "summary" naming the specific decisions it',
  '  bundles, and ONE "question" that asks for the MECHANISM of the whole sub-problem (why it',
  '  works / what breaks if done differently), touching each bundled decision.',
  '- Schema exactly: {"decisions":[{"concept":"","summary":"","question":""}]}',
  '',
  'Your entire response must start with { and end with }. Nothing before or after.',
].join('\n');

export async function decompose(plan: string, backend: LlmBackend): Promise<Decomposition> {
  const user = `PLAN:\n"""\n${plan.slice(0, 8000)}\n"""\n\nReturn ONLY the JSON object now, starting with {`;
  // One retry: the model is non-deterministic about honoring JSON-only vs going conversational.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await backend.complete(SYSTEM, user);
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
