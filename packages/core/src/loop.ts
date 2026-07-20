import crypto from 'crypto';
import { Storage, ExplanationRecord, Stage, RecallOutcome, scheduleAfterGrade, scheduleAfterRecall } from './storage.js';
import { grade, gradePlan } from './grader.js';
import { elicitPrompt, planElicitPrompt, retryPrompt, recallPrompt, tellPrompt } from './elicit.js';
import { decompose, Decision } from './decompose.js';
import { RigorLevel, Rung, FLOOR_RUNG } from './rubric.js';
import { LlmBackend } from './llm.js';

// Safety cap on clusters gated in one plan checkpoint. decompose() returns 2-4 coherent
// sub-problems and we gate ALL of them in one combined grade (no deferral); this is just
// a backstop against a decompose that returns more than expected.
const MAX_GATED = Math.max(1, Number(process.env.RECKON_MAX_DECISIONS || 4));

/**
 * The escalation floor: the attempt number at which, on a fresh miss, Reckon stops asking
 * and TELLS (a marked `told` clear). Default 4 → three question rungs (nudge, sharper,
 * pointed) then the floor. Read per-call, not at module load, so hosts/tests can retune it
 * (RECKON_LADDER_FLOOR) without reimporting. Clamped so there's always ≥1 real swing.
 */
function floorAttempt(): number {
  return Math.max(2, Number(process.env.RECKON_LADDER_FLOOR || 4));
}

/** Map an attempt count to an escalation rung: 1→0, 2→1, 3→2, and the floor attempt →3. */
function rungFor(attempts: number): Rung {
  if (attempts >= floorAttempt()) return FLOOR_RUNG;
  return Math.min(attempts - 1, 2) as Rung;
}

export type Tier = 'earned' | 'assisted' | 'told' | '';

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
  prompt?: string; // retry prompt if !pass, or the TELL prompt at the floor
  feedback: string;
  scores: Record<string, number>;
  overlap: string;
  assisted: boolean;
  /** Honesty tier of a PASS: earned | assisted | told. Empty on a still-open retry. */
  tier: Tier;
  /** True when this pass cleared by TELL at the floor (marked, penalized). */
  told: boolean;
  /** The mechanism the floor handed over, when told. */
  reveal?: string;
  ungraded: boolean;
  next_recall_due?: string;
}

