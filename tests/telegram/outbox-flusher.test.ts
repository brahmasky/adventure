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
