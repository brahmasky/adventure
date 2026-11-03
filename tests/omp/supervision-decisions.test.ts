import { afterEach, describe, expect, it, vi } from "vitest";
import { decideSync } from "../../src/decisions/decide.js";
import { CRASH_WINDOW_MS, PLANNER_CRASH_GUARD } from "../../src/decisions/entries/planner-crash-guard.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import type { Effort, TurnRole } from "../../src/jev/tree-policy.js";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { RETRY_NOTE, type SupervisorDeps } from "../../src/omp/planner-supervisor.js";
import type { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { cleanups, fakeSession, harness, req, until, type Fake, type Outcome, type Script } from "../helpers/supervisor-harness.js";

afterEach(async () => { for (const c of cleanups.splice(0)) await c(); vi.restoreAllMocks(); vi.useRealTimers(); });

const CG = "planner.crash_guard"; const TR = "turn.retry"; const SQ = "intake.steer_or_queue"; const LS = "context.lessons"; const CC = "turn.clarify_cap"; const TM = "turn.model"; // R6 P4: one TM per completed pin walk (the first leg after CC, each walked retry after its TR)
type Row = [string, string, string | null, string, string | null];
type Q = { prepare(q: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
const q = (store: RunStore) => (store as unknown as { db: Q }).db;
function rows(store: RunStore): Row[] {
  return q(store).prepare("SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id IN ('planner.crash_guard','turn.retry') ORDER BY rowid").all()
    .map((r) => [r.entry_id as string, r.verdict as string, (r.reason_code as string | null) ?? null, r.run_id as string, (r.tool_call_id as string | null) ?? null]);
}
/** The recorder needs the store `harness` builds: resolve it lazily (R3 P11). */
function withRecorder(session: Fake, extra: Partial<SupervisorDeps> = {}, env: Record<string, string> = {}) {
  const cell: { store?: RunStore; counts: string[] } = { counts: [] };
  const recorder: DecisionRecorder = { record: (e, r, c) => { cell.counts.push(e.id); return storeRecorder(cell.store as RunStore).record(e, r, c); } };
  const h = harness(session, env, { recorder, ...extra }); cell.store = h.store;
  return { ...h, counts: cell.counts };
}
const outboxN = (store: RunStore) => q(store).prepare("SELECT COUNT(*) AS n FROM notification_outbox").all()[0]?.n as number;
const recordFailedN = (store: RunStore) => q(store).prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind='decision_record_failed' AND state='open'").all()[0]?.n as number;
const failedOf = (o: Outcome, run_id: string) => o.failed.find((f) => (f as { run_id: string }).run_id === run_id) as { error_type: string; error_ref: string } | undefined;
const doneOf = (o: Outcome, run_id: string) => o.done.find((d) => (d as { run_id: string }).run_id === run_id) as { text: string } | undefined;
const incidentKinds = (o: Outcome) => o.incidents.map((i) => (i as { k: string }).k);
const crashLoops = (o: Outcome) => incidentKinds(o).filter((k) => k === "planner_crash_loop");
const escalations = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "routed_escalation").map((e) => e.payload);
/** tests/omp/planner-supervisor.test.ts:1483: the tree routes every turn to `role`. */
const routed = (role: TurnRole, effort: Effort | null = null, verdict_id: string | null = "jv_1"): Partial<SupervisorDeps> =>
  ({ triage: async () => ({ kind: "fallthrough", route: { role, effort, verdict_id } }) });
/** tests/omp/planner-supervisor.test.ts:1486: every prompt fails with `errors[i]` (as an assistant error) until they run out, then answers "ok". */
const failing = (errors: string[]) => {
  let calls = 0;
  const session: Fake = fakeSession({ onPrompt: (_t, e) => {
    e({ type: "turn_start" });
    const err = errors[calls++];
    if (err) session.assistant("", { stopReason: "error", errorMessage: err }); else session.assistant("ok");
    e({ type: "agent_end" });
  } });
  return session;
};
/** A prompt that emits `pre` frames, then one `other` error. */
const toolThenOther = (pre: OmpFrame[]) => {
  const session: Fake = fakeSession({ onPrompt: (_t, e) => {
    e({ type: "turn_start" }); for (const f of pre) e(f);
    session.assistant("", { stopReason: "error", errorMessage: "something odd" }); e({ type: "agent_end" });
  } });
  return session;
};
/** Spec §3 / tests/omp/planner-supervisor.test.ts:121: the first prompt errors quota, the second answers. */
const quotaThenOk = () => {
  let calls = 0;
  const session: Fake = fakeSession({ onPrompt: (_t, e) => {
    e({ type: "turn_start" });
    if (calls++ === 0) session.assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" }); else session.assistant("from 4.6");
    e({ type: "agent_end" });
  } });
  return session;
};
/** P10: a child that never asks for its manifest fails every start after manifestWaitMs (a crash exit each). */
const FAILING_START: Partial<SupervisorDeps> = { manifestWaitMs: 20 };
type Private = { exits: number[]; crashLatched: boolean; stale: boolean; session?: unknown; recordStartMissing(...a: unknown[]): void; ensureSession(fresh: boolean, turn: { finished: boolean; endSignalled: boolean; req: { run_id: string } }): Promise<unknown>; crashLooping(now: number): boolean };
const priv = (sup: unknown) => sup as Private;
const PAIR = [SQ, CG];
/** R5 P4: a start that reaches the spawn consults lessons in preparePaths (no row under the default), a halted one does not. */
const SPAWNED = [SQ, CG, LS];
const spawned = (n: number) => Array<string[]>(n).fill(SPAWNED).flat();
/** R5 P4: a completed turn's prompt build consults the cap once (no row under the default). */
const TURN = [SQ, CG, LS, CC, TM];
const turnOn = (h: { store: RunStore; sup: { submit(r: ReturnType<typeof req>): void; whenIdle(): Promise<void> } }, text = "hi") =>
  async () => { const r = createQueuedTurnRun(h.store, text); h.sup.submit(req(r, text)); await h.sup.whenIdle(); return r; };

describe("R4 rows — planner.crash_guard", () => {
  it("1 a clean turn: no row; the spawn consulted the guard once (P4)", async () => {
    const h = withRecorder(fakeSession()); const a = createQueuedTurnRun(h.store);
    h.sup.submit(req(a)); await h.sup.whenIdle();
    expect(doneOf(h.outcome, a)).toBeDefined(); expect(rows(h.store)).toEqual([]);
    expect(h.counts).toEqual(TURN);
  });
  it("2–4 three failed starts latch on turn 4 (limit_reached), turn 5 reads the latch (latched), a reset spawns again with no row", async () => {
    const session = fakeSession({ noManifest: true }); const h = withRecorder(session, FAILING_START); const turn = turnOn(h);
    for (let i = 0; i < 3; i++) expect((await turn().then((r) => failedOf(h.outcome, r)))?.error_ref.startsWith("start_failed")).toBe(true);
    expect(rows(h.store)).toEqual([]); // recent 0, 1, 2: spawn each time
    const r4 = await turn();
    expect(failedOf(h.outcome, r4)).toMatchObject({ error_type: "planner_exit", error_ref: "crash_loop" });
    expect(rows(h.store)).toEqual([[CG, "halt", "limit_reached", r4, null]]);
    expect(crashLoops(h.outcome)).toHaveLength(1); expect(session.options).toHaveLength(3);
    expect(h.counts).toEqual([...spawned(3), SQ, CG]); // the fourth turn halts before the spawn: no lessons consult
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 61_000); // the gateway admits 5 Telegram intakes per actor per minute
    const r5 = await turn();
    expect(failedOf(h.outcome, r5)).toMatchObject({ error_ref: "crash_loop" });
    expect(rows(h.store)).toEqual([[CG, "halt", "limit_reached", r4, null], [CG, "halt", "latched", r5, null]]);
    expect(crashLoops(h.outcome)).toHaveLength(1); expect(session.options).toHaveLength(3);
    h.sup.resetCrashGuard();
    await turn();
    expect(session.options).toHaveLength(4); expect(rows(h.store)).toHaveLength(2);
    expect(h.counts).toEqual([...spawned(3), SQ, CG, SQ, CG, ...SPAWNED]); // one guard consult per turn, spawned or refused; lessons only at a spawn (turn 6 spawns and fails its start again)
  });
  it("5 latched, a lane turn: the warm spawn's halt is recorded on the lane run, which completes with the lane text (Decision 2-A)", async () => {
    const session = fakeSession({ noManifest: true });
    const triage: SupervisorDeps["triage"] = async (i) => (i.text === "lane" ? { kind: "lane_reply", text: "lane text", buttons: [] } : { kind: "fallthrough" });
    const h = withRecorder(session, { ...FAILING_START, triage }); const turn = turnOn(h);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await turn());
    expect(h.sup.state()).not.toBe("RUNNING");
    const lane = await turnOn(h, "lane")();
    expect(doneOf(h.outcome, lane)).toMatchObject({ text: "lane text" }); expect(h.store.getRunState(lane)).toBe("completed");
    expect(rows(h.store)).toEqual([[CG, "halt", "limit_reached", ids[3] as string, null], [CG, "halt", "latched", lane, null]]);
    expect(h.counts).toEqual([...spawned(3), SQ, CG, SQ, CG]); // the lane turn: halted warm spawn, no prompt build
    expect(session.options).toHaveLength(3);
  });
  it("6 two failed starts then a good turn: no row, completed", async () => {
    const script: Script = { noManifest: true }; const session = fakeSession(script); const h = withRecorder(session, FAILING_START); const turn = turnOn(h);
    await turn(); await turn(); script.noManifest = false;
    const r3 = await turn();
    expect(doneOf(h.outcome, r3)).toMatchObject({ text: "answer" }); expect(rows(h.store)).toEqual([]);
    expect(h.counts).toEqual([...spawned(2), ...TURN]);
  });
  it("7 the late consult (P9): a consult after its turn finished latches and pages but writes no row; the next turn records latched", async () => {
    const h = withRecorder(fakeSession()); const now = Date.now();
    priv(h.sup).exits = [now - 3_000, now - 2_000, now - 1_000];
    expect(await priv(h.sup).ensureSession(true, { finished: true, endSignalled: true, req: { run_id: "late" } })).toBe("crash_loop");
    expect(priv(h.sup).crashLatched).toBe(true); expect(crashLoops(h.outcome)).toHaveLength(1);
    expect(rows(h.store)).toEqual([]); expect(h.counts).toEqual([]);
    const r = await turnOn(h)();
    expect(failedOf(h.outcome, r)).toMatchObject({ error_ref: "crash_loop" });
    expect(rows(h.store)).toEqual([[CG, "halt", "latched", r, null]]); expect(h.counts).toEqual(PAIR);
  });
  it("7b the row names the run of the turn it was given, not this.turn (none is live at the seam)", async () => {
    const h = withRecorder(fakeSession()); const r = createQueuedTurnRun(h.store);
    priv(h.sup).crashLatched = true; (h.sup as unknown as { turn: unknown }).turn = undefined;
    expect(await priv(h.sup).ensureSession(true, { finished: false, endSignalled: false, req: { run_id: r } })).toBe("crash_loop");
    expect(rows(h.store)).toEqual([[CG, "halt", "latched", r, null]]); expect(h.counts).toEqual([CG]);
  });
  it("P4 tally: one candidate refused at spawn is one more consult (the respawn): counts [SQ, CG, CG], no row", async () => {
    const h = withRecorder(fakeSession({ badModels: ["anthropic/claude-opus-5-5"] })); const a = createQueuedTurnRun(h.store);
    h.sup.submit(req(a)); await h.sup.whenIdle();
    expect(doneOf(h.outcome, a)).toBeDefined(); expect(rows(h.store)).toEqual([]);
    expect(h.counts).toEqual([SQ, CG, LS, CG, LS, CC, TM]); // each candidate spawn runs preparePaths: one lessons consult per attempt
  });
  it("P4 tally: the stale re-check (the child loses its bridge during the prompt build) is one more consult: counts [SQ, CG, SQ, CG], no row", async () => {
    const session = fakeSession(); const h = withRecorder(session);
    let release: () => void = () => undefined; let calls = 0;
    (h.sup as unknown as { d: { turnContext: { retrieve(): Promise<unknown> } } }).d.turnContext.retrieve = async () => {
      if (calls++ > 0) await new Promise<void>((r) => { release = r; });
      return { facts: [], pages: [] };
    };
    await turnOn(h)();
    const b = createQueuedTurnRun(h.store); h.sup.submit(req(b)); await until(() => calls === 2);
    session.dropBridge(); await until(() => priv(h.sup).stale);
    release(); await h.sup.whenIdle();
    expect(doneOf(h.outcome, b)).toBeDefined(); expect(rows(h.store)).toEqual([]);
    expect(h.counts).toEqual([...TURN, SQ, CC, CG, LS, TM]); // turn 2: the prompt build (cap) completes before the stale re-check respawns (guard, lessons), then the pin
  });
  it("the non-warm startSession consult names its own turn's run: a start refusal, then exits at the limit, halts there with a row on that run", async () => {
    const h = withRecorder(fakeSession({ badModels: ["anthropic/claude-opus-5-5"] })); const a = createQueuedTurnRun(h.store);
    const orig = priv(h.sup).recordStartMissing.bind(h.sup);
    priv(h.sup).recordStartMissing = (...args: unknown[]) => { orig(...args); const n = Date.now(); priv(h.sup).exits = [n - 3_000, n - 2_000, n - 1_000]; };
    h.sup.submit(req(a)); await h.sup.whenIdle();
    expect(failedOf(h.outcome, a)).toMatchObject({ error_ref: "crash_loop" });
    expect(rows(h.store)).toEqual([[CG, "halt", "limit_reached", a, null]]);
    expect(h.counts).toEqual([SQ, CG, LS, CG]); // the refused first candidate spawned (lessons); the halted re-ensure did not
  });
  it("afterWarm's re-ensure names the consulting turn's run: warm resolves ready, the child goes stale, exits at the limit, the re-ensure halts with a row on that run", async () => {
    const triage: SupervisorDeps["triage"] = async () => {
      await until(() => priv(h.sup).session !== undefined);
      const n = Date.now(); priv(h.sup).exits = [n - 3_000, n - 2_000, n - 1_000]; priv(h.sup).stale = true;
      return { kind: "fallthrough" };
    };
    const h = withRecorder(fakeSession(), { triage }); const a = createQueuedTurnRun(h.store);
    h.sup.submit(req(a)); await h.sup.whenIdle();
    expect(failedOf(h.outcome, a)).toMatchObject({ error_ref: "crash_loop" });
    expect(rows(h.store)).toEqual([[CG, "halt", "limit_reached", a, null]]);
    expect(h.counts).toEqual([SQ, CG, LS, CG]); // the warm spawn (lessons); the halted re-ensure spawned nothing
  });
  it("8b one clock read: with a clock that moves a minute per read, the row still agrees with the raw answer", async () => {
    const h = withRecorder(fakeSession()); const r = createQueuedTurnRun(h.store);
    const base = Date.now(); let n = 0;
    priv(h.sup).exits = [base - CRASH_WINDOW_MS + 1, base - CRASH_WINDOW_MS + 1, base - CRASH_WINDOW_MS + 1]; // inside for the first read only
    vi.spyOn(Date, "now").mockImplementation(() => base + 60_000 * n++);
    const halt = (h.sup as unknown as { crashGuard(turn: unknown): boolean }).crashGuard({ finished: false, req: { run_id: r } });
    vi.restoreAllMocks();
    expect(halt).toBe(true); expect(crashLoops(h.outcome)).toHaveLength(1);
    expect(rows(h.store)).toEqual([[CG, "halt", "limit_reached", r, null]]); // a second read would have excluded the exits from the capture
    expect(h.counts).toEqual([CG]);
  });
  it("8 boundary: three exits at exactly now − CRASH_WINDOW_MS are outside the window (strict >): spawned, no row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); const now = Date.now();
    const h = withRecorder(fakeSession());
    priv(h.sup).exits = [now - CRASH_WINDOW_MS, now - CRASH_WINDOW_MS, now - CRASH_WINDOW_MS];
    const r = await turnOn(h)();
    expect(doneOf(h.outcome, r)).toMatchObject({ text: "answer" }); expect(rows(h.store)).toEqual([]); expect(crashLoops(h.outcome)).toEqual([]);
    expect(h.counts).toEqual(TURN);
  });
  it("mirror: crashLooping(now) is halt ⇔ the rule's verdict over latched × recent", () => {
    const h = withRecorder(fakeSession()); const noop: DecisionRecorder = { record: () => null };
    for (const latched of [false, true]) for (const recent of [0, 2, 3, 4]) {
      h.sup.resetCrashGuard(); const now = Date.now();
      priv(h.sup).crashLatched = latched; priv(h.sup).exits = Array.from({ length: recent }, (_, i) => now - 1_000 - i);
      const want = decideSync(PLANNER_CRASH_GUARD, { latched, recent }, { run_id: null, tool_call_id: null, recorder: noop }).verdict === "halt";
      expect(priv(h.sup).crashLooping(now), `latched=${latched} recent=${recent}`).toBe(want);
    }
  });
});

