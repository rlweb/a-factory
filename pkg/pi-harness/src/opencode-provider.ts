import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const GO_URL = "https://opencode.ai/zen/go/v1";

export const opencodeExtension: InlineExtension = {
  name: "opencode-provider",
  factory: (pi) => {
    const apiKey = process.env.OPENCODE_API_KEY;
    if (!apiKey) return;

    pi.registerProvider("oc-sdk-go", {
      apiKey,
      api: "openai-completions" as const,
      baseUrl: GO_URL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      models: [
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek v4 Pro",
          api: "openai-completions",
          baseUrl: GO_URL,
          contextWindow: 204800,
          maxTokens: 131072,
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          input: ["text"],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek v4 Flash",
          api: "openai-completions",
          baseUrl: GO_URL,
          contextWindow: 204800,
          maxTokens: 131072,
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          input: ["text"],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    });
  },
};
