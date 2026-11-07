import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { REVIEW_CLOSED_TEXT } from "../../src/gateway/decision-commands.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec 2026-11-07 §8-9 (ADR 0034 6.6): the digest and its Unsure section are gone, so a ✅/❌ on an old message answers
// "closed" and writes NO label — a review_bad here would feed improve.route a ladder proposal from a surface that no longer exists.
const NOW = "2026-11-08T11:00:00.000Z";
let seq = 0;
const tap = (decision_id: string, label: string, key = `k${++seq}`) => buildTypedTaskEvent({ source: "telegram", type: "decision_review",
  requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: key, source_reference: key,
  metadata: { telegram_update_id: seq, telegram_callback_id: key, decision_id, label } });
const decision = (store: RunStore): string => store.insertDecision({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model",
  rung: "system_one", verdict: "planner", p: 0.6, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1 });

describe("decision_review taps after the digest", () => {
  it("❌ and ✅ answer closed and write no outcome, for a real decision as for an unknown id", () => {
    const store = RunStore.openInMemory();
    const id = decision(store);
    for (const [d, label] of [[id, "bad"], [id, "ok"], ["dec_nope", "bad"]] as const) expect(new Gateway(store).intake(tap(d, label), NOW)).toMatchObject({ ok: true, status: "decision_reviewed" });
    expect(store.listDecisionOutcomes(id)).toEqual([]);
    expect([...drainOutbox(store).values()].map((p) => p.text)).toEqual([REVIEW_CLOSED_TEXT, REVIEW_CLOSED_TEXT, REVIEW_CLOSED_TEXT]);
    store.close();
  });
  it("a redelivered update is replayed: one reply; taps stay exempt from the 5-a-minute command window", () => {
    const store = RunStore.openInMemory();
    const id = decision(store);
    const e = tap(id, "bad");
    new Gateway(store).intake(e, NOW); new Gateway(store).intake(e, NOW);
    expect(drainOutbox(store).size).toBe(1);
    for (let i = 0; i < 8; i += 1) expect(new Gateway(store).intake(tap(id, "ok"), NOW)).toMatchObject({ ok: true });
    expect(store.checkTelegramRateLimit({ actor_id: "paco", chat_id: "555", command: "turn", now: NOW }).ok).toBe(true);
    store.close();
  });
});