describe("R4 rows — turn.retry", () => {
  it("9 quota then success: one retry/quota row; RETRY_NOTE once; completed", async () => {
    const session = quotaThenOk(); const h = withRecorder(session); const r = await turnOn(h)();
    expect(rows(h.store)).toEqual([[TR, "retry", "quota", r, null]]);
    expect(session.prompts).toEqual(["hi", RETRY_NOTE]); expect(doneOf(h.outcome, r)).toMatchObject({ text: "from 4.6" });
    expect(h.counts).toEqual([...TURN, TR, TM]);
  });
  it("10 model_refusal: final/model_refusal; failed model_error/model_refusal; one prompt", async () => {
    const session = failing(["model refusal"]); const h = withRecorder(session); const r = await turnOn(h)();
    expect(rows(h.store)).toEqual([[TR, "final", "model_refusal", r, null]]);
    expect(failedOf(h.outcome, r)).toMatchObject({ error_type: "model_error", error_ref: "model_refusal" }); expect(session.prompts).toEqual(["hi"]);
    expect(h.counts).toEqual([...TURN, TR]);
  });
  it("11 `other` on an unrouted turn: final/other_unrouted", async () => {
    const session = failing(["something odd"]); const h = withRecorder(session); const r = await turnOn(h)();
    expect(rows(h.store)).toEqual([[TR, "final", "other_unrouted", r, null]]);
    expect(failedOf(h.outcome, r)).toMatchObject({ error_type: "model_error", error_ref: "other" });
    expect(session.prompts).toEqual(["hi"]); expect(h.counts).toEqual([...TURN, TR]);
  });
  it("12 routed Default, `other` twice: retry/other_once then final/other_retried", async () => {
    const session = failing(["something odd", "something odd"]); const h = withRecorder(session, routed("default")); const r = await turnOn(h)();
    expect(rows(h.store)).toEqual([[TR, "retry", "other_once", r, null], [TR, "final", "other_retried", r, null]]);
    expect(failedOf(h.outcome, r)).toMatchObject({ error_type: "model_error", error_ref: "other" }); expect(session.prompts).toEqual(["hi", RETRY_NOTE]);
    expect(h.counts).toEqual([...TURN, TR, TM, TR]);
  });
  it("13 routed Fast, a tool ran, then `other`: final/other_after_tool, one prompt", async () => {
    const session = toolThenOther([{ type: "tool_execution_start" }]); const h = withRecorder(session, routed("fast")); const r = await turnOn(h)();
    expect(rows(h.store)).toEqual([[TR, "final", "other_after_tool", r, null]]); expect(session.prompts).toEqual(["hi"]);
    expect(failedOf(h.outcome, r)).toMatchObject({ error_type: "model_error", error_ref: "other" }); expect(h.counts).toEqual([...TURN, TR]);
  });
  it("14 routed Fast, only a todo tool, then `other` twice: retry/other_once then final/other_retried", async () => {
    const session = toolThenOther([{ type: "tool_execution_start", toolName: "todo" } as OmpFrame]); const h = withRecorder(session, routed("fast")); const r = await turnOn(h)();
    expect(rows(h.store)).toEqual([[TR, "retry", "other_once", r, null], [TR, "final", "other_retried", r, null]]);
    expect(session.prompts).toEqual(["hi", RETRY_NOTE]);
    expect(failedOf(h.outcome, r)).toMatchObject({ error_type: "model_error", error_ref: "other" }); expect(h.counts).toEqual([...TURN, TR, TM, TR]);
  });
  it("15 routed Fast, quota twice steps up to Default: retry/quota ×2, one routed_escalation, completed", async () => {
    const session = failing(["429 quota", "429 quota"]); const h = withRecorder(session, routed("fast")); const r = await turnOn(h)();
    expect(rows(h.store)).toEqual([[TR, "retry", "quota", r, null], [TR, "retry", "quota", r, null]]);
    expect(escalations(h.store, r)).toEqual([{ from: "fast", to: "default", kind: "quota" }]); expect(doneOf(h.outcome, r)).toMatchObject({ text: "ok" });
    expect(h.counts).toEqual([...TURN, TR, TM, TR, TM]);
  });
  it("16 an async-work-only end with an error never consults the rule: no row; failed model_error; one prompt", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" }); session.assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" });
      e({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
    } });
    const h = withRecorder(session, {}, { HOUGE_OMP_FRAME_IDLE_MS: "60000" }); const r = await turnOn(h)();
    expect(rows(h.store)).toEqual([]); expect(h.counts).toEqual(TURN);
    expect(failedOf(h.outcome, r)).toMatchObject({ error_type: "model_error" }); expect(session.prompts).toEqual(["hi"]);
  });
});

