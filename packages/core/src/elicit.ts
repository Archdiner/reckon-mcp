/**
 * Elicitation (Reckon v5). Generates the prompt that asks the human to explain.
 *
 * The load-bearing rule (reckon-design-doc-v5.md §① / IOED research): ask for
 * MECHANISM, never PROCEDURE. "Walk me through the steps" does NOT expose the
 * illusion of explanatory depth; "why does this work, and what breaks if done
 * differently?" does. A procedure prompt gives the grader nothing real to grade.
 *
 * Elicitation can fire at two stages:
 *   - 'plan'  — BEFORE the agent builds (catches "should we build this at all",
 *               the strategy-fork value we kept when we replaced the fork system)
 *   - 'build' — AFTER a change, to verify comprehension of what shipped
 */

export type Stage = 'plan' | 'build';

export interface ElicitInput {
  concept: string;
  subsystem: string;
  stage: Stage;
}

export function elicitPrompt({ concept, subsystem, stage }: ElicitInput): string {
  const head =
    stage === 'plan'
      ? `Before I build ${concept} in ${subsystem} — explain the plan back to me.`
      : `Explain what just happened with ${concept} in ${subsystem}.`;

  return [
    head,
    '',
    'Not the steps — the MECHANISM:',
    `  • why does this approach work?`,
    `  • what would BREAK if it were done differently?`,
    '',
    'In your own words, from your own head. A real swing beats a polished echo.',
  ].join('\n');
}

/**
 * The multi-decision plan prompt (v5.1). Names the specific load-bearing decisions the
 * user must explain, capped to the few that dominate. Fixes the generic-template bug
 * (the old prompt never referenced the plan or any decision) and bounds the ask.
 */
export function planElicitPrompt(
  subsystem: string,
  gated: { concept: string; summary: string }[]
): string {
  const items = gated.map((d, i) => `  ${i + 1}. ${d.summary} (${d.concept})`).join('\n');
  return [
    `Before I build in ${subsystem}, explain the load-bearing sub-problems in this plan.`,
    'Not the steps. The MECHANISM of each: why it works, and what breaks if done differently.',
    '',
    items,
    '',
    'One explanation, in your own words. You need to show real understanding of every one.',
  ].join('\n');
}

/**
 * The re-explanation prompt after a failed grade. This is just the grader's
 * chosen hole, wrapped so the tone stays chill (§③): point at the one gap,
 * invite another pass — never punish.
 */
export function retryPrompt(hole: string, assisted: boolean): string {
  const rescue = assisted
    ? ''
    : `\n(Stuck? Open the source and re-read — that's allowed. I'll mark it ASSISTED and ` +
      `re-check you cold later, when it's not in front of you.)`;
  return `You're close — one gap:\n\n${hole}\n\nTake another pass.${rescue}`;
}

/**
 * The floor of the escalation ladder (§③). After the question rungs are exhausted, Reckon
 * finally TELLS — states the mechanism it has been withholding — and clears the gate. The
 * clear is honest about what it is: marked `told`, so it never reads as earned understanding,
 * and it comes back cold soonest of all. No block, just a truthful label + more teaching.
 */
export function tellPrompt(reveal: string): string {
  const body = reveal.trim() || 'The gap is in the core mechanism — re-read the source with the failure mode in mind.';
  return [
    `Here's the piece you were missing:`,
    '',
    body,
    '',
    `Marked TELL — you were handed this rather than reaching it, so it's logged honestly (not`,
    `as earned) and will come back cold, soon, for you to reconstruct from your own head.`,
  ].join('\n');
}

/**
 * The cold-recall prompt (§④). No source, no hints — reconstruct from memory.
 * This is the real retention test; ASSISTED passes come back here sooner/harder.
 */
export function recallPrompt(concept: string, subsystem: string): string {
  return [
    `Cold recall — no source in front of you.`,
    `Reconstruct ${concept} in ${subsystem}: the mechanism, and the one thing that breaks it.`,
    `From your own head. If you can't, it resurfaces again.`,
  ].join('\n');
}
