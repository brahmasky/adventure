import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { answerWithChain, buildLlmChain } from "../llm/registry.js";
import type { LlmProvider } from "../llm/types.js";

/**
 * Neutral `/ask` persona. `/ask` is plain question answering, NOT agentic
 * coding: this replaces pi's default coding-assistant system prompt (and seeds
 * the API providers' system message) so answers are direct, honest about
 * uncertainty, and not skewed toward a software-engineering framing. Override
 * per-deployment with HOUGE_ASK_SYSTEM_PROMPT, or per-call with `input.system`.
 */
export const DEFAULT_ASK_SYSTEM_PROMPT =
  "You are a direct, neutral question-answering assistant. Answer the user's " +
  "question clearly, accurately, and concisely in plain text suitable for a " +
  "chat message. Do not assume a software-engineering or coding context unless " +
  "the question is explicitly about code. If you are uncertain or lack enough " +
  "information, say so plainly rather than guessing. Do not use tools, take " +
  "actions, or ask follow-up questions; give your best single self-contained answer.";

/** Resolve the system prompt: per-call override → env override → neutral default. */
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
