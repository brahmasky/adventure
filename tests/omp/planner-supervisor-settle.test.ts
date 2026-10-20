import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { RESTATED_MARKER, replyOfPasses } from "../../src/omp/planner-supervisor.js";
import { chatWorkspace } from "../../src/omp/workspace.js";
import { setSharedOmpVersionCacheForTest } from "../../src/omp/omp-version-cache.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { RunStore } from "../../src/run/run-store.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { drainOutbox } from "../helpers/omp-worker.js";
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
    h.emit({ type: "agent_start" }); h.say("partial second", { stopReason: "aborted" });
    expect(sup.turnPassesForTest()[1]!.texts).toEqual([]); // the aborted message is not stored
    h.emit({ type: "agent_end", aborted: true }); await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "planner_exit", partial: "first answer" });
  });
  it("a model error in pass 1 completes with pass 0's text and never retries on another model", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("first answer"); sendBack(sup);
    h.emit({ type: "agent_start" }); h.say("half", { stopReason: "error", errorMessage: "429 rate limit" }); h.emit({ type: "error", error: "429 rate limit" }); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ text: "first answer" });
    expect(session.prompts).toHaveLength(1);
  });
  it("P2' fixture: two agent_start, one terminal agent_end → the turn settles exactly once", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("a"); h.emit({ type: "agent_end", isTerminal: false }); sendBack(sup); h.emit({ type: "agent_start" }); h.say("b"); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect((outcome.done[0] as { text: string }).text).toBe("b");
    session.emitForTest({ type: "agent_end" });
    await new Promise((r) => setTimeout(r, 20));
    expect(outcome.done).toHaveLength(1); expect(outcome.failed).toHaveLength(0);
  });
});

const jev = (ps: number[]) => async (r: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1,
  answers: Object.fromEntries(Object.keys(r.questions).map((id, k) => [id, { type: "noul" as const, noul: ps[k]! }])) });
const settleReq = (text: string, stop_hook_active = false) => ({ kind: "settle", stop_hook_active, text });
const rows = (store: RunStore, run_id: string) => store.listDecisionsForRun(run_id).filter((r) => r.entry_id === "turn.settle");
const outcomes = (store: RunStore, run_id: string) => rows(store, run_id).flatMap((r) => store.listDecisionOutcomes(r.decision_id).map((o) => [o.signal, o.value]));

