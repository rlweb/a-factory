/**
 * Public library surface. Consumers who want to embed the factory (rather than
 * run the CLI) can import the pure logic and helpers from here.
 *
 * The orchestrator run() functions are intentionally NOT re-exported as the primary
 * API — they read process.env and perform I/O. Import them from their own modules if
 * you need them; the stable, testable surface is the pure logic below.
 */

export { run as runEpic } from "./epic.js";
export { run as runImplement } from "./implement.js";
export { AGENTS, implementAgentFor, loadSkillPrompt, mergeAgents } from "./lib/agents.js";
export {
  BOT_MARKER,
  GATE,
  LABELS,
  listEnv,
  MODEL,
  numEnv,
  QUESTION_MAX_ROUNDS,
  SERVER_TIMEOUT_MS,
  strEnv,
  TRUSTED_ASSOCIATIONS,
  VALIDATION_MAX_ATTEMPTS,
} from "./lib/config.js";
export { type GateConfig, type GateDecision, gate, type Risk } from "./lib/gate.js";
export { decompositionSchema, planSchema, riskSchema, triageSchema } from "./lib/schemas.js";
export {
  type AnswerContext,
  decideResume,
  questionCapReached,
  type ResumeAction,
} from "./lib/trust.js";
export { runValidation, type ValidationResult } from "./lib/validate.js";
export { run as runResume } from "./resume.js";
export { run as runReview } from "./review.js";
// Orchestrator entrypoints, for programmatic invocation if desired.
export { run as runTriage } from "./triage.js";
