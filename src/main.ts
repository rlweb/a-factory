import * as core from "@actions/core";
import * as github from "@actions/github";
import * as exe from "./exe.js";
import {
  addLabel,
  hasLabel,
  isBotComment,
  LABEL_AWAITING_ANSWER,
  latestMarker,
  octokit,
  openPullRequest,
  owner,
  removeLabel,
  repo,
  botComment,
} from "./github.js";
import { connect, createSession, promptJSON } from "./opencode.js";

interface Outcome {
  status: "done" | "question";
  branch?: string;
  questions?: string[];
  prTitle?: string;
  prSummary?: string;
}

const outcomeSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "question"] },
    branch: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    prTitle: { type: "string" },
    prSummary: { type: "string" },
  },
  required: ["status"],
};

export function implementPrompt(issueNumber: number, title: string, body: string): string {
  const branch = `factory/issue-${issueNumber}`;
  return `You are implementing a GitHub issue end to end, working directly in this VM.

--- ISSUE #${issueNumber}: ${title} ---
${body}

Steps:
1. Clone https://github.int.exe.xyz/${owner}/${repo}.git — GitHub access comes from
   exe.dev's GitHub integration attached to this VM.
2. Create and check out branch "${branch}".
3. Implement the issue, following the repo's existing conventions.
4. Commit and push the branch.
5. If you're blocked and need something clarified before you can proceed, don't push a
   partial branch — just report status "question" with what you need to know.

When finished (or blocked), report status "done" (with a suggested PR title/summary) or
"question" (with your questions).`;
}

export function continuePrompt(reply: string): string {
  return `The user replied on the issue:

${reply}

Continue the work. When finished (or blocked again), report status "done" (with a suggested
PR title/summary) or "question" (with your questions).`;
}

/** Polls until the VM's opencode server answers, or throws after the budget is spent. */
export async function waitForServer(baseUrl: string, timeoutMs = 180_000, intervalMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(baseUrl);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`opencode server at ${baseUrl} never came up`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export async function handleOutcome(issueNumber: number, vm: string, sessionId: string, outcome: Outcome): Promise<void> {
  if (outcome.status === "question") {
    const body = [
      "### Questions",
      "",
      "Reply on this issue to answer — I'll pick up automatically once someone responds.",
      "",
      ...(outcome.questions ?? []).map((q) => `- ${q}`),
    ].join("\n");
    await botComment(issueNumber, body, { vm, sessionId });
    await addLabel(issueNumber, LABEL_AWAITING_ANSWER);
    core.info(`issue #${issueNumber}: awaiting human answer, VM ${vm} left running`);
    return;
  }

  const branch = outcome.branch ?? `factory/issue-${issueNumber}`;
  const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
  const pr = await openPullRequest(
    branch,
    repoInfo.default_branch,
    outcome.prTitle ?? `factory: issue #${issueNumber}`,
    `${outcome.prSummary ?? ""}\n\nCloses #${issueNumber}`,
  );
  await removeLabel(issueNumber, LABEL_AWAITING_ANSWER);
  core.info(`issue #${issueNumber}: opened PR #${pr.number}`);
  exe.destroyVm(vm);
}

export async function onOpen(issueNumber: number): Promise<void> {
  const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const vm = exe.vmName(issueNumber);

  exe.createVm(vm);
  const url = exe.vmUrl(vm);
  await waitForServer(url);

  const client = connect(url);
  const sessionId = await createSession(client, `issue #${issueNumber}`);
  const outcome = await promptJSON<Outcome>(
    client,
    sessionId,
    implementPrompt(issueNumber, issue.title, issue.body ?? ""),
    outcomeSchema,
  );
  await handleOutcome(issueNumber, vm, sessionId, outcome);
}

export async function onComment(issueNumber: number, commentBody: string): Promise<void> {
  if (!(await hasLabel(issueNumber, LABEL_AWAITING_ANSWER))) return;
  if (isBotComment(commentBody)) return; // never re-trigger on our own comments

  const marker = await latestMarker(issueNumber);
  if (!marker) {
    core.warning(`issue #${issueNumber}: awaiting-answer but no session marker found`);
    return;
  }

  await removeLabel(issueNumber, LABEL_AWAITING_ANSWER);
  const client = connect(exe.vmUrl(marker.vm));
  const outcome = await promptJSON<Outcome>(client, marker.sessionId, continuePrompt(commentBody), outcomeSchema);
  await handleOutcome(issueNumber, marker.vm, marker.sessionId, outcome);
}

export async function onClose(issueNumber: number): Promise<void> {
  exe.destroyVm(exe.vmName(issueNumber));
}

export async function run(): Promise<void> {
  const ctx = github.context;
  if (ctx.eventName === "issues") {
    const issueNumber = ctx.payload.issue?.number;
    if (!issueNumber) return;
    if (ctx.payload.action === "opened") return onOpen(issueNumber);
    if (ctx.payload.action === "closed") return onClose(issueNumber);
    return;
  }
  if (ctx.eventName === "issue_comment" && ctx.payload.action === "created") {
    if (ctx.payload.issue?.pull_request) return; // PR comment, not an issue
    const issueNumber = ctx.payload.issue?.number;
    const commentBody = ctx.payload.comment?.body;
    if (!issueNumber || commentBody === undefined) return;
    return onComment(issueNumber, commentBody);
  }
}

run().catch((e) => {
  core.setFailed(e instanceof Error ? e.message : String(e));
});
