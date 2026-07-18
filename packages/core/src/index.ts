/**
 * @reckon/core — the client-agnostic comprehension-loop brain.
 *
 * Zero coupling to any model runtime: all model calls go through the injected
 * `LlmBackend` port, and storage goes through the `Storage` port. A host (reckon-mcp,
 * or a future reckon-pr GitHub App) wires concrete backends against these interfaces.
 */
export { ComprehensionLoop } from './loop.js';
export type { OpenResult, GradeResultOut } from './loop.js';

export { grade, gradePlan } from './grader.js';
export type { GradeInput, GradeResult, PlanGradeResult } from './grader.js';

export { decompose } from './decompose.js';
export type { Decision, Decomposition } from './decompose.js';

export {
  DIMENSIONS,
  graderSystemPrompt,
  planGraderSystemPrompt,
  gatePasses,
} from './rubric.js';
export type { RigorLevel, Dimension } from './rubric.js';

export { elicitPrompt, planElicitPrompt, retryPrompt, recallPrompt } from './elicit.js';
export type { ElicitInput } from './elicit.js';

export { scheduleAfterGrade, scheduleAfterRecall } from './storage.js';
export type { Storage, ExplanationRecord, Stage, RecallOutcome } from './storage.js';

export type { LlmBackend } from './llm.js';
