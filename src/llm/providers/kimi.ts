import type { LlmProvider, LlmRequest, LlmResult } from "../types.js";

export const KIMI_DEFAULT_MODEL = "kimi-k2-0711-preview";
export const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.ai";
export const KIMI_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Kimi's fetch shape mirrors anthropic's {@link FetchImpl} but additionally
 * carries an optional `signal`, so the provider can enforce a per-call timeout
 * via an `AbortController`. Default impl is `globalThis.fetch`.
 */
export type KimiFetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface KimiProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: KimiFetchImpl;
}

function extractContent(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.length === 0) return undefined;
  return content;
}

function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function createKimiProvider(config: KimiProviderConfig = {}): LlmProvider {
  return {
    name: "kimi-api",
    async answer(req: LlmRequest): Promise<LlmResult> {
      const apiKey = config.apiKey ?? process.env.KIMI_API_KEY;
      if (!apiKey) {
        return {
          ok: false,
          provider: "kimi-api",
          error: "KIMI_API_KEY is not set",
          unavailable: true
        };
      }

      const model =
        req.model ??
        config.model ??
        process.env.HOUGE_LLM_MODEL_KIMI ??
        process.env.HOUGE_LLM_MODEL ??
        KIMI_DEFAULT_MODEL;

      const base = config.baseUrl ?? process.env.HOUGE_KIMI_BASE_URL ?? KIMI_DEFAULT_BASE_URL;
      const url = `${base}/v1/chat/completions`;

      const timeoutMs =
        config.timeoutMs ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS_KIMI) ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS) ??
        KIMI_DEFAULT_TIMEOUT_MS;

      const body = {
        model,
        messages: [{ role: "user", content: req.question }],
        max_tokens: 1024
      };

      const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as KimiFetchImpl);

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let response: Awaited<ReturnType<KimiFetchImpl>>;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        const isAbort =
          timedOut ||
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        if (isAbort) {
          return {
            ok: false,
            provider: "kimi-api",
            error: `Kimi request timed out after ${timeoutMs}ms`
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, provider: "kimi-api", error: `Kimi request failed: ${message}` };
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return {
          ok: false,
          provider: "kimi-api",
          error: `Kimi request returned HTTP ${response.status}`
        };
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return {
          ok: false,
          provider: "kimi-api",
          error: "Kimi response missing message content"
        };
      }

      const answer = extractContent(data);
      if (answer === undefined) {
        return {
          ok: false,
          provider: "kimi-api",
          error: "Kimi response missing message content"
        };
      }

      return { ok: true, provider: "kimi-api", model, answer };
    }
  };
}
