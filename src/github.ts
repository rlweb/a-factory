import * as core from "@actions/core";
import * as github from "@actions/github";

export const BOT_MARKER_PREFIX = "<!-- a-factory-session:";
export const LABEL_AWAITING_ANSWER = "awaiting-answer";

const token = core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
export const octokit = github.getOctokit(token);
export const owner = github.context.repo.owner;
export const repo = github.context.repo.repo;

export interface SessionMarker {
  vm: string;
  sessionId: string;
}

function embedMarker(marker: SessionMarker): string {
  return `${BOT_MARKER_PREFIX}${Buffer.from(JSON.stringify(marker)).toString("base64")} -->`;
}

function extractMarker(body: string): SessionMarker | null {
  const start = body.indexOf(BOT_MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(" -->", start);
  if (end === -1) return null;
  const encoded = body.slice(start + BOT_MARKER_PREFIX.length, end);
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as SessionMarker;
  } catch {
    return null;
  }
}

export function isBotComment(body: string): boolean {
  return body.includes(BOT_MARKER_PREFIX);
}

export async function comment(issueNumber: number, body: string): Promise<void> {
  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
}

/** Posts a comment carrying a hidden marker so a later reply can find it (and this action
 * can tell its own comments apart from human replies). */
export async function botComment(
  issueNumber: number,
  body: string,
  marker: SessionMarker,
): Promise<void> {
  await comment(issueNumber, `${body}\n\n${embedMarker(marker)}`);
}

/** Most recent session marker left on this issue, if any. */
export async function latestMarker(issueNumber: number): Promise<SessionMarker | null> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  for (let i = comments.length - 1; i >= 0; i--) {
    const marker = extractMarker(comments[i]?.body ?? "");
    if (marker) return marker;
  }
  return null;
}

export async function addLabel(issueNumber: number, label: string): Promise<void> {
  await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [label] });
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  try {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
  } catch (e) {
    // Already absent — not an error for our purposes.
    if ((e as { status?: number }).status !== 404) throw e;
  }
}

export async function hasLabel(issueNumber: number, label: string): Promise<boolean> {
  const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  return issue.labels.some((l) => (typeof l === "string" ? l : l.name) === label);
}

export async function openPullRequest(
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<{ number: number }> {
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    head: branch,
    base,
    title,
    body,
  });
  return { number: pr.number };
}
