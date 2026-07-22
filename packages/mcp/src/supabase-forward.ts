import type { ExplanationRecord } from '@reckon/core';
import { resolveIdentity, resolveRepo } from './identity.js';

/**
 * The CONNECTION. Forwards a local MCP comprehension event to the SAME Supabase the reckon-pr
 * PR gate writes to, stamped with the user's GitHub identity — so dev-time (MCP) and merge-time
 * (PR) events for the same person land in one store keyed by one id, and a cross-surface profile
 * ("where you've used Reckon, and what you've shown you understand") becomes a single query.
 *
 * DESIGN:
 *  - DUAL-WRITE, not a move. Local SQLite stays the source of truth; this is a best-effort mirror.
 *    It is fire-and-forget and NEVER throws — a network blip or missing table must not wedge the
 *    comprehension loop (the whole point of a local-first ledger is that it works offline).
 *  - PRIVACY. It forwards only the METADATA a profile needs (subsystem, concept, scores, tier,
 *    pass) plus identity. It deliberately does NOT forward `ground_truth` (your source) — that
 *    never leaves your machine. (`explanation` is likewise omitted for now.)
 *  - OPT-OUT BY DEFAULT-OFF-CREDS. If RECKON_SUPABASE_URL/KEY are unset it silently no-ops, so the
 *    MCP runs identically with or without the shared store.
 */

const supabaseUrl = () => process.env.RECKON_SUPABASE_URL || '';
const supabaseKey = () => process.env.RECKON_SUPABASE_KEY || '';

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function upsert(table: string, row: unknown): Promise<void> {
  const url = supabaseUrl();
  const key = supabaseKey();
  if (!url || !key) return; // not configured → local-only
  await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates', // upsert on the primary key (idempotent re-forward)
    },
    body: JSON.stringify(row),
  });
}

/**
 * Mirror one ExplanationRecord to Supabase. Awaitable but designed to be called fire-and-forget
 * (`void forwardEvent(...)`); it swallows all errors so the caller's write is never affected.
 */
export async function forwardEvent(record: ExplanationRecord): Promise<void> {
  if (!supabaseUrl() || !supabaseKey()) return;
  try {
    const id = resolveIdentity();
    const repo = resolveRepo();

    await upsert('mcp_events', {
      id: record.id,
      github_id: id.github_id,
      github_login: id.github_login,
      email: id.email,
      session_id: record.session_id,
      subsystem: record.subsystem,
      concept: record.concept,
      stage: record.stage,
      rigor: record.rigor,
      assisted: record.assisted,
      told: record.told,
      passed: record.passed,
      ungraded: record.ungraded,
      scores: record.scores ? safeParse(record.scores) : null,
      overlap: record.overlap,
      attempts: record.attempts,
      repo,
      created_at: record.timestamp,
    });

    // Upsert the user dimension so a profile anchor exists even before this person hits a PR gate.
    if (id.github_id) {
      await upsert('users', {
        github_id: id.github_id,
        github_login: id.github_login,
        email: id.email,
        last_seen: new Date().toISOString(),
      });
    }
  } catch {
    // best-effort mirror — the local SQLite ledger already holds the truth.
  }
}
