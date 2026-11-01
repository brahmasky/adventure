import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import type { TelegramAllowlist } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";
import { createTelegramLongPollingAdapter } from "../../src/triggers/telegram-trigger-adapter.js";

// Spec 2026-11-01 R2 §4.1: a refused sender leaves one row naming why; it still gets nothing back, and the skip row and
// offset are written first (the durable truth that keeps the loop moving).
const ALLOW: TelegramAllowlist = { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
const msg = (update_id: number, from: number, extra: Record<string, unknown> = {}) => ({ update_id, message: { message_id: update_id, text: "hi", from: { id: from }, chat: { id: 222 }, ...extra } });
let saved: string | undefined;
beforeEach(() => { saved = process.env.HOUGE_TELEGRAM_CHAT_ID; delete process.env.HOUGE_TELEGRAM_CHAT_ID; });
afterEach(() => { if (saved === undefined) delete process.env.HOUGE_TELEGRAM_CHAT_ID; else process.env.HOUGE_TELEGRAM_CHAT_ID = saved; });

function rig(store: RunStore, updates: unknown[], recorder: DecisionRecorder = storeRecorder(store)) {
  const order: string[] = []; const emitted: unknown[] = []; const acks: unknown[] = [];
  const counted: DecisionRecorder = { record: (e, r, c) => { order.push(`decision:${e.id}`); return recorder.record(e, r, c); } };
  const adapter = createTelegramLongPollingAdapter({
    allowlist: ALLOW, client: { getUpdates: async () => updates as never },
    offsetStore: { getOffset: (s) => store.getOffset(s), setOffset: (s, o) => { order.push(`offset:${o}`); store.setOffset(s, o); } },
    skippedUpdateStore: { recordSkippedTelegramUpdate: (i) => { order.push(`skip:${i.update_id}`); store.recordSkippedTelegramUpdate(i); } },
    acknowledgeSink: (a) => { acks.push(a); }, decisionRecorder: counted
  });
  return { order, emitted, acks, poll: () => adapter.pollOnce(async (e) => { emitted.push(e); }) };
}
const senderRows = (store: RunStore) => (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
  .prepare("SELECT verdict, reason_code, rung, run_id, tool_call_id, stage FROM decisions WHERE entry_id = 'intake.sender' ORDER BY rowid").all();

describe("intake.sender in pollOnce", () => {
  it("a stranger → skip row, offset, then one deny row with no run; nothing emitted, no acknowledgement", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [msg(10, 999)]);
    expect(await r.poll()).toEqual({ processed_updates: 0, skipped_updates: 1 });
    expect(r.order).toEqual(["skip:10", "offset:11", "decision:intake.sender"]);
    expect(senderRows(store)).toEqual([{ verdict: "deny", reason_code: "user_not_allowlisted", rung: "rule", run_id: null, tool_call_id: null, stage: "intake" }]);
    expect(r.emitted).toEqual([]); expect(r.acks).toEqual([]);
  });
  it("Paco's own message is emitted and never consults the entry", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [msg(10, 111)]);
    await r.poll();
    expect(r.emitted).toHaveLength(1);
    expect(r.order.filter((o) => o.startsWith("decision:"))).toEqual([]);
    expect(senderRows(store)).toEqual([]);
  });
  it("a malformed command from Paco (invalid-command ack) is not a sender decision", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [{ update_id: 12, message: { message_id: 12, text: "/deny", from: { id: 111 }, chat: { id: 222 } } }]);
    await r.poll();
    expect(r.acks).toHaveLength(1);
    expect(senderRows(store)).toEqual([]);
  });
  it("a denial between two allowed updates: order and offsets unchanged, one row", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [msg(20, 111), msg(21, 999, { forward_date: 1 }), msg(22, 111)]);
    await r.poll();
    expect(r.emitted).toHaveLength(2);
    expect(store.getOffset("telegram")).toBe(23);
    expect(senderRows(store).map((x) => x.reason_code)).toEqual(["forwarded"]);
  });
  it("a failed decision insert opens decision_record_failed; the skip row, offset and silence to the sender are unchanged", async () => {
    const store = RunStore.openInMemory();
    (store as unknown as { insertDecision: () => never }).insertDecision = () => { throw new Error("planted"); };
    const r = rig(store, [msg(10, 999)]);
    await r.poll();
    expect(store.getOffset("telegram")).toBe(11);
    expect(r.emitted).toEqual([]); expect(r.acks).toEqual([]);
    const incidents = (store as unknown as { db: { prepare(s: string): { all(): Array<Record<string, unknown>> } } }).db
      .prepare("SELECT kind, subject FROM incidents WHERE kind = 'decision_record_failed'").all();
    expect(incidents).toEqual([{ kind: "decision_record_failed", subject: "intake.sender" }]);
  });
  it("a recorder that throws past itself changes nothing and opens no incident", async () => {
    const store = RunStore.openInMemory();
    const r = rig(store, [msg(10, 999), msg(11, 111)], { record: () => { throw new Error("planted"); } });
    await r.poll();
    expect(r.emitted).toHaveLength(1);
    expect(store.getOffset("telegram")).toBe(12);
    const n = (store as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db.prepare("SELECT count(*) AS n FROM incidents").get().n;
    expect(n).toBe(0);
  });
  it("no recorder (eval and older callers) → the denial is handled exactly as before, no row", async () => {
    const store = RunStore.openInMemory();
    const adapter = createTelegramLongPollingAdapter({ allowlist: ALLOW, client: { getUpdates: async () => [msg(10, 999)] as never },
      offsetStore: { getOffset: (s) => store.getOffset(s), setOffset: (s, o) => store.setOffset(s, o) } });
    expect(await adapter.pollOnce(async () => undefined)).toEqual({ processed_updates: 0, skipped_updates: 1 });
    expect(senderRows(store)).toEqual([]);
  });
});
