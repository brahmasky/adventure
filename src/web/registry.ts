import {
  createFirecrawlProvider,
  type FirecrawlProviderConfig
} from "./providers/firecrawl.js";
import { createTavilyProvider, type TavilyProviderConfig } from "./providers/tavily.js";
import type { WebProvider, WebSearchRequest, WebSearchResult } from "./types.js";

export interface BuildWebChainDeps {
  tavilyConfig?: TavilyProviderConfig;
  firecrawlConfig?: FirecrawlProviderConfig;
}

/** Default chain when `HOUGE_WEB_PROVIDERS` is unset: Tavily primary, Firecrawl fallback. */
export const DEFAULT_WEB_PROVIDERS = "tavily,firecrawl";

/** Default results per search; bounds tokens + the global breaker's exposure. */
export const DEFAULT_WEB_MAX_RESULTS = 5;

function parseProviderNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env.HOUGE_WEB_PROVIDERS ?? DEFAULT_WEB_PROVIDERS;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error("HOUGE_WEB_PROVIDERS resolved to an empty provider chain");
  }
  return names;
}

/** Per-run result cap: `HOUGE_WEB_MAX_RESULTS` → code default. */
export function resolveWebMaxResults(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_WEB_MAX_RESULTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WEB_MAX_RESULTS;
}

/**
 * Resolve the ordered web-provider chain from the environment. Known providers:
 * `tavily`, `firecrawl`. Unknown names throw so misconfiguration fails loud.
 */
export function buildWebChain(
  env: NodeJS.ProcessEnv,
  deps: BuildWebChainDeps = {}
): WebProvider[] {
  return parseProviderNames(env).map((name) => {
    switch (name) {
      case "tavily":
        return createTavilyProvider(deps.tavilyConfig);
      case "firecrawl":
        return createFirecrawlProvider(deps.firecrawlConfig);
      default:
        throw new Error(`Unknown web provider: ${name}`);
    }
  });
}

/**
 * Try each provider in order. Returns the first `ok`; skips `unavailable` (e.g.
 * missing key); treats other failures as fallthrough. All-fail → one aggregated error.
 */
export async function searchWithChain(
  chain: WebProvider[],
  req: WebSearchRequest
): Promise<WebSearchResult> {
  const reasons: string[] = [];
  for (const provider of chain) {
    const result = await provider.search(req);
    if (result.ok) {
      return result;
    }
    const tag = result.unavailable ? "unavailable" : "error";
    reasons.push(`${result.provider}: ${result.error} (${tag})`);
  }
  return {
    ok: false,
    provider: "chain",
    error: reasons.length > 0 ? reasons.join("; ") : "no web providers configured"
  };
}
