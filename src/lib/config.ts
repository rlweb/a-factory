/**
 * Central config for the software factory.
 *
 * Values are sourced from environment variables that the workflows populate from
 * GitHub Actions **variables** (`vars.*`). Precedence is handled by GitHub itself:
 * a repo-level variable overrides an org-level one of the same name. When a variable
 * is unset at BOTH levels it expands to an empty string in the workflow, so every
 * reader here treats empty-string as "unset" and falls back to a baked default.
 *
 * This is the only module that reads process.env for config. Keep it that way — the
 * orchestrators import typed values from here, which is what makes them testable.
 */

/** Read an env var, treating undefined OR empty-string as "not set". */
function raw(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** Numeric env var with a default. Empty/unset/NaN all fall back to `def`. */
export function numEnv(name: string, def: number): number {
  const v = raw(name);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** String env var with a default. */
export function strEnv(name: string, def: string): string {
  return raw(name) ?? def;
}

/** Comma-separated list env var with a default. Trims blanks; empty → default. */
export function listEnv(name: string, def: readonly string[]): string[] {
  const v = raw(name);
  if (v === undefined) return [...def];
  const parts = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [...def];
}

// ── Baked defaults (the shared baseline; org/repo vars override via env) ──────────

const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_VALIDATION_ATTEMPTS = 3;
const DEFAULT_QUESTION_ROUNDS = 0;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_PROTECTED_PATHS = [
  ".github/**",
  "infra/**",
  "**/migrations/**",
  "**/*.tf",
  "src/auth/**",
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
] as const;

// ── Resolved config ──────────────────────────────────────────────────────────────

/** Baked fallback model — used only when the consumer repo's opencode.json sets none. */
export const MODEL = {
  providerID: "anthropic",
  modelID: DEFAULT_MODEL,
} as const;

/** How many times the orchestrator loops the agent to self-fix failing validation. */
export const VALIDATION_MAX_ATTEMPTS = numEnv(
  "FACTORY_VALIDATION_ATTEMPTS",
  DEFAULT_VALIDATION_ATTEMPTS,
);

/** Max eager-question rounds before proceeding on assumptions. 0 = uncapped. */
export const QUESTION_MAX_ROUNDS = numEnv("FACTORY_QUESTION_ROUNDS", DEFAULT_QUESTION_ROUNDS);

/** Marker appended to every factory-authored comment so resume never re-triggers on it. */
export const BOT_MARKER = "<!-- factory-bot -->";

/** author_association levels treated as trusted (resume immediately). Overridable. */
export const TRUSTED_ASSOCIATIONS = listEnv("FACTORY_TRUSTED_ASSOCIATIONS", [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** Deterministic risk-gate thresholds. The agent proposes; these dispose. */
export const GATE = {
  maxFilesChanged: numEnv("FACTORY_GATE_MAX_FILES", DEFAULT_MAX_FILES),
  /** Changed paths matching these globs force human review. Comma-separated var. */
  protectedPaths: listEnv("FACTORY_PROTECTED_PATHS", DEFAULT_PROTECTED_PATHS),
} as const;

/** Labels the factory reads and writes. Keep in sync with the issue forms. */
export const LABELS = {
  ready: "ready",
  ticket: "ticket",
  bug: "bug",
  triage: "triage",
  needsHuman: "needs-human",
  inProgress: "in-progress",
  autoMerged: "auto-merged",
  blocked: "blocked",
  awaitingAnswer: "awaiting-answer",
  answerApproved: "answer-approved",
} as const;

/** Server boot timeout — a hung session otherwise burns the whole job limit. */
export const SERVER_TIMEOUT_MS = numEnv("FACTORY_SERVER_TIMEOUT_MS", 15_000);

/** Per-LLM-API-call timeout injected into the OpenCode provider config. */
export const PROVIDER_TIMEOUT_MS = 20 * 60 * 1000;
