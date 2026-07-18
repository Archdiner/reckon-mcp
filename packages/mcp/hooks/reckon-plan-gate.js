#!/usr/bin/env node
// Reckon v5 — plan-gate SIGNATURE hook (the key mechanic). PreToolUse on ExitPlanMode.
//
// The insight (from v0's signature-gate.js): don't rely on the agent introspecting
// whether it's making a load-bearing decision — hook the SIGNATURE. ExitPlanMode IS
// that signature: a plan is approved and about to be BUILT. That is the prior,
// right-grained, load-bearing decision moment. So on this tool call we inject a strong
// instruction to run the comprehension loop on the plan BEFORE building.
//
// v1 is SOFT (inject-and-allow — test before hardening to a sentinel-based deny, the
// way signature-gate.js gates reckon_fork). Fails open on any error.
let stdin = '';
try {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (stdin += d));
} catch {}

let done = false;
function emit() {
  if (done) return;
  done = true;
  try {
    const reason =
      'RECKON: this plan is a load-bearing decision about to be built. Before you build, ' +
      'call reckon_explain(stage="plan", ground_truth=<the plan you just presented>, ' +
      'concept, subsystem) so the human explains the plan back and the isolated grader ' +
      'verifies they understand it. Proceed to build only after it passes (or they opt out).';
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: reason,
        },
      })
    );
  } catch {
    /* fail open — emit nothing, tool proceeds normally */
  }
}

process.stdin.on('end', emit);
setTimeout(emit, 250);
