/**
 * JSON schemas passed to session.prompt({ format: { type: "json_schema", schema } }).
 * Making every agent decision machine-readable is what lets the workflow branch on
 * policy instead of parsing prose.
 */

export const triageSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["bug", "ticket", "epic", "question", "spam"] },
    shouldImplement: {
      type: "boolean",
      description: "True only if this is actionable now and the reporter allowed auto-work.",
    },
    labels: { type: "array", items: { type: "string" }, description: "Labels to apply." },
    duplicateOf: {
      type: ["number", "null"],
      description: "Issue number this duplicates, or null.",
    },
    clarifyingQuestions: {
      type: "array",
      items: { type: "string" },
      description: "If not actionable, what to ask. Empty if actionable.",
    },
    reasoning: { type: "string" },
  },
  required: ["kind", "shouldImplement", "labels", "reasoning"],
} as const;

/** Plan-phase checkpoint. The agent reads the issue + relevant code and either
 *  declares itself ready to implement, or raises questions BEFORE any file edits —
 *  so an eager question costs a cheap read, not a wasted implement+validate cycle. */
export const planSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ready", "needs_input"],
      description: "needs_input if anything material is ambiguous; ready otherwise.",
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "Specific, answerable questions for the human. Empty when ready.",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description:
        "Assumptions the agent would proceed on if forced (used when the round cap is hit).",
    },
    plan: {
      type: "array",
      items: { type: "string" },
      description: "Ordered implementation steps when ready.",
    },
    reasoning: { type: "string" },
  },
  required: ["status", "questions", "assumptions", "reasoning"],
} as const;

export const riskSchema = {
  type: "object",
  properties: {
    risk: { type: "string", enum: ["low", "medium", "high"] },
    autoMerge: {
      type: "boolean",
      description: "Agent's recommendation. Deterministic rules still override this.",
    },
    touchesAuth: { type: "boolean" },
    touchesMigrations: { type: "boolean" },
    touchesInfra: { type: "boolean" },
    summary: { type: "string", description: "One-paragraph review summary for the PR comment." },
    concerns: { type: "array", items: { type: "string" } },
  },
  required: ["risk", "autoMerge", "touchesAuth", "touchesMigrations", "touchesInfra", "summary"],
} as const;

export const decompositionSchema = {
  type: "object",
  properties: {
    subtasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string", description: "Full ticket body incl. acceptance criteria." },
          size: { type: "string", enum: ["S", "M", "L"] },
          dependsOn: {
            type: "array",
            items: { type: "number" },
            description: "Indices (0-based) of other subtasks in this array that must merge first.",
          },
        },
        required: ["title", "body", "size", "dependsOn"],
      },
    },
    reasoning: { type: "string" },
  },
  required: ["subtasks", "reasoning"],
} as const;
