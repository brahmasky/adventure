import { afterEach, describe, expect, it, vi } from "vitest";
import { TURN_MODEL } from "../../src/decisions/entries/turn-model.js";
import { storeRecorder } from "../../src/decisions/record.js";
import type { DecisionRecorder, RuleRung } from "../../src/decisions/types.js";
import type { Effort, TurnRole } from "../../src/jev/tree-policy.js";
import { PlannerRpcError } from "../../src/omp/planner-session.js";
import type { SupervisorDeps } from "../../src/omp/planner-supervisor.js";
import type { RunStore } from "../../src/run/run-store.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { cleanups, fakeRoles, fakeSession, harness, req, until, type Fake, type Outcome } from "../helpers/supervisor-harness.js";

// Spec R6 §4.3: one turn.model consult per completed pin walk, before any failure path; only the walk that left the role's
// first eligible candidate writes a row (Decision 1-A). The pins themselves are today's.
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); vi.restoreAllMocks(); vi.useRealTimers(); });

const TM = "turn.model";
type Q = { prepare(q: string): { all(...a: unknown[]): Array<Record<string, unknown>> } };
const q = (store: RunStore) => (store as unknown as { db: Q }).db;
const rows = (store: RunStore, run: string, id = TM) => q(store).prepare("SELECT verdict, reason_code, rung FROM decisions WHERE entry_id = ? AND run_id = ? ORDER BY rowid").all(id, run)
  .map((r) => [r.verdict, r.reason_code ?? null, r.rung]);
const ids = (store: RunStore, run: string) => q(store).prepare("SELECT entry_id FROM decisions WHERE run_id = ? ORDER BY rowid").all(run).map((r) => r.entry_id);
function withRecorder(session: Fake, extra: Partial<SupervisorDeps> = {}) {
  const cell: { store?: RunStore; counts: string[] } = { counts: [] };
  const recorder: DecisionRecorder = { record: (e, r, c) => { cell.counts.push(e.id); return storeRecorder(cell.store as RunStore).record(e, r, c); } };
  const h = harness(session, {}, { recorder, ...extra }); cell.store = h.store;
  return { ...h, counts: cell.counts, tm: () => cell.counts.filter((c) => c === TM).length };
}
const failedOf = (o: Outcome, run_id: string) => o.failed.find((f) => (f as { run_id: string }).run_id === run_id) as { error_type: string; error_ref: string } | undefined;
const incidentKinds = (o: Outcome) => o.incidents.map((i) => (i as { k: string }).k);
const escalations = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "routed_escalation").map((e) => e.payload);
const attempts = (store: RunStore, run: string) => store.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload as Record<string, unknown>);
const routed = (role: TurnRole, effort: Effort | null = null): Partial<SupervisorDeps> => ({ triage: async () => ({ kind: "fallthrough", route: { role, effort, verdict_id: "jv_1" } }) });
const refusal = (m: string) => new PlannerRpcError("command_failed:set_model", `Model not found: ${m}`);
/** `setModel` scripted by call number: a refusal, a transport failure, or ok. In the harness the spawn pins nothing; n === 1 is the turn's first pin. */
const pins = (script: Record<number, "refuse" | "transport">) => fakeSession({ setModel: async (n) => {
  if (script[n] === "refuse") throw refusal(`pin${n}`);
  if (script[n] === "transport") throw new PlannerRpcError("timeout:set_model");
} });
/** Prompts fail with `errors[i]` (an assistant error) until they run out, then answer "ok"; `setModel` scripted as `pins`. */
const failing = (errors: string[], script: Record<number, "refuse" | "transport"> = {}) => {
  let calls = 0;
  const session: Fake = fakeSession({
    setModel: async (n) => { if (script[n] === "refuse") throw refusal(`pin${n}`); if (script[n] === "transport") throw new PlannerRpcError("timeout:set_model"); },
    onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      const err = errors[calls++];
      if (err) session.assistant("", { stopReason: "error", errorMessage: err }); else session.assistant("ok");
      e({ type: "agent_end" });
    }
  });
  return session;
};
const turn = async (h: ReturnType<typeof withRecorder>, text = "hi") => { const r = createQueuedTurnRun(h.store, text); h.sup.submit(req(r, text)); await h.sup.whenIdle(); return r; };

