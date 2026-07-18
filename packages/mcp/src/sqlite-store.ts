import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Storage, ExplanationRecord } from '@reckon/core';

/**
 * SqliteStore — the local (Claude Code host) implementation of @reckon/core's `Storage`
 * port. Lives here, not in core, so `@reckon/core` carries ZERO runtime dependencies (a
 * hosted client like reckon-pr injects a Postgres store instead). Behavior is unchanged from
 * when it lived in core.
 *
 * Lives at user scope (~/.reckon) so it follows you across repos. RECKON_HOME overrides.
 */

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

export class SqliteStore implements Storage {
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

  /** Cold recall (§④): due items, METADATA ONLY at the call site. */
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
