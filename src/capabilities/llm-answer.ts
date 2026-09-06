import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { answerWithChain, buildLlmChain } from "../llm/registry.js";
import type { LlmProvider } from "../llm/types.js";
import type { LlmAuditSink } from "../llm/audit.js";
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
   * THE AUDIT CHOKEPOINT (spec 2026-09-04 §"Slice 2"; review B1). REQUIRED, no default: every
   * leg the chain tries is recorded through this sink. It replaces the opt-in `onUsage` hook that
   * produced D4 (whole call paths recording nothing because nobody passed it). Build one with
   * `RunStore.llmAuditSink(scope)`; tests that are not about telemetry use the helper in
   * `tests/helpers/llm-audit.ts`.
   */
  audit: LlmAuditSink;
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
  /**
   * Metered-$ ceiling (ADR 0019): threaded to `buildLlmChain` so a latched fuse drops the
   * metered legs (kimi-api/gemini-api) at construction. The daemon/worker wire this to the
   * store's cheap latch read. Ignored when a `chain` is injected (tests bring their own).
   */
  meteredBreached?: () => boolean;
}

export function createLlmAnswerAdapter(
  config: LlmAnswerAdapterConfig
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  const { chain: injectedChain, audit, broker, providers, meteredBreached } = config;

  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const question = input.question;
    if (typeof question !== "string" || question.length === 0) {
      return { ok: false, error: "question must be a non-empty string" };
    }

    // An injected chain (tests) is used as-is; otherwise resolve it from env (+ the metered latch).
    const chain = injectedChain ?? buildLlmChain(
      providers ? { ...process.env, HOUGE_LLM_PROVIDERS: providers } : process.env,
      meteredBreached ? { meteredBreached } : {},
      broker
    );
    const system = resolveSystemPrompt(input);
    const result = await answerWithChain(chain, { question, system }, audit);

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
