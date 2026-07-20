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
  /**
   * The honesty tier's third rung: cleared by TELL at the escalation floor, not by a real
   * pass. A told clear is marked (never masquerades as earned) and penalized — it comes back
   * cold soonest of all. earned → assisted → told is a gradient of how much you leaned; the
   * penalty is more teaching (a shorter recall interval), never less access.
   */
  told: boolean;
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
 * Recall scheduling (the temporal loop). The initial interval is set by the honesty tier —
 * how much you leaned to clear the gate:
 *
 *   earned   (clean, from your head)      → 14 days
 *   assisted (you re-read the source)     →  3 days  — comes back cold, sooner
 *   told     (handed the answer at floor) →  1 day   — soonest; the penalty is more teaching
 *
 * Same curve, steeper at each rung. `told` overrides `assisted` (you can't be handed the
 * answer AND count as merely having peeked). Survived recall lengthens; decayed shortens.
 */
export function scheduleAfterGrade(
  passed: boolean,
  assisted: boolean,
  told: boolean = false
): string | undefined {
  if (!passed) return undefined; // failed checkpoints aren't scheduled; they re-fire in-session
  const days = told ? 1 : assisted ? 3 : 14;
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
