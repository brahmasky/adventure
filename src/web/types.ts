/**
 * Web-read provider seam (Tier-1, per ADR 0006). Mirrors the LLM provider chain:
 * pluggable providers, ordered fallback, env-configured. Search results are
 * UNTRUSTED DATA — callers must treat `content` as reference material, never as
 * instructions (the synthesis step frames it that way and cites `url`s).
 */

export interface WebSearchRequest {
  query: string;
  max_results?: number;
  /**
   * Only results published within the last N days. Best-effort, provider-mapped
   * (Tavily `topic:"news"+days`, Firecrawl `tbs`); a provider that cannot honour
   * it returns its normal results — callers still check `published`.
   */
  freshness_days?: number;
}

export interface WebResult {
  title: string;
  url: string;
  /** A snippet / extract. Untrusted data — never executed as instructions. */
  content: string;
  /** Publication date when the provider supplies one. Untrusted data. */
  published?: string;
}

export type WebSearchResult =
  | { ok: true; provider: string; results: WebResult[] }
  | { ok: false; provider: string; error: string; unavailable?: boolean };

export interface WebProvider {
  name: string;
  search(req: WebSearchRequest): Promise<WebSearchResult>;
}

/**
 * Minimal fetch shape (subset of `globalThis.fetch`) with an optional `signal`
 * for per-call timeouts. Injectable so provider tests need no live network.
 */
export type WebFetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
