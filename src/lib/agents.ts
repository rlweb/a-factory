import { readFileSync } from "node:fs";
import type { Config } from "@opencode-ai/sdk";
import { LABELS } from "./config.js";

type AgentMap = NonNullable<Config["agent"]>;

// agents/ sits next to src/ and dist/, so ../../agents/ resolves from both.
const AGENTS_DIR = new URL("../../agents/", import.meta.url);

/** Read a vendored skill prompt (agents/<name>.md), stripping YAML frontmatter. */
export function loadSkillPrompt(name: string): string {
  const raw = readFileSync(new URL(`${name}.md`, AGENTS_DIR), "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/**
 * Prepended to every vendored skill prompt. The skills were written for interactive
 * use; this reframes their ask-the-user / slash-command / commit instructions for an
 * unattended CI session, so we can vendor them verbatim without contradictions.
 */
export const HARNESS_PREAMBLE = `You run unattended inside a CI factory — there is no human in this session.
- When an instruction below says to ask, confirm, or show something to the user, proceed on your best judgment instead and record the assumption in your output.
- Slash-command references (/tdd, /code-review, /grilling, …) are skills that may not exist here. A "tdd" subagent IS available wherever /tdd is mentioned; skip other such steps.
- If a referenced file doesn't exist, skip it silently.
- Never run git commit or git push — the factory commits, pushes, validates, and reviews separately.
- The factory runs the full verification script (\`pnpm verify\` — format, lint, typecheck, tests) after you finish and feeds any failure back to you to fix, so never run it or the whole test suite yourself — it is slow and your shell commands time out. Verify in small, fast pieces: typecheck a file, run the single test file you touched.

`;

const skill = (name: string) => HARNESS_PREAMBLE + loadSkillPrompt(name);

/** Distilled from mattpocock/skills code-review: the two axes and the smell baseline,
 *  without the interactive process (fixed points, sub-agents, markdown reports). */
const REVIEWER_PROMPT = `You review a pull request diff for an automated factory. Your findings feed a conservative auto-merge risk verdict, so err toward flagging.

Evaluate along two axes, and keep them separate — one axis passing must not mask the other failing:

- **Spec** — the originating issue text is the spec. Flag requirements that are missing or partial, behaviour the issue didn't ask for (scope creep), and requirements that look implemented but wrong.
- **Standards** — does the change follow this repo's conventions (and any documented standards files)? On top of those, apply this smell baseline as judgement calls — a documented repo standard always overrides it, and skip anything tooling already enforces:
  Mysterious Name (name hides intent), Duplicated Code (same logic shape twice), Feature Envy (method lives off another object's data), Data Clumps (same fields always travel together), Primitive Obsession (primitive standing in for a domain concept), Repeated Switches (same if/switch cascade recurs), Shotgun Surgery (one change scattered across many files), Divergent Change (one module edited for unrelated reasons), Speculative Generality (abstraction for needs the spec doesn't have), Message Chains (long a.b().c() walks), Middle Man (pure delegation layer), Refused Bequest (implementer ignoring most of what it inherits).

Also weigh correctness and security directly: auth, data migrations, infrastructure, and public API surface are never low risk.`;

/** Purpose-written decomposition prompt (wayfinder's ideas, one-shot shape). */
const DECOMPOSER_PROMPT = `You decompose epics into child tickets for an automated factory that implements one ticket per agent session.

- Each ticket must be independently shippable and small enough to implement and validate in a single session.
- Each ticket body must contain concrete acceptance criteria a machine or reviewer can check.
- Add dependency edges only for genuine ordering constraints — prefer parallel work; never create a chain for convenience.
- Name explicitly what is OUT of scope for this epic in your reasoning, so later readers know it was considered, not missed.`;

/**
 * The factory's baked agent roster. builder/tdd/bugfixer prompts are vendored from
 * mattpocock/skills (MIT — see agents/LICENSE) behind the harness preamble;
 * read-only phases are enforced with permission denies rather than prose.
 */
export const AGENTS: AgentMap = {
  builder: {
    description: "Implements a ticket end to end.",
    prompt: skill("implement"),
  },
  tdd: {
    description: "Red-green-refactor loop; delegated to by builder at agreed seams.",
    mode: "subagent",
    prompt: skill("tdd"),
  },
  bugfixer: {
    description: "Diagnoses a bug before fixing it; minimal diff plus regression test.",
    prompt: skill("diagnosing-bugs"),
  },
  reviewer: {
    description: "Reviews diffs for correctness and risk. Cannot edit.",
    prompt: REVIEWER_PROMPT,
    permission: { edit: "deny" },
  },
  decomposer: {
    description: "Decomposes epics into shippable child tickets. Cannot edit.",
    prompt: DECOMPOSER_PROMPT,
    permission: { edit: "deny" },
  },
  planner: {
    description: "Read-only planning checkpoint before implementation.",
    prompt:
      "You are the planning checkpoint before an unattended agent implements a GitHub issue. Read the issue and the relevant code first. Decide whether you have everything you need; raise questions eagerly — if anything material is ambiguous, ask rather than assume. You cannot edit files or run commands.",
    permission: { edit: "deny", bash: "deny" },
  },
  triager: {
    description: "Classifies incoming issues. Read-only.",
    prompt:
      'You triage GitHub issues for an automated implementation factory. Classify each issue, decide whether it is actionable for automated work right now, and choose labels. If it references the same defect as an existing issue, set duplicateOf. If it is not actionable, list clarifying questions instead. Only recommend implementation when the reporter opted into auto-work (the issue body\'s "Automation intent" field) AND the request is concrete enough to act on. Be conservative.',
    permission: { edit: "deny", bash: "deny" },
  },
};

/**
 * Baked agents minus any name the consumer repo's opencode.json already defines.
 * OpenCode loads the repo config natively; our injected config is an override, so
 * omitting a name here is what lets the repo's definition win.
 */
export function mergeAgents(repoAgents: AgentMap | undefined): AgentMap {
  const merged: AgentMap = { ...AGENTS };
  for (const name of Object.keys(repoAgents ?? {})) delete merged[name];
  return merged;
}

/** Which agent implements an issue, from its labels. */
export function implementAgentFor(labels: string[]): "bugfixer" | "builder" {
  return labels.includes(LABELS.bug) ? "bugfixer" : "builder";
}
