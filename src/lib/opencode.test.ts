import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK module before importing the wrapper under test.
const closeSpy = vi.fn(() => {});
const createServerMock = vi.fn();
const createClientMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: createServerMock,
  createOpencodeClient: createClientMock,
}));

// Import after the mock is registered.
const { withOpencode, promptJSON, injectContext } = await import("./opencode.js");

/** Build a fake client whose session.prompt returns canned results in sequence. */
function fakeClient(...promptResults: unknown[]) {
  let call = 0;
  return {
    session: {
      create: vi.fn(async () => ({ data: { id: "sess_1" } })),
      prompt: vi.fn(
        async (_req: unknown) => promptResults[Math.min(call++, promptResults.length - 1)],
      ),
    },
  };
}

/** A prompt result whose assistant reply is the given text. */
function textReply(text: string) {
  return { data: { info: {}, parts: [{ type: "text", text }] } };
}

beforeEach(() => {
  createServerMock.mockReset();
  createServerMock.mockResolvedValue({ url: "http://127.0.0.1:1", close: closeSpy });
  createClientMock.mockReset();
  closeSpy.mockClear();
});

describe("withOpencode", () => {
  it("closes the server even when the callback throws", async () => {
    createClientMock.mockReturnValue(fakeClient({}));

    await expect(
      withOpencode(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("closes the server on the happy path and returns the value", async () => {
    createClientMock.mockReturnValue(fakeClient({}));

    const out = await withOpencode(async () => 42);
    expect(out).toBe(42);
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

describe("promptJSON", () => {
  it("parses a bare JSON reply", async () => {
    const client = fakeClient(textReply('{"risk": "low"}'));
    const out = await promptJSON<{ risk: string }>(client as never, "sess_1", "hi", {});
    expect(out).toEqual({ risk: "low" });
  });

  it("strips code fences around the JSON", async () => {
    const client = fakeClient(textReply('```json\n{"ok": true}\n```'));
    const out = await promptJSON<{ ok: boolean }>(client as never, "sess_1", "hi", {});
    expect(out).toEqual({ ok: true });
  });

  it("re-prompts on invalid JSON and succeeds on retry", async () => {
    const client = fakeClient(textReply("sorry, here it is:"), textReply('{"ok": true}'));
    const out = await promptJSON<{ ok: boolean }>(client as never, "sess_1", "hi", {});
    expect(out).toEqual({ ok: true });
    expect(client.session.prompt).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on persistently invalid JSON", async () => {
    const client = fakeClient(textReply("not json"));
    await expect(promptJSON(client as never, "sess_1", "hi", {}, undefined, 2)).rejects.toThrow(
      /Structured output failed after 2 retries/,
    );
    expect(client.session.prompt).toHaveBeenCalledTimes(3);
  });

  it("includes the schema in the prompt text", async () => {
    const client = fakeClient(textReply('{"ok": true}'));
    const schema = { type: "object" };
    await promptJSON(client as never, "sess_1", "hi", schema);
    const call = client.session.prompt.mock.calls[0][0] as {
      body: { parts: { text: string }[] };
    };
    expect(call.body.parts[0].text).toContain(JSON.stringify(schema));
  });
});

describe("agent selection", () => {
  it("withOpencode boots the server with the baked agent roster", async () => {
    createClientMock.mockReturnValue(fakeClient({}));
    await withOpencode(async () => 0);
    const call = createServerMock.mock.calls[0][0] as {
      config: { agent: Record<string, unknown> };
    };
    expect(Object.keys(call.config.agent)).toContain("builder");
    expect(Object.keys(call.config.agent)).toContain("bugfixer");
  });

  it("promptJSON passes the agent name through to the prompt body", async () => {
    const client = fakeClient(textReply('{"ok": true}'));
    await promptJSON(client as never, "sess_1", "hi", {}, "reviewer");
    const call = client.session.prompt.mock.calls[0][0] as { body: { agent?: string } };
    expect(call.body.agent).toBe("reviewer");
  });
});

describe("injectContext", () => {
  it("sends noReply so it doesn't trigger an agent response", async () => {
    const client = fakeClient({ data: {} });
    await injectContext(client as never, "sess_1", "house rules");
    const call = client.session.prompt.mock.calls[0][0] as { body: { noReply: boolean } };
    expect(call.body.noReply).toBe(true);
  });
});
