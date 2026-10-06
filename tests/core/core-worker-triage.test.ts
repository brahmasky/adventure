import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretBroker } from "../../src/config/secret-broker.js";
import { JEV_MODEL } from "../../src/jev/jev-client.js";
import { JEV_INCIDENT_SUBJECT } from "../../src/jev/jev-incidents.js";
import { TRIAGE_LANE, TRIAGE_QUESTIONS } from "../../src/jev/questions/triage.js";
import { TRIAGE_STATUS_ARM_ID } from "../../src/jev/thresholds.js";
import { criteriaHash } from "../../src/jev/questions/types.js";
import type { CoreWorker } from "../../src/core/core-worker.js";
import { RunStore } from "../../src/run/run-store.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { drainOutbox, ompWorker } from "../helpers/omp-worker.js";

// Spec §5.1: the decision before the planner. Every eligible, still-active exit writes exactly ONE `triage` event (the
// denominator for the lane's numbers); an answered call's decision rows land in the same transaction as that event, and
// inside the lesson's save transaction when the memory lane saved. A turn that ended writes nothing late.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const choice = (choice: string, probabilities: Record<string, number>) => {
  const n = Object.keys(probabilities).length; const pMax = Math.max(...Object.values(probabilities));
  return { type: "choice", choice, probabilities, confidence: (pMax - 1 / n) / (1 - 1 / n) };
};
const top = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0];
const jevSays = (lane: Record<string, number>, complete: Record<string, number> = { mixed: 0.1, pure: 0.9 }, scope: Record<string, number> = { ask: 0.9, research: 0.1 }) =>
  vi.fn(async (_url?: unknown, _init?: unknown) => json(200, { model: JEV_MODEL, usage: { input_tokens: 800, output_tokens: 0 }, answers: {
    lane: choice(top(lane), lane), complete: choice(top(complete), complete), scope: choice(top(scope), scope) } }));
const MEMORY = { none: 0.05, status: 0.05, memory: 0.9 };

type Llm = (input: Record<string, unknown>) => Promise<ToolAdapterResult>;
const isDistill = (input: Record<string, unknown>) => /durable/i.test(String(input.system ?? ""));
/** The two seat calls of the lesson-write service, told apart by their system prompt; hooks fire before each answer. */
const lessonLlm = (h: { distill?: () => void; reconcile?: () => void } = {}): Llm => async (input) => {
  if (isDistill(input)) { h.distill?.(); return { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short." }) } }; }
  h.reconcile?.();
  return { ok: true, output: { answer: JSON.stringify({ verdict: "ADD", theme: "format" }) } };
};

/** Arming needs calibration rows (none ship): the gate-only file names every triage question plus the status arm row, both langs. */
function calibrationFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), "htri-cal-")), "rows.json");
  const ids = [...TRIAGE_QUESTIONS.map((q) => [q.id, criteriaHash(q)] as const), [TRIAGE_STATUS_ARM_ID, criteriaHash(TRIAGE_LANE)] as const];
  writeFileSync(f, JSON.stringify(ids.flatMap(([question_id, criteria_hash]) => (["zh", "en"] as const).map((lang) =>
    ({ question_id, criteria_hash, model: JEV_MODEL, lang, approved: "test", evidence: "test" })))));
  return f;
}
const ARM = { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "arm" };