describe("turn.model rows — the first leg (spec R6 §4.3)", () => {
  it("1. the head accepted: no row, one consult", async () => {
    const h = withRecorder(fakeSession()); const r = await turn(h);
    expect(rows(h.store, r)).toEqual([]); expect(h.tm()).toBe(1);
  });
  it("2. the head refused, the second leg pinned: fallback/refused and one model_missing attempt row", async () => {
    const h = withRecorder(pins({ 1: "refuse" })); const r = await turn(h);
    expect(rows(h.store, r)).toEqual([["fallback", "refused", "rule"]]);
    expect(attempts(h.store, r).filter((a) => a.error_kind === "model_missing")).toHaveLength(1);
    expect(h.tm()).toBe(1);
    expect(h.session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]);
  });
  it("3. a routed Fast turn with every Fast leg refused steps up to Default: fallback/stepped_up, routed_escalation", async () => {
    const h = withRecorder(pins({ 1: "refuse", 2: "refuse" }), routed("fast")); const r = await turn(h);
    expect(rows(h.store, r)).toEqual([["fallback", "stepped_up", "rule"]]);
    expect(escalations(h.store, r)).toEqual([{ from: "fast", to: "default", kind: "model_missing" }]);
    expect(h.tm()).toBe(1);
  });
  it("4. an unrouted turn with every Default leg refused: none/no_leg, planner_no_leg, run failed no_planner_leg — the row exists (P14-5)", async () => {
    const h = withRecorder(pins({ 1: "refuse", 2: "refuse", 3: "refuse" })); const r = await turn(h);
    expect(rows(h.store, r)).toEqual([["none", "no_leg", "rule"]]);
    expect(incidentKinds(h.outcome)).toEqual(["planner_no_leg"]);
    expect(failedOf(h.outcome, r)).toMatchObject({ error_type: "no_planner_leg", error_ref: "model_missing" });
    expect(h.tm()).toBe(1);
  });
  it("5. setModel fails in transport: held/pin_failed, planner_model_reset_failed", async () => {
    const h = withRecorder(pins({ 1: "transport" })); const r = await turn(h);
    expect(rows(h.store, r)).toEqual([["held", "pin_failed", "rule"]]);
    expect(incidentKinds(h.outcome)).toEqual(["planner_model_reset_failed"]);
    expect(h.tm()).toBe(1);
  });
  it("9. two turns on one child, the head refused on turn 1: turn 1 fallback/refused; turn 2 no row and no further set_model (the child already holds candidate two)", async () => {
    const h = withRecorder(pins({ 1: "refuse" }));
    const r1 = await turn(h); const r2 = await turn(h);
    expect(rows(h.store, r1)).toEqual([["fallback", "refused", "rule"]]);
    expect(rows(h.store, r2)).toEqual([]);
    expect(h.session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]);
    expect(h.tm()).toBe(2);
  });
  it("10. the turn aborted while setModel is held: no turn.model consult", async () => {
    const session = fakeSession({ setModel: () => new Promise<void>(() => {}) });
    const h = withRecorder(session); const r = createQueuedTurnRun(h.store);
    h.sup.submit(req(r)); await until(() => session.models.length === 1);
    await h.sup.abortAll("killed"); await h.sup.whenIdle();
    expect(h.tm()).toBe(0); expect(rows(h.store, r)).toEqual([]);
  });
  it("11. P13: a planted throwing rule records head at the fail rung; the pins are unchanged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rung = TURN_MODEL.ladder[0] as RuleRung<unknown, string>; const real = rung.decide;
    rung.decide = () => { throw new Error("planted"); };
    try {
      const h = withRecorder(fakeSession()); const r = await turn(h);
      expect(rows(h.store, r)).toEqual([["head", null, "fail"]]);
      expect(h.session.models).toEqual(["anthropic/claude-opus-5-5"]);
      expect(h.tm()).toBe(1);
    } finally { rung.decide = real; err.mockRestore(); }
  });
});

describe("turn.model rows — the retry leg (spec R6 §4.3)", () => {
  it("6. a quota error on the first leg, the next leg answers: turn.retry retry/quota then turn.model fallback/next_leg, in that order", async () => {
    const h = withRecorder(failing(["429 quota"])); const r = await turn(h);
    expect(rows(h.store, r)).toEqual([["fallback", "next_leg", "rule"]]);
    expect(ids(h.store, r)).toEqual(["turn.retry", TM]);
    expect(h.tm()).toBe(2);
  });
  it("7. a retry after an earlier leg's refusal counts next_leg, not refused (P14-6)", async () => {
    const h = withRecorder(failing(["429 quota"], { 1: "refuse" })); const r = await turn(h);
    expect(rows(h.store, r)).toEqual([["fallback", "refused", "rule"], ["fallback", "next_leg", "rule"]]);
    expect(h.session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6", "kimi-code/k3"]);
    expect(h.tm()).toBe(2);
  });
  it("8. the retry pin fails in transport: none/pin_failed, run failed retry_failed", async () => {
    const h = withRecorder(failing(["429 quota"], { 2: "transport" })); const r = await turn(h);
    expect(rows(h.store, r)).toEqual([["none", "pin_failed", "rule"]]);
    expect(failedOf(h.outcome, r)).toMatchObject({ error_type: "planner_exit" });
    expect(failedOf(h.outcome, r)?.error_ref.startsWith("retry_failed")).toBe(true);
    expect(h.tm()).toBe(2);
  });
  it("a routed Fast chain spent on retry steps up: fallback/stepped_up; an unrouted Default chain spent: none/no_leg", async () => {
    const a = withRecorder(failing(["429 quota", "429 quota"]), routed("fast")); const ra = await turn(a);
    expect(rows(a.store, ra)).toEqual([["fallback", "next_leg", "rule"], ["fallback", "stepped_up", "rule"]]);
    expect(a.tm()).toBe(3);
    const b = withRecorder(failing(["429 quota", "429 quota", "429 quota"]), { roles: fakeRoles({ default: ["anthropic/claude-opus-5-5:medium", "kimi-code/k3:low"] }) }); const rb = await turn(b);
    expect(rows(b.store, rb)).toEqual([["fallback", "next_leg", "rule"], ["none", "no_leg", "rule"]]);
    expect(failedOf(b.outcome, rb)).toMatchObject({ error_type: "no_planner_leg", error_ref: "quota" });
    expect(b.tm()).toBe(3);
  });
});
