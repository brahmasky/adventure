import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * Old digest ✅/❌ taps (the digest is gone: spec 2026-11-07 §8-9; ADR 0034 6.6: calibration labels come from taps on cards
 * only). A button on an old message still parses (`REVIEW_PREFIX`); it answers REVIEW_CLOSED_TEXT and writes nothing, once per trigger.
 */
export const REVIEW_CLOSED_TEXT = "This review has closed.";

export function handleDecisionReview(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    replyTo(store, event, "decision_review", REVIEW_CLOSED_TEXT);
    return { ok: true, status: "decision_reviewed", run_id: "" };
  });
}
