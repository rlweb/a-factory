import { execFileSync } from "node:child_process";
import { context, getOctokit } from "@actions/github";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");

export const octokit: ReturnType<typeof getOctokit> = getOctokit(token);
export const { owner, repo } = context.repo;

export function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export async function addLabels(issue: number, labels: string[]) {
  if (!labels.length) return;
  await octokit.rest.issues.addLabels({ owner, repo, issue_number: issue, labels });
}

export async function removeLabel(issue: number, label: string) {
  try {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issue, name: label });
  } catch {
    /* label may not be present */
  }
}

export async function comment(issue: number, body: string) {
  await octokit.rest.issues.createComment({ owner, repo, issue_number: issue, body });
}

/** Comment authored by the factory, tagged with BOT_MARKER so the resume trigger
 *  can tell agent comments from human answers. Always use this for agent questions. */
export async function botComment(issue: number, body: string, marker: string) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue,
    body: `${body}\n\n${marker}`,
  });
}

export interface IssueComment {
  id: number;
  body: string;
  login: string;
  association: string;
  isBot: boolean;
}

/** Full comment thread for an issue, oldest first, with author + association. */
export async function issueComments(issue: number, marker: string): Promise<IssueComment[]> {
  const raw = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issue,
    per_page: 100,
  });
  return raw.map((c) => ({
    id: c.id,
    body: c.body ?? "",
    login: c.user?.login ?? "",
    association: c.author_association ?? "NONE",
    isBot: c.user?.type === "Bot" || (c.body ?? "").includes(marker),
  }));
}

/** True if a maintainer (write access) has reacted 👍 to a specific comment. */
export async function commentHasMaintainerThumbsUp(commentId: number): Promise<boolean> {
  const reactions = await octokit.paginate(octokit.rest.reactions.listForIssueComment, {
    owner,
    repo,
    comment_id: commentId,
    per_page: 100,
  });
  for (const r of reactions) {
    if (r.content !== "+1" || !r.user) continue;
    const assoc = await collaboratorPermission(r.user.login);
    if (assoc === "admin" || assoc === "write") return true;
  }
  return false;
}

async function collaboratorPermission(username: string): Promise<string> {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    return data.permission; // "admin" | "write" | "read" | "none"
  } catch {
    return "none";
  }
}

/**
 * Fire a repository_dispatch — the reliable way to start another workflow from within
 * a GITHUB_TOKEN-authed run (label/push events from the token are suppressed to prevent
 * recursion; dispatch events are the documented exception). The build workflow listens
 * for event_type "factory-build".
 */
export async function dispatchBuild(issueNumber: number) {
  await octokit.rest.repos.createDispatchEvent({
    owner,
    repo,
    event_type: "factory-build",
    client_payload: { issue: issueNumber },
  });
}

/** Same mechanism, for kicking epic decomposition when the epic label was applied by token. */
export async function dispatchEpic(issueNumber: number) {
  await octokit.rest.repos.createDispatchEvent({
    owner,
    repo,
    event_type: "factory-epic",
    client_payload: { issue: issueNumber },
  });
}

/** Current label names on an issue. */
export async function issueLabels(issue: number): Promise<string[]> {
  const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issue });
  return (data.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);
}

export async function hasLabel(issue: number, label: string): Promise<boolean> {
  return (await issueLabels(issue)).includes(label);
}

/** Count prior question rounds by scanning for the agent's marked question comments. */
export async function questionRounds(issue: number, marker: string): Promise<number> {
  const comments = await issueComments(issue, marker);
  return comments.filter((c) => c.body.includes(marker) && c.body.includes("### Questions")).length;
}

/** Files changed in a PR, as paths. */
export async function prFiles(pull_number: number): Promise<string[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  return files.map((f) => f.filename);
}

export async function prDiff(pull_number: number): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return data as unknown as string;
}

/** Enable native auto-merge (waits for required checks) via squash. */
export async function enableAutoMerge(pull_number: number) {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number });
  await octokit.graphql(
    `mutation($id: ID!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
        clientMutationId
      }
    }`,
    { id: pr.node_id },
  );
}

export async function createChildIssue(title: string, body: string, labels: string[]) {
  const { data } = await octokit.rest.issues.create({ owner, repo, title, body, labels });
  return data.number;
}

export async function openPullRequest(head: string, base: string, title: string, body: string) {
  const { data } = await octokit.rest.pulls.create({ owner, repo, head, base, title, body });
  return data;
}
