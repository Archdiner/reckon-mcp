#!/usr/bin/env node
// Reckon v5.2 — plan-gate (HARDENED). PreToolUse on ExitPlanMode.
//
// ExitPlanMode is the signature of "a plan is approved and about to be built" — the
// prior, right-grained, load-bearing moment. v5.1 was SOFT here (inject-and-allow),
// which is why a real plan could sail through. v5.2 HARD-denies the exit until the
// plan has been explained + graded (clearance written under the plan gate_key).
//
// Complements the write-gate: this catches the PLAN-MODE route at plan time; the
// write-gate catches the prose-plan / bypass-permissions route at build time. Between
// them, every build path funnels through one comprehension checkpoint.
//
// Fails open on any error — a hook must never wedge the session.
const lib = require('./reckon-lib.js');

lib.readInput((input) => {
  try {
    if (!lib.isModeAEnabled()) return lib.allow();
    const root = lib.repoRoot(input.cwd);
    const key = lib.planGateKey(root);
    if (lib.isCleared(key)) return lib.allow(); // plan already explained this session

    return lib.deny(
      `RECKON (Mode A): this plan is a load-bearing decision about to be built. Before ` +
        `you exit plan mode, call the reckon_explain MCP tool:\n` +
        `  stage:        "plan"\n` +
        `  subsystem:    <the area this plan touches>\n` +
        `  concept:      <short slug for the plan>\n` +
        `  ground_truth: <the full plan you just presented, verbatim>\n` +
        `  gate_key:     "${key}"   ← REQUIRED. Pass this EXACT string; do not paraphrase it.\n` +
        `Put the returned prompt to the HUMAN, take THEIR explanation, call reckon_grade. ` +
        `On a PASS the gate clears and you may retry ExitPlanMode. The human explains the ` +
        `mechanism — you may not answer for them.`
    );
  } catch {
    return lib.allow();
  }
});
