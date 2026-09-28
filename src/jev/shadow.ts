import type { Intent } from "../capabilities/intent.js";
import type { ChatTurnRow } from "../run/run-store.js";
import type { JevRequest, JevResult } from "./jev-client.js";
import { buildJevIntentRequest, langOf, type Lang } from "./intent-question.js";
import { llmLabel } from "./labels.js";

/**
 * The live intent shadow (Jev spec 2026-09-25 §"Live shadow" + 2026-09-26 amendments): Jev answers the
 * classifier's exact question, beside it, for measurement only. Nothing here may reject into a turn,
 * and nothing Jev returns reaches a prompt or gates an action — it goes to the ledger and nowhere else.
 */
export type JevShadowCall = (req: JevRequest) => Promise<JevResult>;
export type ShadowStatus = "ok" | "skipped_state_too_large" | "error" | "timeout" | "fused" | "no_key" | "auth";
export const JEV_SHADOW_TIMEOUT_MS = 5_000;
/** Backstop over the client's own abort (Codex B4): a shadow that never settles still yields a `timeout` row. */
export const JEV_SHADOW_DEADLINE_MS = 6_000;

export interface JevShadowOutcome {
  status: ShadowStatus;
  lang: Lang;
  jev?: { intent: string; confidence: number; probabilities: Record<string, number>; model: string; latency_ms: number };
  /** jev-client's code-owned failure string (HTTP status, timeout, validation code) — never provider prose. */
  jev_error?: string;
}

/** A type alias (not an interface) so it stays assignable to the ledger's Record payload. */
export type IntentShadowPayload = {
  status: ShadowStatus;
  llm_intent: Intent;
  llm_parsed: boolean;
  lang: Lang;
  modality: "text";
  jev_intent?: string;
  jev_confidence?: number;
  jev_probabilities?: Record<string, number>;
  jev_model?: string;
  jev_latency_ms?: number;
  jev_error?: string;
};

/** HOUGE_JEV_SHADOW_ENABLED — default OFF; 1/true/yes/on. Read LIVE per turn: `/disarm` flips it. */
export function resolveJevShadowEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_JEV_SHADOW_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Run Jev on the classifier's inputs. Resolves on every path — a throw becomes `status: "error"`, and
 * a call that never settles becomes `status: "timeout"` at the outer deadline.
 */
export async function runJevShadow(
  call: JevShadowCall,
  message: string,
  recentTurns: ChatTurnRow[],
  turnChars: number,
  recentClarifyCount: number
): Promise<JevShadowOutcome> {
  const lang = langOf(message);
  let result: JevResult | "deadline";
  try {
    const built = buildJevIntentRequest(message, recentTurns, turnChars, recentClarifyCount);
    if (!built.ok) return { status: "skipped_state_too_large", lang };
    result = await withDeadline(call(built.request), JEV_SHADOW_DEADLINE_MS);
  } catch {
    return { status: "error", lang, jev_error: "shadow call threw" };
  }
  if (result === "deadline") return { status: "timeout", lang, jev_error: `no result after ${JEV_SHADOW_DEADLINE_MS}ms (shadow deadline)` };
  if (!result.ok) return { status: failureStatus(result), lang, jev_error: result.detail };
  const answer = result.answers.intent;
  if (!answer) return { status: "error", lang, jev_error: "response failed validation: answer_missing:intent" };
  return {
    status: "ok",
    lang,
    jev: { intent: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities, model: result.model, latency_ms: result.latency_ms }
  };
}

function failureStatus(result: Extract<JevResult, { ok: false }>): ShadowStatus {
  if (result.reason === "no_key" || result.reason === "fused" || result.reason === "auth") return result.reason;
  return result.error_kind === "timeout" ? "timeout" : "error";
}

/** The timer is unref'd (a pending shadow never holds the daemon open at shutdown) and cleared on settle. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | "deadline"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms);
    timer.unref();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** The `intent_shadow` payload: the Jev outcome joined to the classifier's RAW reply. Pure. */
export function intentShadowPayload(outcome: JevShadowOutcome, llmRaw: string): IntentShadowPayload {
  const label = llmLabel(llmRaw);
  return {
    status: outcome.status,
    llm_intent: label.intent,
    llm_parsed: label.parsed,
    lang: outcome.lang,
    modality: "text",
    ...(outcome.jev
      ? {
          jev_intent: outcome.jev.intent,
          jev_confidence: outcome.jev.confidence,
          jev_probabilities: outcome.jev.probabilities,
          jev_model: outcome.jev.model,
          jev_latency_ms: outcome.jev.latency_ms
        }
      : {}),
    ...(outcome.jev_error !== undefined ? { jev_error: outcome.jev_error } : {})
  };
}
