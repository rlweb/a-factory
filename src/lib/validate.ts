import { spawn } from "node:child_process";

export interface ValidationResult {
  ok: boolean;
  exitCode: number;
  /** Combined stdout+stderr, tail-trimmed for feeding back to the agent. */
  log: string;
}

/**
 * Runs the project's validation script. This is the non-negotiable gate:
 * the agent's work is NEVER trusted until this passes. It shells out to
 * `pnpm validate` (see package.json), which must format, lint, typecheck and test.
 *
 * We capture the tail of the output so a failing run can be fed straight back
 * to the agent for a self-fix attempt.
 */
export function runValidation(cwd = process.cwd(), tailLines = 200): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["run", "validate"], {
      cwd,
      env: process.env,
      shell: false,
    });

    let buf = "";
    const append = (chunk: Buffer) => {
      buf += chunk.toString();
      // Keep memory bounded on very chatty runs.
      if (buf.length > 1_000_000) buf = buf.slice(-1_000_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const log = buf.split("\n").slice(-tailLines).join("\n");
      resolve({ ok: exitCode === 0, exitCode, log });
    });

    child.on("error", (e) => {
      resolve({ ok: false, exitCode: 1, log: `Failed to spawn validation: ${e.message}` });
    });
  });
}
