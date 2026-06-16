import { createAnthropicProvider, type LlmAnswerConfig } from "./providers/anthropic.js";
import { createPiProvider, type PiProviderConfig } from "./providers/pi.js";
import type { LlmProvider, LlmRequest, LlmResult } from "./types.js";

export interface BuildLlmChainDeps {
  anthropicConfig?: LlmAnswerConfig;
  piConfig?: PiProviderConfig;
}

/**
 * Resolve the ordered provider chain from the environment.
 *
 * Known providers: `anthropic` (HTTP) and `pi` (hardened CLI).
 * `HOUGE_LLM_PROVIDERS` (a comma-separated, ordered list) defaults to
 * `"anthropic"` — `pi` is selectable but not yet the default. Unknown provider
 * names throw a clear error so misconfiguration fails loud.
 */
export function buildLlmChain(
  env: NodeJS.ProcessEnv,
  deps: BuildLlmChainDeps = {}
): LlmProvider[] {
  const raw = env.HOUGE_LLM_PROVIDERS ?? "anthropic";
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    throw new Error("HOUGE_LLM_PROVIDERS resolved to an empty provider chain");
  }

  return names.map((name) => {
    switch (name) {
      case "anthropic":
        return createAnthropicProvider(deps.anthropicConfig);
      case "pi":
        return createPiProvider(deps.piConfig);
      default:
        throw new Error(`Unknown LLM provider: ${name}`);
    }
  });
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
