import type { LlmAuditSink, LlmErrorKind } from "../llm/audit.js";
import { JEV_PROVIDER } from "../llm/metered-pricing.js";

/**
 * Thin audited client for TypeSafe's System One endpoint (Jev spec 2026-09-25). Plain `fetch`, not
 * the SDK: the SDK retries internally, which would hide attempts from the `llm_attempt` audit — here
 * every HTTP attempt is exactly one audit row. Zero runtime deps, so responses are validated by hand.
 */
export const JEV_MODEL = "jev-1.13.0";
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const BACKOFF_BASE_MS = 500;
const RETRY_AFTER_CAP_MS = 60_000;
const PROBABILITY_SUM_TOLERANCE = 0.01;
/** A model id is a short token (Codex B2): anything else is a parse failure, so a response that echoes
 *  prose in `model` can never be written to the audit or the ledger. */
const JEV_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface JevRequest {
  state: unknown;
  questions: Record<string, JevChoiceQuestion>;
}
export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevResult =
  | { ok: true; model: string; answers: Record<string, JevChoiceAnswer>; input_tokens: number; latency_ms: number }
  | { ok: false; reason: "no_key" | "fused" | "auth" | "error"; detail: string; error_kind?: LlmErrorKind };

export interface JevClientConfig {
  apiKey: string | undefined;
  audit: LlmAuditSink;
  meteredBreached: () => boolean;
  /** 0 = live shadow (record and drop); 3 = replay. Only 429 / 5xx / network errors retry. */
  retries: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Attempt =
  | { kind: "ok"; result: Extract<JevResult, { ok: true }>; output_tokens: number }
  | { kind: "fail"; outcome: "error" | "unavailable"; error_kind: LlmErrorKind; retryable: boolean; retryAfterMs?: number; detail: string };

export function createJevClient(config: JevClientConfig): (req: JevRequest) => Promise<JevResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (req: JevRequest): Promise<JevResult> => {
    if (!config.apiKey) {
      config.audit.record({ provider: JEV_PROVIDER, role: "", outcome: "unavailable", error_kind: "auth", latency_ms: 0 });
      return { ok: false, reason: "no_key", detail: "TYPESAFE_API_KEY is not set", error_kind: "auth" };
    }
    for (let attempt = 0; ; attempt += 1) {
      // Checked before EVERY attempt, not just the first: a retry that lands after the fuse
      // latches mid-run must not fetch (ADR 0019 ceiling covers jev).
      if (config.meteredBreached()) {
        return { ok: false, reason: "fused", detail: "metered fuse latched" };
      }
      const started = Date.now();
      const a = await attemptOnce(fetchImpl, config.apiKey, req, config.timeoutMs);
      const latency_ms = Date.now() - started;
      if (a.kind === "ok") {
        config.audit.record({
          provider: JEV_PROVIDER, role: "", outcome: "ok", model: a.result.model, latency_ms,
          usage: { input_tokens: a.result.input_tokens, output_tokens: a.output_tokens, cached_input_tokens: 0 }
        });
        return { ...a.result, latency_ms };
      }
      config.audit.record({ provider: JEV_PROVIDER, role: "", outcome: a.outcome, error_kind: a.error_kind, latency_ms });
      if (a.error_kind === "auth") return { ok: false, reason: "auth", detail: a.detail, error_kind: "auth" };
      if (!a.retryable || attempt >= config.retries) return { ok: false, reason: "error", detail: a.detail, error_kind: a.error_kind };
      await sleep(a.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** attempt);
    }
  };
}

type Validated<T> = { ok: true; value: T } | { ok: false; code: string };

/**
 * The abort timer stays armed for the whole attempt — fetch AND the body read — and is cleared
 * only in the outer `finally`. A slow/hanging `res.json()` must still time out: clearing the timer
 * right after `fetch()` resolves (the old bug) leaves nothing to abort a stalled body read.
 */
