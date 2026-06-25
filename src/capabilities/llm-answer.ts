import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { answerWithChain, buildLlmChain } from "../llm/registry.js";
import type { LlmProvider } from "../llm/types.js";
import type { LlmUsage } from "../run/llm-usage.js";
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
  /**
   * Phase 3.1 (W3) cheap-chain telemetry seam. Fired once per SUCCESSFUL kimi/pi completion with the
   * provider name + normalized token usage + the actual model id. The CoreWorker wires this to
   * `recordLlmCall` for the cheap-chain roles (classify/answer). Bound at adapter-construction time
   * (NOT passed through the capability `input`, which the runner canonicalizes/hashes). Counts/
   * metadata ONLY — never prompt or response bodies. Ignored when a `chain` is injected (tests).
   */
  onUsage?: (provider: string, usage: LlmUsage, model: string) => void;
}

export function createLlmAnswerAdapter(
  config: LlmAnswerAdapterConfig = {}
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  const { chain: injectedChain, onUsage } = config;

  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const question = input.question;
    if (typeof question !== "string" || question.length === 0) {
      return { ok: false, error: "question must be a non-empty string" };
    }

    // Thread the construction-time `onUsage` hook into the chain's provider configs, tagging each
    // completion with its provider name (the provider's own hook only carries usage+model). An
    // injected chain (tests) is used as-is.
    const chain = injectedChain ?? buildLlmChain(
      process.env,
      onUsage
        ? {
            piConfig: { onUsage: (usage, model) => onUsage("pi", usage, model) },
            kimiConfig: { onUsage: (usage, model) => onUsage("kimi-api", usage, model) }
          }
        : {}
    );
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
