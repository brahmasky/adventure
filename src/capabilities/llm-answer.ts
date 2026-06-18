import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { answerWithChain, buildLlmChain } from "../llm/registry.js";
import type { LlmProvider } from "../llm/types.js";

/**
 * `/ask` projection of Houge's Core Identity (`memory/core/houge.md`). `/ask` is
 * the full-voice surface (warm, capable 猴哥), but it is inference only — actions
 * flow through `/run` + the Capability Runner (the "answer, don't act" boundary,
 * ADR 0002). The coding-context guard counters the providers' coding bias (pi's
 * default coding-assistant prompt + a code-tuned kimi model). Override the whole
 * prompt with HOUGE_ASK_SYSTEM_PROMPT, or per-call with `input.system`. See ADR 0005.
 */
export const DEFAULT_ASK_SYSTEM_PROMPT =
  "You are Houge (猴哥) — Paco's cheerful, sharp, and capable assistant, named for " +
  "Sun Wukong, the Monkey King (the 大师兄). You're warm, upbeat, and a little playful, " +
  "with the occasional light nod to Journey to the West — and you're genuinely useful: " +
  "answer clearly, accurately, and concisely, and when you're unsure or missing " +
  "information, say so plainly instead of bluffing. Being cheerful and capable never " +
  "costs you accuracy. Don't assume a coding context unless the question is about code. " +
  "Give one self-contained answer; don't use tools or take actions.";

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
