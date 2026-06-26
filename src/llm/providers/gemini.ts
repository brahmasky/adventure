import type { LlmProvider } from "../types.js";
import {
  createOpenAiCompatProvider,
  type OpenAiCompatConfig,
  type OpenAiCompatFetchImpl,
  type OpenAiCompatSpec
} from "./openai-compat.js";

// General-model leg for the research/answer surface (Phase 3.4): a non-coding model that
// synthesizes prose without over-producing like the coding-tuned pi/kimi legs. `gemini-3.5-flash`
// is the current latest Flash on the public API (validated live); override with
// HOUGE_LLM_MODEL_GEMINI.
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";
// Google's OpenAI-compatibility endpoint. The base already includes `/v1beta/openai`; the shared
// factory appends `/chat/completions`. Override with HOUGE_GEMINI_BASE_URL.
export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_DEFAULT_TIMEOUT_MS = 30_000;
// Generous output budget: 3.5-flash spends "thinking" tokens against the SAME max_tokens budget, so a
// tight cap can leave no room for the visible answer (the kimi 1024→empty-content trap). 8192 fits
// synthesis + thinking with headroom; override with HOUGE_GEMINI_MAX_TOKENS.
export const GEMINI_DEFAULT_MAX_TOKENS = 8192;

/** Alias — gemini's fetch impl is the shared OpenAI-compatible shape. */
export type GeminiFetchImpl = OpenAiCompatFetchImpl;
/** Alias — gemini's config is the shared OpenAI-compatible config. */
export type GeminiProviderConfig = OpenAiCompatConfig;

const GEMINI_SPEC: OpenAiCompatSpec = {
  name: "gemini-api",
  apiKeyEnv: "GEMINI_API_KEY",
  modelEnv: "HOUGE_LLM_MODEL_GEMINI",
  baseUrlEnv: "HOUGE_GEMINI_BASE_URL",
  timeoutEnvSuffix: "GEMINI",
  maxTokensEnv: "HOUGE_GEMINI_MAX_TOKENS",
  defaultModel: GEMINI_DEFAULT_MODEL,
  defaultBaseUrl: GEMINI_DEFAULT_BASE_URL,
  defaultTimeoutMs: GEMINI_DEFAULT_TIMEOUT_MS,
  defaultMaxTokens: GEMINI_DEFAULT_MAX_TOKENS,
  chatCompletionsPath: "/chat/completions",
  errorLabel: "Gemini"
};

export function createGeminiProvider(config: GeminiProviderConfig = {}): LlmProvider {
  return createOpenAiCompatProvider(GEMINI_SPEC, config);
}
