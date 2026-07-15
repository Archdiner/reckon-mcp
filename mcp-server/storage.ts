import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Storage (Reckon v5). The fork/decision ledger is gone; the unit is now an
 * EXPLANATION — a comprehension checkpoint — plus its cold-recall schedule (the
 * temporal loop, §④, the part of v0 that survived the pivot).
 *
 * Lives at user scope (~/.reckon) so it follows you across repos and keeps
 * compounding. RECKON_HOME overrides (tests). A fresh v5 db file so the old v0
 * decisions.db is never clobbered during the transition.
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

const COLUMNS: { name: string; ddl: string }[] = [
  { name: 'id', ddl: 'id TEXT PRIMARY KEY' },
  { name: 'timestamp', ddl: 'timestamp TEXT NOT NULL' },
  { name: 'session_id', ddl: 'session_id TEXT NOT NULL' },
  { name: 'subsystem', ddl: 'subsystem TEXT NOT NULL' },
  { name: 'concept', ddl: 'concept TEXT NOT NULL' },
  { name: 'stage', ddl: "stage TEXT NOT NULL DEFAULT 'build'" },
  { name: 'ground_truth', ddl: "ground_truth TEXT NOT NULL DEFAULT ''" },
  { name: 'explanation', ddl: "explanation TEXT NOT NULL DEFAULT ''" },
  { name: 'rigor', ddl: "rigor TEXT NOT NULL DEFAULT 'medium'" },
  { name: 'assisted', ddl: 'assisted INTEGER NOT NULL DEFAULT 0' },
  { name: 'passed', ddl: 'passed INTEGER NOT NULL DEFAULT 0' },
  { name: 'ungraded', ddl: 'ungraded INTEGER NOT NULL DEFAULT 0' },
  { name: 'scores', ddl: "scores TEXT NOT NULL DEFAULT '{}'" },
  { name: 'overlap', ddl: "overlap TEXT NOT NULL DEFAULT 'unknown'" },
  { name: 'attempts', ddl: 'attempts INTEGER NOT NULL DEFAULT 1' },
  { name: 'next_recall_due', ddl: 'next_recall_due TEXT' },
  { name: 'recall_count', ddl: 'recall_count INTEGER NOT NULL DEFAULT 0' },
  { name: 'last_recall_outcome', ddl: 'last_recall_outcome TEXT' },
];

function resolveDbPath(): string {
  const home = process.env.RECKON_HOME || path.join(os.homedir(), '.reckon');
  return path.join(home, 'reckon-v5.db');
}

export class Storage {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || resolveDbPath();
  }

  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = await open({ filename: this.dbPath, driver: sqlite3.Database });

    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS explanations (\n  ${COLUMNS.map((c) => c.ddl).join(',\n  ')}\n)`
    );

    // Additive migration for forward-compat.
    const existing = await this.db.all(`PRAGMA table_info(explanations)`);
    const have = new Set(existing.map((r: any) => r.name));
    for (const col of COLUMNS) {
      if (!have.has(col.name)) {
        await this.db.exec(`ALTER TABLE explanations ADD COLUMN ${col.ddl}`);
      }
    }

    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_v5_subsystem ON explanations(subsystem);
      CREATE INDEX IF NOT EXISTS idx_v5_session ON explanations(session_id);
      CREATE INDEX IF NOT EXISTS idx_v5_recall ON explanations(next_recall_due);
    `);
  }

  async add(record: ExplanationRecord): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    await this.db.run(
      `INSERT INTO explanations (
        id, timestamp, session_id, subsystem, concept, stage, ground_truth,
        explanation, rigor, assisted, passed, ungraded, scores, overlap, attempts,
        next_recall_due, recall_count, last_recall_outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.timestamp,
        record.session_id,
        record.subsystem,
        record.concept,
        record.stage,
        record.ground_truth,
        record.explanation,
        record.rigor,
        record.assisted ? 1 : 0,
        record.passed ? 1 : 0,
        record.ungraded ? 1 : 0,
        record.scores,
        record.overlap,
        record.attempts,
        record.next_recall_due || null,
        record.recall_count,
        record.last_recall_outcome || null,
      ]
    );
  }

  async update(id: string, updates: Partial<ExplanationRecord>): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    const keys = Object.keys(updates).filter((k) => k !== 'id');
    if (keys.length === 0) return;
    const fields = keys.map((k) => `${k} = ?`);
    const values = keys.map((k) => {
      const v = (updates as any)[k];
      return typeof v === 'boolean' ? (v ? 1 : 0) : v;
    });
    await this.db.run(`UPDATE explanations SET ${fields.join(', ')} WHERE id = ?`, [...values, id]);
  }

  async get(id: string): Promise<ExplanationRecord | null> {
    if (!this.db) throw new Error('Database not initialized');
    const row = await this.db.get('SELECT * FROM explanations WHERE id = ?', [id]);
    return row ? this.rowToRecord(row) : null;
  }

  /** Cold recall (§④): due items, METADATA ONLY at the call site — the caller must
   *  not surface ground_truth/explanation so the re-check stays cold. */
  async getDueForRecall(subsystem?: string): Promise<ExplanationRecord[]> {
    if (!this.db) throw new Error('Database not initialized');
    const now = new Date().toISOString();
    let query = 'SELECT * FROM explanations WHERE next_recall_due IS NOT NULL AND next_recall_due <= ?';
    const params: any[] = [now];
    if (subsystem) {
      query += ' AND subsystem = ?';
      params.push(subsystem);
    }
    query += ' ORDER BY next_recall_due ASC';
    const rows = await this.db.all(query, params);
    return rows.map((r) => this.rowToRecord(r));
  }

  async getBySubsystem(subsystem: string): Promise<ExplanationRecord[]> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = await this.db.all(
      'SELECT * FROM explanations WHERE subsystem = ? ORDER BY timestamp DESC',
      [subsystem]
    );
    return rows.map((r) => this.rowToRecord(r));
  }

  async getAll(): Promise<ExplanationRecord[]> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = await this.db.all('SELECT * FROM explanations ORDER BY timestamp DESC');
    return rows.map((r) => this.rowToRecord(r));
  }

  private rowToRecord(row: any): ExplanationRecord {
    return { ...row, assisted: row.assisted === 1, passed: row.passed === 1, ungraded: row.ungraded === 1 };
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}

/**
 * Recall scheduling (the temporal loop). A clean cold pass earns a long interval;
 * an ASSISTED pass (you leaned on the source) comes back sooner and the source is
 * gone — that's the real retention test. Survived recall lengthens; decayed shortens.
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
