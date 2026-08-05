import { sshExec, HARNESS_PORT } from "./exe.js";

export interface HarnessOutcome {
  status: "done" | "question" | "failed";
  branch?: string;
  questions?: string[];
  prUrl?: string;
  verify?: string;
  messages?: Array<{ role: string; content: string }>;
}

function curl(vm: string, method: string, path: string, body?: unknown): HarnessOutcome {
  let cmd = `curl -s -X ${method} http://localhost:${HARNESS_PORT}${path}`;
  if (body !== undefined) {
    const json = JSON.stringify(body).replace(/'/g, "'\\''");
    cmd += ` -H 'Content-Type: application/json' -d '${json}'`;
  }
  const out = sshExec(vm, cmd);
  return JSON.parse(out) as HarnessOutcome;
}

export function startSession(vm: string, owner: string, repo: string, issueNumber: number): HarnessOutcome {
  return curl(vm, "POST", "/", { owner, repo, issueNumber });
}

export function resumeSession(vm: string): HarnessOutcome {
  return curl(vm, "POST", "/issue/comment");
}

/** Polls via SSH until the VM's pi-harness answers, or throws after the budget is spent. */
export function waitForServer(vm: string, timeoutMs = 180_000, intervalMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      sshExec(vm, `curl -s http://localhost:${HARNESS_PORT}/health`);
      return;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error(`harness on ${vm} never came up`);
  }
}
