import { createOpencodeClient } from "@opencode-ai/sdk";
import * as core from "@actions/core";

type Client = ReturnType<typeof createOpencodeClient>;

export function connect(baseUrl: string): Client {
  return createOpencodeClient({ baseUrl });
}

export async function createSession(client: Client, title: string): Promise<string> {
  const session = await client.session.create({ body: { title } });
  const id = session.data?.id;
  if (!id) throw new Error("opencode: session.create returned no id");
  return id;
}

/** Sends a prompt and parses the reply as JSON matching `schema`, retrying once on a
 * malformed reply. */
export async function promptJSON<T>(
  client: Client,
  sessionId: string,
  text: string,
  schema: object,
  retries = 1,
): Promise<T> {
  let prompt = `${text}

Respond with ONLY a JSON object matching this JSON Schema — no prose, no code fences:
${JSON.stringify(schema)}`;

  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    core.info(`opencode: prompt${attempt ? ` (retry ${attempt}/${retries})` : ""}`);
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: prompt }] },
    });
    const reply = (result.data?.parts ?? [])
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    try {
      return JSON.parse(reply.replace(/^\s*```(?:json)?|```\s*$/g, "").trim()) as T;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      prompt = `Your previous reply was not valid JSON (${lastError}). Respond again with ONLY the JSON object, no prose, no code fences.`;
    }
  }
  throw new Error(`opencode: structured output failed after ${retries} retries: ${lastError}`);
}
