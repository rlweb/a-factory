import { sshExec, HARNESS_PORT } from "./exe.js";

/** Polls via SSH until the VM's pi-harness /health endpoint answers, or throws once the
 *  budget is spent. */
export function waitForServer(vm: string, timeoutMs = 180_000, intervalMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      sshExec(vm, `curl -s http://localhost:${HARNESS_PORT}/health`);
      return;
    } catch {
      // VM still booting / harness not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`harness on ${vm} never came up (${timeoutMs}ms budget)`);
    }
  }
}

/** Starts a task on the harness. Non-blocking: the harness runs in the background and the
 *  endpoint returns {status:"started"} immediately. */
export function startSession(
  vm: string,
  owner: string,
  repo: string,
  issueNumber: number,
): { status: string; alreadyRunning?: boolean } {
  const body = JSON.stringify({ owner, repo, issueNumber }).replace(/'/g, "'\\''");
  const cmd = `curl -s -X POST http://localhost:${HARNESS_PORT}/ -H 'Content-Type: application/json' -d '${body}'`;
  const out = sshExec(vm, cmd);
  return JSON.parse(out) as { status: string; alreadyRunning?: boolean };
}

/** Resumes a pending question on the harness. Fire-and-forget: the curl is detached on the
 *  VM (nohup + background), so the SSH call returns immediately and the Action never waits
 *  for the harness to finish the resumed run. */
export function resumeSession(vm: string): void {
  const cmd = `nohup curl -s -X POST http://localhost:${HARNESS_PORT}/issue/comment >/dev/null 2>&1 &`;
  sshExec(vm, cmd);
}
