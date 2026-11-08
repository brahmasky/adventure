import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACH_PATH } from "../../src/decisions/entries/attach-path.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import type { SupervisorDeps } from "../../src/omp/planner-supervisor.js";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { chatWorkspace } from "../../src/omp/workspace.js";
import type { PlannerState } from "../../src/omp/planner-session.js";
import type { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { cleanups, fakeSession, harness, req, until, type Fake } from "../helpers/supervisor-harness.js";

afterEach(async () => { for (const c of cleanups.splice(0)) await c(); vi.restoreAllMocks(); });
type Q = { prepare(q: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
const db = (store: RunStore) => (store as unknown as { db: Q }).db;
const rows = (store: RunStore) => db(store).prepare("SELECT verdict, reason_code, rung, run_id, tool_call_id FROM decisions WHERE entry_id = 'attach.path' ORDER BY rowid").all()
  .map((r) => [r.verdict, r.reason_code, r.rung, r.run_id, r.tool_call_id]);
const storedAssistant = (store: RunStore) => db(store).prepare("SELECT text FROM chat_turns WHERE role = 'assistant' ORDER BY rowid").all().map((r) => r.text);
function withRecorder(session: Fake, extra: Partial<SupervisorDeps> = {}) {
  const cell: { store?: RunStore; calls: string[] } = { calls: [] };
  const recorder: DecisionRecorder = { record: (e, r, c) => { cell.calls.push(e.id); return storeRecorder(cell.store as RunStore).record(e, r, c); } };
  const h = harness(session, {}, { recorder, ...extra }); cell.store = h.store;
  const ws = chatWorkspace(h.data, "42"); mkdirSync(ws, { recursive: true });
  return { ...h, ws, attachCalls: () => cell.calls.filter((id) => id === "attach.path").length };
}
/** A child that answers every prompt with `text` and ends the turn. */
function answering(text: string): Fake {
  const session: Fake = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); session.assistant(text); e({ type: "agent_end" }); } });
  return session;
}
/** tests/omp/planner-supervisor-settle.test.ts:27: a child whose turn stays open until the test emits. */
function held() {
  const h: { prompted: boolean; emit: (f: OmpFrame) => void; say: (t: string) => void } = { prompted: false, emit: () => undefined, say: () => undefined };
  const session = fakeSession({ onPrompt: (_t, e) => { h.emit = e; h.say = (t) => session.assistant(t); e({ type: "turn_start" }); e({ type: "agent_start" }); h.prompted = true; } });
  return { session, h };
}
const running = (sup: ReturnType<typeof harness>["sup"], h: { prompted: boolean }) => until(() => h.prompted && sup.state() === "RUNNING");
const sendBack = (sup: ReturnType<typeof harness>["sup"]) => sup.activeTurnForTest()!.onSendBack!("rule", "");
const REFUSE_MARKER = ["refuse", "marker_outside", "rule"];

