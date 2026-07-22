// Reckon v5.2 — shared hook library (CommonJS). Required by both gate hooks so the
// subsystem derivation, clearance read, care-gate, and deny emitter live in ONE place.
//
// Dependency-free (Node built-ins only) — hooks must never need `npm install`.
// Every function FAILS OPEN: on any error a hook must let the tool proceed, never
// wedge the session. Enforcement is best-effort-strong, not a tripwire that bricks work.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.RECKON_HOME || path.join(os.homedir(), '.reckon');
const CLEARANCES = path.join(HOME, 'clearances.json');
const CONFIG = path.join(HOME, 'config.json');
const CHURN = path.join(HOME, 'churn.json');
// A clearance is a work-session pass, not a permanent bypass. Long enough for a real
// build session, short enough that tomorrow's work re-earns comprehension.
const TTL_MS = Number(process.env.RECKON_CLEARANCE_TTL_MS || 12 * 60 * 60 * 1000);
const LARGE_CHANGE_THRESHOLD = 40; // mirrors mcp-server/classifier.ts

// ── stdin ──────────────────────────────────────────────────────────────────
// Drain the hook payload and hand back the parsed JSON. Falls back to {} so a
// caller never throws on malformed input.
function readInput(cb) {
  let buf = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    let parsed = {};
    try { parsed = JSON.parse(buf); } catch { /* fail open */ }
    cb(parsed);
  };
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', finish);
  } catch { /* fail open */ }
  setTimeout(finish, 250); // safety: emit even if stdin never ends
}

// ── repo + subsystem ─────────────────────────────────────────────────────────
// Git root above cwd (walk up for .git); else cwd itself. Deterministic anchor
// so the same file always resolves to the same gate_key regardless of caller.
function repoRoot(cwd) {
  try {
    let dir = cwd || process.cwd();
    for (let i = 0; i < 40 && dir && dir !== path.dirname(dir); i++) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      dir = path.dirname(dir);
    }
    return cwd || process.cwd();
  } catch {
    return cwd || process.cwd();
  }
}

function repoHash(root) {
  try {
    return crypto.createHash('sha1').update(fs.realpathSync(root)).digest('hex').slice(0, 8);
  } catch {
    return crypto.createHash('sha1').update(String(root)).digest('hex').slice(0, 8);
  }
}

// Prose / docs files never gate — explaining the "mechanism" of a README is nonsense,
// and a docs update is exactly the kind of change the user should never be taxed for.
// Code is what carries mechanism; this exempts the clearly-not-code by extension/name.
// Also exempts machine-authored files (lockfiles, minified, sourcemaps) and anything
// under a generated/build directory — none of it is code a human authored, so taxing
// it is pure friction (a top source of the old over-triggering).
const EXEMPT_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);
const EXEMPT_NAME = new Set(['license', 'licence', 'changelog', 'authors', 'notice', 'copyright']);
const EXEMPT_BASENAME = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'cargo.lock', 'poetry.lock', 'gemfile.lock', 'composer.lock', 'go.sum', 'pipfile.lock',
]);
const EXEMPT_DIR = new Set(['dist', 'build', 'out', '.next', 'node_modules', 'coverage', 'generated', '__generated__', 'vendor']);
function isExemptPath(filePath) {
  try {
    const p = String(filePath);
    const base = path.basename(p).toLowerCase();
    if (EXEMPT_BASENAME.has(base)) return true;
    if (base.endsWith('.min.js') || base.endsWith('.min.css') || base.endsWith('.map')) return true;
    const ext = path.extname(base);
    if (EXEMPT_EXT.has(ext)) return true;
    const stem = ext ? base.slice(0, -ext.length) : base;
    if (EXEMPT_NAME.has(stem)) return true;
    const segs = p.split(/[\\/]/).map((s) => s.toLowerCase());
    if (segs.some((s) => EXEMPT_DIR.has(s))) return true;
    return false;
  } catch {
    return false;
  }
}

