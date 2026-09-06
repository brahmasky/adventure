import {
  createKimiProvider,
  KIMI_DEFAULT_TIMEOUT_MS,
  type KimiProviderConfig
} from "./providers/kimi.js";
import {
  createPiProvider,
  PI_DEFAULT_TIMEOUT_MS,
  type PiProviderConfig
} from "./providers/pi.js";
import {
  createGeminiProvider,
  GEMINI_DEFAULT_TIMEOUT_MS,
  type GeminiProviderConfig
} from "./providers/gemini.js";
import {
  createAgyCliProvider,
  AGY_DEFAULT_TIMEOUT_MS,
  type AgyCliProviderConfig
} from "./providers/agy-cli.js";
import { randomBytes } from "node:crypto";
import type { LlmProvider, LlmRequest, LlmResult } from "./types.js";
import { classifyLlmError, type LlmAuditSink } from "./audit.js";
import type { SecretBroker } from "../config/secret-broker.js";
import { METERED_PROVIDERS } from "./metered-pricing.js";

export interface BuildLlmChainDeps {
  piConfig?: PiProviderConfig;
  kimiConfig?: KimiProviderConfig;
  geminiConfig?: GeminiProviderConfig;
  agyConfig?: AgyCliProviderConfig;
  /**
   * Metered-$ ceiling (ADR 0019): when this returns true, the metered legs
   * (kimi-api/gemini-api) are dropped from the chain before construction — the
   * flat-rate legs keep working. Latch-driven and cheap (a single-row read); the
   * expensive spend sums run once per daemon tick, not here. Absent → no filtering.
   */
  meteredBreached?: () => boolean;
}

/**
 * Default chain when `HOUGE_LLM_PROVIDERS` is unset. CLI-only by construction: both legs are
 * flat-rate subscription CLIs, so no runtime path reaches a metered pay-per-token API unless an
 * operator names one explicitly. The metered providers below stay buildable for exactly that
 * escape hatch — re-enabling one is an env change, not a redeploy.
 */
export const DEFAULT_LLM_PROVIDERS = "pi,agy-cli";

/**
 * Fallback when the metered-ceiling filter would empty the chain (an all-metered
 * `HOUGE_LLM_PROVIDERS`): a zero-leg chain would silence Houge entirely, which is a
 * worse failure than one more flat-rate call — so fall back to the flat-rate default.
 */
export const METERED_FALLBACK_PROVIDERS: readonly string[] = ["pi"];

/**
 * Slack added on top of the chain budget for the CapabilityRunner's wall-clock
 * cap (`timeout_ms`). The runner cap MUST exceed the chain budget so a healthy
 * chain that is legitimately falling through every provider is never killed
 * mid-flight. See {@link resolveChainBudgetMs}.
 */
export const RUNNER_TIMEOUT_BUFFER_MS = 15_000;

/** Per-provider default timeouts — the single source of truth lives in each
 * provider module; this map only wires the chain-name to that constant. */
const PROVIDER_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  pi: PI_DEFAULT_TIMEOUT_MS,
  "kimi-api": KIMI_DEFAULT_TIMEOUT_MS,
  "agy-cli": AGY_DEFAULT_TIMEOUT_MS,
  "gemini-api": GEMINI_DEFAULT_TIMEOUT_MS
};

/** Per-provider override env var suffixes (`HOUGE_LLM_TIMEOUT_MS_<SUFFIX>`). */
const PROVIDER_TIMEOUT_ENV_SUFFIX: Record<string, string> = {
  pi: "PI",
  "kimi-api": "KIMI",
  "agy-cli": "AGY",
  "gemini-api": "GEMINI"
};

function parseProviderNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env.HOUGE_LLM_PROVIDERS ?? DEFAULT_LLM_PROVIDERS;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    throw new Error("HOUGE_LLM_PROVIDERS resolved to an empty provider chain");
  }
  return names;
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the ordered provider chain from the environment.
 *
 * Known providers: `pi` + `agy-cli` (hardened CLIs) and `kimi-api` + `gemini-api`
 * (OpenAI-compatible HTTP). `agy-cli`/`gemini-api` are general-model legs (Gemini Flash)
 * for the research/answer surface, so synthesis doesn't over-produce like the coding-tuned
 * pi/kimi legs (Phase 3.4). `HOUGE_LLM_PROVIDERS` (a comma-separated, ordered list) defaults to
 * {@link DEFAULT_LLM_PROVIDERS} — CLI-only, no metered leg. Naming a metered leg here is the
 * deliberate escape hatch for both flat-rate CLIs being down at once.
 * Unknown provider names throw a clear error so misconfiguration fails loud.
 */
