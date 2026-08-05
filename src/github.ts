import * as core from "@actions/core";
import * as github from "@actions/github";

export const LABEL_AWAITING_ANSWER = "awaiting-answer";

const token = core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
export const octokit = github.getOctokit(token);
export const owner = github.context.repo.owner;
export const repo = github.context.repo.repo;

export async function comment(issueNumber: number, body: string): Promise<void> {
  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
}

export async function addLabel(issueNumber: number, label: string): Promise<void> {
  await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [label] });
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  try {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
}

export async function hasLabel(issueNumber: number, label: string): Promise<boolean> {
  const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  return issue.labels.some((l) => (typeof l === "string" ? l : l.name) === label);
}
