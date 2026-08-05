import { defineTool, type AgentToolUpdateCallback, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const QuestionsParams = Type.Object({
  questions: Type.Array(Type.String(), {
    description: "Questions to ask the user",
  }),
});

export type QuestionsInput = Static<typeof QuestionsParams>;

export interface AskContext {
  owner: string;
  repo: string;
  issueNumber: number;
}

let pendingResolve: ((answer: string) => void) | null = null;
let pendingQuestions: string[] = [];

export function getPendingQuestions(): string[] {
  return pendingQuestions;
}

export function answerQuestion(answer: string): void {
  if (pendingResolve) {
    const r = pendingResolve;
    pendingResolve = null;
    pendingQuestions = [];
    r(answer);
  }
}

export function cleanupBlock(): void {
  if (pendingResolve) {
    pendingResolve("No response received — continue without answers.");
    pendingResolve = null;
    pendingQuestions = [];
  }
}

function createAskQuestionsTool(ctx: AskContext) {
  return defineTool({
    name: "ask_questions",
    label: "Ask Questions",
    description:
      "Ask clarifying questions when blocked. Posts to the GitHub issue, blocks until answered.",
    parameters: QuestionsParams,
    executionMode: "sequential" as const,

    async execute(
      _toolCallId: string,
      params: QuestionsInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
      _ctx: ExtensionContext,
    ) {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!token) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: GITHUB_TOKEN not available — cannot post comment.",
            },
          ],
          details: { questions: params.questions, answer: null, error: "missing token" },
        };
      }

      const body = [
        "### Questions",
        "",
        "I need clarification on the following:",
        "",
        ...params.questions.map((q: string) => `- ${q}`),
        "",
        "Reply on this issue — I'll pick up automatically once someone responds.",
      ].join("\n");

      let commentUrl = "";
      try {
        const res = await fetch(
          `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}/comments`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ body }),
          },
        );
        const data = (await res.json()) as { html_url?: string };
        commentUrl = data.html_url ?? "(unknown)";
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error posting comment: ${String(e)}`,
            },
          ],
          details: { questions: params.questions, answer: null, error: String(e) },
        };
      }

      pendingQuestions = params.questions;

      const answer = await new Promise<string>((resolve) => {
        pendingResolve = resolve;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Posted: ${commentUrl}\n\nUser answer: ${answer}`,
          },
        ],
        details: {
          questions: params.questions,
          answer,
          commentUrl,
        },
      };
    },
  });
}

export { createAskQuestionsTool };
