#!/usr/bin/env node
// Reckon v5.2 — write-gate (the SECOND signature). PreToolUse on Edit|Write|MultiEdit.
//
// The plan-gate only catches you if you cross ExitPlanMode. The failure it MISSES —
// and the one that shipped a whole punch-list unexplained — is a plan dumped as PROSE
// and executed directly, no plan mode, under --dangerously-skip-permissions. Verified:
// PreToolUse hooks still fire AND can `deny` in bypass mode (they run before the
// permission-mode check). So THIS is where Mode A actually gets teeth.
//
// Mechanism: on the FIRST load-bearing write into an un-cleared subsystem, DENY and
// hand the agent an opaque gate_key. The agent runs the comprehension loop; on a PASS
// the server writes the clearance under that key; the retried write sails through.
// Trivial edits are never gated (care-gate) — that's what stops alarm fatigue.
const lib = require('./reckon-lib.js');

lib.readInput((input) => {
  try {
    const toolName = input.tool_name;
    const ti = input.tool_input || {};
    const filePath = ti.file_path;
    if (!filePath) return lib.allow();
    if (lib.isExemptPath(filePath)) return lib.allow(); // prose/docs never gate

    const root = lib.repoRoot(input.cwd);
    const subsystem = lib.deriveSubsystem(filePath, root);
    if (!lib.isArmed(subsystem)) return lib.allow(); // Mode A not armed here

    const key = lib.gateKey(root, subsystem);
    if (lib.isCleared(key)) return lib.allow(); // already explained this subsystem this session

    // Care-gate on CUMULATIVE churn, not just this one write. A new dependency gates
    // immediately; otherwise the running per-subsystem total must cross the threshold —
    // so eight 10-line edits trip on the write that pushes past 40, while a lone typo
    // fix accrues too little to ever gate. This closes the chunk-it-past hole.
    const { churn, hasImport } = lib.classifyWrite(toolName, ti);
    const cumulative = lib.bumpChurn(input.session_id, key, churn);
    const significant = hasImport || cumulative > lib.LARGE_CHANGE_THRESHOLD;
    if (!significant) return lib.allow();

    // Not cleared + load-bearing → block and route through the loop.
    return lib.deny(
      `RECKON (Mode A): about to build in subsystem "${subsystem}" with no comprehension ` +
        `checkpoint. Before this write, call the reckon_explain MCP tool:\n` +
        `  stage:        "build"  (use "plan" if this is the first step of a multi-part plan)\n` +
        `  subsystem:    "${subsystem}"\n` +
        `  concept:      <short slug for what you're building>\n` +
        `  ground_truth: <the code/plan you are about to write, verbatim>\n` +
        `  gate_key:     "${key}"   ← REQUIRED. Pass this EXACT string; do not paraphrase it.\n` +
        `Then put the returned prompt to the HUMAN, take THEIR explanation, and call ` +
        `reckon_grade. On a PASS the gate clears and you may retry this edit. The human ` +
        `must explain the mechanism — you may not answer on their behalf.`
    );
  } catch {
    return lib.allow(); // fail open — a hook must never wedge the session
  }
});
