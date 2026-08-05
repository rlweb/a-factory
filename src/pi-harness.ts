export interface HarnessOutcome {
  status: "done" | "question" | "failed";
  branch?: string;
  questions?: string[];
  prUrl?: string;
  verify?: string;
  messages?: Array<{ role: string; content: string }>;
}

export async function startSession(
  url: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<HarnessOutcome> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, issueNumber }),
  });
  return (await res.json()) as HarnessOutcome;
}

export async function resumeSession(url: string): Promise<HarnessOutcome> {
  const res = await fetch(`${url}/issue/comment`, { method: "POST" });
  return (await res.json()) as HarnessOutcome;
}

/** Polls until the VM's pi-harness server answers, or throws after the budget is spent. */
export async function waitForServer(
  baseUrl: string,
  timeoutMs = 180_000,
  intervalMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error(`harness at ${baseUrl} never came up`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
