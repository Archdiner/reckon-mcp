/**
 * The explanation-grading rubric (Reckon v5).
 *
 * Research-backed (see reckon-design-doc-v5.md §4). Seven dimensions; three are
 * HARD GATES — fail one and the explanation is slop regardless of the rest. The
 * single sharpest signal is OVERLAP WITH THE SOURCE: an explanation that echoes
 * the plan/diff is restatement (Chi's low-inference); one that supplies the
 * causal "because" the artifact never stated is understanding.
 *
 * This module is pure data + prompt construction. The actual judging is an
 * isolated LLM call (grader.ts) — reference-guided, reason-before-score.
 */

export type RigorLevel = 'medium' | 'harsh';
// NOTE: there is deliberately no 'gentle'. Medium is the floor — the minimum
// difficulty that still produces beneficial learning. You may opt UP, never below.

export interface Dimension {
  key: string;
  gate: boolean; // fail a gate → slop, regardless of total score
  label: string;
  strong: string; // what a 2/2 answer looks like
  weak: string; // what a 0/2 answer looks like
  source: string; // research grounding
}

export const DIMENSIONS: Dimension[] = [
  {
    key: 'mechanism',
    gate: true,
    label: 'Mechanism (why/how)',
    strong: 'names the entities + their activities + the causal chain from input to output',
    weak: 'restates WHAT changed with no causal "how"; description, not mechanism',
    source: 'Russ et al. 2008 (mechanistic reasoning)',
  },
  {
    key: 'inference',
    gate: true,
    label: 'Inference beyond the given',
    strong: 'supplies rationale that is NOT present in the plan/diff — the "because"',
    weak: 'paraphrases or echoes the artifact / the agent\'s own summary (high overlap)',
    source: 'Chi et al. 1989/1994 (self-explanation effect)',
  },
  {
    key: 'correctness',
    gate: true,
    label: 'Correctness vs ground truth',
    strong: 'matches what the code/plan actually does',
    weak: 'contradicted by the artifact',
    source: 'disciplinary-quality research',
  },
  {
    key: 'coverage',
    gate: false,
    label: 'Load-bearing coverage',
    strong: 'hits the decision the outcome hinges on',
    weak: 'covers incidental detail, misses the pivot',
    source: 'SOLO (relational)',
  },
  {
    key: 'integration',
    gate: false,
    label: 'Integration / connectedness',
    strong: 'links the parts into a coherent whole',
    weak: 'correct but disconnected list of facts (SOLO multistructural)',
    source: 'SOLO; mental-model revision',
  },
  {
    key: 'tradeoffs',
    gate: false,
    label: 'Tradeoffs / alternatives',
    strong: 'names what was chosen against, and why',
    weak: 'asserts a single path; no road-not-taken',
    source: 'Chi (condition refinement)',
  },
  {
    key: 'self_monitoring',
    gate: false,
    label: 'Self-monitoring',
    strong: 'flags own uncertainty accurately',
    weak: 'confident where wrong; silent gaps',
    source: 'Chi (comprehension monitoring); Rozenblit & Keil (IOED)',
  },
];

/**
 * Build the system prompt for the isolated grader. Reference-guided (ground truth
 * is handed in), reason-before-score (G-Eval CoT), rubric-anchored. The grader
 * NEVER sees the main session — only what this prompt carries — which is what
 * makes its verdict trustworthy rather than self-preferential.
 */
export function graderSystemPrompt(rigor: RigorLevel): string {
  const gateKeys = DIMENSIONS.filter((d) => d.gate).map((d) => d.key);
  const rubricLines = DIMENSIONS.map(
    (d) =>
      `  - ${d.key}${d.gate ? ' [GATE]' : ''}: ${d.label}\n` +
      `      strong(2): ${d.strong}\n` +
      `      weak(0):   ${d.weak}`
  ).join('\n');

  const bar =
    rigor === 'harsh'
      ? 'HARSH: demand a genuine mechanism. Any gate below 2 fails. Be exacting; ' +
        'reward only real causal inference, punish restatement hard.'
      : 'MEDIUM (the floor): encouraging but honest. A gate at 0 fails; a gate at 1 ' +
        'passes only if the other two gates are 2. Point at the ONE biggest hole ' +
        'warmly ("you\'re close — dig into WHY X"). Never feel-good-pass real slop.';

  return [
    'You are Reckon\'s explanation grader. A human just explained what their AI coding',
    'agent did or planned. Your job: decide whether they actually UNDERSTAND it, or are',
    'restating what they were shown. You are isolated — you see ONLY the ground truth and',
    'their explanation, never the original reasoning. This blindness is the point: grade',
    'the explanation against the artifact, not against any agent\'s narrative.',
    '',
    'THE SHARPEST SIGNAL: overlap with the source. If the explanation echoes the plan/diff,',
    'it is RESTATEMENT (slop). If it supplies the causal "because" the artifact never stated,',
    'it is UNDERSTANDING. Score inference and mechanism on what is INFERRED, not reproduced.',
    '',
    'RUBRIC (score each 0/1/2):',
    rubricLines,
    '',
    `GATES: ${gateKeys.join(', ')}. ${bar}`,
    '',
    'PROCEDURE (do this in order, in your reasoning, before the verdict):',
    '  1. For each dimension, quote the part of their explanation that earns/loses it.',
    '  2. Estimate source-overlap: how much is echo vs inferred.',
    '  3. Score each dimension 0/1/2.',
    '  4. Apply the gate rule for this rigor level.',
    '  5. If FAIL: pick the SINGLE most important hole and phrase it as a warm',
    '     re-explanation prompt (mechanism-focused, e.g. "why does X break if changed?").',
    '     Do NOT dump the scorecard at the human.',
    '',
    'Respond with ONLY a JSON object (no prose around it):',
    '{',
    '  "scores": { "mechanism": 0-2, "inference": 0-2, "correctness": 0-2,',
    '              "coverage": 0-2, "integration": 0-2, "tradeoffs": 0-2, "self_monitoring": 0-2 },',
    '  "overlap": "low" | "medium" | "high",',
    '  "pass": boolean,',
    '  "hole": "the ONE re-explanation prompt if !pass, else empty string",',
    '  "note": "one short internal line on why (not shown to the human)"',
    '}',
  ].join('\n');
}

/** Deterministic gate check — a backstop so a lenient judge can't wave slop through. */
export function gatePasses(
  scores: Record<string, number>,
  rigor: RigorLevel
): boolean {
  const gates = DIMENSIONS.filter((d) => d.gate).map((d) => scores[d.key] ?? 0);
  if (gates.some((s) => s === 0)) return false; // any gate at 0 always fails
  if (rigor === 'harsh') return gates.every((s) => s === 2);
  // medium floor: a single gate at 1 is tolerated only if the other two are 2
  const ones = gates.filter((s) => s === 1).length;
  return ones <= 1;
}
