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
import type { LlmProvider, LlmRequest, LlmResult } from "./types.js";

export interface BuildLlmChainDeps {
  piConfig?: PiProviderConfig;
  kimiConfig?: KimiProviderConfig;
  geminiConfig?: GeminiProviderConfig;
  agyConfig?: AgyCliProviderConfig;
}

/** Default chain when `HOUGE_LLM_PROVIDERS` is unset. */
export const DEFAULT_LLM_PROVIDERS = "pi,kimi-api";

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
 * pi/kimi legs (Phase 3.4). `HOUGE_LLM_PROVIDERS` (a comma-separated, ordered list) defaults
 * to `"pi,kimi-api"`; opt into the 4-leg chain `pi,agy-cli,kimi-api,gemini-api` via the env.
 * Unknown provider names throw a clear error so misconfiguration fails loud.
 */
export function buildLlmChain(
  env: NodeJS.ProcessEnv,
  deps: BuildLlmChainDeps = {}
): LlmProvider[] {
  const names = parseProviderNames(env);

  return names.map((name) => {
    switch (name) {
      case "pi":
        return createPiProvider(deps.piConfig);
      case "kimi-api":
        return createKimiProvider(deps.kimiConfig);
      case "agy-cli":
        return createAgyCliProvider(deps.agyConfig);
      case "gemini-api":
        return createGeminiProvider(deps.geminiConfig);
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
 * Try each provider in order. Returns the first `ok:true`; skips providers that
 * report `unavailable`; treats other failures as fallthrough. If every provider
 * fails, returns one aggregated `ok:false` with per-provider reasons joined.
 */
export async function answerWithChain(
  chain: LlmProvider[],
  req: LlmRequest
): Promise<LlmResult> {
  const reasons: string[] = [];

  for (const provider of chain) {
    const result = await provider.answer(req);
    if (result.ok) {
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
