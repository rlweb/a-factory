import { LABELS } from "./lib/config.js";
import { gate, type Risk } from "./lib/gate.js";
import { addLabels, comment, enableAutoMerge, prDiff, prFiles } from "./lib/github.js";
import { log } from "./lib/log.js";
import { promptJSON, withOpencode } from "./lib/opencode.js";
import { riskSchema } from "./lib/schemas.js";

export async function run() {
  const prNumber = Number(process.env.PR_NUMBER);
  const validationPassed = process.env.VALIDATION_PASSED === "true";
  if (!prNumber) throw new Error("PR_NUMBER is required");

  log(`review: start for PR #${prNumber} (validation passed: ${validationPassed})`);
  const files = await prFiles(prNumber);
  const diff = await prDiff(prNumber);
  log(`review: ${files.length} file(s) changed, diff ${diff.length} chars; asking reviewer agent`);

  const verdict = await withOpencode(async ({ client }) => {
    const session = await client.session.create({ body: { title: `review PR #${prNumber}` } });
    const sid = session.data!.id;
    return promptJSON<Risk>(
      client,
      sid,
      `Review this pull request diff and assess whether it is safe to auto-merge.

--- DIFF ---
${diff.slice(0, 120_000)}`,
      riskSchema,
      "reviewer",
    );
  });

  log(`review: agent verdict risk=${verdict.risk} concerns=${verdict.concerns?.length ?? 0}`);
  const decision = gate(verdict, files, validationPassed);
  log(
    `review: gate decision autoMerge=${decision.autoMerge}${
      decision.reasons.length ? ` (${decision.reasons.join("; ")})` : ""
    }`,
  );

  const body = [
    `### Automated review`,
    ``,
    verdict.summary,
    ``,
    `**Risk:** ${verdict.risk}  ·  **Files changed:** ${files.length}  ·  **Validation:** ${validationPassed ? "passed" : "failed"}`,
    verdict.concerns?.length
      ? `\n**Concerns:**\n${verdict.concerns.map((c) => `- ${c}`).join("\n")}`
      : "",
    ``,
    decision.autoMerge
      ? `✅ Eligible for auto-merge. Native auto-merge enabled — will merge once required checks are green.`
      : `⏸️ Routed to human review — ${decision.reasons.join("; ")}.`,
  ].join("\n");

  await comment(prNumber, body);

  if (decision.autoMerge) {
    await addLabels(prNumber, [LABELS.autoMerged]);
    await enableAutoMerge(prNumber);
    log(`review: native auto-merge enabled on PR #${prNumber}`);
  } else {
    await addLabels(prNumber, [LABELS.needsHuman]);
    log(`review: PR #${prNumber} routed to human review`);
  }
}
