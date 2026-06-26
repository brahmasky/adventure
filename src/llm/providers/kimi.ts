import type { LlmProvider } from "../types.js";
import {
  createOpenAiCompatProvider,
  type OpenAiCompatConfig,
  type OpenAiCompatFetchImpl,
  type OpenAiCompatSpec
} from "./openai-compat.js";

// Conservative, stable LAST-RESORT default — `moonshot-v1-auto` is an alias that
// won't 404 as specific k2.x versions retire. Set HOUGE_LLM_MODEL_KIMI to pin a
// specific model (e.g. kimi-k2.7-code-highspeed). Never hardcode a churning id here.
export const KIMI_DEFAULT_MODEL = "moonshot-v1-auto";
export const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.ai";
export const KIMI_DEFAULT_TIMEOUT_MS = 30_000;
// Output token budget. 1024 was too small for research synthesis — a long answer
// (or a reasoning model spending tokens internally) returned empty content, failing
// the chain. 4096 fits synthesis with headroom; override with HOUGE_KIMI_MAX_TOKENS.
export const KIMI_DEFAULT_MAX_TOKENS = 4096;

/** Back-compat alias — kimi's fetch impl is the shared OpenAI-compatible shape. */
export type KimiFetchImpl = OpenAiCompatFetchImpl;
/** Back-compat alias — kimi's config is the shared OpenAI-compatible config. */
export type KimiProviderConfig = OpenAiCompatConfig;

const KIMI_SPEC: OpenAiCompatSpec = {
  name: "kimi-api",
  apiKeyEnv: "KIMI_API_KEY",
  modelEnv: "HOUGE_LLM_MODEL_KIMI",
  baseUrlEnv: "HOUGE_KIMI_BASE_URL",
  timeoutEnvSuffix: "KIMI",
  maxTokensEnv: "HOUGE_KIMI_MAX_TOKENS",
  defaultModel: KIMI_DEFAULT_MODEL,
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
  defaultTimeoutMs: KIMI_DEFAULT_TIMEOUT_MS,
  defaultMaxTokens: KIMI_DEFAULT_MAX_TOKENS,
  chatCompletionsPath: "/v1/chat/completions",
  errorLabel: "Kimi"
};

export function createKimiProvider(config: KimiProviderConfig = {}): LlmProvider {
  return createOpenAiCompatProvider(KIMI_SPEC, config);
}
