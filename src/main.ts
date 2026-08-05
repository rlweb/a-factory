import * as core from "@actions/core";
import * as github from "@actions/github";
import * as exe from "./exe.js";
import {
  addLabel,
  comment,
  hasLabel,
  LABEL_AWAITING_ANSWER,
  owner,
  removeLabel,
  repo,
} from "./github.js";
import { resumeSession, startSession, waitForServer, type HarnessOutcome } from "./pi-harness.js";

export async function handleOutcome(
  issueNumber: number,
  vm: string,
  outcome: HarnessOutcome,
): Promise<void> {
  if (outcome.status === "question") {
    await addLabel(issueNumber, LABEL_AWAITING_ANSWER);
    core.info(`issue #${issueNumber}: awaiting human answer, VM ${vm} left running`);
    return;
  }

  if (outcome.status === "failed") {
    const body = [
      "### Verification failed",
      "",
      "The harness ran the verify command and it did not pass:",
      "",
      "```",
      outcome.verify ?? "(no output)",
      "```",
      "",
      `Branch: \`${outcome.branch ?? `factory/issue-${issueNumber}`}\``,
    ].join("\n");
    await comment(issueNumber, body);
    await removeLabel(issueNumber, LABEL_AWAITING_ANSWER);
    exe.destroyVm(vm);
    return;
  }

  core.info(
    `issue #${issueNumber}: done, PR ${outcome.prUrl ?? "(unknown)"}`,
  );
  await removeLabel(issueNumber, LABEL_AWAITING_ANSWER);
  exe.destroyVm(vm);
}

export async function onOpen(issueNumber: number): Promise<void> {
  const vm = exe.vmName(issueNumber);
  exe.createVm(vm);

  waitForServer(vm);

  const outcome = startSession(vm, owner, repo, issueNumber);
  await handleOutcome(issueNumber, vm, outcome);
}

export async function onComment(issueNumber: number): Promise<void> {
  if (!(await hasLabel(issueNumber, LABEL_AWAITING_ANSWER))) return;

  const vm = exe.vmName(issueNumber);

  await removeLabel(issueNumber, LABEL_AWAITING_ANSWER);

  let outcome: HarnessOutcome;
  try {
    outcome = resumeSession(vm);
  } catch (e) {
    core.warning(
      `issue #${issueNumber}: could not reach harness on ${vm}: ${String(e)}`,
    );
    await addLabel(issueNumber, LABEL_AWAITING_ANSWER);
    return;
  }

  await handleOutcome(issueNumber, vm, outcome);
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
    if (ctx.payload.issue?.pull_request) return;
    const issueNumber = ctx.payload.issue?.number;
    if (!issueNumber) return;
    return onComment(issueNumber);
  }
}

run().catch((e) => {
  core.setFailed(e instanceof Error ? e.message : String(e));
});
