import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { answerWithChain, buildLlmChain } from "../llm/registry.js";
import type { LlmProvider } from "../llm/types.js";
import {
  DEFAULT_LLM_MODEL,
  type FetchImpl,
  type LlmAnswerConfig
} from "../llm/providers/anthropic.js";

export { DEFAULT_LLM_MODEL };
export type { FetchImpl, LlmAnswerConfig };

export interface LlmAnswerAdapterConfig extends LlmAnswerConfig {
  /** Inject a pre-built provider chain (tests). Bypasses env-based resolution. */
  chain?: LlmProvider[];
}

export function createLlmAnswerAdapter(
  config: LlmAnswerAdapterConfig = {}
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  const { chain: injectedChain, ...anthropicConfig } = config;

  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const question = input.question;
    if (typeof question !== "string" || question.length === 0) {
      return { ok: false, error: "question must be a non-empty string" };
    }

    const chain = injectedChain ?? buildLlmChain(process.env, { anthropicConfig });
    const result = await answerWithChain(chain, { question });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return {
      ok: true,
      output: {
        question,
        answer: result.answer,
        model: result.model,
        provider: result.provider
      }
    };
  };
}
