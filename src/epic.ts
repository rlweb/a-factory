import { BOT_MARKER, LABELS } from "./lib/config.js";
import { parseDecomposeMode } from "./lib/decompose.js";
import {
  addLabels,
  botComment,
  comment,
  createChildIssue,
  dispatchBuild,
  getIssue,
  issueComments,
  removeLabel,
} from "./lib/github.js";
import { log } from "./lib/log.js";
import { promptJSON, withOpencode } from "./lib/opencode.js";
import {
  type Decomposition,
  decodePlanBlock,
  MAX_COMMENT_CHARS,
  withPlanBlock,
} from "./lib/plan-block.js";
import { decompositionSchema } from "./lib/schemas.js";

export async function run() {
  const epicNumber = Number(process.env.ISSUE_NUMBER);
  if (!epicNumber) throw new Error("ISSUE_NUMBER is required");

  // The epic job doesn't resolve the issue into env — fetch it ourselves.
  const envTitle = process.env.ISSUE_TITLE ?? "";
  const { title: epicTitle, body: epicBody } = envTitle
    ? { title: envTitle, body: process.env.ISSUE_BODY ?? "" }
    : await getIssue(epicNumber);

  // "auto" creates children immediately; "propose" posts a breakdown and waits for an
  // `approve` reply. DECOMPOSE_MODE is the per-dispatch override an approval sets.
  const mode = parseDecomposeMode(epicBody, { dispatched: process.env.DECOMPOSE_MODE });

  log(`epic: start for #${epicNumber} "${epicTitle}" (mode ${mode})`);

  const thread = await issueComments(epicNumber, BOT_MARKER);
  const humanAnswers = thread
    .filter((c) => !c.isBot)
    .map((c) => `@${c.login} (${c.association}): ${c.body}`)
    .join("\n\n");

  // Approving a breakdown must create the breakdown that was approved, so replay the
  // plan stored in the newest proposal rather than asking the model again — it does not
  // answer the same way twice. Only auto mode replays; propose always re-decomposes so
  // that revision feedback is actually incorporated.
  const stored = mode === "auto" ? decodePlanBlock(thread.map((c) => c.body).join("\n")) : null;
  if (stored) {
    log(`epic: replaying approved plan of ${stored.subtasks.length} subtask(s) — no model call`);
  }

  const plan =
    stored ??
    (await withOpencode(async ({ client }) => {
      const session = await client.session.create({ body: { title: `epic #${epicNumber}` } });
      const sid = session.data!.id;
      return promptJSON<Decomposition>(
        client,
        sid,
        `Decompose this epic into child tickets. Express ordering constraints via dependsOn,
as 0-based indices into your own subtasks array.

--- EPIC #${epicNumber}: ${epicTitle} ---
${epicBody}
${humanAnswers ? `\n--- ANSWERS & DISCUSSION ---\n${humanAnswers}` : ""}`,
        decompositionSchema,
        "decomposer",
      );
    }));

  if (!stored) log(`epic: decomposed into ${plan.subtasks.length} subtask(s)`);

  if (mode !== "auto") {
    await propose(epicNumber, plan);
    return;
  }

  // Create children. Only those with no dependencies get labelled ready immediately;
  // dependents stay blocked until their prerequisites merge (promote by adding `ready`).
  const created: number[] = [];
  for (const s of plan.subtasks) {
    const labels = [LABELS.ticket];
    const num = await createChildIssue(
      s.title,
      `${s.body}\n\n---\nPart of epic #${epicNumber}.`,
      labels,
    );
    created.push(num);
    log(`epic: created child #${num} "${s.title}"`);
  }

  // Second pass: wire dependencies by real issue number and label the roots ready.
  for (let i = 0; i < plan.subtasks.length; i++) {
    const s = plan.subtasks[i];
    const deps = s.dependsOn.map((idx) => created[idx]).filter(Boolean);
    if (deps.length === 0) {
      log(`epic: #${created[i]} has no dependencies — marked ready, dispatching build`);
      await addLabels(created[i], [LABELS.ready]);
      await dispatchBuild(created[i]); // token label won't fire build; dispatch it
    } else {
      log(`epic: #${created[i]} blocked on ${deps.map((d) => `#${d}`).join(", ")}`);
      await addLabels(created[i], [LABELS.blocked]);
      await comment(created[i], `Blocked until ${deps.map((d) => `#${d}`).join(", ")} merge.`);
    }
  }

  const checklist = created.map((n) => `- [ ] #${n}`).join("\n");
  await comment(epicNumber, `### Child tickets created\n\n${checklist}`);
  await addLabels(epicNumber, [LABELS.inProgress]);
  // The epic is decomposed, so it is neither awaiting an answer nor itself buildable.
  // `ready` gets here via resume on older runs; clear it so nothing implements the epic.
  await removeLabel(epicNumber, LABELS.triage);
  await removeLabel(epicNumber, LABELS.awaitingAnswer);
  await removeLabel(epicNumber, LABELS.ready);
}

/**
 * Post the breakdown for review and stop. The plan is embedded in the comment so an
 * `approve` reply can replay it verbatim, and `awaiting-answer` is what makes resume.ts
 * listen to that reply at all — without it the comment is ignored and propose mode is a
 * dead end.
 */
async function propose(epicNumber: number, plan: Decomposition) {
  const preview = plan.subtasks
    .map(
      (s, i) =>
        `${i + 1}. **${s.title}** (${s.size})${s.dependsOn.length ? ` — depends on ${s.dependsOn.map((d) => d + 1).join(", ")}` : ""}`,
    )
    .join("\n");

  const head =
    `### Proposed breakdown\n\n${preview}\n\n${plan.reasoning}\n\n---\n` +
    `Reply **\`approve\`** (on its own first line) to create these as tickets. ` +
    `Reply with changes instead and I'll propose a revised breakdown.`;

  // botComment appends the marker, so reserve room for it in the size check.
  const limit = MAX_COMMENT_CHARS - BOT_MARKER.length - 2;
  const first = withPlanBlock(head, plan, limit);
  // Too large to embed: say so, since approving will then re-plan rather than replay.
  const body = first.persisted
    ? first.text
    : withPlanBlock(
        `${head}\n\n_This breakdown was too large to store, so approving it will re-plan from ` +
          `scratch and may differ from the above._`,
        plan,
        limit,
      ).text;

  log(
    `epic: propose mode — posting breakdown (plan persisted: ${first.persisted}), creating nothing`,
  );
  await botComment(epicNumber, body, BOT_MARKER);
  await addLabels(epicNumber, [LABELS.awaitingAnswer]);
}
