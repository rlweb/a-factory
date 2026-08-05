import { PiHarness } from "./harness.js";
import { createHarnessServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "4096", 10);

async function main() {
  // Fail fast on a missing key so the Action's waitForServer fails visibly instead of the
  // harness silently never starting a task.
  if (!process.env.OPENCODE_API_KEY) {
    console.error("Fatal: OPENCODE_API_KEY is not set — cannot register the oc-sdk-go provider");
    process.exit(1);
  }

  const harness = new PiHarness();
  createHarnessServer(harness, PORT);
  console.log(`pi-harness v0.1.0 ready (GET http://0.0.0.0:${PORT}/)`);
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
