import { readFileSync } from "node:fs";
import {
  type Config,
  createOpencodeClient,
  createOpencodeServer,
  type Event,
} from "@opencode-ai/sdk";
import { mergeAgents } from "./agents.js";
import { MODEL, PROVIDER_TIMEOUT_MS, SERVER_TIMEOUT_MS } from "./config.js";
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
      provider: { [MODEL.providerID]: { options: { timeout: PROVIDER_TIMEOUT_MS } } },
      ...configOverride,
    },
  });
  log(`opencode: server up at ${server.url}`);
  const client = createOpencodeClient({
    baseUrl: server.url,
    fetch: (req) => {
      // @ts-expect-error Undici extensions — session.prompt() is a sync POST that blocks
      // until the full AI response is ready, which routinely exceeds 5 min.
      req.timeout = false;
      // @ts-expect-error
      req.headersTimeout = false;
      return globalThis.fetch(req);
    },
  });
  // The SSE client retries forever on disconnect (setTimeout backoff, no attempt
  // cap), so it MUST be aborted or the process never exits once the server dies.
  const events = new AbortController();
  streamAgentEvents(client, events.signal);
  try {
    return await fn({ client, server });
  } finally {
    events.abort();
    server.close();
    log("opencode: server closed");
  }
}

/** Flatten to one line and cap, so a single event can't swamp the log. */
function brief(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Background-tail the server's SSE event stream so the Actions log shows what the
 * agent is doing between "prompt sent" and "prompt returned". The stream ends when
 * the server closes; failures here must never break a run, so everything is
 * swallowed. Parts stream as deltas, so everything is deduped and capped — the aim
 * is a readable trace, not a transcript.
 */
function streamAgentEvents(client: Opencode["client"], signal: AbortSignal): void {
  void (async () => {
    const seen = new Set<string>();
    /** Log once per key; returns false when this event was already reported. */
    const first = (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };

    try {
      const events = await client.event.subscribe({ signal });
      for await (const event of events.stream as AsyncIterable<Event>) {
        switch (event.type) {
          case "message.part.updated": {
            const part = event.properties.part;
            if (part.type === "tool") {
              const state = part.state;
              if (state.status === "pending" || !first(`${part.id}:${state.status}`)) break;
              const detail =
                state.status === "error"
                  ? state.error
                  : ("title" in state ? state.title : undefined) || JSON.stringify(state.input);
              log(
                `opencode: [tool] ${part.tool} ${state.status}${detail ? ` — ${brief(detail)}` : ""}`,
              );
            } else if (part.type === "text") {
              // Text arrives as deltas — report it once, when the part is finished.
              if (!part.time?.end || part.synthetic || part.ignored) break;
              if (!part.text.trim() || !first(`text:${part.id}`)) break;
              log(`opencode: [say] ${brief(part.text, 500)}`);
            }
            break;
          }
          case "message.updated": {
            const info = event.properties.info;
            if (info.role !== "assistant" || !info.time.completed) break;
            if (!first(`msg:${info.id}`)) break;
            const t = info.tokens;
            log(
              `opencode: [usage] ${info.providerID}/${info.modelID} in=${t.input} out=${t.output} ` +
                `cache=${t.cache.read}r/${t.cache.write}w cost=$${info.cost.toFixed(4)}` +
                `${info.finish ? ` finish=${info.finish}` : ""}`,
            );
            break;
          }
          case "todo.updated": {
            const todos = event.properties.todos;
            if (!todos.length) break;
            const done = todos.filter((t) => t.status === "completed").length;
            const current = todos.find((t) => t.status === "in_progress");
            if (!first(`todo:${done}/${todos.length}:${current?.id ?? ""}`)) break;
            log(
              `opencode: [todo] ${done}/${todos.length} done` +
                `${current ? ` — now: ${brief(current.content, 120)}` : ""}`,
            );
            break;
          }
          // Nothing can answer a permission prompt in CI, so an unanswered one is a
          // stalled run — always surface it.
          case "permission.updated":
            log(
              `opencode: [permission] ${event.properties.type} requested — ${brief(event.properties.title, 200)}`,
            );
            break;
          case "permission.replied":
            log(`opencode: [permission] replied ${event.properties.response}`);
            break;
          case "session.status": {
            // Provider retries are a common cause of a slow run; busy/idle is noise.
            const status = event.properties.status;
            if (status.type !== "retry") break;
            log(`opencode: [retry] attempt ${status.attempt} — ${brief(status.message, 200)}`);
            break;
          }
          case "session.compacted":
            log("opencode: [compact] context compacted — earlier turns summarised");
            break;
          case "file.edited":
            log(`opencode: [edit] ${event.properties.file}`);
            break;
          case "session.error":
            log(`opencode: [error] ${brief(JSON.stringify(event.properties.error ?? {}), 500)}`);
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
  agent?: string,
): Promise<void> {
  await client.session.prompt({
    path: { id: sessionId },
    body: { noReply: true, parts: [{ type: "text", text }], ...(agent ? { agent } : {}) },
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
