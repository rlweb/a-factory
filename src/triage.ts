import { LABELS } from "./lib/config.js";
import { addLabels, comment, dispatchBuild, dispatchEpic, removeLabel } from "./lib/github.js";
import { log } from "./lib/log.js";
import { promptJSON, withOpencode } from "./lib/opencode.js";
import { triageSchema } from "./lib/schemas.js";

interface Triage {
  kind: "bug" | "ticket" | "epic" | "question" | "spam";
  shouldImplement: boolean;
  labels: string[];
  duplicateOf: number | null;
  clarifyingQuestions?: string[];
  reasoning: string;
}

export async function run() {
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const issueTitle = process.env.ISSUE_TITLE ?? "";
  const issueBody = process.env.ISSUE_BODY ?? "";
  if (!issueNumber) throw new Error("ISSUE_NUMBER is required");

  log(`triage: start for issue #${issueNumber} "${issueTitle}"`);
  const verdict = await withOpencode(async ({ client }) => {
    const session = await client.session.create({ body: { title: `triage #${issueNumber}` } });
    const sid = session.data!.id;

    return promptJSON<Triage>(
      client,
      sid,
      `Triage this GitHub issue.

--- ISSUE #${issueNumber}: ${issueTitle} ---
${issueBody}`,
      triageSchema,
      "triager",
    );
  });

  log(
    `triage: verdict kind=${verdict.kind} shouldImplement=${verdict.shouldImplement} duplicateOf=${verdict.duplicateOf ?? "none"}`,
  );

  // Apply labels; always clear the raw triage label.
  const labels = [...new Set(verdict.labels)].filter((l) => l !== LABELS.triage);
  const willBuild = verdict.shouldImplement && verdict.kind !== "epic" && !verdict.duplicateOf;
  if (willBuild) labels.push(LABELS.ready);
  if (verdict.kind === "epic") labels.push(LABELS.epic);
  await addLabels(issueNumber, labels);
  await removeLabel(issueNumber, LABELS.triage);
  log(`triage: labels applied [${labels.join(", ")}]`);

  if (verdict.duplicateOf) {
    await comment(
      issueNumber,
      `Looks like a duplicate of #${verdict.duplicateOf}. ${verdict.reasoning}`,
    );
    return;
  }

  // The `ready` label was applied via token and won't fire the build workflow on its
  // own — dispatch it explicitly. (The epic label is handled by the labeled trigger's
  // epic job, which is a different workflow path; epics dispatch after decomposition.)
  if (willBuild) {
    log(`triage: dispatching build for #${issueNumber}`);
    await dispatchBuild(issueNumber);
  }
  if (verdict.kind === "epic") {
    log(`triage: dispatching epic decomposition for #${issueNumber}`);
    await dispatchEpic(issueNumber);
  }

  if (!verdict.shouldImplement) {
    const qs = verdict.clarifyingQuestions ?? [];
    const body = qs.length
      ? `Before this can be picked up automatically, a few things need clarifying:\n\n${qs
          .map((q) => `- ${q}`)
          .join("\n")}`
      : `Triaged as **${verdict.kind}**, not queued for automated work.\n\n${verdict.reasoning}`;
    await comment(issueNumber, body);
  }
}
