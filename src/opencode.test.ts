import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const createOpencodeClient = vi.fn();
  return { createOpencodeClient };
});

vi.mock("@opencode-ai/sdk", () => ({ createOpencodeClient: h.createOpencodeClient }));
vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
}));

import { connect, createSession, promptJSON, type Client } from "./opencode.js";

interface TextPart {
  type: "text";
  text: string;
}

function promptClient(replies: string[]): Client {
  return {
    session: {
      prompt: vi.fn(async () => ({ data: { parts: replies.map((text): TextPart => ({ type: "text", text })) } })),
    },
  } as unknown as Client;
}

describe("connect", () => {
  it("creates a client for the given base URL", () => {
    const fake = { marker: "client" };
    h.createOpencodeClient.mockReturnValue(fake);
    expect(connect("http://example:4096")).toBe(fake);
    expect(h.createOpencodeClient).toHaveBeenCalledWith({ baseUrl: "http://example:4096" });
  });
});

describe("createSession", () => {
  it("returns the session id", async () => {
    const client = { session: { create: vi.fn(async () => ({ data: { id: "sess-1" } })) } } as unknown as Client;
    await expect(createSession(client, "issue #3")).resolves.toBe("sess-1");
    expect(client.session.create).toHaveBeenCalledWith({ body: { title: "issue #3" } });
  });

  it("throws when the session has no id", async () => {
    const client = { session: { create: vi.fn(async () => ({ data: {} })) } } as unknown as Client;
    await expect(createSession(client, "issue #3")).rejects.toThrow("no id");
  });
});

describe("promptJSON", () => {
  it("parses a plain JSON reply", async () => {
    const client = promptClient(['{"status":"done"}']);
    await expect(promptJSON(client, "sess-1", "go", { type: "object" })).resolves.toEqual({
      status: "done",
    });
    expect(client.session.prompt).toHaveBeenCalledWith({
      path: { id: "sess-1" },
      body: { parts: [{ type: "text", text: expect.stringContaining("JSON Schema") }] },
    });
  });

  it("strips a json code fence around the reply", async () => {
    const client = promptClient(["```json\n{\"a\":1}\n```"]);
    await expect(promptJSON(client, "sess-1", "go", { type: "object" })).resolves.toEqual({ a: 1 });
  });

  it("retries once when the first reply is not JSON", async () => {
    const client = {
      session: {
        prompt: vi
          .fn()
          .mockResolvedValueOnce({ data: { parts: [{ type: "text", text: "no, i refuse" }] } })
          .mockResolvedValueOnce({ data: { parts: [{ type: "text", text: "{\"a\":2}" }] } }),
      },
    } as unknown as Client;
    await expect(promptJSON(client, "sess-1", "go", { type: "object" })).resolves.toEqual({ a: 2 });
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
  });

  it("throws when every attempt returns invalid JSON", async () => {
    const client = promptClient(["not json", "still not json"]);
    await expect(promptJSON(client, "sess-1", "go", { type: "object" })).rejects.toThrow(
      "structured output failed",
    );
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
  });

  it("treats an empty reply as invalid and retries", async () => {
    const client = {
      session: {
        prompt: vi
          .fn()
          .mockResolvedValueOnce({ data: { parts: [] } })
          .mockResolvedValueOnce({ data: { parts: [{ type: "text", text: "{\"a\":3}" }] } }),
      },
    } as unknown as Client;
    await expect(promptJSON(client, "sess-1", "go", { type: "object" })).resolves.toEqual({ a: 3 });
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
  });
});
