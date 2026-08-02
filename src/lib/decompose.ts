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

/**
 * Resolve the decomposition mode for one epic. Pure — the body and the repo-wide
 * default are both injected.
 *
 * Precedence is most-specific-first: the epic's own "Decomposition intent" dropdown
 * beats the repo's `FACTORY_DECOMPOSE_MODE` variable, which beats the baked "propose".
 * Anything unrecognised at either level falls through rather than guessing "auto",
 * since "auto" is the branch that opens issues and dispatches builds unattended.
 */
export function parseDecomposeMode(body: string, fallback: string = DECOMPOSE_MODE): DecomposeMode {
  const field = DECOMPOSE_FIELD.exec(body ?? "")?.[1];
  return normalise(field) ?? normalise(fallback) ?? "propose";
}
