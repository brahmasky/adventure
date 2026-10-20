import { describe, expect, it } from "vitest";
import { buildSettleState, PACO_MESSAGE_CAP, SETTLE_JEV_HEAD, SETTLE_JEV_TAIL, settleJevState, toolSummary } from "../../src/decisions/settle-state.js";

// Spec §3.1 (senior B4): the reply and Paco's message pass through redactForJudge BEFORE the Jev rung, as a required
// argument of the builder; a planted secret in a reply never reaches the Jev request. The tool summary is code-built from
// ledger rows (tool names and outcomes), never text.
const ev = (event_type: string, payload: Record<string, unknown>) => ({ event_id: "e", correlation_id: "c", event_type, occurred_at: "2026-10-20T00:00:00.000Z", actor: "core", sequence: 1, payload }) as any;
const raw = (over: Partial<Parameters<typeof buildSettleState>[0]> = {}) => ({ run_id: "run_1", text: "x", pass: 0, sentBack: false, trust: "clean" as const, lastCallDenied: false, steerQueued: false,
  msLeft: 100_000, aborting: false, evidence: [], todoBefore: null, todoNow: null, pacoMessage: "hi", attachmentsAccepted: 0, ...over });

describe("buildSettleState", () => {
  it("redacts the reply and Paco's message with the given redactor and caps the message at 600 chars", () => {
    const s = buildSettleState(raw({ text: "saved api_key: ABCDEFGHIJKLMNOPQRSTUVWX ok", pacoMessage: "m".repeat(700) }), (x) => x.replace("ABCDEFGHIJKLMNOPQRSTUVWX", "<broker>"));
    expect(s.redacted.text).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(s.redacted.pacoMessage).toHaveLength(PACO_MESSAGE_CAP);
    expect(s.text).toContain("ABCDEFGHIJKLMNOPQRSTUVWX"); // the code checks still read the raw reply
  });
  it("the Jev reply is exactly head 4000 + marker + tail 2000: the middle is dropped; 6000 chars stay whole, 6001 are cut", () => {
    const id = (x: string) => x;
    const cut = settleJevState(buildSettleState(raw({ text: "H".repeat(4000) + "MIDDLE_SENTINEL" + "x".repeat(500) + "T".repeat(2000) }), id));
    expect(cut.reply).not.toContain("MIDDLE_SENTINEL");
    expect(cut.reply).toBe("H".repeat(4000) + "\n[…]\n" + "T".repeat(2000));
    const whole = "a".repeat(SETTLE_JEV_HEAD + SETTLE_JEV_TAIL);
    expect(settleJevState(buildSettleState(raw({ text: whole }), id)).reply).toBe(whole);
    expect(settleJevState(buildSettleState(raw({ text: whole + "b" }), id)).reply).toContain("[…]");
  });
  it("the Jev state is cut from the redacted text: a secret inside head or tail is gone", () => {
    const secret = "sk-" + "b".repeat(40);
    const s = buildSettleState(raw({ text: `${secret} ${"m".repeat(9_000)} ${secret}` }), (x) => x.split(secret).join("<redacted>"));
    const js = settleJevState(s);
    expect(JSON.stringify(js)).not.toContain(secret);
    expect(js.reply).toContain("[…]");
  });
  it("the tool summary names tools and outcomes only, in ledger order; none → 'none'", () => {
    expect(toolSummary([])).toBe("none");
    expect(toolSummary([ev("tool_finished", { tool: "schedule_task", status: "succeeded", output_hash: "h" }), ev("tool_finished", { tool: "builtin:read", status: "failed" }), ev("loop_step", { action: "x" })]))
      .toBe("schedule_task: succeeded; builtin:read: failed");
  });
});
