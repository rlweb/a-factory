import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { opencodeExtension } from "./opencode-provider.js";
import {
  createAskQuestionsTool,
  answerQuestion,
  getPendingQuestions,
  cleanupBlock,
  type AskContext,
} from "./tools/ask-questions.js";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_VERIFY = "pnpm run verify";

const SYSTEM_PROMPT = `You are a coding agent implementing GitHub issues. You operate in a repo
checked out at ./repo/.

Workflow:
1. Read the issue and understand what's needed
2. Explore the codebase to follow existing conventions
3. Implement the changes — edit files directly, don't just describe what to do
4. Run the verify command to validate
5. Push the branch if all checks pass
6. Report DONE

If you're genuinely blocked and can't proceed without clarification, call the ask_questions
tool. Use it sparingly — only when you cannot make progress without answers.`;

export interface PlanPayload {
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface Outcome {
  status: "done" | "question" | "failed";
  branch?: string;
  questions?: string[];
  prUrl?: string;
  verify?: string;
  messages?: Array<{ role: string; content: string }>;
}

export type HarnessState = "idle" | "running" | "question" | "done" | "failed";

export class PiHarness {
  private session: AgentSession | null = null;
  private modelRuntime: ModelRuntime | null = null;
  public state: HarnessState = "idle";
  private workingDir: string;
  private repoDir: string;
  private payload: PlanPayload | null = null;
  private sessionMessages: Array<{ role: string; content: string }> = [];
  private runPromise: Promise<Outcome> | null = null;
  private runResolve: ((o: Outcome) => void) | null = null;
  private subscribed = false;

  constructor(workingDir?: string) {
    this.workingDir = workingDir ?? mkdtempSync(join(tmpdir(), "pi-harness-"));
    this.repoDir = join(this.workingDir, "repo");
  }

  async init(): Promise<void> {
    const modelRuntime = await ModelRuntime.create();
    this.modelRuntime = modelRuntime;

    const loader = new DefaultResourceLoader({
      cwd: this.workingDir,
      agentDir: getAgentDir(),
      extensionFactories: [opencodeExtension],
      systemPromptOverride: () => SYSTEM_PROMPT,
    });
    await loader.reload();

    const model = this.modelRuntime.getModel("oc-sdk-go", DEFAULT_MODEL);
    if (!model) throw new Error(`Model "oc-sdk-go/${DEFAULT_MODEL}" not found`);

    const askCtx: AskContext = {
      owner: this.payload?.owner ?? "",
      repo: this.payload?.repo ?? "",
      issueNumber: this.payload?.issueNumber ?? 0,
    };
    const askTool = createAskQuestionsTool(askCtx);

    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });

    const { session } = await createAgentSession({
      model,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      cwd: this.workingDir,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_questions"],
      customTools: [askTool],
      sessionManager: SessionManager.inMemory(this.workingDir),
      settingsManager: settings,
    });

    this.session = session;
  }

  async run(payload: PlanPayload): Promise<Outcome> {
    if (this.state !== "idle") {
      throw new Error(`Cannot run: state is ${this.state}`);
    }

    this.payload = payload;

    await this.init();
    await this.cloneRepo(payload);

    this.state = "running";
    this.subscribeToEvents();

    const issue = await this.fetchIssue(payload);
    const branch = `factory/issue-${payload.issueNumber}`;

    const prompt = `${
      issue.title
        ? `Implement this GitHub issue:\n\n### Issue #${payload.issueNumber}: ${issue.title}\n\n${issue.body ?? ""}`
        : issue.body ?? "Implement the changes described in the issue."
    }

Steps:
1. Checkout branch "${branch}" if not already on it
2. Implement the issue following the repo's existing conventions
3. Run the verify command: ${process.env.VERIFY_COMMAND ?? DEFAULT_VERIFY}
4. If it passes: git push the branch
5. Report DONE with a suggested PR title and summary

