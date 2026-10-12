import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { REVIEW_BAD_TEXT, REVIEW_HANDLED_TEXT, REVIEW_OK_TEXT } from "../../src/gateway/decision-commands.js";
import { RunStore } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Spec §8.1: a tap writes one decision_outcomes label and replies; it is one-shot (a second tap, an unknown id or one no
// digest offered in the last 7 days answers "Already handled." and writes nothing); a redelivered update replies once.
// Plan ruling 16: the 5-a-minute command limit neither drops a tap nor counts taps against Paco's next real command.
const NOW = "2026-10-12T11:00:00.000Z";
let seq = 0;
const tap = (decision_id: string, label: string, key = `k${++seq}`) => buildTypedTaskEvent({ source: "telegram", type: "decision_review",
  requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "555" }, idempotency_key: key, source_reference: key,
  metadata: { telegram_update_id: seq, telegram_callback_id: key, decision_id, label } });
const decision = (store: RunStore): string => store.insertDecision({ entry_id: "turn.handler", entry_version: 1, run_id: null, tool_call_id: null, stage: "pre_model",
  rung: "system_one", verdict: "planner", p: 0.6, reason_code: "routed", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 1 });
/** `n` decisions offered by one digest dated by `created_at` (one latch row per local date). */
function offeredMany(store: RunStore, n: number, created_at = "2026-10-12T10:00:00.000Z"): string[] {
  const ids = Array.from({ length: n }, () => decision(store));
  store.recordDecisionDigest({ local_date: created_at.slice(0, 10), sent: true, offered: ids, created_at });
  return ids;
}
const offered = (store: RunStore, created_at?: string): string => offeredMany(store, 1, created_at)[0]!;
const replies = (store: RunStore) => [...drainOutbox(store).values()].map((p) => p.text);

describe("decision_review taps", () => {
  it("❌ writes review_bad (value: the entry id, source paco) and replies once", () => {
    const store = RunStore.openInMemory();
    const id = offered(store);
    expect(new Gateway(store).intake(tap(id, "bad"), NOW)).toMatchObject({ ok: true, status: "decision_reviewed" });
    expect(store.listDecisionOutcomes(id).map((o) => [o.signal, o.value, o.source])).toEqual([["review_bad", "turn.handler", "paco"]]);
    expect(replies(store)).toEqual([REVIEW_BAD_TEXT]);
    store.close();
  });
  it("a second tap (either button) answers Already handled and writes nothing", () => {
    const store = RunStore.openInMemory();
    const id = offered(store);
    new Gateway(store).intake(tap(id, "ok"), NOW);
    new Gateway(store).intake(tap(id, "bad"), NOW);
    expect(store.listDecisionOutcomes(id)).toHaveLength(1);
    expect(replies(store)).toEqual([REVIEW_OK_TEXT, REVIEW_HANDLED_TEXT]);
    store.close();
  });
  it("an unknown id, a decision no digest offered, and one offered 8 days ago: Already handled, nothing written", () => {
    const store = RunStore.openInMemory();
    const stale = offered(store, "2026-10-04T10:00:00.000Z");
    const never = decision(store);
    for (const id of ["dec_00000000-0000-0000-0000-000000000000", never, stale]) new Gateway(store).intake(tap(id, "bad"), NOW);
    expect([store.listDecisionOutcomes(never), store.listDecisionOutcomes(stale)]).toEqual([[], []]);
    expect(replies(store)).toEqual([REVIEW_HANDLED_TEXT, REVIEW_HANDLED_TEXT, REVIEW_HANDLED_TEXT]);
    store.close();
  });
  it("a redelivered update (same idempotency key) is replayed, not re-applied: one reply", () => {
    const store = RunStore.openInMemory();
    const id = offered(store);
    new Gateway(store).intake(tap(id, "bad", "same"), NOW);
    new Gateway(store).intake(tap(id, "bad", "same"), NOW);
    expect(replies(store)).toEqual([REVIEW_BAD_TEXT]);
    store.close();
  });
  it("8 taps in one minute all write labels and do not use up the command window; the limit still holds for other commands", () => {
    const store = RunStore.openInMemory();
    const ids = offeredMany(store, 8);
    for (const id of ids) expect(new Gateway(store).intake(tap(id, "bad"), NOW)).toMatchObject({ ok: true, status: "decision_reviewed" });
    expect(ids.every((id) => store.listDecisionOutcomes(id).length === 1)).toBe(true);
    const limit = () => store.checkTelegramRateLimit({ actor_id: "paco", chat_id: "555", command: "turn", now: NOW }).ok;
    expect(limit()).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      store.recordTelegramCommandAudit({ actor_id: "paco", chat_id: "555", command: "turn", source_reference: `s${i}`, decision: "accepted", occurred_at: NOW });
    }
    expect(limit()).toBe(false);
    store.close();
  });
});
