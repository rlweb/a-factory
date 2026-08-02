import { QUESTION_MAX_ROUNDS, TRUSTED_ASSOCIATIONS } from "./config.js";

export type ResumeAction = "resume" | "hold" | "ignore";

export interface AnswerContext {
  /** GitHub user type of the commenter. */
  authorType: "User" | "Bot" | string;
  /** author_association: OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE | ... */
  association: string;
  /** True if the comment body carried the factory's bot marker. */
  isMarkedBot: boolean;
  /** True if a maintainer has 👍'd the answer or the answer-approved label is present. */
  maintainerApproved: boolean;
}

/**
 * Decide what a comment on an awaiting-answer issue should do. Pure — all the
 * I/O (fetching reactions, labels, posting) happens in resume.ts around this.
 *
 *   - bot / self-marked comments      → ignore (never re-trigger on our own questions)
 *   - trusted collaborator            → resume immediately
 *   - untrusted human + approval       → resume
 *   - untrusted human, no approval     → hold (accept the answer, wait for maintainer 👍)
 */
export function decideResume(ctx: AnswerContext): ResumeAction {
  if (ctx.authorType === "Bot" || ctx.isMarkedBot) return "ignore";

  const trusted = TRUSTED_ASSOCIATIONS.includes(ctx.association.toUpperCase());
  if (trusted) return "resume";

  return ctx.maintainerApproved ? "resume" : "hold";
}

/**
 * Whether the agent must stop asking and proceed on assumptions.
 * roundsSoFar counts question rounds already spent. cap of 0 means uncapped.
 */
export function questionCapReached(
  roundsSoFar: number,
  cap: number = QUESTION_MAX_ROUNDS,
): boolean {
  return cap > 0 && roundsSoFar >= cap;
}
