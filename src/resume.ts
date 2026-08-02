import { appendFileSync } from "node:fs";
import { BOT_MARKER, LABELS } from "./lib/config.js";
import {
  addLabels,
  botComment,
  commentHasMaintainerThumbsUp,
  dispatchBuild,
  dispatchEpic,
  hasLabel,
  octokit,
  owner,
  removeLabel,
  repo,
} from "./lib/github.js";
import { log } from "./lib/log.js";
import { decideResume, isApproval } from "./lib/trust.js";

/**
 * Runs on issue_comment for issues labelled `awaiting-answer`.
 * Decides whether this comment should resume the agent:
 *   - bot/self comments: ignored (never re-trigger on our own questions)
 *   - trusted human (OWNER/MEMBER/COLLABORATOR): resume immediately
 *   - untrusted human: post an acknowledgement asking for a maintainer 👍;
 *     resume only once that 👍 is present (a maintainer can also just react to
 *     the original answer, which the reaction-triggered path re-checks)
 * Emits `resume=true|false` to GITHUB_OUTPUT so the workflow gates the build job.
 *
 * On an epic the comment carries a second decision: `approve` creates the proposed child
 * tickets, anything else re-proposes with the comment as feedback. See resume() below.
 */

function setOutput(k: string, v: string) {
  appendFileSync(process.env.GITHUB_OUTPUT!, `${k}=${v}\n`);
}

export async function run() {
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const commentId = Number(process.env.COMMENT_ID);
  const commentBody = process.env.COMMENT_BODY ?? "";
  const association = (process.env.COMMENT_ASSOCIATION ?? "NONE").toUpperCase();
  const authorType = process.env.COMMENT_AUTHOR_TYPE ?? "User"; // "User" | "Bot"
  if (!issueNumber || !commentId) throw new Error("ISSUE_NUMBER and COMMENT_ID required");

  log(
    `resume: start for issue #${issueNumber}, comment by ${process.env.COMMENT_AUTHOR ?? "?"} (${association}, ${authorType})`,
  );

  // Only act on awaiting-answer issues.
  if (!(await hasLabel(issueNumber, LABELS.awaitingAnswer))) {
    log(`resume: issue is not awaiting-answer — ignoring`);
    setOutput("resume", "false");
    return;
  }

  // Compute maintainer approval (label or 👍) for the untrusted path.
  const maintainerApproved =
    (await hasLabel(issueNumber, LABELS.answerApproved)) ||
    (await commentHasMaintainerThumbsUp(commentId));

  const action = decideResume({
    authorType,
    association,
    isMarkedBot: commentBody.includes(BOT_MARKER),
    maintainerApproved,
  });

  log(`resume: decision=${action} (maintainer approved: ${maintainerApproved})`);

  if (action === "ignore") {
    setOutput("resume", "false");
    return;
  }

  if (action === "resume") {
    if (maintainerApproved) await removeLabel(issueNumber, LABELS.answerApproved);
    await resume(issueNumber, isApproval(commentBody));
    setOutput("resume", "true");
    return;
  }

  // action === "hold": acknowledge once, wait for a maintainer 👍.
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const alreadyHeld = comments.some(
    (c) => (c.body ?? "").includes(BOT_MARKER) && (c.body ?? "").includes("awaiting a maintainer"),
  );
  if (!alreadyHeld) {
    await botComment(
      issueNumber,
      `Thanks @${process.env.COMMENT_AUTHOR ?? "there"} — since you're not a repo collaborator, a ` +
        `maintainer needs to 👍 your answer before I act on it (this keeps unassociated input from ` +
        `steering automated changes). A maintainer can react 👍 to your comment, or add the ` +
        `\`${LABELS.answerApproved}\` label, to resume.`,
      BOT_MARKER,
    );
  }
  setOutput("resume", "false");
}

/**
 * Route an accepted answer. Epics and tickets diverge sharply:
 *
 * An epic is never itself buildable, so it must not get `ready` — that label on an epic
 * is a live hazard, since anything that later re-fires the ready path hands the whole
 * epic to the builder as one ticket. Instead the comment decides the decomposition mode:
 * an explicit approval creates the child tickets from the proposed plan; anything else
 * is treated as revision feedback and re-proposes (epic.ts re-applies awaiting-answer,
 * so the review loop continues until approved).
 */
async function resume(issueNumber: number, approved: boolean) {
  await removeLabel(issueNumber, LABELS.awaitingAnswer);
  if (await hasLabel(issueNumber, LABELS.epic)) {
    const mode = approved ? "auto" : "propose";
    log(`resume: dispatching epic decomposition for #${issueNumber} (mode ${mode})`);
    await dispatchEpic(issueNumber, mode);
  } else {
    log(`resume: dispatching build for #${issueNumber}`);
    await addLabels(issueNumber, [LABELS.ready]);
    await dispatchBuild(issueNumber);
  }
}