export function buildLlmChain(
  env: NodeJS.ProcessEnv,
  deps: BuildLlmChainDeps = {},
  broker?: SecretBroker
): LlmProvider[] {
  let names = parseProviderNames(env);

  // Metered-$ ceiling (ADR 0019): with the fuse latched, drop the metered legs BEFORE
  // mapping. NEVER a zero-leg chain — an all-metered list falls back to the flat-rate
  // default instead of silencing Houge.
  if (deps.meteredBreached?.()) {
    const flatRate = names.filter((name) => !METERED_PROVIDERS.has(name));
    if (flatRate.length !== names.length) {
      // Loud, because this can UNDO the documented escape hatch: an operator who set
      // HOUGE_LLM_PROVIDERS to a metered leg because both CLIs were down gets that leg dropped
      // the moment the ceiling latches, and the fallback is the very leg that was failing.
      console.warn(
        `[llm-chain] metered ceiling latched — dropped ${names.filter((n) => METERED_PROVIDERS.has(n)).join(",")} from the chain; ` +
          (flatRate.length > 0
            ? `continuing on ${flatRate.join(",")}`
            : `no flat-rate leg remained, falling back to ${METERED_FALLBACK_PROVIDERS.join(",")}`)
      );
    }
    names = flatRate.length > 0 ? flatRate : [...METERED_FALLBACK_PROVIDERS];
  }

  // Single source of truth for the HTTP providers' key (ADR 0015): resolve it HERE — from the
  // broker when the firewall is armed, else from env — and populate each provider's `config.apiKey`.
  // The providers no longer read `process.env` themselves. When the firewall is OFF the resolved
  // value is exactly what the provider used to read from env, so behavior is byte-identical.
  const kimiKey = broker ? broker.kimiKey() : env.KIMI_API_KEY;
  const geminiKey = broker ? broker.geminiKey() : env.GEMINI_API_KEY;

  return names.map((name) => {
    switch (name) {
      case "pi":
        return createPiProvider(deps.piConfig);
      case "kimi-api":
        return createKimiProvider({ ...deps.kimiConfig, ...(kimiKey !== undefined ? { apiKey: kimiKey } : {}) });
      case "agy-cli":
        return createAgyCliProvider(deps.agyConfig);
      case "gemini-api":
        return createGeminiProvider({ ...deps.geminiConfig, ...(geminiKey !== undefined ? { apiKey: geminiKey } : {}) });
      default:
        throw new Error(`Unknown LLM provider: ${name}`);
    }
  });
}

/**
 * Sum each configured provider's per-provider timeout to get the chain's total
 * wall-clock budget. This MUST mirror what the providers themselves use so the
 * derived runner cap (`resolveChainBudgetMs + RUNNER_TIMEOUT_BUFFER_MS`) never
 * kills a healthy, falling-through chain. The per-provider defaults are imported
 * from each provider module (single source of truth — no drift).
 *
 * Resolution per provider mirrors the providers: `HOUGE_LLM_TIMEOUT_MS_<NAME>`,
 * then `HOUGE_LLM_TIMEOUT_MS`, then the provider's own default constant.
 */
export function resolveChainBudgetMs(env: NodeJS.ProcessEnv): number {
  const names = parseProviderNames(env);
  const fallback = numericEnv(env.HOUGE_LLM_TIMEOUT_MS);

  return names.reduce((sum, name) => {
    const suffix = PROVIDER_TIMEOUT_ENV_SUFFIX[name];
    const specific = suffix ? numericEnv(env[`HOUGE_LLM_TIMEOUT_MS_${suffix}`]) : undefined;
    const fallbackDefault = PROVIDER_DEFAULT_TIMEOUT_MS[name] ?? 0;
    return sum + (specific ?? fallback ?? fallbackDefault);
  }, 0);
}

/**
 * Try each provider in order. Returns the first `ok:true`; skips providers that report
 * `unavailable`; treats other failures as fallthrough. If every provider fails, returns one
 * aggregated `ok:false` with per-provider reasons joined.
 *
 * THE AUDIT CHOKEPOINT (spec 2026-09-04 §"Slice 2"): every leg attempted is recorded through the
 * REQUIRED `audit` sink — success, error, or unavailable — with its latency, its position in the
 * invocation (`attempt_group` + `leg_index`, so "agy failed then pi served" is reconstructable),
 * and on success the usage the provider returned. Providers only parse; this loop is the one
 * place that reports, so coverage is structural. `error_kind` is classified HERE, per leg, never
 * from the joined aggregate. Recording is best-effort: a sink failure logs and never fails an
 * answer. The `role` is filled by the scoped sink — the chain does not know a call's purpose.
 *
 * A leg that fails while a LATER leg succeeds is ALSO logged to the console — that line is the
 * D1 visibility signal that would have shown agy dead for three months. Counts and provider
 * names only, never prompt or response content.
 */
export async function answerWithChain(
  chain: LlmProvider[],
  req: LlmRequest,
  audit: LlmAuditSink
): Promise<LlmResult> {
  const reasons: string[] = [];
  const attempt_group = randomBytes(6).toString("hex");

  for (let leg_index = 0; leg_index < chain.length; leg_index++) {
    const provider = chain[leg_index]!;
    const t0 = Date.now();
    const result = await provider.answer(req);
    const latency_ms = Date.now() - t0;

    try {
      if (result.ok) {
        audit.record({
          provider: result.provider,
          role: "",
          outcome: "ok",
          model: result.model,
          latency_ms,
          attempt_group,
          leg_index,
          ...(result.usage ? { usage: result.usage } : {})
        });
      } else {
        audit.record({
          provider: result.provider,
          role: "",
          outcome: result.unavailable ? "unavailable" : "error",
          latency_ms,
          attempt_group,
          leg_index,
          error_kind: classifyLlmError(result.error)
        });
      }
    } catch (error) {
      console.warn(
        `[llm-chain] audit sink failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (result.ok) {
      if (reasons.length > 0) {
        console.warn(
          `[llm-chain] ${result.provider} served after ${reasons.length} leg(s) fell through: ${reasons.join("; ")}`
        );
      }
      return result;
    }
    const tag = result.unavailable ? "unavailable" : "error";
    reasons.push(`${result.provider}: ${result.error} (${tag})`);
  }

  return {
    ok: false,
    provider: "chain",
    error: reasons.length > 0 ? reasons.join("; ") : "no providers configured"
  };
}
