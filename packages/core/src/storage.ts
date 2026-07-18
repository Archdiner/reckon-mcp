/**
 * Storage port + types (Reckon v5). The unit is an EXPLANATION — a comprehension checkpoint —
 * plus its cold-recall schedule (the temporal loop, §④).
 *
 * This module is PURE: it defines the `Storage` interface and the record types, and holds the
 * recall-scheduling math. No database, no sqlite, no filesystem — that keeps `@reckon/core`
 * dependency-free. The concrete stores live in the hosts: `SqliteStore` in @reckon/mcp (local
 * Claude Code), a Postgres/Supabase store in the GitHub-App sister repo.
 */

export type Stage = 'plan' | 'build';
export type RecallOutcome = 'survived' | 'decayed';

export interface ExplanationRecord {
  id: string;
  timestamp: string;
  session_id: string;
  subsystem: string;
  concept: string;
  stage: Stage;
  /** The plan/diff the explanation was graded against (the reference). */
  ground_truth: string;
  /** The human's latest explanation. */
  explanation: string;
  rigor: string; // 'medium' | 'harsh'
  /** Did the human lean on the source? Assisted passes are re-checked cold sooner. */
  assisted: boolean;
  passed: boolean;
  /** True when the grader failed open (unavailable): logged but NOT verified. */
  ungraded: boolean;
  /** JSON blob of the 7 dimension scores. */
  scores: string;
  overlap: string;
  attempts: number;
  next_recall_due?: string;
  recall_count: number;
  last_recall_outcome?: string;
}

/**
 * The storage port. Core depends on this interface, not on any concrete engine, so a host
 * can inject SqliteStore (local) or a Postgres/Supabase store (hosted) without touching the
 * loop.
 */
export interface Storage {
  init(): Promise<void>;
  add(record: ExplanationRecord): Promise<void>;
  update(id: string, updates: Partial<ExplanationRecord>): Promise<void>;
  get(id: string): Promise<ExplanationRecord | null>;
  getDueForRecall(subsystem?: string): Promise<ExplanationRecord[]>;
  getBySubsystem(subsystem: string): Promise<ExplanationRecord[]>;
  getAll(): Promise<ExplanationRecord[]>;
  close(): Promise<void>;
}

/**
 * Recall scheduling (the temporal loop). A clean cold pass earns a long interval; an ASSISTED
 * pass (you leaned on the source) comes back sooner and the source is gone — the real
 * retention test. Survived recall lengthens; decayed shortens.
 */
export function scheduleAfterGrade(passed: boolean, assisted: boolean): string | undefined {
  if (!passed) return undefined; // failed checkpoints aren't scheduled; they re-fire in-session
  const days = assisted ? 3 : 14;
  return isoInDays(days);
}

export function scheduleAfterRecall(outcome: RecallOutcome, priorCount: number): string {
  if (outcome === 'survived') {
    // spaced: 14 → 30 → 60 …
    const days = Math.min(14 * Math.pow(2, priorCount), 120);
    return isoInDays(days);
  }
  return isoInDays(2); // decayed → resurface fast
}

function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
