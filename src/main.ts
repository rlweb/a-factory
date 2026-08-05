import * as core from "@actions/core";
import * as github from "@actions/github";
import * as exe from "./exe.js";
import {
  addLabel,
  hasLabel,
  LABEL_AWAITING_ANSWER,
  owner,
  removeLabel,
  repo,
} from "./github.js";
import { resumeSession } from "./pi-harness.js";

export async function onOpen(issueNumber: number): Promise<void> {
  const vm = exe.vmName(issueNumber);
  exe.createVm(vm, [`ISSUE_NUMBER=${issueNumber}`, `GITHUB_REPOSITORY=${owner}/${repo}`]);
  core.info(`issue #${issueNumber}: VM ${vm} created, harness will run autonomously`);
}

export async function onComment(issueNumber: number): Promise<void> {
  if (!(await hasLabel(issueNumber, LABEL_AWAITING_ANSWER))) return;

  const vm = exe.vmName(issueNumber);

  await removeLabel(issueNumber, LABEL_AWAITING_ANSWER);

  try {
    resumeSession(vm);
  } catch (e) {
    core.warning(`issue #${issueNumber}: could not resume harness on ${vm}: ${String(e)}`);
    await addLabel(issueNumber, LABEL_AWAITING_ANSWER);
  }
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
