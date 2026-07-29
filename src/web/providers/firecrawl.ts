import type { WebFetchImpl, WebProvider, WebResult, WebSearchRequest, WebSearchResult } from "../types.js";

export const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";
export const FIRECRAWL_DEFAULT_TIMEOUT_MS = 30_000;
export const FIRECRAWL_DEFAULT_MAX_RESULTS = 5;

export interface FirecrawlProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: WebFetchImpl;
}

/** Parse Firecrawl's `{ success, data: [{ url, title, description }] }` shape (locked against the live API). */
function parseResults(data: unknown): WebResult[] | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const list = (data as { data?: unknown }).data;
  if (!Array.isArray(list)) return undefined;
  const parsed: WebResult[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url === "string" && typeof r.title === "string") {
      // Search returns `description`; a scraped result may carry `markdown`.
      const content =
        typeof r.markdown === "string" && r.markdown.length > 0
          ? r.markdown
          : typeof r.description === "string"
            ? r.description
            : "";
      parsed.push({ title: r.title, url: r.url, content });
    }
  }
  return parsed;
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Firecrawl freshness rides Google's `tbs` window — the coarsest bucket that covers N days. */
function tbsForDays(days: number): string {
  if (days <= 1) return "qdr:d";
  if (days <= 7) return "qdr:w";
  if (days <= 31) return "qdr:m";
  return "qdr:y";
}

export function createFirecrawlProvider(config: FirecrawlProviderConfig = {}): WebProvider {
  return {
    name: "firecrawl",
    async search(req: WebSearchRequest): Promise<WebSearchResult> {
      // Single source of truth (ADR 0015): key via `config.apiKey` only — no ambient env fallback.
      const apiKey = config.apiKey;
      if (!apiKey) {
        return { ok: false, provider: "firecrawl", error: "FIRECRAWL_API_KEY is not set", unavailable: true };
      }

      const base = config.baseUrl ?? process.env.HOUGE_FIRECRAWL_BASE_URL ?? FIRECRAWL_DEFAULT_BASE_URL;
      const timeoutMs = config.timeoutMs ?? numericEnv(process.env.HOUGE_WEB_TIMEOUT_MS) ?? FIRECRAWL_DEFAULT_TIMEOUT_MS;
      const limit = req.max_results ?? FIRECRAWL_DEFAULT_MAX_RESULTS;
      const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as WebFetchImpl);

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let response: Awaited<ReturnType<WebFetchImpl>>;
      try {
        response = await fetchImpl(`${base}/v1/search`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query: req.query,
            limit,
            ...(req.freshness_days !== undefined && req.freshness_days > 0
              ? { tbs: tbsForDays(req.freshness_days) }
              : {})
          }),
          signal: controller.signal
        });
      } catch (error) {
        const isAbort =
          timedOut ||
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        if (isAbort) {
          return { ok: false, provider: "firecrawl", error: `Firecrawl request timed out after ${timeoutMs}ms` };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, provider: "firecrawl", error: `Firecrawl request failed: ${message}` };
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return { ok: false, provider: "firecrawl", error: `Firecrawl request returned HTTP ${response.status}` };
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return { ok: false, provider: "firecrawl", error: "Firecrawl response was not valid JSON" };
      }

      const results = parseResults(data);
      if (results === undefined) {
        return { ok: false, provider: "firecrawl", error: "Firecrawl response missing data array" };
      }
      return { ok: true, provider: "firecrawl", results };
    }
  };
}
