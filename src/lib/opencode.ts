import { readFileSync } from "node:fs";
import {
  type Config,
  createOpencodeClient,
  createOpencodeServer,
  type Event,
} from "@opencode-ai/sdk";
import { mergeAgents } from "./agents.js";
import { MODEL, SERVER_TIMEOUT_MS } from "./config.js";
import { log } from "./log.js";

type Opencode = {
  client: ReturnType<typeof createOpencodeClient>;
  server: Awaited<ReturnType<typeof createOpencodeServer>>;
};

/**
 * The consumer repo's own opencode.json (cwd is the checkout when orchestrators run).
 * OpenCode loads it natively; we read it only to know what NOT to override.
 */
function loadRepoConfig(): Config {
  try {
    return JSON.parse(readFileSync("opencode.json", "utf8")) as Config;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      console.log("::notice::opencode.json present but unparseable; using factory defaults");
    return {};
  }
}

const repoConfig = loadRepoConfig();
// The repo's opencode.json model wins; the baked default only fills its absence.
// No per-prompt model is ever sent, so agent-level models in repo config also win.
const useFallbackModel = !repoConfig.model;

/**
 * Boots an in-process OpenCode server + client, runs `fn`, and ALWAYS closes the
 * server — a hung session otherwise consumes the entire Actions job timeout.
 */
export async function withOpencode<T>(
  fn: (oc: Opencode) => Promise<T>,
  configOverride: Config = {},
): Promise<T> {
  log(
    `opencode: booting server${useFallbackModel ? ` (fallback model ${MODEL.providerID}/${MODEL.modelID} — set one in opencode.json)` : " (model from repo opencode.json)"}`,
  );
  const server = await createOpencodeServer({
    timeout: SERVER_TIMEOUT_MS,
    config: {
      ...(useFallbackModel ? { model: `${MODEL.providerID}/${MODEL.modelID}` } : {}),
      agent: mergeAgents(repoConfig.agent),
      ...configOverride,
    },
  });
  log(`opencode: server up at ${server.url}`);
  const client = createOpencodeClient({ baseUrl: server.url });
  streamAgentEvents(client);
  try {
    return await fn({ client, server });
  } finally {
    server.close();
    log("opencode: server closed");
  }
}

/**
 * Background-tail the server's SSE event stream so the Actions log shows what the
 * agent is doing between "prompt sent" and "prompt returned": tool calls, file
 * edits, and errors. The stream ends when the server closes; failures here must
 * never break a run, so everything is swallowed.
 */
function streamAgentEvents(client: Opencode["client"]): void {
  void (async () => {
    // A tool part updates many times (streaming deltas); log each status once.
    const seen = new Set<string>();
    try {
      const events = await client.event.subscribe();
      for await (const event of events.stream as AsyncIterable<Event>) {
        switch (event.type) {
          case "message.part.updated": {
            const part = event.properties.part;
            if (part.type !== "tool" || part.state.status === "pending") break;
            const key = `${part.id}:${part.state.status}`;
            if (seen.has(key)) break;
            seen.add(key);
            const state = part.state;
            const detail = (
              state.status === "error"
                ? state.error
                : ("title" in state ? state.title : undefined) || JSON.stringify(state.input)
            )?.slice(0, 200);
            log(`opencode: [tool] ${part.tool} ${state.status}${detail ? ` — ${detail}` : ""}`);
            break;
          }
          case "file.edited":
            log(`opencode: [edit] ${event.properties.file}`);
            break;
          case "session.error":
            log(`opencode: [error] ${JSON.stringify(event.properties.error ?? {})}`);
            break;
          case "session.idle":
            log(`opencode: [idle] session ${event.properties.sessionID} finished its turn`);
            break;
        }
      }
    } catch {
      // Stream torn down (server closed) or unsupported — progress logging only.
    }
  })();
}

/**
 * Send a prompt and get back JSON matching `schema`. The SDK has no server-side
 * structured output, so this instructs the model to reply with bare JSON, parses the
 * text parts, and re-prompts with the parse error up to `retryCount` times.
 * Throws if the model can't produce parseable JSON after retries.
 */
export async function promptJSON<T>(
  client: Opencode["client"],
  sessionId: string,
  text: string,
  schema: object,
  agent?: string,
  retryCount = 2,
): Promise<T> {
  // ponytail: parse-only, no client-side schema validation — add ajv if shape drift bites.
  let prompt = `${text}

Respond with ONLY a JSON object matching this JSON Schema — no prose, no code fences:
${JSON.stringify(schema)}`;

  let lastError = "";
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    log(
      `opencode: structured prompt${agent ? ` (agent ${agent})` : ""}${attempt ? ` — JSON retry ${attempt}/${retryCount}` : ""}`,
    );
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        ...(agent ? { agent } : {}),
        parts: [{ type: "text", text: prompt }],
      },
    });

    const reply = (result.data?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
    try {
      return JSON.parse(reply.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as T;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      prompt = `Your previous reply was not valid JSON (${lastError}). Respond again with ONLY the JSON object, no prose, no code fences.`;
    }
  }
  throw new Error(`Structured output failed after ${retryCount} retries: ${lastError}`);
}

/** Inject context into a session without triggering an AI response (noReply). */
export async function injectContext(
  client: Opencode["client"],
  sessionId: string,
  text: string,
): Promise<void> {
  await client.session.prompt({
    path: { id: sessionId },
    body: { noReply: true, parts: [{ type: "text", text }] },
  });
}

/** Plain agentic prompt — used for implement/fix steps where the agent edits files. */
export async function promptAgent(
  client: Opencode["client"],
  sessionId: string,
  text: string,
  agent?: string,
): Promise<void> {
  log(`opencode: agentic prompt${agent ? ` (agent ${agent})` : ""} — this can take a while`);
  await client.session.prompt({
    path: { id: sessionId },
    body: {
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text }],
    },
  });
}
