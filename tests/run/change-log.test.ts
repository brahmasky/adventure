import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { chatIntent, logIntent } from "../support/intents.js";

// Spec 2026-11-03 §4.3: background notices leave chat and land in change_log; the topic alone decides.
const dirs: string[] = [];
const stores: RunStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch { /* already closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const db = (s: RunStore) => (s as unknown as { db: DatabaseSync }).db;
const open = () => { const s = RunStore.openInMemory(); stores.push(s); return s; };
const countOutbox = (s: RunStore) => (db(s).prepare("SELECT COUNT(*) AS n FROM notification_outbox").get() as { n: number }).n;
const countLog = (s: RunStore) => (db(s).prepare("SELECT COUNT(*) AS n FROM change_log").get() as { n: number }).n;

describe("change_log", () => {
  it("a log intent writes one change_log row and no outbox row", () => {
    const store = open();
    const r = store.enqueueNotification({ topic: "model_change", idempotency_key: "k1", correlation_id: "model-roles", text: "🔁 Kimi K: k3 → k3.1-pro", now: "2026-11-03T05:00:00.000Z" });
    expect(r.status).toBe("logged");
    expect(store.listChangeLog("2026-11-01T00:00:00.000Z", 20).map((x) => x.text)).toEqual(["🔁 Kimi K: k3 → k3.1-pro"]);
    expect(countOutbox(store)).toBe(0);
  });
  it("the same key and text is duplicate_log; a different text is a conflict", () => {
    const store = open();
    const a = store.enqueueNotification(logIntent({ idempotency_key: "k1", text: "one" }));
    const b = store.enqueueNotification(logIntent({ idempotency_key: "k1", text: "one" }));
    const c = store.enqueueNotification(logIntent({ idempotency_key: "k1", text: "two" }));
    expect(a.status).toBe("logged");
    expect(b.status).toBe("duplicate_log");
    if (a.status === "logged" && b.status === "duplicate_log") expect(b.change_id).toBe(a.change_id);
    expect(c.status).toBe("conflict");
    expect(countLog(store)).toBe(1);
  });
  it("a log write needs no chat (no target field exists)", () => {
    const store = open();
    // @ts-expect-error a LogIntent has no target: the log never needs a chat
    const withTarget: Parameters<RunStore["logChange"]>[0] = logIntent({ target: { kind: "local" } });
    expect(store.logChange(withTarget).status).toBe("logged");
    expect(countOutbox(store)).toBe(0);
  });
  it("created_at is the intent's now", () => {
    const store = open();
    store.logChange(logIntent({ now: "2026-11-03T05:00:00.000Z" }));
    expect(store.listChangeLog("2026-01-01T00:00:00.000Z", 5)[0]?.created_at).toBe("2026-11-03T05:00:00.000Z");
  });
  it("listChangeLog is newest first and bounded; countChangeLogSince counts the window", () => {
    const store = open();
    const t = ["2026-11-03T01:00:00.000Z", "2026-11-03T02:00:00.000Z", "2026-11-03T03:00:00.000Z"];
    t.forEach((now, i) => store.logChange(logIntent({ idempotency_key: `k${i}`, text: `t${i}`, now })));
    expect(store.listChangeLog(t[0]!, 20).map((x) => x.text)).toEqual(["t2", "t1", "t0"]);
    expect(store.listChangeLog(t[0]!, 2).map((x) => x.text)).toEqual(["t2", "t1"]);
    expect(store.listChangeLog(t[1]!, 20).map((x) => x.text)).toEqual(["t2", "t1"]);
    expect(store.countChangeLogSince(t[1]!)).toBe(2);
    expect(store.countChangeLogSince("2026-11-04T00:00:00.000Z")).toBe(0);
  });
  it("a chat intent is unchanged: queued, one outbox row, zero change_log rows", () => {
    const store = open();
    const r = store.enqueueNotification(chatIntent({ topic: "reply" }));
    expect(r.status).toBe("queued");
    expect(countOutbox(store)).toBe(1);
    expect(countLog(store)).toBe(0);
  });
  it("an already-migrated database still gets the table (base migration, not behind a migration guard)", () => {
    const d = mkdtempSync(join(tmpdir(), "hcl-")); dirs.push(d);
    const path = join(d, "h.sqlite");
    const a = RunStore.open(path);
    expect(db(a).prepare("SELECT 1 AS x FROM schema_migrations WHERE version = '2026-11-02-loud-degradation'").get()).toBeTruthy();
    db(a).exec("DROP TABLE change_log");
    a.close();
    const b = RunStore.open(path); stores.push(b);
    expect(b.logChange(logIntent()).status).toBe("logged");
  });
});
