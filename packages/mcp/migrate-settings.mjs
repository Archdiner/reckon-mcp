#!/usr/bin/env node
// Reckon v5 — settings migration. MERGES Reckon's three hooks into the `hooks` block
// of ~/.claude/settings.json, PRESERVING every other key AND every hook the user
// already has (their own SessionStart, PreToolUse, etc. are left untouched). Backs
// up before writing. Also retires the stale ~/.claude/hooks.json orphan.
//
// Safe by construction: reads + parses first, backs up, only touches Reckon's own
// hook entries — never clobbers unrelated wiring, and injects nothing personal.
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const RECKON = process.env.RECKON_HOME || path.join(HOME, '.reckon');
const settingsPath = path.join(HOME, '.claude', 'settings.json');
const hooksJsonPath = path.join(HOME, '.claude', 'hooks.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const node = (cmd) => ({ type: 'command', command: `node ${cmd}` });

const planGate = path.join(RECKON, 'hooks', 'reckon-plan-gate.js');
const flagNudge = path.join(RECKON, 'hooks', 'reckon-flag-nudge.js');
const writeGate = path.join(RECKON, 'hooks', 'reckon-write-gate.js');

// True if a hook-group entry runs one of Reckon's own hook scripts. Used to strip any
// prior Reckon entry (possibly at a stale path) before re-adding the current one —
// keeps the merge idempotent without touching the user's other hooks.
const isReckonEntry = (entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some(
    (h) => typeof h?.command === 'string' && /reckon-(plan-gate|flag-nudge|write-gate)\.js/.test(h.command),
  );

// Merge Reckon's hooks into an existing hooks object, preserving all non-Reckon
// entries. Reckon owns exactly three: ExitPlanMode + Edit|Write|MultiEdit (PreToolUse)
// and flag-nudge (UserPromptSubmit). SessionStart and everything else stay as-is.
function mergeReckonHooks(existing) {
  const hooks = existing && typeof existing === 'object' ? { ...existing } : {};
  hooks.PreToolUse = [
    ...(Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []).filter((e) => !isReckonEntry(e)),
    // ExitPlanMode = the SIGNATURE of "a plan is approved and about to be built".
    { matcher: 'ExitPlanMode', hooks: [node(planGate)] },
    // Write/Edit = the SECOND signature — catches a plan dumped as prose and built
    // directly (no ExitPlanMode), the failure that ships unexplained under
    // --dangerously-skip-permissions. Hooks still deny in bypass mode.
    { matcher: 'Edit|Write|MultiEdit', hooks: [node(writeGate)] },
  ];
  hooks.UserPromptSubmit = [
    ...(Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []).filter(
      (e) => !isReckonEntry(e),
    ),
    { hooks: [node(flagNudge)] },
  ];
  return hooks;
}

function backup(p) {
  if (fs.existsSync(p)) {
    const b = `${p}.bak-${stamp}`;
    fs.copyFileSync(p, b);
    return b;
  }
  return null;
}

// 1. settings.json — preserve all keys and all non-Reckon hooks, merge in Reckon's.
if (!fs.existsSync(settingsPath)) {
  console.error(`✗ ${settingsPath} not found — aborting settings migration`);
  process.exit(1);
}
let settings;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
  console.error(`✗ ${settingsPath} is not valid JSON — aborting (${e.message})`);
  process.exit(1);
}
const sBak = backup(settingsPath);
const preservedKeys = Object.keys(settings).filter((k) => k !== 'hooks');
settings.hooks = mergeReckonHooks(settings.hooks);
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.error(`✓ settings.json: merged Reckon hooks (backup: ${sBak})`);
console.error(`  preserved keys: ${preservedKeys.join(', ')}`);
console.error(`  preserved non-Reckon hooks (SessionStart, etc.) untouched`);

// 2. Retire the stale hooks.json orphan.
if (fs.existsSync(hooksJsonPath)) {
  const hBak = backup(hooksJsonPath);
  fs.rmSync(hooksJsonPath);
  console.error(`✓ removed stale hooks.json (backup: ${hBak})`);
}

console.error('✓ settings migration complete');
