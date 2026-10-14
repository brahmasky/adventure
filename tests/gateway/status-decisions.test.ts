import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore, type DecisionInsert } from "../../src/run/run-store.js";
import { drainOutbox } from "../helpers/omp-worker.js";

// Paco 2026-10-14: /status carries a short decisions section (and only when there were decisions, so a quiet day reads as
// before); `/status decisions` answers with the last ten rows. Both are plain control replies through the outbox.
const NOW = "2026-10-13T10:00:00.000Z";
const D = (o: Partial<DecisionInsert> = {}): DecisionInsert => ({ entry_id: "tool.injection", entry_version: 1, run_id: "run_1", tool_call_id: "tc",
  stage: "post_tool", rung: "system_one", verdict: "pass", p: 0.1, reason_code: "jev_passed", fallback_reason: null, fallback_rung: null, armed_mode: "on",
  latency_ms: 5, created_at: "2026-10-13T09:00:00.000Z", ...o });
const status = (key: string, metadata?: Record<string, unknown>) => buildTypedTaskEvent({ source: "telegram", type: "status",
  requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "222" }, idempotency_key: `telegram:${key}`,
  source_reference: `telegram:update:${key}`, ...(metadata ? { metadata } : {}) });
const reply = (store: RunStore): string => String([...drainOutbox(store).values()][0]?.text);

describe("/status and decisions", () => {
  it("a day with no decisions renders /status exactly as before: no decisions section", () => {
    const store = RunStore.openInMemory();
    new Gateway(store).intake(status("s1"), NOW);
    const text = reply(store);
    expect(text).toContain("💰 COST & USAGE");
    expect(text).not.toContain("DECISIONS");
    store.close();
  });
  it("a day with decisions appends the section after the existing ones", () => {
    const store = RunStore.openInMemory();
    store.insertDecision(D());
    new Gateway(store).intake(status("s2"), NOW);
    const text = reply(store);
    expect(text.indexOf("🪜 DECISIONS (24h)")).toBeGreaterThan(text.indexOf("💰 COST & USAGE"));
    expect(text).toContain("· tool.injection 1 — Jev 1");
    store.close();
  });
  it("/status decisions answers with the last rows, not a run lookup", () => {
    const store = RunStore.openInMemory();
    store.insertDecision(D());
    expect(new Gateway(store).intake(status("s3", { status_view: "decisions" }), NOW)).toMatchObject({ ok: true, status: "status_returned" });
    const text = reply(store);
    expect(text.split("\n")[0]).toBe("🪜 Last 10 decisions");
    expect(text).toContain("tool.injection · Jev → pass · p 0.10 · run 1");
    expect(text).not.toContain("Run not found");
    store.close();
  });
});
