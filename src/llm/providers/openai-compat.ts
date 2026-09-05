import type { LlmProvider, LlmRequest, LlmResult } from "../types.js";
import type { LlmUsage } from "../../run/llm-usage.js";

/**
 * A minimal subset of `globalThis.fetch` that additionally carries an optional
 * `signal`, so a provider can enforce a per-call timeout via an `AbortController`.
 * Default impl is `globalThis.fetch`. Shared by every OpenAI-compatible provider
 * (kimi, gemini).
 */
export type OpenAiCompatFetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Per-call configuration shared by all OpenAI-compatible providers. */
export interface OpenAiCompatConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: OpenAiCompatFetchImpl;
  /**
   * Phase 3.1 telemetry seam. Fired once per SUCCESSFUL completion with the call's normalized token
   * usage and the actual model id — the W3 caller wires this to `recordLlmCall`. Optional: existing
   * callers are unaffected, and the provider's `LlmResult` shape is unchanged (usage rides this side
   * channel, not the result). NON-NEGOTIABLE: carries ONLY counts/metadata — never prompt or response
   * bodies.
   */
  onUsage?: (usage: LlmUsage, model: string) => void;
}

/**
 * The static per-provider identity an OpenAI-compatible chat endpoint needs. Everything that differs
 * between, say, kimi and gemini lives here (names, defaults, env var names, the completions path and
 * the human error label); the request/response machinery in {@link createOpenAiCompatProvider} is
 * identical across all of them.
 */
export interface OpenAiCompatSpec {
  /** Provider name surfaced on `LlmResult.provider` (e.g. "kimi-api", "gemini-api"). */
  name: string;
  /** Env var holding the API key (e.g. "KIMI_API_KEY", "GEMINI_API_KEY"). */
  apiKeyEnv: string;
  /** Env var that pins the model (e.g. "HOUGE_LLM_MODEL_KIMI"). */
  modelEnv: string;
  /** Env var that overrides the base URL (e.g. "HOUGE_KIMI_BASE_URL"). */
  baseUrlEnv: string;
  /** Suffix for the per-provider timeout override `HOUGE_LLM_TIMEOUT_MS_<SUFFIX>` (e.g. "KIMI"). */
  timeoutEnvSuffix: string;
  /** Env var that overrides the output token budget (e.g. "HOUGE_KIMI_MAX_TOKENS"). */
  maxTokensEnv: string;
  defaultModel: string;
  defaultBaseUrl: string;
  defaultTimeoutMs: number;
  defaultMaxTokens: number;
  /** Path appended to the base URL for chat completions (kimi: "/v1/chat/completions"). */
  chatCompletionsPath: string;
  /** Human label used in error messages (e.g. "Kimi" → "Kimi request timed out"). */
  errorLabel: string;
}

/**
 * Normalize the OpenAI-compatible `usage` block into {@link LlmUsage}. `prompt_tokens`/
 * `completion_tokens` are the OpenAI field names; cached prompt tokens (when reported) live under
 * `prompt_tokens_details.cached_tokens`. Returns `null` when no usable `usage` block is present.
 *
 * D3: `completion_tokens` alone UNDERCOUNTS output on engines that bill reasoning/thinking tokens.
 * Google's OpenAI-compat endpoint was measured undercounting 5–11x (12/54/611 on a trivial probe),
 * and the metered-$ ceiling (ADR 0019) sums these same figures — a fuse cannot trip on spend it
 * cannot see. Output is therefore `max(completion_tokens, total_tokens - prompt_tokens)`.
 *
 * Why a max and not a sum. Vendors disagree on whether reasoning is inside `completion_tokens`:
 * OpenAI's schema puts `completion_tokens_details.reasoning_tokens` INSIDE it, while Google reports
 * neither field and leaves the gap visible only in `total_tokens`. Adding `reasoning_tokens` — which
 * the design doc proposed, by analogy to `normalizeCodexUsage`, whose engine really does report the
 * two disjointly — would double-count on every spec-compliant engine and latch the fuse at half the
 * real spend. Worse, branching on the mere PRESENCE of `reasoning_tokens` would skip the total-based
 * derivation whenever a vendor sent `reasoning_tokens: 0`, restoring the exact 11x undercount this
 * fix exists to remove. The max needs no knowledge of which convention an engine follows: it is
 * exact for OpenAI (total - prompt == completion), exact for Google (the gap), and cannot regress
 * below the reported completion count. `reasoning_tokens` is deliberately not read.
 *
 * The metered legs are out of every default chain as of the CLI-only migration, but re-enabling one
 * must not silently reintroduce D3.
 */
