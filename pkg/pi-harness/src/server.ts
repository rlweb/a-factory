import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PiHarness } from "./harness.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
  });
}

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  return JSON.parse(raw) as T;
}

export function createHarnessServer(harness: PiHarness, port: number): void {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        const status = harness.getStatus();
        json(res, 200, status);
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/") {
        const body = await jsonBody<{ owner: string; repo: string; issueNumber: number }>(
          req,
        );
        if (!body.owner || !body.repo || !body.issueNumber) {
          json(res, 400, { error: "owner, repo, issueNumber required" });
          return;
        }

        if (harness.state === "done" || harness.state === "failed") {
          json(res, 409, { error: "task already finished", state: harness.state });
          return;
        }
        if (harness.isActive()) {
          json(res, 200, { status: "started", alreadyRunning: true });
          return;
        }

        // Non-blocking: start the task in the background and return immediately. Status is
        // polled via GET /; questions and PRs surface as GitHub comments.
        harness.run(body).catch((e) => {
          console.error("harness run failed:", e instanceof Error ? e.message : String(e));
        });
        json(res, 200, { status: "started", issueNumber: body.issueNumber });
        return;
      }

      if (req.method === "POST" && req.url === "/issue/comment") {
        if (harness.state !== "question") {
          json(res, 409, { error: "not awaiting an answer", state: harness.state });
          return;
        }

        // Non-blocking resume: feed the latest human comment to the agent in the background.
        harness.answer().catch((e) => {
          console.error("harness resume failed:", e instanceof Error ? e.message : String(e));
        });
        json(res, 200, { status: "started" });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, {
        error: "server error",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`pi-harness listening on :${port}`);
  });

  process.on("SIGTERM", async () => {
    await harness.dispose();
    server.close();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await harness.dispose();
    server.close();
    process.exit(0);
  });
}
