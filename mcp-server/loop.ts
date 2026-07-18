import crypto from 'crypto';
import { Storage, ExplanationRecord, Stage, RecallOutcome, scheduleAfterGrade, scheduleAfterRecall } from './storage.js';
import { grade, gradePlan } from './grader.js';
import { elicitPrompt, planElicitPrompt, retryPrompt, recallPrompt } from './elicit.js';
import { decompose, Decision } from './decompose.js';
import { RigorLevel } from './rubric.js';
import { grantClearance } from './clearance.js';

// Safety cap on clusters gated in one plan checkpoint. decompose() returns 2-4 coherent
// sub-problems and we gate ALL of them in one combined grade (no deferral); this is just
// a backstop against a decompose that returns more than expected.
const MAX_GATED = Math.max(1, Number(process.env.RECKON_MAX_DECISIONS || 4));

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
  // Mode A hardening (v5.2): the opaque clearance key from the gate DENY message.
  // On a PASS we write a clearance under it so the blocked write/plan may proceed.
  gateKey?: string;
  // Plan checkpoints (v5.1): a decomposed plan gates the top decisions now and
  // defers the tail to recall.
  isPlan?: boolean;
  gated?: Decision[];
  deferred?: Decision[];
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

  /** Open an explanation checkpoint. Returns the mechanism-elicitation prompt.
   *  For a plan (stage="plan") with more than one load-bearing decision, decomposes it,
   *  gates the top MAX_GATED, and defers the tail to recall. */
  async open(input: {
    concept: string;
    subsystem: string;
    stage: Stage;
    groundTruth: string;
    rigor?: RigorLevel;
    sessionId: string;
    gateKey?: string;
  }): Promise<OpenResult> {
    const id = crypto.randomUUID();
    const rigor: RigorLevel = input.rigor === 'harsh' ? 'harsh' : 'medium'; // floor at medium

    if (input.stage === 'plan') {
      const d = await decompose(input.groundTruth);
      if (d.ok && d.decisions.length > 1) {
        // Gate ALL clusters (decompose bounds to 2-4); no deferral. The whole plan is
        // covered in one combined grade.
        const gated = d.decisions.slice(0, MAX_GATED);
        this.open_.set(id, { ...input, id, rigor, attempts: 0, isPlan: true, gated, deferred: [] });
        return { id, prompt: planElicitPrompt(input.subsystem, gated), stage: input.stage, rigor };
      }
    }
    // single-decision path (build stage, or a plan that decomposed to 0-1 decisions)
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

    if (cp.isPlan) return this.submitPlan(cp, explanation, assisted);

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
    // Mode A: a PASS clears the gate that blocked the write/plan. We clear even on an
    // UNGRADED pass (grader failed open) — !pass never reaches here, and wedging every
    // build because the grader is down would violate the fail-open-loudly contract.
    if (cp.gateKey) grantClearance(cp.gateKey, { stage: cp.stage, concept: cp.concept });
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

  /** Grade a plan explanation covering the gated decisions; on pass, defer the tail to recall. */
  private async submitPlan(cp: OpenCheckpoint, explanation: string, assisted: boolean): Promise<GradeResultOut> {
    const g = await gradePlan({ groundTruth: cp.groundTruth, explanation, rigor: cp.rigor, decisions: cp.gated || [] });
    if (!g.pass) {
      return {
        pass: false,
        prompt: retryPrompt(g.hole, assisted),
        feedback: g.ungraded ? 'plan grader unavailable — passing ungraded' : `not yet — ${g.missing.length} decision(s) still need real mechanism`,
        scores: {},
        overlap: 'unknown',
        assisted,
        ungraded: g.ungraded,
      };
    }
    // Retention recall stays (the Feynman moat): a passed plan comes back cold later.
    const next_due = g.ungraded ? undefined : scheduleAfterGrade(true, assisted);
    await this.storage.add({
      id: cp.id, timestamp: new Date().toISOString(), session_id: cp.sessionId,
      subsystem: cp.subsystem, concept: cp.concept, stage: 'plan', ground_truth: cp.groundTruth,
      explanation, rigor: cp.rigor, assisted, passed: true, ungraded: g.ungraded,
      scores: JSON.stringify({ covered: g.covered }), overlap: 'unknown', attempts: cp.attempts,
      next_recall_due: next_due, recall_count: 0,
    });
    if (cp.gateKey) grantClearance(cp.gateKey, { stage: cp.stage, concept: cp.concept });
    this.open_.delete(cp.id);
    return {
      pass: true,
      feedback: g.ungraded
        ? '○ Plan logged ungraded (grader unavailable).'
        : `✓ Passed — explained all ${g.covered.length} sub-problem(s) of the plan. Filed for cold recall.`,
      scores: {}, overlap: 'unknown', assisted, ungraded: g.ungraded, next_recall_due: next_due,
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
