import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationDispatcher } from "../../src/notifications/notification-dispatcher.js";
import { NotificationOutbox } from "../../src/notifications/notification-outbox.js";
import { RunStore } from "../../src/run/run-store.js";
import { ATTACH_PATH } from "../../src/decisions/entries/attach-path.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { AttachCheck } from "../../src/notifications/attachment-check.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";

describe("NotificationDispatcher", () => {
  it("sends queued Telegram notification and marks delivered", async () => {
    const store = RunStore.openInMemory();
    const sent: string[] = [];
    try {
      const outbox = new NotificationOutbox(store);
      const record = outbox.enqueue({
        topic: "reply",
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "final_report",
        idempotency_key: "run_1:final",
        run_id: "run_1",
        correlation_id: "run_1:final",
        payload: { text: "Report ready", run_id: "run_1" }
      });
      const dispatcher = new NotificationDispatcher(outbox, {
        local: { send: async () => ({ provider_message_id: "local:1" }) },
        telegram: { send: async (notification) => {
          sent.push(notification.payload.text);
          return { provider_message_id: "telegram:99" };
        } }
      });

      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "delivered", notification_id: record.notification_id });
      expect(sent).toEqual(["Report ready"]);
      expect(outbox.get(record.notification_id)?.provider_message_id).toBe("telegram:99");
    } finally {
      store.close();
    }
  });

  it("marks retryable failure when adapter throws", async () => {
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const record = outbox.enqueue({
        topic: "reply",
        target: { kind: "telegram", chat_id: "222" },
        intent_type: "progress",
        idempotency_key: "run_1:progress",
        run_id: "run_1",
        correlation_id: "run_1:progress",
        payload: { text: "Queued" }
      });
      const dispatcher = new NotificationDispatcher(outbox, {
        local: { send: async () => ({ provider_message_id: "local:1" }) },
        telegram: { send: async () => { throw new Error("network down"); } }
      });

      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "failed", notification_id: record.notification_id, retryable: true });
      expect(outbox.get(record.notification_id)?.state).toBe("retry_wait");
    } finally {
      store.close();
    }
  });
  it("onDelivered runs after the delivered row committed; a throwing hook never turns the delivered message into a failure", async () => {
    // Stage 4A §7: settlement rides delivery, but a settlement error must not make Houge resend (or mark failed) what Paco already has
    const store = RunStore.openInMemory();
    try {
      const outbox = new NotificationOutbox(store);
      const record = outbox.enqueue({ topic: "reply", target: { kind: "telegram", chat_id: "222" }, intent_type: "final_report", idempotency_key: "run_9:final_report", run_id: "run_9", correlation_id: "run_9", payload: { text: "200" } });
      const seen: string[] = [];
      const dispatcher = new NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "local:1" }) }, telegram: { send: async () => ({ provider_message_id: "telegram:7" }) } },
        { onDelivered: (r) => { seen.push(`${r.idempotency_key}=${String(outbox.get(r.notification_id)?.state)}`); throw Object.assign(new Error("settle failed: /secret/path"), { code: "SQLITE_FULL" }); } });
      const logged: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
      try { await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "delivered", notification_id: record.notification_id }); }
      finally { console.error = orig; }
      expect(seen).toEqual(["run_9:final_report=delivered"]);
      expect(logged).toEqual([`[notification-dispatcher] onDelivered failed for ${record.notification_id}: SQLITE_FULL`]); // the code, never the raw message
      expect(outbox.get(record.notification_id)?.state).toBe("delivered");
      await expect(dispatcher.dispatchOnce("sender-1")).resolves.toEqual({ status: "idle" }); // nothing requeued
    } finally {
      store.close();
    }
  });
});

