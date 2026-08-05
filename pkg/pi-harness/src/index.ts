import { PiHarness } from "./harness.js";
import { createHarnessServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "4096", 10);

async function main() {
  const harness = new PiHarness();
  createHarnessServer(harness, PORT);
  console.log(`pi-harness v0.1.0 ready (GET http://0.0.0.0:${PORT}/)`);

  // Autonomous mode: the VM is created with ISSUE_NUMBER + GITHUB_REPOSITORY env vars.
  // The harness picks the work up itself — the Action never calls in to start it.
  const issueNumber = parseInt(process.env.ISSUE_NUMBER ?? "", 10);
  const repoEnv = process.env.GITHUB_REPOSITORY ?? "";
  if (issueNumber > 0 && repoEnv.includes("/")) {
    const [owner, repo] = repoEnv.split("/");
    console.log(`pi-harness: auto-starting on issue #${issueNumber} (${owner}/${repo})`);
    harness.run({ owner, repo, issueNumber }).catch((e) => {
      console.error("harness run failed:", e instanceof Error ? e.message : String(e));
    });
  }
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
