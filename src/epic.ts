import { BOT_MARKER, LABELS } from "./lib/config.js";
import {
  addLabels,
  comment,
  createChildIssue,
  dispatchBuild,
  getIssue,
  issueComments,
  removeLabel,
} from "./lib/github.js";
import { log } from "./lib/log.js";
import { promptJSON, withOpencode } from "./lib/opencode.js";
import { decompositionSchema } from "./lib/schemas.js";

interface Subtask {
  title: string;
  body: string;
  size: "S" | "M" | "L";
  dependsOn: number[];
}
interface Decomposition {
  subtasks: Subtask[];
  reasoning: string;
}

export async function run() {
  const epicNumber = Number(process.env.ISSUE_NUMBER);
  // "auto" creates children immediately; otherwise just proposes them in a comment.
  const mode = (process.env.DECOMPOSE_MODE ?? "propose").toLowerCase();
  if (!epicNumber) throw new Error("ISSUE_NUMBER is required");

  // The epic job doesn't resolve the issue into env — fetch it ourselves.
  const envTitle = process.env.ISSUE_TITLE ?? "";
  const { title: epicTitle, body: epicBody } = envTitle
    ? { title: envTitle, body: process.env.ISSUE_BODY ?? "" }
    : await getIssue(epicNumber);

  log(`epic: start for #${epicNumber} "${epicTitle}" (mode ${mode})`);

  const thread = await issueComments(epicNumber, BOT_MARKER);
  const humanAnswers = thread
    .filter((c) => !c.isBot)
    .map((c) => `@${c.login} (${c.association}): ${c.body}`)
    .join("\n\n");

  const plan = await withOpencode(async ({ client }) => {
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
  });

  log(`epic: decomposed into ${plan.subtasks.length} subtask(s)`);

  if (mode !== "auto") {
    log(`epic: propose mode — posting breakdown comment, creating nothing`);
    const preview = plan.subtasks
      .map(
        (s, i) =>
          `${i + 1}. **${s.title}** (${s.size})${s.dependsOn.length ? ` — depends on ${s.dependsOn.map((d) => d + 1).join(", ")}` : ""}`,
      )
      .join("\n");
    await comment(
      epicNumber,
      `### Proposed breakdown\n\n${preview}\n\n${plan.reasoning}\n\n_Re-run with auto mode, or edit the epic and re-trigger, to create these as tickets._`,
    );
    return;
  }

  // Create children. Only those with no dependencies get labelled ready immediately;
  // dependents stay blocked until their prerequisites merge (a separate watcher promotes them).
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
  await removeLabel(epicNumber, LABELS.triage);
}