describe("R4 faults (spec §4.4)", () => {
  it("17 a throwing recorder: no rows, no incident; the retry (case 9) and the latch (case 2) are unchanged", async () => {
    const seen: string[] = [];
    const boom: DecisionRecorder = { record: (e) => { seen.push(e.id); throw new Error("boom"); } };
    const s9 = quotaThenOk(); const h9 = harness(s9, {}, { recorder: boom }); const r9 = await turnOn(h9)();
    expect(s9.prompts).toEqual(["hi", RETRY_NOTE]); expect(doneOf(h9.outcome, r9)).toMatchObject({ text: "from 4.6" });
    expect(rows(h9.store)).toEqual([]); expect(recordFailedN(h9.store)).toBe(0);
    expect(seen).toEqual([...TURN, TR, TM]); seen.length = 0;
    const s2 = fakeSession({ noManifest: true }); const h2 = harness(s2, {}, { recorder: boom, ...FAILING_START }); const turn = turnOn(h2);
    for (let i = 0; i < 3; i++) await turn();
    const r4 = await turn();
    expect(failedOf(h2.outcome, r4)).toMatchObject({ error_type: "planner_exit", error_ref: "crash_loop" });
    expect(crashLoops(h2.outcome)).toHaveLength(1); expect(s2.options).toHaveLength(3);
    expect(rows(h2.store)).toEqual([]); expect(recordFailedN(h2.store)).toBe(0);
    expect(seen).toEqual([...spawned(3), SQ, CG]);
  });
  it("18 an insert fault on the latch row: one decision_record_failed, one alert; the latch, the incident and the failure are unchanged", async () => {
    vi.stubEnv("HOUGE_TELEGRAM_CHAT_ID", "stub-chat");
    try {
      const session = fakeSession({ noManifest: true }); const h = withRecorder(session, FAILING_START); const turn = turnOn(h);
      vi.spyOn(h.store, "insertDecision").mockImplementation(() => { throw new Error("disk"); });
      for (let i = 0; i < 3; i++) await turn();
      expect(recordFailedN(h.store)).toBe(0); // spawn is the default: nothing was inserted yet
      const out0 = outboxN(h.store); const r4 = await turn();
      expect(failedOf(h.outcome, r4)).toMatchObject({ error_type: "planner_exit", error_ref: "crash_loop" });
      expect(crashLoops(h.outcome)).toHaveLength(1); expect(session.options).toHaveLength(3);
      expect(rows(h.store)).toEqual([]); expect(h.counts).toEqual([...spawned(3), SQ, CG]);
      expect(recordFailedN(h.store)).toBe(1); expect(outboxN(h.store) - out0).toBe(1);
      expect(q(h.store).prepare("SELECT target_json FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'").all()).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); }
  });
});
