import type { ToolAdapterResult } from "../tools/tool-registry.js";
import {
  fetchUrl,
  resolveHttpFetchDeny,
  resolveHttpFetchMaxBytes,
  resolveHttpFetchTimeoutMs
} from "../web/http-fetch.js";
import type { HttpFetchDeps } from "../web/http-fetch.js";

export interface HttpFetchAdapterConfig {
  /** Inject the DNS/transport seams (tests). Bypasses real sockets. */
  deps?: HttpFetchDeps;
  /** Override the env-resolved limits (tests). */
  timeoutMs?: number;
  maxBytes?: number;
  deny?: string[];
}

/**
 * `http_fetch` capability (external_read). Fetches ONE public URL and returns its text
 * content as DATA; it never acts. The SSRF floor (resolve-and-pin, blocked ranges,
 * no-follow redirects, byte/wall-clock caps) lives in src/web/http-fetch.ts — this
 * adapter only validates the model's input shape and flattens errors.
 */
export function createHttpFetchAdapter(
  config: HttpFetchAdapterConfig = {}
): (input: Record<string, unknown>) => Promise<ToolAdapterResult> {
  return async (input: Record<string, unknown>): Promise<ToolAdapterResult> => {
    const url = input.url;
    if (typeof url !== "string" || url.trim().length === 0) {
      return { ok: false, error: "url must be a non-empty string" };
    }
    const method = typeof input.method === "string" && input.method.trim().length > 0 ? input.method.trim().toUpperCase() : "GET";
    if (method !== "GET" && method !== "HEAD") {
      return { ok: false, error: 'method must be "GET" or "HEAD"' };
    }

    const outcome = await fetchUrl(
      { url: url.trim(), method },
      {
        timeoutMs: config.timeoutMs ?? resolveHttpFetchTimeoutMs(process.env),
        maxBytes: config.maxBytes ?? resolveHttpFetchMaxBytes(process.env),
        deny: config.deny ?? resolveHttpFetchDeny(process.env)
      },
      config.deps ?? {}
    );
    if (!outcome.ok) {
      return { ok: false, error: outcome.error };
    }
    return { ok: true, output: { ...outcome.result } };
  };
}
