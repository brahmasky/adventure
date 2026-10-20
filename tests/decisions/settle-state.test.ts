import { describe, expect, it } from "vitest";
import { buildSettleState, PACO_MESSAGE_CAP, SETTLE_JEV_HEAD, SETTLE_JEV_TAIL, settleJevState, toolSummary } from "../../src/decisions/settle-state.js";

// Spec §3.1 (senior B4): the reply and Paco's message pass through redactForJudge BEFORE the Jev rung, as a required
// argument of the builder; a planted secret in a reply never reaches the Jev request. The tool summary is code-built from
// ledger rows (tool names and outcomes), never text.
const ev = (event_type: string, payload: Record<string, unknown>) => ({ event_id: "e", correlation_id: "c", event_type, occurred_at: "2026-10-20T00:00:00.000Z", actor: "core", sequence: 1, payload }) as any;
const raw = (over: Partial<Parameters<typeof buildSettleState>[0]> = {}) => ({ run_id: "run_1", text: "x", pass: 0, sentBack: false, trust: "clean" as const, lastCallDenied: false, steerQueued: false,
  msLeft: 100_000, aborting: false, passErrored: false, evidence: [], todoBefore: null, todoNow: null, pacoMessage: "hi", attachmentsAccepted: 0, ...over });

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
  it("A11.3: no cut leaves a lone surrogate (TypeSafe's JSON parser may reject it): an emoji straddling each cut is dropped whole", () => {
    const id = (x: string) => x;
    const lone = (t: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
    const msg = buildSettleState(raw({ pacoMessage: `${"m".repeat(PACO_MESSAGE_CAP - 1)}😀tail` }), id).redacted.pacoMessage;
    expect(lone(msg)).toBe(false); expect(msg).toBe("m".repeat(PACO_MESSAGE_CAP - 1));
    const text = `${"H".repeat(SETTLE_JEV_HEAD - 1)}😀${"x".repeat(500)}😀${"T".repeat(SETTLE_JEV_TAIL - 1)}`;
    const reply = settleJevState(buildSettleState(raw({ text }), id)).reply;
    expect(lone(reply)).toBe(false);
    expect(reply).toBe(`${"H".repeat(SETTLE_JEV_HEAD - 1)}\n[…]\n${"T".repeat(SETTLE_JEV_TAIL - 1)}`);
  });
  it("A5: todo rows are bookkeeping and never reach Jev's tool summary; only todo rows → 'none'", () => {
    const todo = ev("tool_finished", { tool: "builtin:todo", status: "succeeded" });
    expect(toolSummary([todo, ev("tool_finished", { tool: "schedule_task", status: "succeeded" }), todo])).toBe("schedule_task: succeeded");
    expect(toolSummary([todo, todo])).toBe("none");
  });
});