export class ComprehensionLoop {
  private open_: Map<string, OpenCheckpoint> = new Map();
  // The model backend is injected (grader + decompose call it). Core never spawns a
  // process or names a provider; the host wires a ClaudeCliBackend / OpenAiBackend here.
  constructor(private storage: Storage, private backend: LlmBackend) {}

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
  }): Promise<OpenResult> {
    const id = crypto.randomUUID();
    const rigor: RigorLevel = input.rigor === 'harsh' ? 'harsh' : 'medium'; // floor at medium

    if (input.stage === 'plan') {
      const d = await decompose(input.groundTruth, this.backend);
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

    const rung = rungFor(cp.attempts);
    const g = await grade({ groundTruth: cp.groundTruth, explanation, rigor: cp.rigor, assisted, escalation: rung, backend: this.backend });

    if (!g.pass) {
      // Genuine graded fail (fail-open returns pass=true, so it never lands here).
      if (cp.attempts >= floorAttempt()) {
        // FLOOR: stop asking, TELL, and clear the gate with a marked `told` pass. Access is
        // never blocked — only the honesty label changes (told never reads as earned).
        return this.tellAtFloor(cp, explanation, assisted, g.reveal, g.scores, g.overlap);
      }
      // Stay open — the human takes another pass at a sharper rung (source rescue allowed).
      return {
        pass: false,
        prompt: retryPrompt(g.hole, assisted),
        feedback: `not yet — one gap to close (nudge ${cp.attempts}/${floorAttempt() - 1})`,
        scores: g.scores,
        overlap: g.overlap,
        assisted,
        tier: '',
        told: false,
        ungraded: false,
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
      told: false,
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
      tier: g.ungraded ? '' : assisted ? 'assisted' : 'earned',
      told: false,
      ungraded: g.ungraded,
      next_recall_due: next_due,
    };
  }

  /**
   * The escalation floor for a single-decision checkpoint. Logs a marked `told` clear,
   * schedules the soonest cold recall, and hands the withheld mechanism to the human. This
   * is the one place the gate clears WITHOUT a real pass — the price is honesty (logged told)
   * plus resurfacing fast, never a wall.
   */
  private async tellAtFloor(
    cp: OpenCheckpoint,
    explanation: string,
    assisted: boolean,
    reveal: string,
    scores: Record<string, number>,
    overlap: string
  ): Promise<GradeResultOut> {
    const next_due = scheduleAfterGrade(true, assisted, /* told */ true);
    await this.storage.add({
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
      told: true,
      passed: true,
      ungraded: false,
      scores: JSON.stringify(scores),
      overlap,
      attempts: cp.attempts,
      next_recall_due: next_due,
      recall_count: 0,
    });
    this.open_.delete(cp.id);
    return {
      pass: true,
      prompt: tellPrompt(reveal),
      feedback: '● Cleared by TELL (marked) — handed the mechanism at the floor; logged told, resurfaces cold soon.',
      scores,
      overlap,
      assisted,
      tier: 'told',
      told: true,
      reveal,
      ungraded: false,
      next_recall_due: next_due,
    };
  }

  /** Grade a plan explanation covering the gated decisions; escalates and tells at the floor. */
  private async submitPlan(cp: OpenCheckpoint, explanation: string, assisted: boolean): Promise<GradeResultOut> {
    const rung = rungFor(cp.attempts);
    const g = await gradePlan({ groundTruth: cp.groundTruth, explanation, rigor: cp.rigor, decisions: cp.gated || [], escalation: rung, backend: this.backend });
    if (!g.pass) {
      if (cp.attempts >= floorAttempt()) {
        // FLOOR: tell the weakest decision's mechanism, clear with a marked `told`.
        return this.tellAtFloor(cp, explanation, assisted, g.reveal, {}, 'unknown');
      }
      return {
        pass: false,
        prompt: retryPrompt(g.hole, assisted),
        feedback: `not yet — ${g.missing.length} decision(s) still need real mechanism (nudge ${cp.attempts}/${floorAttempt() - 1})`,
        scores: {},
        overlap: 'unknown',
        assisted,
        tier: '',
        told: false,
        ungraded: false,
      };
    }
    // Retention recall stays (the Feynman moat): a passed plan comes back cold later.
    const next_due = g.ungraded ? undefined : scheduleAfterGrade(true, assisted);
    await this.storage.add({
      id: cp.id, timestamp: new Date().toISOString(), session_id: cp.sessionId,
      subsystem: cp.subsystem, concept: cp.concept, stage: 'plan', ground_truth: cp.groundTruth,
      explanation, rigor: cp.rigor, assisted, told: false, passed: true, ungraded: g.ungraded,
      scores: JSON.stringify({ covered: g.covered }), overlap: 'unknown', attempts: cp.attempts,
      next_recall_due: next_due, recall_count: 0,
    });
    this.open_.delete(cp.id);
    return {
      pass: true,
      feedback: g.ungraded
        ? '○ Plan logged ungraded (grader unavailable).'
        : `✓ Passed — explained all ${g.covered.length} sub-problem(s) of the plan. Filed for cold recall.`,
      scores: {}, overlap: 'unknown', assisted,
      tier: g.ungraded ? '' : assisted ? 'assisted' : 'earned', told: false,
      ungraded: g.ungraded, next_recall_due: next_due,
    };
  }

  /** Answer a cold recall. Grades against the stored ground truth; reschedules. */
  async recallAnswer(id: string, answer: string): Promise<GradeResultOut | null> {
    const rec = await this.storage.get(id);
    if (!rec) return null;

    // Recall is always at least as strict as the original; no source this time.
    const g = await grade({ groundTruth: rec.ground_truth, explanation: answer, rigor: rec.rigor as RigorLevel, assisted: false, backend: this.backend });
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
      tier: '',
      told: false,
      ungraded: g.ungraded,
      next_recall_due: next,
    };
  }

  /** The cold-recall prompt for a due item (metadata only — stays cold). */
  recallQuestion(rec: ExplanationRecord): string {
    return recallPrompt(rec.concept, rec.subsystem);
  }
}
