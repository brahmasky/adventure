import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_LESSONS } from "../../src/decisions/entries/context-lessons.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder } from "../../src/decisions/types.js";
import type { SupervisorDeps } from "../../src/omp/planner-supervisor.js";
import type { TurnContextDeps, TurnRetrieval } from "../../src/omp/turn-context.js";
import type { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { cleanups, fakeSession, harness, req, until, type Fake } from "../helpers/supervisor-harness.js";

afterEach(async () => { for (const c of cleanups.splice(0)) await c(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const SQ = "intake.steer_or_queue"; const CG = "planner.crash_guard"; const LS = "context.lessons"; const CC = "turn.clarify_cap"; const RC = "context.recall"; const TM = "turn.model";
type Row = [string, string, string | null, string, string | null];
type Q = { prepare(q: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
const q = (store: RunStore) => (store as unknown as { db: Q }).db;
function rows(store: RunStore): Row[] {
  return q(store).prepare("SELECT entry_id, verdict, reason_code, run_id, tool_call_id FROM decisions WHERE entry_id IN ('context.recall','context.catch_up','context.lessons','turn.clarify_cap') ORDER BY rowid").all()
    .map((r) => [r.entry_id as string, r.verdict as string, (r.reason_code as string | null) ?? null, r.run_id as string, (r.tool_call_id as string | null) ?? null]);
}
const incidentsN = (store: RunStore, kind: string) => q(store).prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind = ?").all(kind)[0]?.n as number;
/** The recorder needs the store `harness` builds: resolve it lazily (R3 P11); `turnContext` merges over the harness's own (R5 harness option). */
function withRecorder(session: Fake, extra: Partial<SupervisorDeps> = {}, turnContext: Partial<TurnContextDeps> = {}) {
  const cell: { store?: RunStore; counts: string[] } = { counts: [] };
  const recorder: DecisionRecorder = { record: (e, r, c) => { cell.counts.push(e.id); return storeRecorder(cell.store as RunStore).record(e, r, c); } };
  const h = harness(session, {}, { recorder, ...extra }, { turnContext }); cell.store = h.store;
  return { ...h, counts: cell.counts };
}
type SeamTurn = { finished: boolean; endSignalled: boolean; req: { run_id: string } };
type Private = { turn?: { endSignalled: boolean; finished: boolean } | SeamTurn; d: { turnContext: TurnContextDeps }; preflightThenSpawn(fresh: boolean, turn: SeamTurn): Promise<unknown> };
const priv = (sup: unknown) => sup as Private;
/** tests/omp/planner-supervisor.test.ts:38: a 27-char bullet fits a 40-char cap, a 60-char one is skipped. */
function seedOverCap(store: RunStore): void {
  store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
  store.addLesson({ scope: "ask", text: "z".repeat(60), source: "user_feedback" });
}
const CAP40 = { env: { HOUGE_LESSON_CHAR_CAP: "40" } };
const dones = (o: { done: unknown[] }) => o.done as Array<{ run_id: string }>;

describe("R5 rows — context.lessons at the spawn (spec R5 §4.3), the end signal (§4.0)", () => {
  it("1 lessons under the cap, one turn: zero rows; the spawn consulted lessons once, the prompt build the cap once", async () => {
    const h = withRecorder(fakeSession(), {}, CAP40);
    h.store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    const a = createQueuedTurnRun(h.store); h.sup.submit(req(a)); await h.sup.whenIdle();
    expect(dones(h.outcome).map((d) => d.run_id)).toEqual([a]);
    expect(rows(h.store)).toEqual([]); expect(h.counts).toEqual([SQ, CG, LS, CC, TM]);
  });
  it("2 lessons over the cap: one capped/char_cap row on the run; one lesson_dropped incident as today", async () => {
    const h = withRecorder(fakeSession(), {}, CAP40); seedOverCap(h.store);
    const a = createQueuedTurnRun(h.store); h.sup.submit(req(a)); await h.sup.whenIdle();
    expect(rows(h.store)).toEqual([[LS, "capped", "char_cap", a, null]]);
    expect(incidentsN(h.store, "lesson_dropped")).toBe(1); expect(h.counts).toEqual([SQ, CG, LS, CC, TM]);
  });
  it("3 getActiveLessons throwing: one none/render_failed row; one lesson_render_failed incident", async () => {
    const h = withRecorder(fakeSession());
    vi.spyOn(h.store, "getActiveLessons").mockImplementation(() => { throw new Error("disk"); });
    const a = createQueuedTurnRun(h.store); h.sup.submit(req(a)); await h.sup.whenIdle();
    expect(rows(h.store)).toEqual([[LS, "none", "render_failed", a, null]]);
    expect(incidentsN(h.store, "lesson_render_failed")).toBe(1);
  });
  it("4 seam, ended-not-finished: the prompt file is written and the drop raised, zero lessons rows and zero calls", async () => {
    const h = withRecorder(fakeSession(), {}, CAP40); seedOverCap(h.store);
    await priv(h.sup).preflightThenSpawn(true, { finished: false, endSignalled: true, req: { run_id: "late" } });
    expect(existsSync(join(h.data, "omp", "system-chat-42.md"))).toBe(true);
    expect(incidentsN(h.store, "lesson_dropped")).toBe(1);
    expect(rows(h.store)).toEqual([]); expect(h.counts).toEqual([]);
  });
  it("5 seam, live: one capped/char_cap row naming the threaded run, not the different running turn", async () => {
    const h = withRecorder(fakeSession(), {}, CAP40); seedOverCap(h.store);
    priv(h.sup).turn = { finished: false, endSignalled: false, req: { run_id: "other" } }; // a different running turn (P15 mutation 1)
    try { await priv(h.sup).preflightThenSpawn(true, { finished: false, endSignalled: false, req: { run_id: "late" } }); } finally { delete priv(h.sup).turn; }
    expect(rows(h.store)).toEqual([[LS, "capped", "char_cap", "late", null]]); expect(h.counts).toEqual([LS]);
  });
  it("8 planted throw (P14) on the real context.lessons rule: one fail-rung full row; prompt file and lesson_dropped as unplanted", async () => {
    const run = async (plant: boolean) => {
      const h = withRecorder(fakeSession(), {}, CAP40); seedOverCap(h.store);
      const rung = CONTEXT_LESSONS.ladder[0] as { decide: unknown }; const orig = rung.decide;
      if (plant) rung.decide = () => { throw new Error("planted"); };
      try {
        const a = createQueuedTurnRun(h.store); h.sup.submit(req(a)); await h.sup.whenIdle();
        const r = q(h.store).prepare("SELECT rung, verdict, run_id FROM decisions WHERE entry_id = 'context.lessons'").all();
        const scrub = (v: unknown) => JSON.stringify(v).split(a).join("RUN");
        const loop = h.store.getLedgerEvents(a).filter((e) => e.event_type === "loop_started").map((e) => scrub(e.payload));
        const touches = q(h.store).prepare("SELECT id, applied_count, last_used IS NOT NULL AS used FROM lessons ORDER BY id").all();
        const incidents = q(h.store).prepare("SELECT kind, subject, fingerprint, state, detail_json FROM incidents ORDER BY kind, fingerprint").all().map(scrub);
        return { r, a, file: readFileSync(join(h.data, "omp", "system-chat-42.md"), "utf8"), dropped: incidentsN(h.store, "lesson_dropped"), loop, touches, incidents };
      } finally { rung.decide = orig; }
    };
    const base = await run(false); const planted = await run(true);
    expect(planted.r).toEqual([{ rung: "fail", verdict: "full", run_id: planted.a }]);
    expect(base.r).toEqual([{ rung: "rule", verdict: "capped", run_id: base.a }]);
    expect(planted.file).toBe(base.file); expect(planted.dropped).toBe(base.dropped); expect(planted.dropped).toBe(1);
    expect(planted.loop).toHaveLength(1); expect(planted.loop).toEqual(base.loop);
    expect(planted.touches).toEqual(base.touches); expect(planted.incidents).toEqual(base.incidents); expect(planted.incidents.length).toBeGreaterThan(0);
  });
  it("6 the end signal: /kill while retrieve is held → endSignalled true while finished is false; the released build writes loop_started and no R5 row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r5-kill-")); // P2: pin the tombstone paths; nothing may land in the cwd
    vi.stubEnv("HOUGE_TOMBSTONE_PATH", join(dir, "houge.kill")); vi.stubEnv("HOUGE_DISARM_PATH", join(dir, "houge.disarm"));
    let release: () => void = () => undefined; let retrieves = 0;
    const retrieval: TurnRetrieval = { facts: [{ id: 1, block: "fact" }], pages: [], telemetry: { facts: { admitted: 1, best_admitted: 0.7, best_rejected: null, embedding: true, fts_only: false }, pages: { admitted: 0, best_admitted: null, best_rejected: null, embedding: true, fts_only: false } } };
    const h = withRecorder(fakeSession(), {}, { retrieve: () => { retrieves++; return new Promise<TurnRetrieval>((r) => { release = () => r(retrieval); }); } });
    const a = createQueuedTurnRun(h.store); h.sup.submit(req(a)); await until(() => retrieves === 1);
    const killed = h.sup.abortAll("killed");
    const t = priv(h.sup).turn!;
    expect(t.endSignalled).toBe(true); expect(t.finished).toBe(false); // done("abort") fired; settle has not finished the turn yet
    release(); await killed; await h.sup.whenIdle();
    expect(h.store.getLedgerEvents(a).some((e) => e.event_type === "loop_started")).toBe(true);
    expect(rows(h.store)).toEqual([]); expect(h.counts).toEqual([SQ, CG, LS]); // no recall, no cap: the turn's end signal had fired
    expect(h.outcome.failed).toHaveLength(1);
    expect(existsSync(join(process.cwd(), "houge.kill"))).toBe(false); rmSync(dir, { recursive: true, force: true });
  });
  it("7 armEnd re-arms per leg: true after the first leg's agent_end, false again inside the retried leg, true at the end", async () => {
    const seen: boolean[] = []; let calls = 0;
    const session: Fake = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      if (calls++ === 0) {
        session.assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" }); e({ type: "agent_end" });
        seen.push(priv(h.sup).turn!.endSignalled); // after the first leg's end
      } else {
        seen.push(priv(h.sup).turn!.endSignalled); // inside the retried leg, before its end
        session.assistant("from 4.6"); e({ type: "agent_end" });
      }
    } });
    const h = withRecorder(session);
    const a = createQueuedTurnRun(h.store); h.sup.submit(req(a)); await h.sup.whenIdle();
    expect(session.prompts).toHaveLength(2);
    expect(seen).toEqual([true, false]);
    expect(h.counts).toEqual([SQ, CG, LS, CC, TM, "turn.retry", TM]);
  });
});
