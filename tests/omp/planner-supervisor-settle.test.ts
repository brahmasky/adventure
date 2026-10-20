import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { RESTATED_MARKER, replyOfPasses } from "../../src/omp/planner-supervisor.js";
import { chatWorkspace } from "../../src/omp/workspace.js";
import { setSharedOmpVersionCacheForTest } from "../../src/omp/omp-version-cache.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { cleanups, fakeSession, harness, req, until } from "../helpers/supervisor-harness.js";

afterEach(async () => { setSharedOmpVersionCacheForTest(null); for (const c of cleanups.splice(0)) await c(); });

// Spec §3.5: a send-back opens pass 1 at the bridge's onSendBack (before the reply is written); the second agent_start
// is the continuation; the reply is pass 1's final text with a code fallback; attachments survive across passes; the
// hidden continuation message is never stored; an abort or a model error in pass 1 falls back to pass 0.
type Emit = (f: OmpFrame) => void;
const custom = (): OmpFrame => ({ type: "message_end", message: { role: "custom", customType: "session-stop-continuation", display: false, content: [{ type: "text", text: "HIDDEN" }] } });
/** A child whose prompt yields control to the test: `held.emit`, `held.say(text)`; the test ends the turn itself. */
function held() {
  const h: { prompted: boolean; emit: Emit; say: (t: string, extra?: object) => void } = { prompted: false, emit: () => undefined, say: () => undefined };
  const session = fakeSession({ onPrompt: (_t, e) => { h.emit = e; h.say = (t, extra) => session.assistant(t, extra); e({ type: "turn_start" }); e({ type: "agent_start" }); h.prompted = true; } });
  return { session, h };
}
/** The fake calls onPrompt asynchronously (codex plan B5): every case waits for `prompted`, never for a function to be "defined". */
const running = (sup: ReturnType<typeof harness>["sup"], h: { prompted: boolean }) => until(() => h.prompted && sup.state() === "RUNNING");
const sendBack = (sup: ReturnType<typeof harness>["sup"], kind: "rule" | "jev" = "rule", text = "") => sup.activeTurnForTest()!.onSendBack!(kind, text);

describe("replyOfPasses", () => {
  it("one pass: its final text; two passes: pass 1 unless empty (pass 0) or under a third of pass 0 (pass 0, marker, pass 1)", () => {
    expect(replyOfPasses([{ texts: ["a", "b"], final: "b" }])).toBe("b");
    expect(replyOfPasses([{ texts: [], final: "x".repeat(30) }, { texts: [], final: "y".repeat(10) }])).toBe("y".repeat(10));
    expect(replyOfPasses([{ texts: [], final: "x".repeat(30) }, { texts: [], final: "yy" }])).toBe(`${"x".repeat(30)}\n${RESTATED_MARKER}\nyy`);
    expect(replyOfPasses([{ texts: [], final: "first" }, { texts: [], final: "  " }])).toBe("first");
    expect(RESTATED_MARKER).toBe("— restated: —");
  });
});

describe("passes and the continuation (spec §3.5)", () => {
  it("a send-back then a continuation: the reply is pass 1's text, one completion, settleAsk only after a jev send-back", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id));
    await running(sup, h);
    h.say("I've scheduled it.");
    sendBack(sup, "jev");
    expect(sup.activeTurnForTest()!.settleAsk).toBe(true);
    h.emit({ type: "agent_start" }); h.emit(custom()); h.say("I have not scheduled it yet; tell me the time and I will."); h.emit({ type: "agent_end" });
    await sup.whenIdle();
    expect(outcome.done).toHaveLength(1);
    expect((outcome.done[0] as { text: string }).text).toBe("I have not scheduled it yet; tell me the time and I will.");
    expect(JSON.stringify(outcome.done)).not.toContain("HIDDEN");
    expect(store.getChatTurnsAfter("42", undefined, 10).filter((t) => t.role === "assistant").map((t) => t.text)).toEqual(["I have not scheduled it yet; tell me the time and I will."]);
  });
  it("a rule send-back leaves settleAsk off; a short pass 1 falls back to pass 0 with the marker", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("x".repeat(300)); sendBack(sup, "rule");
    expect(sup.activeTurnForTest()!.settleAsk).not.toBe(true);
    h.emit({ type: "agent_start" }); h.say("ok"); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect((outcome.done[0] as { text: string }).text).toBe(`${"x".repeat(300)}\n${RESTATED_MARKER}\nok`);
  });
  it("attachments: a pass-0 [[attach:]] survives; the same path in both passes is sent once; the marker lines leave the text", async () => {
    const { session, h } = held(); const { store, sup, outcome, data } = harness(session);
    const ws = chatWorkspace(data, "42"); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, "r.txt"), "r");
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("Report attached.\n[[attach: r.txt]]"); sendBack(sup);
    h.emit({ type: "agent_start" }); h.say("Here is the full report.\n[[attach: r.txt]]"); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ text: "Here is the full report.", attachments: [join(ws, "r.txt")] });
  });
  it("an aborted assistant message after a send-back is not stored; an abort in pass 1 fails with pass 0 as partial", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("first answer"); sendBack(sup);
    h.emit({ type: "agent_start" }); h.say("partial second", { stopReason: "aborted" }); h.emit({ type: "agent_end", aborted: true }); await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "planner_exit", partial: "first answer" });
  });
  it("a model error in pass 1 completes with pass 0's text and never retries on another model", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("first answer"); sendBack(sup);
    h.emit({ type: "agent_start" }); h.emit({ type: "error", error: "429 rate limit" }); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ text: "first answer" });
    expect(session.prompts).toHaveLength(1);
  });
  it("P2' fixture: two agent_start, one terminal agent_end → the turn settles exactly once", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("a"); sendBack(sup); h.emit({ type: "agent_start" }); h.say("b"); h.emit({ type: "agent_end" }); await sup.whenIdle();
    session.emitForTest({ type: "agent_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(outcome.done).toHaveLength(1); expect(outcome.failed).toHaveLength(0);
  });
});
