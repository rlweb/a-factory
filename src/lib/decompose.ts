import { DECOMPOSE_MODE } from "./config.js";

/** "propose" posts the breakdown for review; "auto" creates the child tickets. */
export type DecomposeMode = "propose" | "auto";

/**
 * GitHub renders an issue form's dropdown as an `### <label>` heading, a blank line, then
 * the chosen option on its own line. `\s*` skips the blank line(s); the `(?!#)` guard stops
 * an empty field from swallowing the *next* section's heading as its value.
 */
const DECOMPOSE_FIELD = /^###[ \t]+Decomposition intent[ \t]*\r?\n\s*(?!#)(.*)/im;

/** GitHub's placeholder for a dropdown the reporter left blank. */
const NO_RESPONSE = "_no response_";

/** Anything that isn't recognisably "auto" is treated as propose — the safe direction. */
function normalise(value: string | undefined): DecomposeMode | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === NO_RESPONSE) return undefined;
  if (v.includes("auto")) return "auto";
  if (v.includes("propose")) return "propose";
  return undefined;
}

export interface DecomposeModeSources {
  /** Mode carried on the repository_dispatch payload — set when a human approved. */
  dispatched?: string;
  /** Repo-wide `FACTORY_DECOMPOSE_MODE` variable. */
  repoDefault?: string;
}

/**
 * Resolve the decomposition mode for one epic. Pure — every input is injected.
 *
 * Precedence is most-specific-first:
 *   1. the mode on the dispatch payload — an explicit "approve" comment, which must
 *      outrank a dropdown the reporter set before seeing the breakdown
 *   2. the epic's own "Decomposition intent" dropdown
 *   3. the repo's `FACTORY_DECOMPOSE_MODE` variable
 *   4. the baked "propose"
 *
 * Anything unrecognised at any level falls through rather than guessing "auto", since
 * "auto" is the branch that opens issues and dispatches builds unattended.
 */
export function parseDecomposeMode(
  body: string,
  sources: DecomposeModeSources = {},
): DecomposeMode {
  const { dispatched, repoDefault = DECOMPOSE_MODE } = sources;
  const field = DECOMPOSE_FIELD.exec(body ?? "")?.[1];
  return normalise(dispatched) ?? normalise(field) ?? normalise(repoDefault) ?? "propose";
}
