import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { answerWithChain, buildLlmChain } from "../llm/registry.js";
import type { LlmProvider } from "../llm/types.js";
import type { LlmUsage } from "../run/llm-usage.js";
import type { SecretBroker } from "../config/secret-broker.js";
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
  /**
   * Secrets firewall (ADR 0015): when armed, the provider API keys come from the broker instead of
   * `process.env` (which has been stripped). Absent (firewall OFF) → the chain builder reads env.
   * Ignored when a `chain` is injected (tests bring their own providers).
   */
  broker?: SecretBroker;
  /**
   * Dual-LLM reader chain (ADR 0014): resolve the provider chain from THIS comma-separated list
   * instead of `HOUGE_LLM_PROVIDERS`. Used only for the quarantined reader (role "reader") so it
   * can run a cheap, cross-family leg. Absent ⇒ the planner chain. Ignored when a `chain` is
   * injected (tests bring their own providers).
   */
  providers?: string;
}

export function createLlmAnswerAdapter(
  config: LlmAnswerAdapterConfig = {}
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  const { chain: injectedChain, onUsage, broker, providers } = config;

  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const question = input.question;
    if (typeof question !== "string" || question.length === 0) {
      return { ok: false, error: "question must be a non-empty string" };
    }

    // Thread the construction-time `onUsage` hook into the chain's provider configs, tagging each
    // completion with its provider name (the provider's own hook only carries usage+model). An
    // injected chain (tests) is used as-is.
    const chain = injectedChain ?? buildLlmChain(
      providers ? { ...process.env, HOUGE_LLM_PROVIDERS: providers } : process.env,
      onUsage
        ? {
            piConfig: { onUsage: (usage, model) => onUsage("pi", usage, model) },
            kimiConfig: { onUsage: (usage, model) => onUsage("kimi-api", usage, model) },
            // gemini-api reports OpenAI-style usage; agy-cli (print mode) emits none, so it has no hook.
            geminiConfig: { onUsage: (usage, model) => onUsage("gemini-api", usage, model) }
          }
        : {},
      broker
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