// Subsystem = the first path segment under the repo root (files at root → "root").
// Deliberately coarse and PREDICTABLE: over-gating slightly is safe, a mismatch that
// silently under-gates (the old sentinel bug) is not. Granularity is a later concern.
function deriveSubsystem(filePath, root) {
  try {
    const rel = path.relative(root, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'root';
    const parts = rel.split(path.sep).filter(Boolean);
    return parts.length > 1 ? parts[0] : 'root';
  } catch {
    return 'root';
  }
}

// The opaque token that round-trips hook → agent → server → hook. The hook is its
// SOLE author; the server just stores the string it's handed.
function gateKey(root, subsystem) {
  return `${repoHash(root)}:${subsystem}`;
}
function planGateKey(root) {
  return `${repoHash(root)}:__plan__`;
}

// ── clearance ────────────────────────────────────────────────────────────────
function isCleared(key) {
  try {
    const file = JSON.parse(fs.readFileSync(CLEARANCES, 'utf8'));
    const entry = file && file.clearances && file.clearances[key];
    if (!entry || typeof entry.ts !== 'number') return false;
    return Date.now() - entry.ts < TTL_MS;
  } catch {
    return false; // no file / unreadable → not cleared (safe: gate holds)
  }
}

// ── config (arming seam — minimal; armed everywhere by default) ───────────────
// Shape: { "modeA": { "enabled": true, "subsystems": { "mode": "all"|"only"|"except", "list": [] } } }
// Absent/unparseable config → fully armed. This is the seam the user will later
// configure per-subsystem; for now it just answers "is the gate on here?".
function isArmed(subsystem) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const m = cfg && cfg.modeA;
    if (!m) return true;
    if (m.enabled === false) return false;
    const s = m.subsystems;
    if (!s || !s.mode || s.mode === 'all') return true;
    const list = Array.isArray(s.list) ? s.list : [];
    if (s.mode === 'only') return list.includes(subsystem);
    if (s.mode === 'except') return !list.includes(subsystem);
    return true;
  } catch {
    return true; // default armed
  }
}

// Whether Mode A is on at all — used by the plan-gate, which is repo-wide and must
// not be silently disarmed by a per-subsystem `only` list that omits "__plan__".
function isModeAEnabled() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return !(cfg && cfg.modeA && cfg.modeA.enabled === false);
  } catch {
    return true;
  }
}

// ── tunable thresholds (config.json, live — no redeploy) ───────────────────────
// The two knobs that set how aggressive Mode A feels. Read per-call from config.json
// so the user retunes by feel without a rebuild. Sane defaults if absent/garbage.
//   modeA.threshold  cumulative per-subsystem churn (lines) that trips the gate  [80]
//   modeA.writeFloor the MINIMUM size of the write that actually trips it         [8]
// The floor is the fix for "a trivial copy edit set it off": a sub-floor write only
// accrues toward the cumulative total, it can never itself be the trigger.
function modeAConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return (cfg && cfg.modeA) || {};
  } catch {
    return {};
  }
}
function churnThreshold() {
  const v = Number(modeAConfig().threshold);
  return Number.isFinite(v) && v > 0 ? v : 80;
}
function writeFloor() {
  const v = Number(modeAConfig().writeFloor);
  return Number.isFinite(v) && v >= 0 ? v : 8;
}