describe("the settle request end to end (spec §3)", () => {
  it("a claim with no schedule_task: sendBack with the note, one row (rule), pass 1 replaces, settle_sent_back written on the continuation", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("I've scheduled it for 9am.");
    const r = await session.request(settleReq("I've scheduled it for 9am.")) as { sendBack: boolean; note?: string };
    expect(r.sendBack).toBe(true); expect(r.note).toMatch(/^You said you scheduled it/);
    expect(rows(store, run_id).map((x) => [x.rung, x.verdict, x.reason_code])).toEqual([["rule", "send_back", "claim_scheduled"]]);
    h.emit({ type: "agent_start" }); h.say("Tell me the time and I'll schedule it.");
    // omp fires session_stop again (stop_hook_active) BEFORE its one terminal agent_end (probe P2')
    expect(await session.request(settleReq("Tell me the time and I'll schedule it.", true))).toEqual({ sendBack: false });
    h.emit({ type: "agent_end" });
    await sup.whenIdle();
    expect((outcome.done[0] as { text: string }).text).toBe("Tell me the time and I'll schedule it.");
    expect(outcomes(store, run_id)).toEqual([["settle_sent_back", "claim_scheduled"]]);
    expect(rows(store, run_id)).toHaveLength(1);
  });
  it("a Jev send-back sets settleAsk; a write in pass 1 takes the settle redirect at the gate", async () => {
    const { session, h } = held(); const { store, sup } = harness(session, {}, { settleClient: () => jev([0.1, 0.1, 0.9, 0.1]) });
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("I'll look into it next.");
    expect((await session.request(settleReq("I'll look into it next.")) as { sendBack: boolean }).sendBack).toBe(true);
    expect(sup.activeTurnForTest()!.settleAsk).toBe(true);
    expect(rows(store, run_id).map((x) => [x.rung, x.reason_code])).toEqual([["system_one", "jev_promise"]]);
    h.emit({ type: "agent_start" });
    expect(await session.request({ kind: "gate", tool: "write", input: { path: "/tmp/x" }, toolCallId: "w1" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("sent back") });
    h.say("Done: nothing more to do."); h.emit({ type: "agent_end" }); await sup.whenIdle();
  });
  it("a send-back the extension discarded (no continuation) writes settle_discarded extension_timeout; on an abort, signal", async () => {
    const a = held(); const A = harness(a.session);
    const r1 = createQueuedTurnRun(A.store); A.sup.submit(req(r1)); await running(A.sup, a.h);
    a.h.say("I've saved it."); await a.session.request(settleReq("I've saved it.")); a.h.emit({ type: "agent_end" }); await A.sup.whenIdle();
    expect(outcomes(A.store, r1)).toEqual([["settle_discarded", "extension_timeout"]]);
    const b = held(); const B = harness(b.session);
    const r2 = createQueuedTurnRun(B.store); B.sup.submit(req(r2)); await running(B.sup, b.h);
    b.h.say("I've saved it."); await b.session.request(settleReq("I've saved it.")); await B.sup.abortAll("killed");
    expect(outcomes(B.store, r2)).toEqual([["settle_discarded", "signal"]]);
  });
  it("guards: a hostile turn and a queued steer never send back, with their reasons recorded; deadline arithmetic 61 s eligible, 59 s short", async () => {
    const { session, h } = held(); const { store, sup } = harness(session, {}, { settleClient: () => jev([0.9, 0.9, 0.9, 0.9]) });
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    sup.activeTurnForTest()!.trust!.raise("injection_withheld", "x");
    h.say("done"); expect(await session.request(settleReq("done"))).toEqual({ sendBack: false });
    expect(rows(store, run_id)[0]).toMatchObject({ rung: "rule", reason_code: "hostile" });
    h.emit({ type: "agent_end" }); await sup.whenIdle();
    const q = held(); const Q = harness(q.session, {}, { settleClient: () => jev([0.9, 0.9, 0.9, 0.9]) });
    q.session.scriptGetState(async () => ({ todoPhases: [], queuedMessageCount: 1, queuedMessages: { steering: ["later"] } }));
    const r2 = createQueuedTurnRun(Q.store); Q.sup.submit(req(r2)); await running(Q.sup, q.h);
    q.h.say("done"); expect(await q.session.request(settleReq("done"))).toEqual({ sendBack: false });
    expect(rows(Q.store, r2)[0]).toMatchObject({ reason_code: "steer_queued" });
    q.h.emit({ type: "agent_end" }); await Q.sup.whenIdle();
    const d = held(); const D = harness(d.session, { HOUGE_OMP_TURN_TIMEOUT_MS: "59500" }, { settleClient: () => jev([0.9, 0.9, 0.9, 0.9]) });
    const r3 = createQueuedTurnRun(D.store); D.sup.submit(req(r3)); await running(D.sup, d.h);
    d.h.say("done"); await d.session.request(settleReq("done"));
    expect(rows(D.store, r3)[0]).toMatchObject({ reason_code: "deadline_short" });
    d.h.emit({ type: "agent_end" }); await D.sup.whenIdle();
    const e = held(); const E = harness(e.session, { HOUGE_OMP_TURN_TIMEOUT_MS: "61500" }, { settleClient: () => jev([0.9, 0.9, 0.9, 0.9]) });
    const r4 = createQueuedTurnRun(E.store); E.sup.submit(req(r4)); await running(E.sup, e.h);
    e.h.say("done"); expect(await e.session.request(settleReq("done"))).toMatchObject({ sendBack: true });
    expect(rows(E.store, r4)[0]).toMatchObject({ rung: "system_one", verdict: "send_back" });
    e.h.emit({ type: "agent_start" }); e.h.say("done, for real"); e.h.emit({ type: "agent_end" }); await E.sup.whenIdle();
  });
  it("todo: get_state before the prompt and at settle; a pending item added this turn sends back todo_pending; an unchanged list does not", async () => {
    let calls = 0;
    const { session, h } = held(); const { store, sup } = harness(session);
    session.scriptGetState(async () => ({ todoPhases: calls++ === 0 ? [] : [{ name: "p", tasks: [{ content: "x", status: "pending" }] }], queuedMessageCount: 0, queuedMessages: { steering: [] } }));
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    expect(calls).toBe(1); // before the prompt
    h.say("Working on it."); const r = await session.request(settleReq("Working on it.")) as { note?: string };
    expect(r.note).toMatch(/^Your todo list still has 1 open items\./);
    expect(calls).toBe(2); // at settle
    h.emit({ type: "agent_start" }); h.say("Done."); h.emit({ type: "agent_end" }); await sup.whenIdle();
    const u = held(); const U = harness(u.session);
    u.session.scriptGetState(async () => ({ todoPhases: [{ name: "p", tasks: [{ content: "old", status: "pending" }] }], queuedMessageCount: 0, queuedMessages: { steering: [] } }));
    const r2 = createQueuedTurnRun(U.store); U.sup.submit(req(r2)); await running(U.sup, u.h);
    u.h.say("ok"); expect(await u.session.request(settleReq("ok"))).toEqual({ sendBack: false });
    u.h.emit({ type: "agent_end" }); await U.sup.whenIdle();
  });
  it("final-pass audit: a pass 1 that still claims writes settle_unverified and queues ONE urgent card even when the Jev re-ask also flags", async () => {
    const { session, h } = held(); const { store, sup } = harness(session, {}, { settleClient: () => jev([0.1, 0.1, 0.9, 0.1]) });
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("I've saved it."); await session.request(settleReq("I've saved it."));
    h.emit({ type: "agent_start" }); h.say("I've saved it, and next I'll tidy up."); h.emit({ type: "agent_end" }); await sup.whenIdle();
    await until(() => outcomes(store, run_id).length >= 3);
    expect(outcomes(store, run_id)).toEqual([["settle_sent_back", "claim_saved"], ["settle_unverified", "claim_saved"], ["settle_unverified", "jev_promise"]]);
    const cards = [...drainOutbox(store).entries()].filter(([k]) => k.startsWith("urgent:settle_unverified:"));
    expect(cards).toHaveLength(1);
    // drainOutbox maps each key to the notification's payload itself ({ text }), as the other card tests read it
    expect(String((cards[0]![1] as { text: string }).text)).toMatch(/^⚠️ Settled unverified: You said you saved it/);
  });
  it("the production redactor strips a planted secret and the bridge token from the real Jev request (spec §3.1)", async () => {
    const bodies: string[] = [];
    const spy = (ps: number[]) => (_run_id: string) => async (r: JevRequest) => { bodies.push(JSON.stringify(r)); return jev(ps)(r); };
    const { session, h } = held(); const { store, sup } = harness(session, {}, { settleClient: spy([0.1, 0.1, 0.1, 0.1]) });
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    const token = session.options[0]!.bridgeToken;
    const text = `Config read. api_key: ABCDEFGHIJKLMNOPQRSTUVWX and the token ${token} are fine.`;
    h.say(text); await session.request(settleReq(text));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWX"); expect(bodies[0]).not.toContain(token);
    expect(bodies[0]).toContain("Config read."); // the reply itself did reach Jev, masked
    h.emit({ type: "agent_end" }); await sup.whenIdle();
  });
  it("a retried leg (model error, RETRY_NOTE) gets its own settle decision, not the first leg's cached answer", async () => {
    const { session, h } = held(); const { store, sup } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    expect(await session.request(settleReq(""))).toEqual({ sendBack: false }); // leg 0 settles `empty`
    h.prompted = false; // BEFORE the retry prompt can fire (the fake calls onPrompt after a 5 ms timer)
    h.emit({ type: "error", error: "429 rate limit" }); h.emit({ type: "agent_end" });
    await until(() => session.prompts.length === 2); await running(sup, h);
    h.say("I've scheduled it."); expect((await session.request(settleReq("I've scheduled it."))) as { sendBack: boolean }).toMatchObject({ sendBack: true });
    expect(rows(store, run_id).map((x) => x.reason_code)).toEqual(["empty", "claim_scheduled"]);
    h.emit({ type: "agent_start" }); h.say("Tell me when."); h.emit({ type: "agent_end" }); await sup.whenIdle();
  });
  it("a model error in pass 1 writes settle_discarded continuation_failed", async () => {
    const { session, h } = held(); const { store, sup, outcome } = harness(session);
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("I've saved it."); await session.request(settleReq("I've saved it."));
    h.emit({ type: "agent_start" }); h.emit({ type: "error", error: "429 rate limit" }); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ text: "I've saved it." });
    expect(outcomes(store, run_id)).toEqual([["settle_discarded", "continuation_failed"]]);
  });
  it("past the 4 s budget (the gate hold eats 3.8 s of it) Houge answers sendBack: false inside the extension's 5 s and the row is fail/budget", async () => {
    const { session, h } = held(); const { store, sup } = harness(session, {}, { settleClient: () => jev([0.9, 0.9, 0.9, 0.9]), gateHold: { settleMs: 3_800 } });
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    h.say("done"); const t0 = Date.now();
    expect(await session.request(settleReq("done"))).toEqual({ sendBack: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3_800); expect(Date.now() - t0).toBeLessThan(4_600);
    expect(rows(store, run_id)[0]).toMatchObject({ rung: "fail", reason_code: "budget" });
    h.emit({ type: "agent_end" }); await sup.whenIdle();
  }, 10_000);
  it("a judge_read still in flight at the terminal agent_end is drained (bounded) before trust finalises: a local read lost → turn_trust_final untrusted", async () => {
    const judge = async (i: { text: string }) => { await new Promise((r) => setTimeout(r, 4_000)); return { text: i.text, verdict: "pass" as const, withheld: 0, withheldUnjudged: 0, framed: 0, notChecked: 0, sent: 1, unanswered: 0, skipped: false, blocked: null, decisionId: null, masked: 0 }; };
    const { session, h } = held(); const { store, sup } = harness(session, {}, { buildTools: () => ({ registry: new ToolRegistry(), quarantine: async () => ({ digest: "", contains_instructions: false, source_meta: { tool: "x", bytes: 0 } }), judge }) });
    const run_id = createQueuedTurnRun(store); sup.submit(req(run_id)); await running(sup, h);
    expect(await session.request({ kind: "gate", tool: "read", input: { path: "/tmp/a.txt" }, toolCallId: "r1" })).toEqual({ decision: "allow" });
    void session.request({ kind: "judge_read", toolCallId: "r1", text: "slow file" }).catch(() => undefined);
    await until(() => (sup.activeTurnForTest()?.judgeInFlight?.size ?? 0) === 1); // the judge_read reached the bridge before the turn ends
    h.say("done"); h.emit({ type: "agent_end" });
    const t0 = Date.now(); await sup.whenIdle();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_900); expect(Date.now() - t0).toBeLessThan(3_900);
    expect(store.getLedgerEvents(run_id).find((e) => e.event_type === "turn_trust_final")?.payload).toEqual({ max_level: "untrusted" });
  }, 10_000);
});
