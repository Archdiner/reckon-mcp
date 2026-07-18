/**
 * Clearance store (Reckon v5.2 — Mode A hardening).
 *
 * The SENTINEL that lets the write-gate / plan-gate hooks know a comprehension
 * checkpoint was actually PASSED, so a build may proceed. The hook and the MCP
 * server are separate processes; a small JSON file on disk is their only shared
 * channel (same pattern as v0's `.fork-sentinel`, but keyed correctly this time).
 *
 * WHY gate_key and not session/subsystem:
 *   The original v0 sentinel keyed on session id and broke — the MCP server mints
 *   its OWN `crypto.randomUUID()` session id, which never equals the Claude Code
 *   `session_id` the HOOK sees on stdin. So any key the two must independently
 *   compute drifts. The fix: the HOOK is the sole author of an opaque `gate_key`
 *   (`<repoHash>:<subsystem>`), hands it to the agent in the deny message, the
 *   agent echoes it into reckon_explain, and on a PASS the server writes the
 *   clearance under that exact string. The server never derives it — it just
 *   stores what it was handed. The hook re-derives the same key deterministically
 *   from (repo root, file path) and checks it. One opaque string round-trips; no
 *   coordination, no drift.
 *
 * FORMAT (also read by hooks/reckon-lib.js — keep in lockstep):
 *   { "version": 1, "clearances": { "<gate_key>": { ts, stage, concept } } }
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ClearanceMeta {
  stage: 'plan' | 'build';
  concept: string;
}

function home(): string {
  return process.env.RECKON_HOME || path.join(os.homedir(), '.reckon');
}

function clearancePath(): string {
  return path.join(home(), 'clearances.json');
}

interface ClearanceFile {
  version: number;
  clearances: Record<string, { ts: number; stage: string; concept: string }>;
}

function read(): ClearanceFile {
  try {
    const raw = fs.readFileSync(clearancePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.clearances) return parsed as ClearanceFile;
  } catch {
    /* missing/corrupt → fresh */
  }
  return { version: 1, clearances: {} };
}

/**
 * Grant a clearance for gate_key. Atomic write (temp + rename) so a hook reading
 * concurrently never sees a torn file. Only the server writes; hooks read-only.
 * We deliberately do NOT set a fixed clock here — ts is Date.now() at grant time
 * and the hook enforces the TTL, so the store stays a plain append/refresh.
 */
export function grantClearance(gateKey: string, meta: ClearanceMeta): void {
  if (!gateKey || typeof gateKey !== 'string') return;
  const file = read();
  file.clearances[gateKey] = { ts: Date.now(), stage: meta.stage, concept: meta.concept };
  const dir = home();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.clearances.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, clearancePath());
}