// ── care-gate (classifier heuristic, mirrors mcp-server/classifier.ts) ─────────
// Only LOAD-BEARING writes are gated: a new EXTERNAL dependency, or a substantial
// change. Trivial edits sail through — that is what keeps this from becoming alarm
// fatigue (the v0 failure that trained rubber-stamping). Scans the NEW text written.
//
// A NEW EXTERNAL dependency is the import signal — a package pulled from OUTSIDE the
// codebase (new capability, new blast radius). Relative imports (./  ../  absolute
// local paths) are just intra-project wiring and must NOT gate; treating every import
// line as load-bearing was the single biggest source of the old over-triggering.
function isRelativeSpecifier(spec) {
  return !spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~');
}
function hasNewImport(text) {
  const src = text || '';
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"\n]*from\s+['"]([^'"]+)['"]/g, // import x from 'pkg'
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g, // side-effect import 'pkg'
    /(?:^|\n)\s*(?:const|let|var)\s+[^=\n]+=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g, // require('pkg')
    /(?:^|\n)\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/g, // python: from pkg import (relative "from ." never matches)
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!isRelativeSpecifier(m[1])) return true;
    }
  }
  return false;
}

function lineCount(s) {
  return s ? s.split('\n').length : 0;
}

// Returns { churn, hasImport } for the pending write — the RAW measures. The gate
// decides significance, so it can fold in CUMULATIVE churn (many small edits) rather
// than judging each write in isolation (which is how a big change gets chunked past).
function classifyWrite(toolName, input) {
  try {
    if (toolName === 'Write') {
      const c = input.content || '';
      return { churn: lineCount(c), hasImport: hasNewImport(c) };
    }
    if (toolName === 'Edit') {
      const added = input.new_string || '';
      const removed = input.old_string || '';
      return { churn: lineCount(added) + lineCount(removed), hasImport: hasNewImport(added) };
    }
    if (toolName === 'MultiEdit') {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      let churn = 0;
      let imp = false;
      for (const e of edits) {
        churn += lineCount(e.new_string) + lineCount(e.old_string);
        if (hasNewImport(e.new_string)) imp = true;
      }
      return { churn, hasImport: imp };
    }
  } catch { /* fall through */ }
  return { churn: 0, hasImport: false };
}

// Per-session, per-subsystem CUMULATIVE churn. Closes the "death by a thousand small
// edits" hole: each write below the single-shot threshold still accrues, and the write
// that pushes the running total over the line trips the gate. A lone typo fix never
// accrues enough to gate — only sustained building does. Keyed by the Claude Code
// session_id (hook-only state; no server round-trip, so no session-id-mismatch issue).
// Prunes entries older than 24h so the file can't grow without bound.
function bumpChurn(sessionId, key, add) {
  const k = `${sessionId || 'nosession'}:${key}`;
  let file = { version: 1, churn: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(CHURN, 'utf8'));
    if (parsed && parsed.churn) file = parsed;
  } catch { /* fresh */ }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [ek, ev] of Object.entries(file.churn)) {
    if (!ev || typeof ev.ts !== 'number' || ev.ts < cutoff) delete file.churn[ek];
  }
  const prev = file.churn[k] && typeof file.churn[k].n === 'number' ? file.churn[k].n : 0;
  const n = prev + Math.max(0, add);
  file.churn[k] = { n, ts: Date.now() };
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const tmp = path.join(HOME, `.churn.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, CHURN);
  } catch { /* best effort — never wedge the write */ }
  return n;
}

// ── emitters ───────────────────────────────────────────────────────────────
// DENY the pending tool call. Canonical PreToolUse shape: the reason is fed back
// to the model so it can act on it (run the reckon loop, then retry). Exit 0 —
// the JSON decision, not the exit code, carries the block.
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

// ALLOW = emit nothing and exit 0, so the NORMAL permission flow (and any other
// hook) still runs. We deliberately never emit permissionDecision:"allow" — that
// would short-circuit other checks; this gate only ever blocks-or-defers.
function allow() {
  process.exit(0);
}

module.exports = {
  readInput,
  repoRoot,
  isExemptPath,
  deriveSubsystem,
  gateKey,
  planGateKey,
  isCleared,
  isArmed,
  isModeAEnabled,
  classifyWrite,
  bumpChurn,
  churnThreshold,
  writeFloor,
  deny,
  allow,
  LARGE_CHANGE_THRESHOLD,
  HOME,
};
