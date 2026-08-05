import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PiHarness, type Outcome } from "./harness.js";

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
        try {
          const outcome = await harness.run(body);
          json(res, 200, outcome);
        } catch (e) {
          json(res, 500, {
            error: "run failed",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }

      if (req.method === "POST" && req.url === "/issue/comment") {
        try {
          const outcome = await harness.answer();
          json(res, 200, outcome);
        } catch (e) {
          json(res, 500, {
            error: "answer failed",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
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
