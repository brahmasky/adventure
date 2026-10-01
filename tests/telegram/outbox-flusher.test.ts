import { describe, expect, it, vi } from "vitest";
import { errorCode } from "../../src/domain/error-code.js";
import { serialFlusher, throttledIncident } from "../../src/telegram/telegram-daemon.js";

/** A dispatcher whose queue holds `pending` sends; `failOnce` makes the first dispatch throw. */
function fakeDispatcher(pending: string[], failOnce: boolean) {
  const delivered: string[] = [];
  let thrown = !failOnce;
  return {
    delivered,
    dispatchOnce: async () => {
      if (!thrown) { thrown = true; throw Object.assign(new Error("database is locked at /secret/path"), { code: "ERR_SQLITE_ERROR" }); }
      const next = pending.shift();
      if (next === undefined) return { status: "idle" as const };
      delivered.push(next);
      return { status: "delivered" as const, notification_id: next };
    }
  };
}

describe("the daemon's outbox sender (fix round 1, item 1)", () => {
  it("a dispatch that throws once never kills the sender: the next flush still delivers", async () => {
    const d = fakeDispatcher(["reply", "approval card"], true);
    const flush = serialFlusher(d);
    await expect(flush()).rejects.toThrow();
    await flush();
    expect(d.delivered).toEqual(["reply", "approval card"]);
  });

  it("drains serially: two concurrent flushes never interleave and both settle", async () => {
    const d = fakeDispatcher(["a", "b", "c"], false);
    const flush = serialFlusher(d);
    await Promise.all([flush(), flush()]);
    expect(d.delivered).toEqual(["a", "b", "c"]);
  });

  it("a persistent failure logs and opens an incident once per code per window, again when the code changes — never a line a second (N-2)", () => {
    const incidents: Array<{ kind: string; detail: Record<string, unknown> }> = [];
    const store = { openIncident: (i: { kind: string; subject: string; detail: Record<string, unknown> }) => { incidents.push(i); return {} as never; } };
    let t = 0;
    const report = throttledIncident(store, 600_000, () => t);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const locked = Object.assign(new Error("EACCES: /Users/x/secret"), { code: "EACCES" });
    for (t = 0; t < 60_000; t += 1_000) report("outbox_flush_failed", locked); // the 1 s pump, for a minute
    expect(log).toHaveBeenCalledTimes(1);
    t = 61_000; report("outbox_flush_failed", Object.assign(new Error("x"), { code: "ENOSPC" })); // new code: reported
    t = 62_000; report("outbox_flush_failed", locked); // code changed back: reported
    t = 700_000; report("outbox_flush_failed", locked); // same code, window over: reported
    t = 701_000; report("outbox_flush_failed", locked); // within the window: silent
    expect(log).toHaveBeenCalledTimes(4);
    expect(incidents.map((i) => i.detail)).toEqual([{ code: "EACCES" }, { code: "ENOSPC" }, { code: "EACCES" }, { code: "EACCES" }]);
    expect(JSON.stringify(incidents)).not.toContain("/Users/x/secret");
    log.mockRestore();
  });

  it("errorCode keeps an errno-style code and drops the message", () => {
    expect(errorCode(Object.assign(new Error("open /a/b failed"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errorCode(new TypeError("x at /path"))).toBe("TypeError");
    expect(errorCode("boom /path")).toBe("unknown");
  });
});

// Live gate 2026-10-01, item 5: a reply whose send failed once sat in retry_wait forever. The daemon's poll cycle now
// runs the retry step inside the serialized sender, so a transient Telegram failure is redelivered on a later cycle.
describe("the daemon retries a notification whose send failed once", () => {
  it("a transient sendMessage failure is redelivered on a later poll cycle", async () => {
    const { RunStore } = await import("../../src/run/run-store.js");
    const { runTelegramDaemon } = await import("../../src/telegram/telegram-daemon.js");
    const { pinOmpEnv, tmpOmpDist, useFakeOmp } = await import("../helpers/omp-env.js");
    const { until } = await import("../helpers/omp-worker.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    pinOmpEnv();
    const store = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "houge-retry-"));
    const controller = new AbortController();
    const sent: string[] = [];
    let failures = 0;
    try {
      useFakeOmp({ "*": { rpcText: "x" } }, root);
      store.enqueueNotification({ target: { kind: "telegram", chat_id: "222" }, intent_type: "progress",
        idempotency_key: "reply:transient", correlation_id: "c", payload: { text: "the reply" } });
      let calls = 0;
      const elapseBackoff = () => (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
        .prepare("UPDATE notification_outbox SET next_attempt_at = ? WHERE state = 'retry_wait'").run(new Date(Date.now() - 1_000).toISOString());
      await runTelegramDaemon({ store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) },
        allowlist: { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] },
        stopSignal: controller.signal, longPollTimeoutSeconds: 0, outboxPumpMs: 60_000,
        telegramClient: {
          getUpdates: async () => {
            calls += 1;
            // the first retry's 30 s backoff elapses between cycles (moved back instead of waiting it out)
            if (calls === 2) elapseBackoff();
            if (calls >= 2) { await until(() => sent.includes("the reply"), 3_000).catch(() => undefined); controller.abort(); }
            return [];
          },
          sendMessage: async ({ text }) => {
            // both attempts of the first dispatch fail (the adapter retries once without parse_mode)
            if (text === "the reply" && failures < 2) { failures += 1; throw new Error("HTTP 502"); }
            sent.push(text);
            return { message_id: sent.length };
          }
        } });
      expect(failures).toBe(2);
      expect(sent.filter((t) => t === "the reply")).toHaveLength(1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the daemon never sends a reply that went stale while it was down", () => {
  it("a queued reply older than the resend window at boot is abandoned before the boot flush can send it", async () => {
    const { RunStore } = await import("../../src/run/run-store.js");
    const { runTelegramDaemon } = await import("../../src/telegram/telegram-daemon.js");
    const { pinOmpEnv, tmpOmpDist, useFakeOmp } = await import("../helpers/omp-env.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    pinOmpEnv();
    const store = RunStore.openInMemory();
    const root = mkdtempSync(join(tmpdir(), "houge-stale-"));
    const controller = new AbortController();
    const sent: string[] = [];
    try {
      useFakeOmp({ "*": { rpcText: "x" } }, root);
      const row = store.enqueueNotification({ target: { kind: "telegram", chat_id: "222" }, intent_type: "progress",
        idempotency_key: "reply:stale", correlation_id: "c", payload: { text: "the stale reply" } });
      if (row.status !== "queued") throw new Error("expected queued");
      (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
        .prepare("UPDATE notification_outbox SET created_at = ? WHERE notification_id = ?")
        .run(new Date(Date.now() - 7 * 3_600_000).toISOString(), row.record.notification_id);
      await runTelegramDaemon({ store, projectRoot: root, omp: { dataDir: root, distDir: tmpOmpDist(root) },
        allowlist: { users: [{ telegram_user_id: 111, identity_id: "paco" }], chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] },
        stopSignal: controller.signal, longPollTimeoutSeconds: 0,
        telegramClient: {
          getUpdates: async () => { controller.abort(); return []; },
          sendMessage: async ({ text }) => { sent.push(text); return { message_id: sent.length }; }
        } });
      expect(sent).not.toContain("the stale reply");
      expect(store.getNotification(row.record.notification_id)?.state).toBe("failed_terminal");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