function extractUsage(data: unknown): LlmUsage | null {
  if (typeof data !== "object" || data === null) return null;
  const usage = (data as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const toNum = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  const details = u.prompt_tokens_details;
  const cached =
    typeof details === "object" && details !== null
      ? toNum((details as Record<string, unknown>).cached_tokens)
      : 0;

  const prompt = toNum(u.prompt_tokens);
  const completion = toNum(u.completion_tokens);
  // The gap is only meaningful when the engine actually reported BOTH ends of it. With
  // `prompt_tokens` absent, `toNum` yields 0 and the derivation would read the entire prompt as
  // output — at output pricing, on the one leg the spend fuse is guarding. A missing or nonsensical
  // total yields a derived value <= completion, so the max discards it.
  const derivedFromTotal =
    u.prompt_tokens !== undefined && u.total_tokens !== undefined
      ? toNum(u.total_tokens) - prompt
      : 0;
  const output = Math.max(completion, derivedFromTotal);

  return {
    input_tokens: prompt,
    output_tokens: output,
    cached_input_tokens: cached
  };
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

/**
 * Build an {@link LlmProvider} that speaks the OpenAI `chat/completions` protocol. The static
 * differences live in {@link OpenAiCompatSpec}; the wire machinery (auth, timeout via AbortController,
 * system-message shaping, content/usage extraction, error mapping) is shared. kimi and gemini are both
 * instantiated from this factory — identical behavior, one place to fix.
 */
export function createOpenAiCompatProvider(
  spec: OpenAiCompatSpec,
  config: OpenAiCompatConfig = {}
): LlmProvider {
  return {
    name: spec.name,
    async answer(req: LlmRequest): Promise<LlmResult> {
      // Single source of truth (ADR 0015): the key arrives ONLY via `config.apiKey`, populated by
      // the chain builder from the SecretBroker (firewall ON) or from env (firewall OFF). There is
      // deliberately NO `?? process.env[…]` fallback — the daemon holds no ambient credential.
      const apiKey = config.apiKey;
      if (!apiKey) {
        return {
          ok: false,
          provider: spec.name,
          error: `${spec.apiKeyEnv} is not set`,
          unavailable: true
        };
      }

      const model = req.model ?? config.model ?? process.env[spec.modelEnv] ?? spec.defaultModel;

      const base = config.baseUrl ?? process.env[spec.baseUrlEnv] ?? spec.defaultBaseUrl;
      const url = `${base}${spec.chatCompletionsPath}`;

      const timeoutMs =
        config.timeoutMs ??
        numericEnv(process.env[`HOUGE_LLM_TIMEOUT_MS_${spec.timeoutEnvSuffix}`]) ??
        numericEnv(process.env.HOUGE_LLM_TIMEOUT_MS) ??
        spec.defaultTimeoutMs;

      // Houge-controlled system prompt (the neutral persona) goes first as a standard OpenAI-style
      // system message when present.
      const messages = [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.question }
      ];
      const body = {
        model,
        messages,
        max_tokens: numericEnv(process.env[spec.maxTokensEnv]) ?? spec.defaultMaxTokens
      };

      const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as OpenAiCompatFetchImpl);

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let response: Awaited<ReturnType<OpenAiCompatFetchImpl>>;
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
            provider: spec.name,
            error: `${spec.errorLabel} request timed out after ${timeoutMs}ms`
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, provider: spec.name, error: `${spec.errorLabel} request failed: ${message}` };
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return {
          ok: false,
          provider: spec.name,
          error: `${spec.errorLabel} request returned HTTP ${response.status}`
        };
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return {
          ok: false,
          provider: spec.name,
          error: `${spec.errorLabel} response missing message content`
        };
      }

      const answer = extractContent(data);
      if (answer === undefined) {
        return {
          ok: false,
          provider: spec.name,
          error: `${spec.errorLabel} response missing message content`
        };
      }

      // Telemetry side channel (Phase 3.1): surface normalized usage without altering the result
      // shape. Best-effort — a missing usage block or a throwing hook never fails the answer.
      if (config.onUsage) {
        const usage = extractUsage(data);
        if (usage) {
          try {
            config.onUsage(usage, model);
          } catch {
            // a failing telemetry hook must never break a good answer
          }
        }
      }

      return { ok: true, provider: spec.name, model, answer };
    }
  };
}