async function attemptOnce(fetchImpl: typeof fetch, apiKey: string, req: JevRequest, timeoutMs: number): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state: req.state, questions: req.questions }),
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return timedOut
        ? { kind: "fail", outcome: "error", error_kind: "timeout", retryable: false, detail: `timed out after ${timeoutMs}ms` }
        : { kind: "fail", outcome: "error", error_kind: "transport", retryable: true, detail: "network error" };
    }
    // Never echo the body into `detail`: a provider error may reflect the Authorization header.
    if (res.status === 401 || res.status === 403) {
      return { kind: "fail", outcome: "unavailable", error_kind: "auth", retryable: false, detail: `HTTP ${res.status}` };
    }
    // 422 names a malformed question: a code bug on our side, so it is never retried (spec §3.3).
    if (res.status === 422) {
      return { kind: "fail", outcome: "error", error_kind: "malformed_question", retryable: false, detail: "HTTP 422" };
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const after = Number(res.headers.get("retry-after"));
      const error_kind: LlmErrorKind = res.status === 429 ? "rate_limited" : res.status === 529 ? "overloaded" : "transport";
      return {
        kind: "fail", outcome: "error", error_kind, retryable: true, detail: `HTTP ${res.status}`,
        ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: Math.min(after * 1000, RETRY_AFTER_CAP_MS) } : {})
      };
    }
    if (!res.ok) return { kind: "fail", outcome: "error", error_kind: "other", retryable: false, detail: `HTTP ${res.status}` };
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return timedOut
        ? { kind: "fail", outcome: "error", error_kind: "timeout", retryable: false, detail: `timed out after ${timeoutMs}ms` }
        : { kind: "fail", outcome: "error", error_kind: "parse", retryable: false, detail: "response is not JSON" };
    }
    const parsed = validateResponse(body, req);
    return parsed.ok
      ? { kind: "ok", result: { ok: true, model: parsed.value.model, answers: parsed.value.answers, input_tokens: parsed.value.input_tokens, latency_ms: 0 }, output_tokens: parsed.value.output_tokens }
      : { kind: "fail", outcome: "error", error_kind: "parse", retryable: false, detail: `response failed validation: ${parsed.code}` };
  } finally {
    clearTimeout(timer);
  }
}

function validateResponse(
  body: unknown,
  req: JevRequest
): Validated<{ model: string; answers: Record<string, JevChoiceAnswer>; input_tokens: number; output_tokens: number }> {
  if (typeof body !== "object" || body === null) return { ok: false, code: "body_not_object" };
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string") return { ok: false, code: "model_missing" };
  if (!JEV_MODEL_ID.test(b.model)) return { ok: false, code: "model_invalid" };
  if (typeof b.answers !== "object" || b.answers === null) return { ok: false, code: "answers_missing" };
  const usage = b.usage as Record<string, unknown> | undefined;
  if (typeof usage?.input_tokens !== "number") return { ok: false, code: "usage_input_tokens_missing" };
  const output_tokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const answers: Record<string, JevChoiceAnswer> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    const raw = (b.answers as Record<string, unknown>)[id];
    if (raw === undefined) return { ok: false, code: `answer_missing:${id}` };
    const answer = validateChoice(raw, Object.keys(question.criteria));
    if (!answer.ok) return answer;
    answers[id] = answer.value;
  }
  return { ok: true, value: { model: b.model, answers, input_tokens: usage.input_tokens, output_tokens } };
}

function validateChoice(raw: unknown, options: string[]): Validated<JevChoiceAnswer> {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "answer_not_object" };
  const a = raw as Record<string, unknown>;
  if (a.type !== "choice" || typeof a.choice !== "string") return { ok: false, code: "not_choice" };
  if (!options.includes(a.choice)) return { ok: false, code: "choice_not_option" };
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) return { ok: false, code: "confidence_out_of_range" };
  if (typeof a.probabilities !== "object" || a.probabilities === null) return { ok: false, code: "probabilities_missing" };
  const probs = a.probabilities as Record<string, unknown>;
  if (Object.keys(probs).length !== options.length || !options.every((o) => typeof probs[o] === "number")) {
    return { ok: false, code: "probability_keys" };
  }
  const sum = options.reduce((s, o) => s + (probs[o] as number), 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return { ok: false, code: "probability_sum" };
  return { ok: true, value: { choice: a.choice, probabilities: probs as Record<string, number>, confidence: a.confidence } };
}
