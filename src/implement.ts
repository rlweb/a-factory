import { implementAgentFor } from "./lib/agents.js";
import { BOT_MARKER, LABELS, VALIDATION_MAX_ATTEMPTS } from "./lib/config.js";
import {
  addLabels,
  botComment,
  comment,
  git,
  issueComments,
  issueLabels,
  openPullRequest,
  questionRounds,
  removeLabel,
} from "./lib/github.js";
import { log } from "./lib/log.js";
import { injectContext, promptAgent, promptJSON, withOpencode } from "./lib/opencode.js";
import { planSchema } from "./lib/schemas.js";
import { questionCapReached } from "./lib/trust.js";
import { runValidation } from "./lib/validate.js";

interface Plan {
  status: "ready" | "needs_input";
  questions: string[];
  assumptions: string[];
  plan?: string[];
  reasoning: string;
}

export async function run() {
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const issueTitle = process.env.ISSUE_TITLE ?? "";
  const issueBody = process.env.ISSUE_BODY ?? "";
  const base = process.env.BASE_BRANCH ?? "main";
  if (!issueNumber) throw new Error("ISSUE_NUMBER is required");

  log(`implement: start for issue #${issueNumber} "${issueTitle}" (base ${base})`);

  // Prior question rounds already spent on this issue. Uncapped when QUESTION_MAX_ROUNDS === 0.
  const roundsSoFar = await questionRounds(issueNumber, BOT_MARKER);
  const capReached = questionCapReached(roundsSoFar);
  log(
    `implement: plan phase starting (question rounds so far: ${roundsSoFar}, cap reached: ${capReached})`,
  );

  // The comment thread carries any human answers from previous rounds. We inject the
  // human (non-bot) comments as context so answered questions flow into planning.
  const thread = await issueComments(issueNumber, BOT_MARKER);
  const humanAnswers = thread
    .filter((c) => !c.isBot)
    .map((c) => `@${c.login} (${c.association}): ${c.body}`)
    .join("\n\n");

  // ---- Plan phase: cheap read-only checkpoint BEFORE any file edits. The planner
  // agent prompt carries the process; only per-run facts go in the prompt here. ----
  const plan = await withOpencode(async ({ client }) => {
    const session = await client.session.create({ body: { title: `plan #${issueNumber}` } });
    const sid = session.data!.id;

    return promptJSON<Plan>(
      client,
      sid,
      `Assess this issue and produce a plan or questions.${
        capReached
          ? " NOTE: the question limit has been reached — proceed on your best assumptions and set status=ready."
          : ""
      }

--- ISSUE #${issueNumber}: ${issueTitle} ---
${issueBody}
${humanAnswers ? `\n--- ANSWERS & DISCUSSION SO FAR ---\n${humanAnswers}` : ""}`,
      planSchema,
      "planner",
    );
  });

  // If the agent needs input and we're not capped, ask and exit cleanly — no branch,
  // no PR, no wasted validation cycle. The resume workflow re-runs this on a human answer.
  log(
    `implement: plan result status=${plan.status} questions=${plan.questions.length} steps=${plan.plan?.length ?? 0}`,
  );

  if (plan.status === "needs_input" && plan.questions.length && !capReached) {
    log(`implement: asking ${plan.questions.length} question(s) on the issue and exiting`);
    const body = [
      `### Questions`,
      ``,
      `I need a few things clarified before implementing this. Reply on this issue to answer —`,
      `I'll pick up automatically once someone responds.`,
      ``,
      ...plan.questions.map((q) => `- ${q}`),
      plan.assumptions.length
        ? `\n_If I don't hear back, I'd otherwise assume:_\n${plan.assumptions.map((a) => `- ${a}`).join("\n")}`
        : "",
    ].join("\n");
    await botComment(issueNumber, body, BOT_MARKER);
    await addLabels(issueNumber, [LABELS.awaitingAnswer]);
    await removeLabel(issueNumber, LABELS.ready);
    console.log(`::notice::issue #${issueNumber} awaiting human answer (round ${roundsSoFar + 1})`);
    return; // clean exit, exit code 0
  }

  // ---- Implementation phase. ----
  const branch = `factory/issue-${issueNumber}`;
  git(["checkout", "-b", branch]);
  log(`implement: created branch ${branch}`);
  await addLabels(issueNumber, [LABELS.inProgress]);
  await removeLabel(issueNumber, LABELS.ready);
  await removeLabel(issueNumber, LABELS.awaitingAnswer);

  const forcedAssumptions =
    capReached && plan.assumptions.length
      ? `\n\nThe question limit was reached; proceed on these assumptions and note them in the PR:\n${plan.assumptions
          .map((a) => `- ${a}`)
          .join("\n")}`
      : "";

  // Bug issues get the diagnose-first agent; everything else gets the builder.
  const implAgent = implementAgentFor(await issueLabels(issueNumber));
  log(`implement: implementation phase starting with agent "${implAgent}"`);

  const outcome = await withOpencode(async ({ client }) => {
    const session = await client.session.create({ body: { title: `impl #${issueNumber}` } });
    const sid = session.data!.id;

    await injectContext(
      client,
      sid,
      `You are implementing a change in this repository. Follow existing conventions.

The factory runs the validation script (\`pnpm validate\` — format, lint, typecheck, tests)
for you once you finish, and will hand you the failure output to fix if it does not pass.
So do NOT run the full validation script or the whole test suite yourself: it is slow and
your shell commands time out. Verify in small, fast pieces instead — typecheck a file, run
the single test file you touched — and leave the full run to the factory.

Your work must pass that run. Do not weaken tests or the validation config to make it pass.`,
    );

    await promptAgent(
      client,
      sid,
      `Implement the following issue end to end, editing files as needed.${forcedAssumptions}

--- ISSUE #${issueNumber}: ${issueTitle} ---
${issueBody}
${humanAnswers ? `\n--- ANSWERS & DISCUSSION ---\n${humanAnswers}` : ""}
${plan.plan?.length ? `\n--- YOUR PLAN ---\n${plan.plan.map((p) => `- ${p}`).join("\n")}` : ""}`,
      implAgent,
    );

    log(`implement: agent finished editing; validation loop starting`);

    for (let attempt = 1; attempt <= VALIDATION_MAX_ATTEMPTS; attempt++) {
      const result = await runValidation();
      log(
        `implement: validation attempt ${attempt}/${VALIDATION_MAX_ATTEMPTS} ${result.ok ? "passed" : "failed"}`,
      );
      if (result.ok) return { passed: true, attempts: attempt };
      if (attempt === VALIDATION_MAX_ATTEMPTS) {
        return { passed: false, attempts: attempt, log: result.log };
      }
      await promptAgent(
        client,
        sid,
        `The validation script failed (attempt ${attempt}/${VALIDATION_MAX_ATTEMPTS}). Fix the
underlying cause — do not modify the validation config or delete tests. Fix it and stop;
I re-run validation for you and will send the next failure if there is one. Output below:

\`\`\`
${result.log}
\`\`\``,
        implAgent,
      );
    }
    return { passed: false, attempts: VALIDATION_MAX_ATTEMPTS };
  });

  git(["add", "-A"]);
  const hasChanges = git(["status", "--porcelain"]).length > 0;
  log(`implement: agent produced ${hasChanges ? "changes" : "NO changes"}`);
  if (hasChanges) {
    git([
      "-c",
      "user.name=factory-bot",
      "-c",
      "user.email=factory@users.noreply.github.com",
      "commit",
      "-m",
      `factory: implement #${issueNumber}`,
    ]);
    git(["push", "origin", branch]);
    log(`implement: committed and pushed ${branch}`);
  }

  await removeLabel(issueNumber, LABELS.inProgress);

  if (!outcome.passed || !hasChanges) {
    log(
      `implement: handing off to human (${!hasChanges ? "no changes" : `validation failed after ${outcome.attempts} attempts`})`,
    );
    await addLabels(issueNumber, [LABELS.needsHuman]);
    await comment(
      issueNumber,
      !hasChanges
        ? `The agent produced no changes for this issue. Handing off for human review.`
        : `Validation still failing after ${outcome.attempts} attempts. Handing off — branch \`${branch}\` pushed for inspection.`,
    );
    process.exit(0);
  }

  const assumptionNote =
    capReached && plan.assumptions.length
      ? `\n\n⚠️ Question limit reached — implemented on assumptions:\n${plan.assumptions.map((a) => `- ${a}`).join("\n")}\nRouting to human review.`
      : "";

  const pr = await openPullRequest(
    branch,
    base,
    `factory: ${issueTitle}`,
    `Automated implementation of #${issueNumber}.\n\nValidation passed after ${outcome.attempts} attempt(s).${assumptionNote}\n\nCloses #${issueNumber}`,
  );
  log(
    `implement: opened PR #${pr.number} (validation passed after ${outcome.attempts} attempt(s))`,
  );
  console.log(`::notice::opened PR #${pr.number}`);
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_OUTPUT!, `pr_number=${pr.number}\n`);
  // If we implemented on forced assumptions, flag the PR for a human even if low-risk.
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT!,
    `forced_assumptions=${capReached ? "true" : "false"}\n`,
  );
}