function setup(fetchImpl: unknown, env: Record<string, string> = ARM, o: { llm?: Llm; jevNow?: () => Date } = {}) {
  vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", calibrationFile()); vi.stubEnv("HOUGE_JEV_GATE", "1");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  const store = RunStore.openInMemory();
  const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "htri-")), { llm: o.llm ?? lessonLlm(), jevFetch: fetchImpl as typeof fetch, ...(o.jevNow ? { jevNow: o.jevNow } : {}) });
  const turn = (text: string, w: CoreWorker = worker) => {
    const run_id = createQueuedTurnRun(store, text);
    const claim = store.claimRun(run_id, "w", 120)!;
    w.buildOmpTools(claim, "555");
    return { run_id, claim, input: { claim, text, userText: text, modality: "text" as const, posture: null, signal: new AbortController().signal } };
  };
  return { store, worker, turn };
}
const triageRows = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "triage").map((e) => e.payload);
const decisions = (store: RunStore, run_id: string) => store.listJevDecisions(run_id);

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("CoreWorker.triageTurn (spec §5.1 flow; every exit leaves exactly one triage row)", () => {
  it("flag off: skipped{disabled}, fallthrough, no fetch, one triage row", async () => {
    const fetchImpl = vi.fn();
    const { store, worker, turn } = setup(fetchImpl, { HOUGE_JEV_ENABLED: "0" });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "disabled", decision: "fallback", lane: null, margin: null }]);
    expect(decisions(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "disabled" }]);
    store.close();
  });
  it("photo turn: skipped{modality}; killed posture: skipped{posture}; neither asks Jev", async () => {
    const fetchImpl = jevSays(MEMORY);
    const { store, worker, turn } = setup(fetchImpl);
    const photo = turn("caption");
    expect(await worker.triageTurn({ ...photo.input, modality: "photo" })).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, photo.run_id)).toMatchObject([{ skip_reason: "modality" }]);
    const killed = turn("以后回复短一点");
    expect(await worker.triageTurn({ ...killed.input, posture: "killed" })).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, killed.run_id)).toMatchObject([{ skip_reason: "posture" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
    store.close();
  });
  it("pure memory: saves through the service, replies with the card, marks decisions 'act'", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind !== "lane_reply") return;
    expect(out.text).toMatch(/^📒 Saved lesson #\d+ · format/);
    expect(out.buttons.map((b) => b.data.split(":")[1])).toEqual(["undo", "ask"]);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", lane: "memory", complete: "pure", scope: "ask", decision: "act", lang: "zh" }]);
    expect(decisions(store, t.run_id)).toHaveLength(3);
    expect(decisions(store, t.run_id).every((r) => r.decision === "act")).toBe(true);
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("the triage state carries exactly the four keys (Task 2): no pending, no tool list", async () => {
    const fetchImpl = jevSays(MEMORY);
    const { store, worker, turn } = setup(fetchImpl, { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow" });
    await worker.triageTurn(turn("以后回复短一点").input);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { state: Record<string, unknown> };
    expect(Object.keys(body.state).sort()).toEqual(["last_houge_turn", "latest_message", "modality", "recent_turns"]);
    store.close();
  });
  it("the card names the saved row's theme: an UPDATE onto a themed lesson shows that theme, not the verdict's", async () => {
    const llm: Llm = async (input) => isDistill(input)
      ? { ok: true, output: { answer: JSON.stringify({ durable: true, lesson: "Keep replies short and lead with the result." }) } }
      : { ok: true, output: { answer: JSON.stringify({ verdict: "UPDATE", id: 1, text: "Be concise; lead with the result.", theme: "nonsense" }) } };
    const { store, worker, turn } = setup(jevSays(MEMORY), ARM, { llm });
    store.addLesson({ scope: "ask", text: "Be concise.", theme: "format", source: "loop", created_at: new Date().toISOString() });
    const out = await worker.triageTurn(turn("以后回复先说结论").input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind === "lane_reply") expect(out.text).toMatch(/· format/);
    store.close();
  });
  it("mixed memory: saves, returns the inform note, planner path continues", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY, { mixed: 0.7, pure: 0.3 }));
    const t = turn("以后短一点，另外今天天气？");
    const out = await worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+ \(format\)/) });
    expect(triageRows(store, t.run_id)).toMatchObject([{ complete: "mixed", decision: "act" }]);
    store.close();
  });
  it("memory verdict but nothing durable: no card, fallthrough, decision 'fallback'", async () => {
    const notDurable: Llm = async () => ({ ok: true, output: { answer: JSON.stringify({ durable: false }) } });
    const { store, worker, turn } = setup(jevSays(MEMORY), ARM, { llm: notDurable });
    const t = turn("谢谢你");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ lane: "memory", decision: "fallback" }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    store.close();
  });
  it("status: code-rendered houge_status text, no planner, no LLM", async () => {
    const llm = vi.fn(lessonLlm());
    const { store, worker, turn } = setup(jevSays({ none: 0.1, status: 0.85, memory: 0.05 }), ARM, { llm });
    const t = turn("did you restart?");
    const out = await worker.triageTurn(t.input);
    expect(out.kind).toBe("lane_reply");
    if (out.kind === "lane_reply") { expect(out.buttons).toEqual([]); expect(out.text.length).toBeGreaterThan(10); }
    expect(triageRows(store, t.run_id)).toMatchObject([{ lane: "status", decision: "act", lang: "en" }]);
    expect(llm).not.toHaveBeenCalled();
    store.close();
  });
  // Final review (T9 deferred minor): an `act` row on a turn the planner then answered corrupts the status precision evidence
  // the arm decision reads. The status text renders first; a render throw settles exactly one answered `fallback` row.
  it("status: a render throw settles one answered fallback row (never act) and falls through to the planner", async () => {
    const { store, worker, turn } = setup(jevSays({ none: 0.1, status: 0.85, memory: 0.05 }));
    vi.spyOn(worker as unknown as { hougeStatusText: () => string }, "hougeStatusText").mockImplementation(() => { throw new Error("render"); });
    const t = turn("did you restart?");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", lane: "status", decision: "fallback" }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "fallback")).toBe(true);
    store.close();
  });
  // Final review I1: triage_overrides is a condition whose durable state is the disarm marker. It resolves once Paco has
  // deleted the marker, so a later drift episode opens (and pages) again; while the marker exists it stays open.
  it("triage_overrides resolves on the next turn once the disarm marker is gone, and stays open while it exists", async () => {
    const { store, worker, turn } = setup(jevSays({ none: 0.9, status: 0.05, memory: 0.05 }));
    const marker = join(mkdtempSync(join(tmpdir(), "htri-mk-")), "houge.jev-disarmed");
    vi.stubEnv("HOUGE_JEV_DISARM_PATH", marker);
    writeFileSync(marker, JSON.stringify({ reason: "triage_overrides", at: "x" }));
    store.openIncident({ kind: "triage_overrides", subject: JEV_INCIDENT_SUBJECT, detail: {} });
    await worker.triageTurn(turn("hello").input);
    expect(store.listOpenIncidents().map((i) => i.kind)).toEqual(["triage_overrides"]);
    rmSync(marker);
    await worker.triageTurn(turn("hello again").input);
    expect(store.listOpenIncidents()).toHaveLength(0);
    store.close();
  });
  it("shadow mode: rows written with decision 'shadow', behaviour unchanged", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY), { HOUGE_JEV_ENABLED: "1", HOUGE_JEV_TRIAGE_ENABLED: "shadow" });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ lane: "memory", decision: "shadow" }]);
    expect(decisions(store, t.run_id).every((r) => r.decision === "shadow")).toBe(true);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    store.close();
  });
  it("armed on the committed rows alone (no gate file): a pure memory instruction acts", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", ""); vi.stubEnv("HOUGE_JEV_GATE", "");
    const t = turn("以后回复短一点");
    expect((await worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", lane: "memory", decision: "act" }]);
    store.close();
  });
  it("armed but uncalibrated (a model the rows do not name): answered, decision 'fallback', no lesson", async () => {
    const other = vi.fn(async () => json(200, { model: "jev-1.14.0", usage: { input_tokens: 800, output_tokens: 0 }, answers: {
      lane: choice("memory", MEMORY), complete: choice("pure", { mixed: 0.1, pure: 0.9 }), scope: choice("ask", { ask: 0.9, research: 0.1 }) } }));
    const { store, worker, turn } = setup(other);
    vi.stubEnv("HOUGE_JEV_CALIBRATION_FILE", ""); vi.stubEnv("HOUGE_JEV_GATE", "");
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", lane: "memory", decision: "fallback" }]);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("Jev 429: skipped{rate_limited}, incident jev_rate_limited, fallthrough", async () => {
    const { store, worker, turn } = setup(vi.fn(async () => json(429, {})));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "rate_limited" }]);
    expect(store.listOpenIncidents().some((i) => i.kind === "jev_rate_limited")).toBe(true);
    store.close();
  });
  it("an override run (Ask Houge anyway) is never triaged again", async () => {
    const fetchImpl = jevSays(MEMORY);
    const { store, worker, turn } = setup(fetchImpl);
    const t = turn("以后回复短一点");
    store.recordMemoryEvent("triage_override", { run_id: "run_old", new_run_id: t.run_id, change_id: null });
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(triageRows(store, t.run_id)).toMatchObject([{ skip_reason: "override" }]);
    store.close();
  });
  it("the broker's key wins over the environment and reaches the Authorization header", async () => {
    let seenAuth = "";
    const body = jevSays(MEMORY);
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => { seenAuth = String((init.headers as Record<string, string>).authorization); return body(url, init); });
    vi.stubEnv("HOUGE_JEV_ENABLED", "1"); vi.stubEnv("HOUGE_JEV_TRIAGE_ENABLED", "shadow"); vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const store = RunStore.openInMemory();
    const worker = ompWorker(store, mkdtempSync(join(tmpdir(), "htri-")), { llm: lessonLlm(), jevFetch: fetchImpl as unknown as typeof fetch,
      broker: { typesafeKey: () => "test-key", redact: (s: string) => s } as unknown as SecretBroker });
    const run_id = createQueuedTurnRun(store, "以后回复短一点"); const claim = store.claimRun(run_id, "w", 120)!; worker.buildOmpTools(claim, "555");
    await worker.triageTurn({ claim, text: "以后回复短一点", userText: "以后回复短一点", modality: "text", posture: null, signal: new AbortController().signal });
    expect(seenAuth).toBe("Bearer test-key");
    store.close();
  });
});

