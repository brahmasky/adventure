import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { answerWithChain, buildLlmChain } from "../llm/registry.js";
import type { LlmProvider } from "../llm/types.js";
import { ASK_DISCIPLINE, FALLBACK_IDENTITY, GUARDRAILS } from "../prompt/composer.js";

/**
 * Thin fallback `/ask` system prompt — used only when a caller invokes this adapter
 * without an explicit `input.system`. The live `/ask` path composes the real prompt
 * via the prompt composer (identity from `houge.md` + discipline + learned lessons,
 * ADR 0009) and passes it as `input.system`; the persona is NOT duplicated here. The
 * env override `HOUGE_ASK_SYSTEM_PROMPT` still wins where set.
 */
export const DEFAULT_ASK_SYSTEM_PROMPT = [FALLBACK_IDENTITY, ASK_DISCIPLINE, GUARDRAILS].join("\n\n");

/** Resolve the system prompt: per-call override → env override → identity default. */
function resolveSystemPrompt(input: Record<string, unknown>): string {
  if (typeof input.system === "string" && input.system.length > 0) return input.system;
  const fromEnv = process.env.HOUGE_ASK_SYSTEM_PROMPT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return DEFAULT_ASK_SYSTEM_PROMPT;
}

export interface LlmAnswerAdapterConfig {
  /** Inject a pre-built provider chain (tests). Bypasses env-based resolution. */
  chain?: LlmProvider[];
}

export function createLlmAnswerAdapter(
  config: LlmAnswerAdapterConfig = {}
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  const { chain: injectedChain } = config;

  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const question = input.question;
    if (typeof question !== "string" || question.length === 0) {
      return { ok: false, error: "question must be a non-empty string" };
    }

    const chain = injectedChain ?? buildLlmChain(process.env);
    const system = resolveSystemPrompt(input);
    const result = await answerWithChain(chain, { question, system });

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
