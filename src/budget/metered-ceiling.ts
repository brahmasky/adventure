import type { RunStore } from "../run/run-store.js";
import {
  computeMeteredBreaches,
  formatMeteredFuseAlert,
  resolveMeteredCeilings
} from "./global-budget-ledger.js";

/**
 * The metered-$ ceiling's per-poll-cycle check (ADR 0019, Phase S-2).
 *
 * Evaluating SUM(cost_usd) on every LLM call would be chatty; instead this runs once per
 * daemon tick (the signal path), drives the single-row `metered_fuse_state` latch, and
 * enqueues the ONE deduped alert on the 0→1 transition. Enforcement stays cheap:
 * `buildLlmChain`'s `meteredBreached` dep only READS the latch row.
 *
 * When spend falls back under both ceilings (the window rolled), the latch disarms — a
 * future breach is a new episode and alerts again.
 */

export interface CheckMeteredCeilingInput {
  store: RunStore;
  /** Allowlisted chat to alert; absent (no allowlist chat) → latch still drives, no alert. */
  chatId?: string;
  env?: NodeJS.ProcessEnv;
  now: string;
}

export interface CheckMeteredCeilingResult {
  breached: boolean;
  alerted: boolean;
}

export function checkMeteredCeiling(input: CheckMeteredCeilingInput): CheckMeteredCeilingResult {
  const env = input.env ?? process.env;
  const ceilings = resolveMeteredCeilings(env);
  const spend = input.store.meteredSpendUsd(input.now);
  const breaches = computeMeteredBreaches(spend, ceilings);

  if (breaches.length === 0) {
    input.store.disarmMeteredFuse();
    return { breached: false, alerted: false };
  }

  const fuse = input.store.armMeteredFuseIfNeeded(input.now);
  const alerted = fuse.armed && input.chatId !== undefined;
  if (alerted && input.chatId) {
    input.store.enqueueNotification({
      target: { kind: "telegram", chat_id: input.chatId },
      intent_type: "progress",
      idempotency_key: `metered-fuse:${fuse.since}`,
      correlation_id: `metered-fuse:${fuse.since}`,
      payload: { text: formatMeteredFuseAlert(breaches) }
    });
  }
  return { breached: true, alerted };
}