type Db = { prepare(s: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
const db = (s: RunStore) => (s as unknown as { db: Db }).db;
const attachRows = (s: RunStore) => db(s).prepare("SELECT verdict, reason_code, rung, run_id, tool_call_id FROM decisions WHERE entry_id = 'attach.path' ORDER BY rowid").all()
  .map((r) => [r.verdict, r.reason_code, r.rung, r.run_id, r.tool_call_id]);
/** One telegram notification, an adapter returning `checks`, a shared log of send / markDelivered / record events. */
function rig(checks: AttachCheck[] | undefined, o: { run_id?: string; recorder?: (s: RunStore, log: string[]) => DecisionRecorder; onDelivered?: () => void; send?: () => Promise<never> } = {}) {
  const store = RunStore.openInMemory(); const log: string[] = []; const outbox = new NotificationOutbox(store);
  const mark = store.markNotificationDelivered.bind(store);
  store.markNotificationDelivered = (id, p) => { log.push("markDelivered"); mark(id, p); };
  const rec = outbox.enqueue({ topic: "reply", target: { kind: "telegram", chat_id: "222" }, intent_type: "final_report", idempotency_key: "k", correlation_id: "k",
    ...(o.run_id === undefined ? { run_id: "run_1" } : o.run_id === "none" ? {} : { run_id: o.run_id }), payload: { text: "r", attachments: ["/w/a"] } });
  const base = o.recorder ? o.recorder(store, log) : { record: (e, r, c) => { log.push(`record:${r.verdict}:${r.reason}`); return storeRecorder(store).record(e, r, c); } } as DecisionRecorder;
  const dispatcher = new NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "l" }) },
    telegram: { send: async () => { log.push("send"); if (o.send) return o.send(); return checks ? { provider_message_id: "t:1", attach_checks: checks } : { provider_message_id: "t:1" }; } } },
    { recorder: base, ...(o.onDelivered ? { onDelivered: o.onDelivered } : {}) });
  return { store, log, outbox, rec, dispatcher };
}