describe("CoreWorker.triageTurn — one finalisation per turn, atomic with the lane's save", () => {
  it("a throw after the save (card builder) yields inform, decisions 'act', one triage row", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    worker.breakMemoryLaneCardForTest(); // makes memoryLaneCard throw once
    const t = turn("以后回复短一点");
    const out = await worker.triageTurn(t.input);
    expect(out).toMatchObject({ kind: "inform", note: expect.stringMatching(/^\[memory\] Lesson #\d+/) });
    expect(triageRows(store, t.run_id)).toHaveLength(1);
    expect(triageRows(store, t.run_id)[0]).toMatchObject({ decision: "act", lane: "memory" });
    expect(decisions(store, t.run_id).every((r) => r.decision === "act")).toBe(true);
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("a rolled-back inTx hook leaves no lesson, no guard, and exactly one fallback triage row", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    const t = turn("以后回复短一点");
    worker.breakLaneFinalizeOnceForTest(); // makes the inTx finalize throw once (the event write failing)
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    expect(store.getLedgerEvents(t.run_id).filter((e) => e.event_type === "lesson_saved")).toHaveLength(0);
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback" }]);
    expect(decisions(store, t.run_id).filter((r) => r.decision === "fallback")).toHaveLength(3);
    // the guard was never set: the planner's own lesson_write in this turn still runs the pipeline
    const again = await worker.runLessonWrite(t.claim, "555", { scope: "ask" }, { source: "loop" });
    expect(again.committed).toBe(true);
    store.close();
  });
  it("the decision rows and the triage event land in the SAME transaction as the lesson (a failing event write rolls the lesson back)", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    const t = turn("以后回复短一点");
    const original = store.appendRunLedgerEvent.bind(store);
    const spy = vi.spyOn(store, "appendRunLedgerEvent").mockImplementation((run_id, type, actor, payload) => {
      if (type === "triage") throw new Error("disk");
      return original(run_id, type, actor, payload);
    });
    await worker.triageTurn(t.input).catch(() => undefined);
    spy.mockRestore();
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    expect(decisions(store, t.run_id).filter((r) => r.status === "answered")).toHaveLength(0);
    store.close();
  });
  it("an aborted turn writes nothing after Jev: no rows, no event, no lesson", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    const t = turn("以后回复短一点"); const ac = new AbortController();
    const p = worker.triageTurn({ ...t.input, signal: ac.signal }); ac.abort();
    expect(await p).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
});

describe("CoreWorker.triageTurn — per-stage failures (exactly one triage row each, or none for a lost turn)", () => {
  it("Jev transport failure (fetch rejects): skipped{transport}, one row", async () => {
    const { store, worker, turn } = setup(vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "transport", decision: "fallback" }]);
    expect(decisions(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "transport" }]);
    store.close();
  });
  it("a throw before Jev answered (the clock seam): skipped{error}, one row", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY), ARM, { jevNow: () => { throw new Error("clock"); } });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "skipped", skip_reason: "error" }]);
    store.close();
  });
  it("distill throws: answered fallback, three fallback rows, no lesson", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY), ARM, { llm: lessonLlm({ distill: () => { throw new Error("seat down"); } }) });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", lane: "memory", decision: "fallback" }]);
    expect(decisions(store, t.run_id).map((r) => r.decision)).toEqual(["fallback", "fallback", "fallback"]);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("reconcile seat throws: the service's own fallback (ADD, theme unknown) still saves, so the lane acts once", async () => {
    // reconcileLesson fails open to ADD (memory A1): a reconcile outage is not a lane failure.
    const { store, worker, turn } = setup(jevSays(MEMORY), ARM, { llm: lessonLlm({ reconcile: () => { throw new Error("seat down"); } }) });
    const t = turn("以后回复短一点");
    expect((await worker.triageTurn(t.input)).kind).toBe("lane_reply");
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "act" }]);
    expect(store.getActiveLessons("ask")).toHaveLength(1);
    store.close();
  });
  it("the save itself throws (store error): rolled back, answered fallback, one row, no lesson", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    vi.spyOn(store, "saveReconciledLesson").mockImplementation(() => { throw new Error("disk"); });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toMatchObject([{ status: "answered", decision: "fallback" }]);
    expect(decisions(store, t.run_id).map((r) => r.decision)).toEqual(["fallback", "fallback", "fallback"]);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it.each(["distill", "reconcile"] as const)("a turn aborted during %s writes nothing", async (stage) => {
    const ac = new AbortController();
    const { store, worker, turn } = setup(jevSays(MEMORY), ARM, { llm: lessonLlm({ [stage]: () => ac.abort() }) });
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn({ ...t.input, signal: ac.signal })).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a turn whose state was replaced mid-lane (identity changed) writes nothing", async () => {
    let replace = () => undefined as void;
    const { store, worker, turn } = setup(jevSays(MEMORY), ARM, { llm: lessonLlm({ distill: () => replace() }) });
    const t = turn("以后回复短一点");
    replace = () => { worker.buildOmpTools(t.claim, "555"); };
    expect(await worker.triageTurn(t.input)).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    expect(store.getActiveLessons("ask")).toHaveLength(0);
    store.close();
  });
  it("a turn aborted while a skip is pending (Jev 429) writes nothing", async () => {
    const ac = new AbortController();
    const { store, worker, turn } = setup(vi.fn(async () => { ac.abort(); return json(429, {}); }));
    const t = turn("以后回复短一点");
    expect(await worker.triageTurn({ ...t.input, signal: ac.signal })).toEqual({ kind: "fallthrough" });
    expect(triageRows(store, t.run_id)).toHaveLength(0); expect(decisions(store, t.run_id)).toHaveLength(0);
    store.close();
  });
});

