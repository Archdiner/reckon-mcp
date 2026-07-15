import crypto from 'crypto';
import { Storage, ExplanationRecord, Stage, RecallOutcome, scheduleAfterGrade, scheduleAfterRecall } from './storage.js';
import { grade } from './grader.js';
import { elicitPrompt, retryPrompt, recallPrompt } from './elicit.js';
import { RigorLevel } from './rubric.js';

/**
 * The comprehension loop engine (Reckon v5).
 *
 *   elicit (mechanism) → grade (isolated) → [rescue → re-explain] → log + schedule cold recall
 *
 * Replaces the v0–v4 commit→reveal→reconcile fork primitive. Nothing is withheld and
 * revealed anymore; instead the human explains, and an isolated grader checks the
 * explanation against ground truth. Medium is the rigor floor; harsh is opt-in.
 */

interface OpenCheckpoint {
  id: string;
  concept: string;
  subsystem: string;
  stage: Stage;
  groundTruth: string;
  rigor: RigorLevel;
  attempts: number;
  sessionId: string;
}

export interface OpenResult {
  id: string;
  prompt: string;
  stage: Stage;
  rigor: RigorLevel;
}

export interface GradeResultOut {
  pass: boolean;
  prompt?: string; // retry prompt if !pass
  feedback: string;
  scores: Record<string, number>;
  overlap: string;
  assisted: boolean;
  ungraded: boolean;
  next_recall_due?: string;
}

export class ComprehensionLoop {
  private open_: Map<string, OpenCheckpoint> = new Map();
  constructor(private storage: Storage) {}

  /** Open an explanation checkpoint. Returns the mechanism-elicitation prompt. */
  open(input: {
    concept: string;
    subsystem: string;
    stage: Stage;
    groundTruth: string;
    rigor?: RigorLevel;
    sessionId: string;
  }): OpenResult {
    const id = crypto.randomUUID();
    const rigor: RigorLevel = input.rigor === 'harsh' ? 'harsh' : 'medium'; // floor at medium
    this.open_.set(id, { ...input, id, rigor, attempts: 0 });
    return {
      id,
      prompt: elicitPrompt({ concept: input.concept, subsystem: input.subsystem, stage: input.stage }),
      stage: input.stage,
      rigor,
    };
  }

  /** Submit the human's explanation. Grades it (isolated). Pass → log + schedule; fail → retry prompt. */
  async submit(id: string, explanation: string, assisted: boolean): Promise<GradeResultOut | null> {
    const cp = this.open_.get(id);
    if (!cp) return null;
    cp.attempts += 1;

    const g = await grade({ groundTruth: cp.groundTruth, explanation, rigor: cp.rigor, assisted });

    if (!g.pass) {
      // Stay open — the human takes another pass (with source rescue allowed).
      return {
        pass: false,
        prompt: retryPrompt(g.hole, assisted),
        feedback: g.ungraded ? 'grader unavailable — passing ungraded' : 'not yet — one gap to close',
        scores: g.scores,
        overlap: g.overlap,
        assisted,
        ungraded: g.ungraded,
      };
    }

    // Passed → log + schedule cold recall. Assisted passes come back sooner.
    // An UNGRADED pass (grader failed open) is logged but NOT verified, so it must
    // NOT enter the recall loop — you can't cold-test something that was never graded
    // (adversarial finding F2: ungraded must not masquerade as learned in the ledger).
    const next_due = g.ungraded ? undefined : scheduleAfterGrade(true, assisted);
    const record: ExplanationRecord = {
      id: cp.id,
      timestamp: new Date().toISOString(),
      session_id: cp.sessionId,
      subsystem: cp.subsystem,
      concept: cp.concept,
      stage: cp.stage,
      ground_truth: cp.groundTruth,
      explanation,
      rigor: cp.rigor,
      assisted,
      passed: true,
      ungraded: g.ungraded,
      scores: JSON.stringify(g.scores),
      overlap: g.overlap,
      attempts: cp.attempts,
      next_recall_due: next_due,
      recall_count: 0,
    };
    await this.storage.add(record);
    this.open_.delete(id);

    return {
      pass: true,
      feedback: g.ungraded
        ? '○ Logged ungraded (grader unavailable).'
        : assisted
        ? '✓ Passed (ASSISTED) — you leaned on the source, so this comes back cold, sooner.'
        : '✓ Passed — clean. Filed for a cold recall later.',
      scores: g.scores,
      overlap: g.overlap,
      assisted,
      ungraded: g.ungraded,
      next_recall_due: next_due,
    };
  }

  /** Answer a cold recall. Grades against the stored ground truth; reschedules. */
  async recallAnswer(id: string, answer: string): Promise<GradeResultOut | null> {
    const rec = await this.storage.get(id);
    if (!rec) return null;

    // Recall is always at least as strict as the original; no source this time.
    const g = await grade({ groundTruth: rec.ground_truth, explanation: answer, rigor: rec.rigor as RigorLevel, assisted: false });
    const outcome: RecallOutcome = g.pass ? 'survived' : 'decayed';
    const next = scheduleAfterRecall(outcome, rec.recall_count);

    await this.storage.update(id, {
      recall_count: rec.recall_count + 1,
      last_recall_outcome: outcome,
      next_recall_due: next,
    });

    return {
      pass: g.pass,
      prompt: g.pass ? undefined : retryPrompt(g.hole, false),
      feedback: g.pass ? '✓ Survived cold recall — it stuck. Interval lengthened.' : '~ Decayed — resurfacing soon.',
      scores: g.scores,
      overlap: g.overlap,
      assisted: false,
      ungraded: g.ungraded,
      next_recall_due: next,
    };
  }

  /** The cold-recall prompt for a due item (metadata only — stays cold). */
  recallQuestion(rec: ExplanationRecord): string {
    return recallPrompt(rec.concept, rec.subsystem);
  }
}
