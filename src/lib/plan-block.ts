/**
 * Round-tripping an epic decomposition through a GitHub comment.
 *
 * Propose mode posts a human-readable breakdown and waits for an `approve` reply. For
 * that approval to mean anything, the tickets created afterwards must be the ones that
 * were reviewed — re-prompting the decomposer produces a different split (observed:
 * 4 subtasks on one run, 3 on the next). So the plan travels in the comment itself,
 * inside an HTML comment, and approval replays it without a model call.
 *
 * The payload is base64 rather than raw JSON on purpose: a subtask body containing the
 * sequence `-->` would otherwise close the HTML comment early and corrupt both the block
 * and the rendered comment.
 */

export interface Subtask {
  title: string;
  body: string;
  size: "S" | "M" | "L";
  dependsOn: number[];
}

export interface Decomposition {
  subtasks: Subtask[];
  reasoning: string;
}

/** Bump if the encoded shape changes; old blocks then simply fail to decode. */
export const PLAN_BLOCK_VERSION = "v1";

/** GitHub rejects issue comments longer than this. */
export const MAX_COMMENT_CHARS = 65536;

const BLOCK_RE = /<!--\s*factory-plan:v1\s+([A-Za-z0-9+/=]+)\s*-->/g;

export function encodePlanBlock(plan: Decomposition): string {
  const payload = Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
  return `<!-- factory-plan:${PLAN_BLOCK_VERSION} ${payload} -->`;
}

function isDecomposition(v: unknown): v is Decomposition {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.reasoning !== "string" || !Array.isArray(o.subtasks)) return false;
  return o.subtasks.every((s) => {
    if (typeof s !== "object" || s === null) return false;
    const t = s as Record<string, unknown>;
    return (
      typeof t.title === "string" &&
      typeof t.body === "string" &&
      (t.size === "S" || t.size === "M" || t.size === "L") &&
      Array.isArray(t.dependsOn) &&
      t.dependsOn.every((d) => typeof d === "number")
    );
  });
}

/**
 * A well-formed block that deliberately fails to decode. Written when the real plan
 * won't fit, so that it still supersedes any earlier block — see decodePlanBlock.
 */
export function unavailablePlanBlock(): string {
  const payload = Buffer.from(JSON.stringify({ unavailable: true }), "utf8").toString("base64");
  return `<!-- factory-plan:${PLAN_BLOCK_VERSION} ${payload} -->`;
}

/**
 * Recover the plan from text that may contain several blocks — pass the thread joined
 * oldest-first.
 *
 * ONLY the newest block counts, and a newest block that fails to decode yields null
 * rather than falling back to an older one. That's the whole point: falling back would
 * silently create tickets from a breakdown that has since been revised or superseded,
 * which is far worse than re-decomposing. Null means "ask the model again".
 */
export function decodePlanBlock(text: string): Decomposition | null {
  const matches = [...(text ?? "").matchAll(BLOCK_RE)];
  const newest = matches.at(-1);
  if (!newest) return null;
  try {
    const parsed = JSON.parse(Buffer.from(newest[1], "base64").toString("utf8"));
    return isDecomposition(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Append the plan to a comment body. If embedding would breach GitHub's comment limit,
 * append the unavailable sentinel instead — `persisted: false` then means approval will
 * re-decompose, which is worse than replaying but still beats either failing to post the
 * breakdown or leaving a stale earlier block as the newest one.
 */
export function withPlanBlock(
  body: string,
  plan: Decomposition,
  limit: number = MAX_COMMENT_CHARS,
): { text: string; persisted: boolean } {
  const text = `${body}\n\n${encodePlanBlock(plan)}`;
  if (text.length <= limit) return { text, persisted: true };
  return { text: `${body}\n\n${unavailablePlanBlock()}`, persisted: false };
}
