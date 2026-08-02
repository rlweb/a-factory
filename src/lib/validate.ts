import { spawn } from "node:child_process";
import { log } from "./log.js";

export interface ValidationResult {
  ok: boolean;
  exitCode: number;
  /** Combined stdout+stderr, tail-trimmed for feeding back to the agent. */
  log: string;
}

/**
 * Runs the project's verification script. This is the non-negotiable gate:
 * the agent's work is NEVER trusted until this passes. It shells out to
 * `pnpm verify` (see package.json), which must format, lint, typecheck and test.
 *
 * We capture the tail of the output so a failing run can be fed straight back
 * to the agent for a self-fix attempt.
 */
export function runValidation(cwd = process.cwd(), tailLines = 200): Promise<ValidationResult> {
  return new Promise((resolve) => {
    log("verify: running `pnpm run verify`");
    // Collapsible in the Actions log — the run is long and chatty, but you can open it.
    console.log("::group::pnpm run verify");
    const child = spawn("pnpm", ["run", "verify"], {
      cwd,
      env: process.env,
      shell: false,
    });

    let buf = "";
    const append = (chunk: Buffer) => {
      process.stdout.write(chunk); // stream it live; the buffer is for the agent's feedback
      buf += chunk.toString();
      // Keep memory bounded on very chatty runs.
      if (buf.length > 1_000_000) buf = buf.slice(-1_000_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    child.on("close", (code) => {
      console.log("::endgroup::");
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0,
        exitCode,
        log: buf.split("\n").slice(-tailLines).join("\n"),
      });
    });

    child.on("error", (e) => {
      console.log("::endgroup::");
      resolve({ ok: false, exitCode: 1, log: `Failed to spawn verification: ${e.message}` });
    });
  });
}