describe("attach.path at parse (spec R7 §4.0)", () => {
  it("1. an inside and a ../ marker: one marker_outside row, two consults, the inside file delivered, the stored turn clean", async () => {
    const { store, sup, outcome, ws, attachCalls } = withRecorder(answering("Done.\n[[attach: in.txt]]\n[[attach: ../x.txt]]"));
    writeFileSync(join(ws, "in.txt"), "i");
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await sup.whenIdle();
    expect(rows(store)).toEqual([[...REFUSE_MARKER, run, null]]);
    expect(attachCalls()).toBe(2);
    expect(outcome.done[0]).toMatchObject({ text: "Done.", attachments: [join(ws, "in.txt")] });
    expect(storedAssistant(store)).toEqual(["Done."]);
  });
  it("2. an absolute outside path, a symlink out and a not-yet-existing inside file: two rows in line order, three consults", async () => {
    const { store, sup, outcome, ws, attachCalls } = withRecorder(answering("x\n[[attach: /etc/hosts]]\n[[attach: out.lnk]]\n[[attach: later.txt]]"));
    symlinkSync("/etc/hosts", join(ws, "out.lnk"));
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await sup.whenIdle();
    expect(rows(store)).toEqual([[...REFUSE_MARKER, run, null], [...REFUSE_MARKER, run, null]]);
    expect(attachCalls()).toBe(3);
    expect(outcome.done[0]).toMatchObject({ attachments: [join(ws, "later.txt")] });
  });
  it("3. the same refused path in pass 0 and pass 1 writes one row", async () => {
    const { session, h } = held(); const { store, sup, attachCalls } = withRecorder(session);
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await running(sup, h);
    h.say("a\n[[attach: ../x]]"); sendBack(sup);
    h.emit({ type: "agent_start" }); h.say("b\n[[attach: ../x]]"); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect(rows(store)).toEqual([[...REFUSE_MARKER, run, null]]);
    expect(attachCalls()).toBe(1);
  });
  it("4. a turn that takes the failure arm writes none", async () => {
    const { session, h } = held(); const { store, sup, outcome, attachCalls } = withRecorder(session);
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await running(sup, h);
    h.say("x\n[[attach: ../x]]");
    await sup.abortAll("killed"); await sup.whenIdle();
    expect(outcome.failed.map((f) => (f as { run_id: string }).run_id)).toEqual([run]);
    expect(rows(store)).toEqual([]);
    expect(attachCalls()).toBe(0);
  });
  it("5. a /kill inside the settle snapshot is seen before any consult: no row", async () => {
    const { session, h } = held(); const { store, sup, outcome, attachCalls } = withRecorder(session);
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await running(sup, h);
    h.say("a\n[[attach: ../x]]"); sendBack(sup);
    h.emit({ type: "agent_start" }); h.say("b\n[[attach: ../x]]");
    let release: () => void = () => undefined; const gate = new Promise<void>((r) => { release = r; });
    let called = false;
    session.scriptGetState(async (): Promise<PlannerState> => { called = true; await gate; return { todoPhases: [], queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] } }; });
    h.emit({ type: "agent_end" });
    await until(() => called);
    const k = sup.abortAll("killed"); release(); await k; await sup.whenIdle();
    expect(outcome.done).toEqual([]);
    expect(outcome.failed[0]).toMatchObject({ run_id: run, error_type: "killed" });
    expect(rows(store)).toEqual([]);
    expect(attachCalls()).toBe(0);
  });
  it("6. a merged run gets no row of its own: the parent's row only", async () => {
    const { session, h } = held(); const { store, sup, outcome } = withRecorder(session);
    const parent = createQueuedTurnRun(store); const merged = createQueuedTurnRun(store);
    sup.submit(req(parent)); await running(sup, h);
    sup.submit(req(merged, "more")); await until(() => session.steers.length === 1);
    h.say("r\n[[attach: ../x]]"); h.emit({ type: "agent_end" }); await sup.whenIdle();
    expect(outcome.done.find((d) => (d as { run_id: string }).run_id === merged)).toMatchObject({ merged_into: parent });
    expect(rows(store)).toEqual([[...REFUSE_MARKER, parent, null]]);
  });
  it("7. a lane reply never consults", async () => {
    const { store, sup, outcome, attachCalls } = withRecorder(answering("unused"), { triage: async () => ({ kind: "lane_reply", text: "lane\n[[attach: ../x]]", buttons: [] }) });
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await sup.whenIdle();
    expect(attachCalls()).toBe(0);
    expect(rows(store)).toEqual([]);
    expect(outcome.done).toHaveLength(1);
  });
  it("8. the row precedes recordChatTurn: a throwing chat-turn write still leaves it", async () => {
    const { store, sup } = withRecorder(answering("x\n[[attach: ../x]]"));
    const orig = store.recordChatTurn.bind(store);
    vi.spyOn(store, "recordChatTurn").mockImplementation((i) => { if (i.role === "assistant") throw new Error("planted"); return orig(i); });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await sup.whenIdle();
    expect(rows(store)).toEqual([[...REFUSE_MARKER, run, null]]);
  });
  it("9. outcome.complete throwing leaves no row (best-effort: the consult follows the completion); the crash is the ordinary incident", async () => {
    const { store, sup, outcome } = withRecorder(answering("x\n[[attach: ../x]]"));
    outcome.complete = () => { throw new Error("planted"); }; // the supervisor reads deps.outcome at call time
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await sup.whenIdle();
    expect(rows(store)).toEqual([]);
  });
  it("10. a registry mistake (a non-rule rung) is caught: no row, a log line, the turn finishes, no crash incident (P20)", async () => {
    const { store, sup, outcome } = withRecorder(answering("x\n[[attach: ../x]]"), { triage: async () => ({ kind: "fallthrough", route: { role: "default", effort: null, verdict_id: "jv_1" } }) }); // a routed turn: routeEnd fires only with a verdict id
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ladder = ATTACH_PATH.ladder;
    (ATTACH_PATH as { ladder: unknown }).ladder = [{ kind: "system_one", name: "x", questions: [], bars: { kind: "provisional", question: "q", criteriaHash: "h", model: "m", p: 0.5, source: "t" }, timeoutMs: 1 }];
    try {
      const run = createQueuedTurnRun(store); sup.submit(req(run)); await sup.whenIdle();
      expect(rows(store)).toEqual([]);
      expect(err.mock.calls.some((c) => String(c[0]).includes("attach_path_record_failed"))).toBe(true);
      expect(storedAssistant(store)).toEqual(["x"]);
      expect(outcome.routeEnds).toHaveLength(1);
      expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_done" });
      expect(outcome.incidents).not.toContainEqual(expect.objectContaining({ k: "planner_turn_crashed" }));
    } finally { (ATTACH_PATH as { ladder: unknown }).ladder = ladder; }
  });
  it("11. a throwing rule fails closed: one refuse/fail row per consult, accepted ones included; delivery unchanged (P20)", async () => {
    const { store, sup, outcome, ws } = withRecorder(answering("x\n[[attach: in.txt]]\n[[attach: ../x]]"));
    writeFileSync(join(ws, "in.txt"), "i");
    const rung = ATTACH_PATH.ladder[0] as { decide: unknown }; const orig = rung.decide;
    rung.decide = () => { throw new Error("planted"); };
    try {
      const run = createQueuedTurnRun(store); sup.submit(req(run)); await sup.whenIdle();
      expect(rows(store)).toEqual([["refuse", null, "fail", run, null], ["refuse", null, "fail", run, null]]);
      expect(outcome.done[0]).toMatchObject({ attachments: [join(ws, "in.txt")] });
    } finally { rung.decide = orig; }
  });
  it("12. no recorder: nothing written, no throw", async () => {
    const { store, sup, outcome } = harness(answering("x\n[[attach: ../x]]"));
    const run = createQueuedTurnRun(store); sup.submit(req(run)); await sup.whenIdle();
    expect(outcome.done).toHaveLength(1);
    expect(rows(store)).toEqual([]);
  });
});