describe("the outcome sink: a lane reply's buttons reach the outbox; a failure after a lane save names the lesson", () => {
  type Sink = { complete: (i: Record<string, unknown>) => void; fail: (i: Record<string, unknown>) => void };
  const sinkOf = (w: CoreWorker) => (w as unknown as { ompOutcomeSink: (chat: string) => Sink }).ompOutcomeSink("555");

  it("ompComplete hands the card's buttons to the final-report notification", () => {
    const { store, worker, turn } = setup(jevSays(MEMORY));
    const t = turn("以后回复短一点");
    const buttons = [{ text: "↩️ Undo", data: "memlane:undo:lc_x" }];
    sinkOf(worker).complete({ run_id: t.run_id, worker_id: "w", text: "📒 Saved lesson #1 · format", attachments: [], duration_ms: 1, tool_calls: 0, buttons });
    const sent = [...drainOutbox(store).values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ buttons });
    store.close();
  });
  it("ompFail after a committed lane save appends the saved lesson's id; without one the text is unchanged", async () => {
    const { store, worker, turn } = setup(jevSays(MEMORY, { mixed: 0.7, pure: 0.3 }));
    const t = turn("以后短一点，另外今天天气？");
    const out = await worker.triageTurn(t.input);
    const id = Number(/Lesson #(\d+)/.exec(out.kind === "inform" ? out.note : "")?.[1]);
    expect(id).toBeGreaterThan(0);
    sinkOf(worker).fail({ run_id: t.run_id, worker_id: "w", error_type: "planner_exit", error_ref: "x" });
    const plain = turn("hello");
    sinkOf(worker).fail({ run_id: plain.run_id, worker_id: "w", error_type: "planner_exit", error_ref: "x" });
    const texts = [...drainOutbox(store).values()].map((p) => String(p.text));
    expect(texts).toHaveLength(2);
    expect(texts[0]!.endsWith(`\n\n📒 Lesson #${id} was saved before the failure.`)).toBe(true);
    expect(texts[1]).not.toContain("📒");
    store.close();
  });
});