describe("R7: attach.path send rows", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("1. rows come after markDelivered, carry the claimed run's id, refusals only", async () => {
    const t = rig(["ok", "too_large", "over_count"]);
    await expect(t.dispatcher.dispatchOnce("s")).resolves.toMatchObject({ status: "delivered" });
    expect(t.log).toEqual(["send", "markDelivered", "record:send:checked", "record:refuse:too_large", "record:refuse:over_count"]);
    expect(attachRows(t.store)).toEqual([["refuse", "too_large", "rule", "run_1", null], ["refuse", "over_count", "rule", "run_1", null]]);
    t.store.close();
  });

  it("2. a run-less row records run_id null", async () => {
    const t = rig(["not_found"], { run_id: "none" });
    await t.dispatcher.dispatchOnce("s");
    expect(attachRows(t.store)).toEqual([["refuse", "not_found", "rule", null, null]]);
    t.store.close();
  });

  it("3. no checks, empty checks, or no recorder records nothing", async () => {
    const a = rig(undefined); await a.dispatcher.dispatchOnce("s");
    expect(a.log.filter((l) => l.startsWith("record:"))).toEqual([]); a.store.close();
    const e = rig([]); await expect(e.dispatcher.dispatchOnce("s")).resolves.toMatchObject({ status: "delivered" });
    expect(e.log.filter((l) => l.startsWith("record:"))).toEqual([]); e.store.close();
    const store = RunStore.openInMemory(); const outbox = new NotificationOutbox(store);
    const rec = outbox.enqueue({ topic: "reply", target: { kind: "telegram", chat_id: "222" }, intent_type: "final_report", idempotency_key: "k", correlation_id: "k", run_id: "run_1", payload: { text: "r" } });
    const d = new NotificationDispatcher(outbox, { local: { send: async () => ({ provider_message_id: "l" }) }, telegram: { send: async () => ({ provider_message_id: "t", attach_checks: ["too_large"] }) } });
    await d.dispatchOnce("s");
    expect(attachRows(store)).toEqual([]); expect(outbox.get(rec.notification_id)!.state).toBe("delivered"); store.close();
  });

  it("4. a failed send records nothing", async () => {
    const t = rig(["too_large"], { send: async () => { throw new Error("boom"); } });
    await expect(t.dispatcher.dispatchOnce("s")).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(t.outbox.get(t.rec.notification_id)!.state).toBe("retry_wait");
    expect(attachRows(t.store)).toEqual([]); t.store.close();
  });

  it("5. the lease is over when the recorder runs: a stale sweep and a second claim find nothing (P10)", async () => {
    let first = true;
    const t = rig(["too_large"], { recorder: (store, log) => ({ record: (e, r, c) => {
      if (first) {
        first = false;
        log.push(String(store.recoverStaleSendingNotifications(new Date(Date.now() + 31_000).toISOString()).length));
        log.push(String(new NotificationOutbox(store).claimNext("second", 30) === null));
      }
      return storeRecorder(store).record(e, r, c);
    } }) });
    await t.dispatcher.dispatchOnce("s");
    const i0 = t.log.indexOf("0"), i1 = t.log.indexOf("true");
    expect(i0).toBeGreaterThan(-1); expect(i1).toBeGreaterThan(i0);
    expect(t.outbox.get(t.rec.notification_id)!.state).toBe("delivered");
    expect(t.log.filter((l) => l === "send")).toHaveLength(1);
    t.store.close();
  });

  it("6. a recorder that throws past itself does not undo the delivery", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = rig(["too_large"], { recorder: () => ({ record: () => { throw new Error("planted"); } }) });
    await expect(t.dispatcher.dispatchOnce("s")).resolves.toMatchObject({ status: "delivered" });
    expect(t.outbox.get(t.rec.notification_id)!.state).toBe("delivered");
    // decideSync's own record() catch logs a recorder throw first; recordAttach's catch is the net for what decideSync itself throws (case 8)
    expect(err.mock.calls.some((c) => String(c[0]).includes("record threw past the recorder"))).toBe(true);
    t.store.close();
  });

  it("7. afterDelivered and recordAttach cannot skip each other", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const a = rig(["too_large"], { onDelivered: () => { throw new Error("hook"); } });
    await a.dispatcher.dispatchOnce("s");
    expect(attachRows(a.store)).toEqual([["refuse", "too_large", "rule", "run_1", null]]); a.store.close();
    const hook = vi.fn();
    const b = rig(["too_large"], { onDelivered: hook, recorder: () => ({ record: () => { throw new Error("planted"); } }) });
    await b.dispatcher.dispatchOnce("s");
    expect(hook).toHaveBeenCalledTimes(1); b.store.close();
  });

  it("8. a planted non-rule rung records no row, is logged, and the message stays delivered (P20)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const orig = ATTACH_PATH.ladder;
    (ATTACH_PATH as { ladder: unknown }).ladder = [{ kind: "system_one", name: "x", questions: [], bars: { kind: "provisional", question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "t" }, timeoutMs: 1 }];
    const t = rig(["too_large"]);
    try {
      await expect(t.dispatcher.dispatchOnce("s")).resolves.toMatchObject({ status: "delivered" });
      expect(attachRows(t.store)).toEqual([]);
      expect(err.mock.calls.some((c) => String(c[0]).includes("attach_path_record_failed"))).toBe(true);
    } finally { (ATTACH_PATH as { ladder: unknown }).ladder = orig; t.store.close(); }
  });

  it("9. an insert fault opens decision_record_failed as a log row, never a chat message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saved = process.env.HOUGE_TELEGRAM_CHAT_ID; process.env.HOUGE_TELEGRAM_CHAT_ID = "";
    const t = rig(["linked"]);
    vi.spyOn(t.store, "insertDecision").mockImplementation(() => { throw new Error("disk"); });
    try {
      await expect(t.dispatcher.dispatchOnce("s")).resolves.toMatchObject({ status: "delivered" });
      expect(db(t.store).prepare("SELECT kind, subject, detail_json FROM incidents").all().map((r) => [r.kind, r.subject, JSON.parse(String(r.detail_json))]))
        .toEqual([["decision_record_failed", "attach.path", { entry: "attach.path" }]]);
      expect(db(t.store).prepare("SELECT 1 FROM ledger_events WHERE event_type = 'incident_opened'").all()).toHaveLength(1);
      expect(db(t.store).prepare("SELECT topic FROM change_log").all()).toEqual([{ topic: "incident_log" }]);
      expect(db(t.store).prepare("SELECT 1 FROM notification_outbox").all()).toHaveLength(1);
      expect(t.outbox.get(t.rec.notification_id)!.state).toBe("delivered");
    } finally { if (saved === undefined) delete process.env.HOUGE_TELEGRAM_CHAT_ID; else process.env.HOUGE_TELEGRAM_CHAT_ID = saved; t.store.close(); }
  });
});
