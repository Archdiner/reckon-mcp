#!/usr/bin/env node
// Reckon v5 — agent-flagging nudge (Layer 1). UserPromptSubmit.
//
// Injects the standing instruction every turn (the PROVEN mechanism — this is how the
// old "RECKON (active)" reminder worked). Reinforces the agent's own judgment to flag
// load-bearing decisions via reckon_explain. Advisory, not enforcement.
//
// Fails open (emits nothing) on any error — a hook must never wedge the session.
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
    const context =
      'RECKON v5 (comprehension loop active). When you make a LOAD-BEARING decision — ' +
      'choosing an approach/architecture, a pattern, an irreversible seam — or are about ' +
      'to ship a significant change, call the reckon_explain MCP tool so the HUMAN explains ' +
      'it back (MECHANISM, not procedure) and an isolated grader verifies understanding ' +
      'BEFORE it ships. Do not make load-bearing calls silently. Pure legwork (research, ' +
      'mapping, mechanical edits) needs no checkpoint.';
    process.stdout.write(JSON.stringify({ additionalContext: context }));
  } catch {
    /* fail open */
  }
}

process.stdin.on('end', emit);
// Safety: if stdin never ends (no piped input), still emit.
setTimeout(emit, 250);
