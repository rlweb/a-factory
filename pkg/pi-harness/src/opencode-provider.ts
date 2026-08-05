import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "oc-sdk-go";
const GO_URL = "https://opencode.ai/zen/go/v1";

/** Registers the opencode Go provider directly on the model runtime. The provider must be
 *  registered on the *same* ModelRuntime instance the harness queries — registering it as an
 *  extension routes it through the loader's own runtime, which the SDK session path never
 *  flushes into the runtime we call getModel() on. */
export function registerOpencodeProvider(modelRuntime: ModelRuntime): void {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    throw new Error("OPENCODE_API_KEY is not set — cannot register the oc-sdk-go provider");
  }

  modelRuntime.registerProvider(PROVIDER_ID, {
    apiKey,
    api: "openai-completions",
    baseUrl: GO_URL,
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
      },
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
      },
    ],
  });
}
