import { OutcomeRejected } from "../decisions/outcomes.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * Decision digest taps (decision ladder spec §8.1). The adapter already passed the sender allowlist. A tap writes one
 * `decision_outcomes` label for a decision a digest offered in the last REVIEW_STALE_MS, once; anything else replies
 * REVIEW_HANDLED_TEXT and writes nothing. Labels feed `improve.route` from stage 2b.
 */
export const REVIEW_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_OK_TEXT = "✅ Noted: right.";
export const REVIEW_BAD_TEXT = "❌ Noted: wrong. It goes into the next review.";
export const REVIEW_HANDLED_TEXT = "Already handled.";
const reviewed = (): GatewayIntakeResult => ({ ok: true, status: "decision_reviewed", run_id: "" });

export function handleDecisionReview(store: RunStore, event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const id = typeof event.metadata?.decision_id === "string" ? event.metadata.decision_id : "";
    const raw = event.metadata?.label;
    const label = raw === "ok" || raw === "bad" ? raw : null;
    const decision = id ? store.getDecision(id) : undefined;
    const since = new Date(Date.parse(now) - REVIEW_STALE_MS).toISOString();
    if (!decision || !label || !store.wasDecisionOffered(id, since)) {
      replyTo(store, event, "decision_review", REVIEW_HANDLED_TEXT);
      return reviewed();
    }
    replyTo(store, event, "decision_review", labelOnce(store, decision.decision_id, decision.entry_id, label, now));
    return reviewed();
  });
}

/** One label per decision (the store's unique index); an entry id the registry no longer has is answered as handled. */
function labelOnce(store: RunStore, decision_id: string, entry_id: string, label: "ok" | "bad", now: string): string {
  try {
    const r = store.insertDecisionOutcome({ decision_id, signal: label === "ok" ? "review_ok" : "review_bad", value: entry_id, source: "paco", created_at: now });
    if (!r.inserted) return REVIEW_HANDLED_TEXT;
    return label === "ok" ? REVIEW_OK_TEXT : REVIEW_BAD_TEXT;
  } catch (e) {
    if (e instanceof OutcomeRejected) return REVIEW_HANDLED_TEXT;
    throw e;
  }
}