Call ask_questions only if genuinely blocked.`;

    this.session!.prompt(prompt).catch((e) => {
      console.error("prompt error:", e instanceof Error ? e.message : String(e));
      if (this.state === "running") {
        this.finish();
      }
    });

    this.runPromise = new Promise<Outcome>((resolve) => {
      this.runResolve = resolve;
    });

    return this.runPromise;
  }

  async answer(): Promise<Outcome> {
    if (this.state !== "question") {
      throw new Error(`Cannot answer: state is ${this.state}`);
    }

    const issue = await this.fetchIssue(this.payload!);
    const answer = issue.lastCommentBody ?? "No comment found — continue.";

    answerQuestion(answer);
    this.state = "running";

    this.runPromise = new Promise<Outcome>((resolve) => {
      this.runResolve = resolve;
    });

    return this.runPromise;
  }

  getStatus(): {
    state: HarnessState;
    messages: Array<{ role: string; content: string }>;
    questions: string[];
  } {
    return {
      state: this.state,
      messages: [...this.sessionMessages],
      questions: this.state === "question" ? [...getPendingQuestions()] : [],
    };
  }

  async dispose(): Promise<void> {
    // Don't leave a hanging tool if the server is shutting down
    if (this.state === "question") {
      cleanupBlock();
    }
    this.session?.dispose();
  }

  private subscribeToEvents(): void {
    if (this.subscribed || !this.session) return;
    this.subscribed = true;

    this.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const last = this.sessionMessages.at(-1);
        if (last && last.role === "assistant") {
          last.content += event.assistantMessageEvent.delta;
        } else {
          this.sessionMessages.push({
            role: "assistant",
            content: event.assistantMessageEvent.delta,
          });
        }
      }

      if (event.type === "tool_execution_start" && event.toolName === "ask_questions") {
        this.state = "question";
        if (this.runResolve) {
          const r = this.runResolve;
          this.runResolve = null;
          r({
            status: "question",
            questions: getPendingQuestions(),
            branch: this.branchName(),
            messages: [...this.sessionMessages],
          });
        }
      }

      if (event.type === "agent_settled") {
        if (this.state === "running" && this.runResolve) {
          this.finish();
        }
      }
    });
  }

  private async finish(): Promise<void> {
    const p = this.payload!;
    const branch = this.branchName();
    const verifyCmd = process.env.VERIFY_COMMAND ?? DEFAULT_VERIFY;

    let verify = "";
    let verifyPassed = false;

    try {
      verify = execSync(verifyCmd, {
        cwd: this.repoDir,
        stdio: "pipe",
        encoding: "utf8",
        timeout: 120_000,
      });
      verifyPassed = true;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      verify = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");

      const combined = verify.toLowerCase();
      verifyPassed = !combined.includes("fail") && !combined.includes("error");
    }

    let prUrl: string | undefined;

    if (verifyPassed) {
      try {
        const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        const defaultBranch = this.getDefaultBranch(p);
        const title = `factory: issue #${p.issueNumber}`;
        const res = await fetch(
          `https://api.github.com/repos/${p.owner}/${p.repo}/pulls`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title,
              head: branch,
              base: defaultBranch,
              body: `Closes #${p.issueNumber}`,
            }),
          },
        );
        const pr = (await res.json()) as { html_url?: string };
        prUrl = pr.html_url;
      } catch {
        // best-effort
      }
    }

    const status = verifyPassed ? "done" as const : "failed" as const;
    this.state = status;

    if (this.runResolve) {
      const r = this.runResolve;
      this.runResolve = null;
      r({ status, branch, prUrl, verify, messages: [...this.sessionMessages] });
    }
  }

  private getDefaultBranch(payload: PlanPayload): string {
    try {
      const out = execSync(
        `git -C "${this.repoDir}" rev-parse --abbrev-ref HEAD`,
        { encoding: "utf8" },
      ).trim();
      return out || "main";
    } catch {
      return "main";
    }
  }

  private async cloneRepo(payload: PlanPayload): Promise<void> {
    const repoUrl = `https://github.com/${payload.owner}/${payload.repo}.git`;
    if (!existsSync(this.repoDir)) {
      mkdirSync(this.repoDir, { recursive: true });
    }
    this.sessionMessages.push({
      role: "system",
      content: `Cloning ${repoUrl} into ${this.repoDir}`,
    });
    execSync(`git clone --depth 1 "${repoUrl}" "${this.repoDir}"`, {
      stdio: "pipe",
      encoding: "utf8",
    });
  }

  private async fetchIssue(payload: PlanPayload): Promise<{
    title: string;
    body: string | null;
    lastCommentBody: string | null;
  }> {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "pi-harness",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const issueUrl = `https://api.github.com/repos/${payload.owner}/${payload.repo}/issues/${payload.issueNumber}`;
    const issueRes = await fetch(issueUrl, { headers });
    const issueData = (await issueRes.json()) as { title?: string; body?: string };
    const title = issueData.title ?? "";
    const body = issueData.body ?? null;

    let lastCommentBody: string | null = null;
    try {
      const commentsUrl = `https://api.github.com/repos/${payload.owner}/${payload.repo}/issues/${payload.issueNumber}/comments?per_page=100`;
      const commentsRes = await fetch(commentsUrl, { headers });
      const comments = (await commentsRes.json()) as Array<{
        user?: { login?: string };
        body?: string;
      }>;
      for (let i = comments.length - 1; i >= 0; i--) {
        const c = comments[i];
        if (c.user?.login !== "github-actions[bot]") {
          lastCommentBody = c.body ?? null;
          break;
        }
      }
    } catch {
      // best-effort
    }

    return { title, body, lastCommentBody };
  }

  private branchName(): string {
    return `factory/issue-${this.payload?.issueNumber ?? 0}`;
  }
}
