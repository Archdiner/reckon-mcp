#!/usr/bin/env node
// Reckon v5 — settings migration. Surgically rewrites the `hooks` block of
// ~/.claude/settings.json to the v5 wiring, PRESERVING every other key (model,
// plugins, outputStyle, weekly-review, etc.). Backs up before writing. Also retires
// the stale ~/.claude/hooks.json orphan (backed up, then removed).
//
// Safe by construction: reads + parses first, backs up, only rewrites `hooks`.
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const RECKON = process.env.RECKON_HOME || path.join(HOME, '.reckon');
const settingsPath = path.join(HOME, '.claude', 'settings.json');
const hooksJsonPath = path.join(HOME, '.claude', 'hooks.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const node = (cmd) => ({ type: 'command', command: `node ${cmd}` });

// The v5 hook wiring. Everything else in settings.json is preserved untouched.
const v5Hooks = {
  PreToolUse: [
    {
      // ExitPlanMode = the SIGNATURE of "a plan is approved and about to be built" —
      // the prior, load-bearing decision moment. Reliable, no introspection needed.
      matcher: 'ExitPlanMode',
      hooks: [node(path.join(RECKON, 'hooks', 'reckon-plan-gate.js'))],
    },
  ],
  UserPromptSubmit: [
    { hooks: [node(path.join(RECKON, 'hooks', 'reckon-flag-nudge.js'))] },
  ],
  // Preserve the (non-reckon) weekly-review SessionStart hook; drop v0 recall-hook.
  SessionStart: [{ hooks: [node(path.join(RECKON, 'weekly-review.js'))] }],
  // Dropped from v0: Stop/stop-scan, PreToolUse hook.js + signature-gate (they
  // gated the now-removed reckon_fork), UserPromptSubmit fork-guard.
};

function backup(p) {
  if (fs.existsSync(p)) {
    const b = `${p}.bak-${stamp}`;
    fs.copyFileSync(p, b);
    return b;
  }
  return null;
}

// 1. settings.json — preserve all keys, replace only `hooks`.
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
settings.hooks = v5Hooks;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.error(`✓ settings.json hooks → v5 (backup: ${sBak})`);
console.error(`  preserved keys: ${preservedKeys.join(', ')}`);

// 2. Retire the stale hooks.json orphan.
if (fs.existsSync(hooksJsonPath)) {
  const hBak = backup(hooksJsonPath);
  fs.rmSync(hooksJsonPath);
  console.error(`✓ removed stale hooks.json (backup: ${hBak})`);
}

console.error('✓ settings migration complete');
