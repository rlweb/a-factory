import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { registerOpencodeProvider } from "./opencode-provider.js";
import {
  createAskQuestionsTool,
  answerQuestion,
  getPendingQuestions,
  getLastPostedCommentId,
  cleanupBlock,
  type AskContext,
} from "./tools/ask-questions.js";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_VERIFY = "pnpm run verify";

function ghHeaders(token: string | undefined): Record<string, string> {
  return {
    Authorization: `Bearer ${token ?? ""}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "pi-harness",
  };
}

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
  private taskStarted = false;

  constructor(workingDir?: string) {
    this.workingDir = workingDir ?? mkdtempSync(join(tmpdir(), "pi-harness-"));
    this.repoDir = join(this.workingDir, "repo");
  }

  /** True while a task is being worked (including the init/clone window where state is
   *  still "idle"). A second POST / while active is an idempotent no-op, not a restart. */
  isActive(): boolean {
    return this.taskStarted || this.state === "running" || this.state === "question";
  }

  private log(msg: string): void {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  async init(): Promise<void> {
    const modelRuntime = await ModelRuntime.create();
    this.modelRuntime = modelRuntime;

    registerOpencodeProvider(this.modelRuntime);

    const loader = new DefaultResourceLoader({
      cwd: this.workingDir,
      agentDir: getAgentDir(),
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
    if (this.taskStarted) {
      throw new Error("task already started");
    }
    if (this.state === "done" || this.state === "failed") {
      throw new Error(`task already finished: ${this.state}`);
    }
    this.taskStarted = true;
    this.payload = payload;

    try {
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

      // Assign the resolver BEFORE launching the agent so a fast settle can never find it
      // null and leave the run promise hanging.
      this.runPromise = new Promise<Outcome>((resolve) => {
        this.runResolve = resolve;
      });
      this.startTimeout();

      this.session!.prompt(prompt).catch((e) => {
        console.error("prompt error:", e instanceof Error ? e.message : String(e));
        if (this.state === "running") {
          void this.finish();
        }
      });

      return this.runPromise;
    } catch (e) {
      this.taskStarted = false;
      throw e;
    }
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

  /** Arms a watchdog that fails the task if the agent stays busy past TASK_TIMEOUT_MS.
   *  Does not apply while awaiting a human answer (state "question") — that wait is
   *  legitimately unbounded. */
  private startTimeout(): void {
    const timeoutMs = parseInt(process.env.TASK_TIMEOUT_MS ?? "", 10);
    if (!timeoutMs || timeoutMs <= 0) return;

    setTimeout(() => {
      if (this.state !== "running") return;
      this.log(`task timed out after ${timeoutMs}ms`);
      if (this.payload) {
        void this.postComment(
          this.payload,
          `### Timed out\n\nThe task exceeded the ${timeoutMs}ms timeout.`,
        );
        void this.removeLabel(this.payload);
      }
      this.state = "failed";
      if (this.runResolve) {
        const r = this.runResolve;
        this.runResolve = null;
        r({
          status: "failed",
          branch: this.branchName(),
          verify: `timed out after ${timeoutMs}ms`,
          messages: [...this.sessionMessages],
        });
      }
    }, timeoutMs).unref();
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
      if (event.type === "agent_start") {
        this.log("agent started");
      }

      if (event.type === "turn_end") {
        this.log("turn ended");
      }

      if (event.type === "tool_execution_start") {
        const args = event.args
          ? JSON.stringify(event.args).slice(0, 300)
          : "";
        this.log(`tool ${event.toolName}${args ? ` ${args}` : ""}`);
      }

      if (event.type === "tool_execution_end") {
        this.log(`tool ${event.toolName} done${event.isError ? " (ERROR)" : ""}`);
      }

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
          void this.finish();
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
      const [file, ...args] = verifyCmd.split(/\s+/).filter(Boolean);
      const { stdout } = await execFileAsync(file, args, {
        cwd: this.repoDir,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      verify = stdout;
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
        const defaultBranch = await this.getDefaultBranch(p);
        const title = `factory: issue #${p.issueNumber}`;
        const res = await fetch(
          `https://api.github.com/repos/${p.owner}/${p.repo}/pulls`,
          {
            method: "POST",
            headers: ghHeaders(token),
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
    } else {
      await this.postComment(
        p,
        [
          "### Verification failed",
          "",
          "The harness ran the verify command and it did not pass:",
          "",
          "```",
          verify || "(no output)",
          "```",
          "",
          `Branch: \`${branch}\``,
        ].join("\n"),
      );
    }

    // No longer awaiting an answer — this is terminal (done or failed).
    await this.removeLabel(p);

    const status = verifyPassed ? "done" as const : "failed" as const;
    this.state = status;

    if (this.runResolve) {
      const r = this.runResolve;
      this.runResolve = null;
      r({ status, branch, prUrl, verify, messages: [...this.sessionMessages] });
    }
  }

  private async postComment(payload: PlanPayload, body: string): Promise<void> {
    try {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      await fetch(
        `https://api.github.com/repos/${payload.owner}/${payload.repo}/issues/${payload.issueNumber}/comments`,
        {
          method: "POST",
          headers: ghHeaders(token),
          body: JSON.stringify({ body }),
        },
      );
    } catch {
      // best-effort
    }
  }

  private async removeLabel(payload: PlanPayload): Promise<void> {
    try {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      await fetch(
        `https://api.github.com/repos/${payload.owner}/${payload.repo}/issues/${payload.issueNumber}/labels/awaiting-answer`,
        { method: "DELETE", headers: ghHeaders(token) },
      );
    } catch {
      // best-effort (label may not exist)
    }
  }

  private async getDefaultBranch(payload: PlanPayload): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.repoDir, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: 10_000 },
      );
      return stdout.trim() || "main";
    } catch {
      return "main";
    }
  }

  private async cloneRepo(payload: PlanPayload): Promise<void> {
    const repoUrl = `https://github.com/${payload.owner}/${payload.repo}.git`;
    if (!existsSync(this.repoDir)) {
      mkdirSync(this.repoDir, { recursive: true });
    }
    this.log(`cloning ${repoUrl}`);
    this.sessionMessages.push({
      role: "system",
      content: `Cloning ${repoUrl} into ${this.repoDir}`,
    });
    await execFileAsync("git", ["clone", "--depth", "1", repoUrl, this.repoDir], {
      timeout: 180_000,
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
        id?: number;
        user?: { login?: string };
        body?: string;
      }>;
      // Skip the harness's own question comments (tracked by id) and any bot noise, so a
      // resume never mistakes the harness's own questions for a human answer.
      const sinceId = getLastPostedCommentId();
      for (let i = comments.length - 1; i >= 0; i--) {
        const c = comments[i];
        if (c.user?.login === "github-actions[bot]") continue;
        if (sinceId !== null && (c.id ?? 0) <= sinceId) continue;
        lastCommentBody = c.body ?? null;
        break;
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
