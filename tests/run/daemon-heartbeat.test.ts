import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";

describe("daemon poll heartbeat", () => {
  it("is null until the daemon records a cycle", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.getPollHeartbeat()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("records a successful poll's timestamp", () => {
    const store = RunStore.openInMemory();
    try {
      store.recordPollHeartbeat({ now: "2026-06-18T12:00:00.000Z", ok: true });
      const hb = store.getPollHeartbeat();
      expect(hb).toMatchObject({
        last_success_at: "2026-06-18T12:00:00.000Z",
        last_error: null,
        updated_at: "2026-06-18T12:00:00.000Z"
      });
    } finally {
      store.close();
    }
  });

  it("records the last error and keeps the last success across cycles", () => {
    const store = RunStore.openInMemory();
    try {
      store.recordPollHeartbeat({ now: "2026-06-18T12:00:00.000Z", ok: true });
      store.recordPollHeartbeat({
        now: "2026-06-18T12:00:30.000Z",
        ok: false,
        error: "Telegram getUpdates failed: HTTP 502"
      });
      const hb = store.getPollHeartbeat();
      expect(hb).toMatchObject({
        last_success_at: "2026-06-18T12:00:00.000Z", // preserved
        last_error: "Telegram getUpdates failed: HTTP 502",
        last_error_at: "2026-06-18T12:00:30.000Z"
      });
    } finally {
      store.close();
    }
  });
});
