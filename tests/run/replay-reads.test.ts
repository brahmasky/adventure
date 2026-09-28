import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";

function createRun(store: RunStore, key: string): string {
  const created = store.createOrGet(buildTypedTaskEvent({
    source: "cli", type: "run", program: "research-brief", goal: key,
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "local" },
    idempotency_key: key, source_reference: "argv", created_at: "2026-09-01T00:00:00.000Z"
  }));
  if (created.status !== "created") throw new Error("expected created");
  return created.run_id;
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));

afterEach(() => vi.useRealTimers());

describe("replay reads", () => {
  it("anchors on the classify attempt, not chat_turns.created_at (completion time — codex BLOCKER 1)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      at("2026-09-10T00:00:00.000Z");
      const run = createRun(store, "k1");
      at("2026-09-10T00:00:05.000Z");
      store.llmAuditSink({ run_id: run, role: "classify" }).record({ provider: "pi", role: "", outcome: "ok", model: "m", latency_ms: 1 });
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "user", text: "q", created_at: "2026-09-10T00:01:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "assistant", text: "a", intent: "research", created_at: "2026-09-10T00:01:00.001Z" });
      const [row] = store.listReplayTurns({});
      expect(row).toMatchObject({ run_id: run, text: "q", recorded_intent: "research", anchor: "2026-09-10T00:00:05.000Z", anchor_kind: "classify" });
    } finally {
      store.close();
    }
  });

  it("falls back to the run's earliest ledger event before the audit chokepoint existed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = RunStore.openInMemory();
    try {
      at("2026-08-01T00:00:00.000Z");
      const run = createRun(store, "k2");
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "user", text: "q", created_at: "2026-08-01T00:02:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "assistant", text: "a", intent: "answer", created_at: "2026-08-01T00:02:00.001Z" });
      const [row] = store.listReplayTurns({});
      expect(row!.anchor_kind).toBe("run_start");
      expect(row!.anchor).toBe(store.getLedgerEvents(run)[0]!.occurred_at);
    } finally {
      store.close();
    }
  });

  it("excludes evolution_report rows, user turns with no classified reply, and honours since/limit", () => {
    const store = RunStore.openInMemory();
    try {
      const a = createRun(store, "a"); const b = createRun(store, "b"); const c = createRun(store, "c");
      store.recordChatTurn({ chat_id: "c", run_id: a, role: "user", text: "1", created_at: "2026-09-01T00:00:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: a, role: "assistant", text: "r", intent: "evolution_report", created_at: "2026-09-01T00:00:01.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: b, role: "user", text: "2", created_at: "2026-09-02T00:00:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: c, role: "user", text: "3", created_at: "2026-09-03T00:00:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: c, role: "assistant", text: "r", intent: "answer", created_at: "2026-09-03T00:00:01.000Z" });
      expect(store.listReplayTurns({}).map((r) => r.text)).toEqual(["3"]);
      expect(store.listReplayTurns({ sinceIso: "2026-09-04T00:00:00.000Z" })).toEqual([]);
      expect(store.listReplayTurns({ limit: 0 })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("returns exactly one row per user turn even when its run has two qualifying assistant rows (no double-counted turns — review fix round 1)", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "d");
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "user", text: "q", created_at: "2026-09-01T00:00:00.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "assistant", text: "a1", intent: "research", created_at: "2026-09-01T00:00:01.000Z" });
      store.recordChatTurn({ chat_id: "c", run_id: run, role: "assistant", text: "a2", intent: "answer", created_at: "2026-09-01T00:00:02.000Z" });
      const rows = store.listReplayTurns({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ text: "q", recorded_intent: "research" });
    } finally {
      store.close();
    }
  });

  it("getChatTurnsBefore: strictly before the anchor, inside the window, never the target run's own rows", () => {
    const store = RunStore.openInMemory();
    try {
      const rows = [
        ["r0", "user", "too old", "2026-09-01T00:00:00.000Z"],
        ["r1", "user", "in window", "2026-09-05T00:00:00.000Z"],
        ["r1", "assistant", "reply", "2026-09-05T00:00:01.000Z"],
        ["r2", "user", "concurrent run, completed later", "2026-09-05T00:10:00.000Z"],
        ["rT", "user", "target", "2026-09-05T00:00:03.000Z"]
      ] as const;
      for (const [run_id, role, text, created_at] of rows) store.recordChatTurn({ chat_id: "c", run_id, role, text, created_at });
      const got = store.getChatTurnsBefore("c", 20, "2026-09-04T00:00:00.000Z", "2026-09-05T00:05:00.000Z", "rT");
      expect(got.map((t) => t.text)).toEqual(["in window", "reply"]);
      expect(store.getChatTurnsBefore("c", 1, "2026-09-04T00:00:00.000Z", "2026-09-05T00:05:00.000Z", "rT").map((t) => t.text)).toEqual(["reply"]);
    } finally {
      store.close();
    }
  });

  it("runLoopCapabilities returns the distinct capabilities the loop used", () => {
    const store = RunStore.openInMemory();
    try {
      const run = createRun(store, "k3");
      for (const capability of ["web_search", "web_search", "http_fetch"]) {
        store.recordLoopStep(run, { step: 1, action: "tool", capability, ok: true, result_digest: "" });
      }
      expect(store.runLoopCapabilities(run).sort()).toEqual(["http_fetch", "web_search"]);
      expect(store.runLoopCapabilities("nope")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
