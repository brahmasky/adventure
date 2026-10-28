import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { createOutboxDispatcher } from "../../src/telegram/telegram-daemon.js";

// Stage 4A §7: the daemon's one sender settles a sealed run the moment its report is delivered (the sweep is only the net).
describe("createOutboxDispatcher", () => {
  it("routes a delivered final_report of a sealing run to settlement", async () => {
    const s = RunStore.openInMemory();
    const row = s.insertStandingApprovalForTest({ schedule_id: "sch_1", chat_id: "555", action_fingerprint: "fp", state: "sealing", sealed_run_id: "run_gone", sealed_tool_call_id: "tc", sealing_started_at: new Date().toISOString() });
    s.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "final_report", idempotency_key: "run_gone:final_report", run_id: "run_gone", correlation_id: "run_gone", payload: { text: "x" } });
    const d = createOutboxDispatcher(s, { local: { send: async () => ({ provider_message_id: "l" }) }, telegram: { send: async () => ({ provider_message_id: "t" }) } });
    await d.dispatchOnce("x");
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "sealed_trial_failed" }); // no such run: never a seal
  });
  it("is the daemon's only sender: telegram-daemon.ts builds its dispatcher through it (a bare NotificationDispatcher would deliver without settling)", () => {
    const src = readFileSync(new URL("../../src/telegram/telegram-daemon.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const dispatcher = createOutboxDispatcher\(options\.store,/);
    expect(src.match(/new NotificationDispatcher\(/g) ?? []).toHaveLength(1); // the one inside createOutboxDispatcher
  });
});
