import type { WebFetchImpl, WebProvider, WebResult, WebSearchRequest, WebSearchResult } from "../types.js";

export const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
export const TAVILY_DEFAULT_TIMEOUT_MS = 20_000;
export const TAVILY_DEFAULT_MAX_RESULTS = 5;

export interface TavilyProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: WebFetchImpl;
}

/** Parse Tavily's `{ results: [{ url, title, content, ... }] }` shape (locked against the live API). */
function parseResults(data: unknown): WebResult[] | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return undefined;
  const parsed: WebResult[] = [];
  for (const item of results) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url === "string" && typeof r.title === "string") {
      parsed.push({
        title: r.title,
        url: r.url,
        content: typeof r.content === "string" ? r.content : ""
      });
    }
  }
  return parsed;
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function createTavilyProvider(config: TavilyProviderConfig = {}): WebProvider {
  return {
    name: "tavily",
    async search(req: WebSearchRequest): Promise<WebSearchResult> {
      // Single source of truth (ADR 0015): key via `config.apiKey` only — no ambient env fallback.
      const apiKey = config.apiKey;
      if (!apiKey) {
        return { ok: false, provider: "tavily", error: "TAVILY_API_KEY is not set", unavailable: true };
      }

      const base = config.baseUrl ?? process.env.HOUGE_TAVILY_BASE_URL ?? TAVILY_DEFAULT_BASE_URL;
      const timeoutMs = config.timeoutMs ?? numericEnv(process.env.HOUGE_WEB_TIMEOUT_MS) ?? TAVILY_DEFAULT_TIMEOUT_MS;
      const max_results = req.max_results ?? TAVILY_DEFAULT_MAX_RESULTS;
      const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as WebFetchImpl);

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let response: Awaited<ReturnType<WebFetchImpl>>;
      try {
        response = await fetchImpl(`${base}/search`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ query: req.query, max_results }),
          signal: controller.signal
        });
      } catch (error) {
        const isAbort =
          timedOut ||
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        if (isAbort) {
          return { ok: false, provider: "tavily", error: `Tavily request timed out after ${timeoutMs}ms` };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, provider: "tavily", error: `Tavily request failed: ${message}` };
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return { ok: false, provider: "tavily", error: `Tavily request returned HTTP ${response.status}` };
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return { ok: false, provider: "tavily", error: "Tavily response was not valid JSON" };
      }

      const results = parseResults(data);
      if (results === undefined) {
        return { ok: false, provider: "tavily", error: "Tavily response missing results" };
      }
      return { ok: true, provider: "tavily", results };
    }
  };
}
