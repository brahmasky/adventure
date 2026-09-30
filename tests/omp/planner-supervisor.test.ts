import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { PlannerSupervisor, parseAttachments, type PlannerSessionLike, type SupervisorDeps, type SupervisorState, type TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import type { ExitInfo, PlannerSessionOptions } from "../../src/omp/planner-session.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { openManifestClient } from "../helpers/bridge-manifest.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

type Script = {
  onPrompt?: (text: string, emit: (f: OmpFrame) => void) => void; noManifest?: boolean;
  /** Replaces start(): e.g. a child that never becomes ready. */
  start?: () => Promise<unknown>;
  /** Runs after the model is recorded: may throw or never resolve. */
  setModel?: (n: number) => Promise<void>;
};
const never = () => new Promise<never>(() => undefined);
type Fake = PlannerSessionLike & {
  prompts: string[]; steers: string[]; models: string[]; options: PlannerSessionOptions[];
  exit: (c: number) => void; assistant: (text: string, extra?: object) => void; bind: (o: PlannerSessionOptions) => Fake;
};

/** In-memory omp child. Its start() plays the extension against the REAL bridge socket (ruling 3). */
function fakeSession(script: Script = {}): Fake {
  const frameCbs: Array<(f: OmpFrame) => void> = []; const exitCbs: Array<(i: ExitInfo) => void> = [];
  const sockets: Socket[] = [];
  const emit = (f: OmpFrame) => frameCbs.forEach((cb) => cb(f));
  const assistant = (text: string, extra: object = {}) => emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 2 }, stopReason: "stop", ...extra } } as OmpFrame);
  const drop = () => { for (const k of sockets.splice(0)) k.destroy(); };
  const s: Fake = {
    prompts: [], steers: [], models: [], options: [],
    bind: (o) => { s.options.push(o); return s; },
    start: async () => {
      if (script.start) await script.start();
      const o = s.options[s.options.length - 1] as PlannerSessionOptions;
      if (!script.noManifest) sockets.push(await openManifestClient(o.bridgeSock, o.bridgeToken));
      return { resumed: false, sessionId: "s" };
    },
    prompt: async (t: string) => { s.prompts.push(t); setTimeout(() => (script.onPrompt ?? ((_t, e) => { e({ type: "turn_start" }); assistant("answer"); e({ type: "agent_end" }); }))(t, emit), 5); },
    steer: async (t: string) => { s.steers.push(t); },
    abort: async () => { setTimeout(() => emit({ type: "agent_end", aborted: true }), 5); },
    setModel: async (m: { provider: string; model: string }) => { s.models.push(`${m.provider}/${m.model}`); await script.setModel?.(s.models.length); },
    onFrame: (cb: (f: OmpFrame) => void) => { frameCbs.push(cb); }, onExit: (cb: (i: ExitInfo) => void) => { exitCbs.push(cb); },
    stop: async () => { drop(); },
    exit: (c: number) => { drop(); exitCbs.forEach((cb) => cb({ code: c, signal: null, stopped: false })); },
    assistant
  };
  return s;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

type Outcome = TurnOutcomeSink & { done: unknown[]; failed: unknown[]; incidents: unknown[] };
function sink(store: RunStore): Outcome {
  const outcome: Outcome = {
    done: [], failed: [], incidents: [],
    complete: (i) => { outcome.done.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "completed", report_ref: "r", duration_ms: i.duration_ms, tool_calls: i.tool_calls }); },
    fail: (i) => { outcome.failed.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "failed", error_type: i.error_type, error_ref: i.error_ref }); },
    incident: (k, d) => { outcome.incidents.push({ k, d }); }
  };
  return outcome;
}

function harness(session = fakeSession(), env: Record<string, string> = {}, extra: Partial<SupervisorDeps> = {}) {
  const store = RunStore.openInMemory();
  const data = mkdtempSync(join(tmpdir(), "hsv-")); // short: the bridge socket path must fit sun_path (104 bytes)
  const outcome = sink(store);
  const sup = new PlannerSupervisor({
    chatId: "42", store, cfg: resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0", ...env }), ctx: { home: data, repo: data, data }, distDir: data,
    decls: [], env: {}, turnEnvelopeActions: ["shell"],
    turnContext: { store, memoryRoot: new URL("../../memory", import.meta.url).pathname, dataDir: data, lessonsReader: () => undefined, skillsReader: () => undefined, coreBlock: () => undefined, retrieve: async () => ({ facts: [], pages: [] }), env: {} },
    buildTools: () => ({ registry: new ToolRegistry(), quarantine: async () => ({ digest: "", contains_instructions: false, source_meta: { tool: "x", bytes: 0 } }) }),
    posture: () => null, outcome, sessionFactory: (o) => session.bind(o), versionCheck: () => ({ ok: true, version: "18.4.4" }),
    skipPreflightForTest: true, manifestWaitMs: 5_000, ...extra
  });
  cleanups.push(async () => { await sup.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); });
  return { store, sup, outcome, session, data };
}
const req = (run_id: string, text = "hi", source: "telegram" | "schedule" = "telegram") => ({ run_id, text, source, requester: { kind: "user" as const, id: "paco" } });

/** Under fake timers: yield to real I/O (the bridge socket) and advance fake time until the state is reached. */
async function untilState(sup: PlannerSupervisor, want: SupervisorState): Promise<void> {
  for (let i = 0; i < 500 && sup.state() !== want; i++) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1);
  }
}

describe("PlannerSupervisor — detached turns (spec §7)", () => {
  it("runs a turn: claims with a unique planner owner, prompts, completes once, returns to IDLE", async () => {
    const { store, sup, outcome, session } = harness();
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done).toHaveLength(1);
    expect((outcome.done[0] as { worker_id: string }).worker_id).toMatch(/^planner:42:/);
    expect(session.prompts).toEqual(["hi"]);
    expect(sup.state()).toBe("IDLE");
  });

  it("spawns with the single houge.js extension entry, a minted token and a bridge socket that fits sun_path", async () => {
    const { store, sup, session, data } = harness();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    const o = session.options[0] as PlannerSessionOptions;
    expect(o.extensions).toEqual([join(data, "omp", "extension", "houge.js")]);
    expect(o.bridgeToken).toMatch(/^[0-9a-f]{48}$/);
    expect(o.bridgeSock.startsWith(join(data, "omp", "bridge"))).toBe(true);
    expect(Buffer.byteLength(o.bridgeSock)).toBeLessThan(104);
    expect(o.cwd).toBe(join(data, "omp", "workspace", "chat-42"));
  });

  it("writes one llm_attempt per model request with request_key and family (spec §8)", async () => {
    const { store, sup } = harness(); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    const rows = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ role: "compose", family: "claude", request_key: `${run_id}:1` });
  });

  it("steers a second Telegram message into the live turn and completes both runs with one reply", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); setTimeout(() => { session.assistant("both answered"); e({ type: "agent_end" }); }, 60); } });
    const { store, sup, outcome } = harness(session);
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    sup.submit(req(a, "first")); await new Promise((r) => setTimeout(r, 20)); sup.submit(req(b, "second"));
    await sup.whenIdle();
    expect(session.steers).toEqual(["second"]);
    expect(outcome.done.map((d) => (d as { run_id: string }).run_id).sort()).toEqual([a, b].sort());
    expect(outcome.done.find((d) => (d as { run_id: string }).run_id === b)).toMatchObject({ merged_into: a });
  });

  it("never steers a schedule fire into a user turn — it waits and runs as its own turn", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); setTimeout(() => { session.assistant("ok"); e({ type: "agent_end" }); }, 40); } });
    const { store, sup } = harness(session);
    const a = createQueuedTurnRun(store); const s = createQueuedTurnRun(store);
    sup.submit(req(a, "user")); await new Promise((r) => setTimeout(r, 10)); sup.submit({ ...req(s, "brief", "schedule"), goal: "AI日报" });
    await sup.whenIdle(); await sup.whenIdle();
    expect(session.steers).toEqual([]);
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("[scheduled: AI日报]");
  });

  it("falls back to the next planner model on a quota error and keeps the conversation (live set_model)", async () => {
    let calls = 0;
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      if (calls++ === 0) session.assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" });
      else session.assistant("from 4.6");
      e({ type: "agent_end" });
    } });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["google-antigravity/claude-opus-4-6"]);
    expect(outcome.done[0]).toMatchObject({ text: "from 4.6" });
    const kinds = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => (e.payload as { error_kind?: string }).error_kind);
    expect(kinds).toEqual(["quota", undefined]);
  });

  it("fails every planner string exhausted as no_planner_leg and opens an incident", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); session.assistant("", { stopReason: "error", errorMessage: "429 quota" }); e({ type: "agent_end" }); } });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "no_planner_leg" });
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "planner_no_leg" }));
  });

  it("aborts on the turn deadline, reports turn_timeout with any partial text", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); session.assistant("partial"); } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "100" }); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "turn_timeout", partial: "partial" });
    const types = store.getLedgerEvents(run_id).map((e) => e.event_type);
    // the halt reason and step count land before the terminal event (spec §7 terminal transitions)
    expect(types.indexOf("loop_halted")).toBeGreaterThan(-1);
    expect(types.indexOf("loop_halted")).toBeLessThan(types.indexOf("run_failed"));
    expect(store.getLedgerEvents(run_id).find((e) => e.event_type === "loop_halted")?.payload).toEqual({ reason: "turn_timeout", steps: 1 });
  });

  it("pauses the turn deadline while a tool waits for Paco's approval, and resumes it with the time left", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    // setImmediate stays real so the real bridge socket's I/O can complete (ruling 3)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(10);
      sup.setAwaitingApprovalForTest(true); await vi.advanceTimersByTimeAsync(5_000);
      expect(sup.state()).toBe("AWAITING_APPROVAL");
      expect(outcome.failed).toEqual([]);
      sup.setAwaitingApprovalForTest(false); await vi.advanceTimersByTimeAsync(1_100);
      expect(outcome.failed[0]).toMatchObject({ error_type: "turn_timeout" });
    } finally { vi.useRealTimers(); }
  });

  it("fails the turn and every steered run when the child exits mid-turn, then restarts lazily", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); setTimeout(() => session.exit(3), 40); } });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store); const steered = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await new Promise((r) => setTimeout(r, 20)); sup.submit(req(steered, "also"));
    await sup.whenIdle();
    expect(session.steers).toEqual(["also"]);
    expect(outcome.failed.find((f) => (f as { run_id: string }).run_id === run_id)).toMatchObject({ error_type: "planner_exit", error_ref: "exit 3" });
    expect(outcome.failed.find((f) => (f as { run_id: string }).run_id === steered)).toMatchObject({ error_type: "merged_parent_failed" });
    expect(store.getRunState(steered)).toBe("failed");
    expect(sup.state()).toBe("STOPPED");
  });

  it("abortAll('killed') stops the turn within 5 s and records killed", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now(); await sup.abortAll("killed");
    expect(Date.now() - t0).toBeLessThan(5_500);
    expect(outcome.failed[0]).toMatchObject({ error_type: "killed" });
    // a dispatch that failed before any frame still gets its one audit row (spec §8: n = 0)
    const rows = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload);
    expect(rows).toEqual([expect.objectContaining({ outcome: "error", error_kind: "aborted", request_key: `${run_id}:0` })]);
  });

  it("restarts the child at the next turn when the system prompt fingerprint changed (a new lesson must reach a live session)", async () => {
    let starts = 0;
    const session = fakeSession();
    const { store, sup } = harness(session);
    (sup as never as { d: { sessionFactory: (o: PlannerSessionOptions) => unknown } }).d.sessionFactory = (o) => { starts++; return session.bind(o); };
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    (sup as never as { d: { turnContext: { lessonsReader: () => string } } }).d.turnContext.lessonsReader = () => "- new lesson";
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(starts).toBe(2);
  });

  it("returns to the top planner string on the next turn after a fallback", async () => {
    let calls = 0;
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); if (calls++ === 0) session.assistant("", { stopReason: "error", errorMessage: "429 quota" }); else session.assistant("ok"); e({ type: "agent_end" }); } });
    const { store, sup } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.models).toEqual(["google-antigravity/claude-opus-4-6", "anthropic/claude-opus-5-5"]);
  });

  it("refuses to start when the omp version is wrong, failing the run with an incident instead of hanging", async () => {
    const { store, sup, outcome } = harness();
    (sup as never as { d: { versionCheck: () => unknown } }).d.versionCheck = () => ({ ok: false, version: "18.5.0", reason: "omp 18.5.0 is not the pinned 18.4.4" });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "planner_exit" });
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "omp_version_mismatch" }));
  });

  it("fails the run when the child never asks for its manifest (omp only warns on an extension load failure)", async () => {
    const session = fakeSession({ noManifest: true });
    const { store, sup, outcome } = harness(session, {}, { manifestWaitMs: 100 }); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "planner_exit" });
    expect((outcome.failed[0] as { error_ref: string }).error_ref.startsWith("start_failed")).toBe(true);
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "planner_start_failed" }));
    expect(session.prompts).toEqual([]);
  });

  it("strips the attach marker and keeps only paths inside the workspace", () => {
    expect(parseAttachments("done\n[[attach: out/report.pdf]]", "/w")).toEqual({ text: "done", attachments: ["/w/out/report.pdf"] });
    expect(parseAttachments("x\n[[attach: ../../etc/passwd]]", "/w")).toEqual({ text: "x", attachments: [] });
  });

  it("refuses an attachment that is a symlink out of the workspace (a secret must never ride a reply)", () => {
    const d = mkdtempSync(join(tmpdir(), "hat-")); cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const ws = join(d, "ws"); mkdirSync(ws); writeFileSync(join(d, "secret"), "k"); symlinkSync(join(d, "secret"), join(ws, "leak"));
    expect(parseAttachments("x\n[[attach: leak]]", ws)).toEqual({ text: "x", attachments: [] });
  });
});

const failedOf = (o: Outcome, run_id: string) => o.failed.find((f) => (f as { run_id: string }).run_id === run_id) as { error_type: string; error_ref: string } | undefined;
const incidentKinds = (o: Outcome) => o.incidents.map((i) => (i as { k: string }).k);
type Mutable = { d: { turnContext: { retrieve: () => Promise<{ facts: never[]; pages: never[] }> }; sessionFactory: (o: PlannerSessionOptions) => unknown } };

describe("PlannerSupervisor — aborts are per turn and bounded (fix round 1)", () => {
  it("a turn aborted after an earlier turn's abort still finishes, and abortAll resolves (no stale ABORTING guard)", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); } }); // never ends on its own
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "150" });
    let release: () => void = () => undefined; let calls = 0;
    (sup as never as Mutable).d.turnContext.retrieve = async () => {
      if (calls++ > 0) await new Promise<void>((r) => { release = r; }); // turn 2's prompt build hangs
      return { facts: [], pages: [] };
    };
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    sup.submit(req(a)); sup.submit({ ...req(b, "brief", "schedule"), goal: "g" });
    await new Promise((r) => setTimeout(r, 220)); // a timed out and aborted; b is building its prompt
    expect(failedOf(outcome, a)).toMatchObject({ error_type: "turn_timeout" });
    const t0 = Date.now(); await sup.abortAll("killed");
    expect(Date.now() - t0).toBeLessThan(5_500);
    expect(failedOf(outcome, b)).toMatchObject({ error_type: "killed" });
    expect(session.prompts).toHaveLength(1);
    release();
  });

  it("/kill during a hung set_model (fallback leg) resolves within 5 s and records killed", async () => {
    const session = fakeSession({
      onPrompt: (_t, e) => { e({ type: "turn_start" }); session.assistant("", { stopReason: "error", errorMessage: "429 quota" }); e({ type: "agent_end" }); },
      setModel: () => never()
    });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await new Promise((r) => setTimeout(r, 40));
    expect(session.models).toHaveLength(1);
    const t0 = Date.now(); await sup.abortAll("killed");
    expect(Date.now() - t0).toBeLessThan(5_500);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "killed" });
  });

  it("/kill during a start that never becomes ready resolves within 5 s and records killed", async () => {
    const session = fakeSession({ start: never });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now(); await sup.abortAll("killed");
    expect(Date.now() - t0).toBeLessThan(5_500);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "killed" });
    expect(incidentKinds(outcome)).not.toContain("planner_start_failed"); // a deliberate stop is not a start failure
  });

  it("a start that never becomes ready fails the run after the start timeout instead of hanging", async () => {
    const session = fakeSession({ start: never });
    const { store, sup, outcome } = harness(session, {}, { startWaitMs: 60 }); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "planner_exit", error_ref: "start_failed: start timed out" });
    expect(incidentKinds(outcome)).toContain("planner_start_failed");
  });

  it("the turn deadline covers child start: a slow start fails turn_timeout", async () => {
    const session = fakeSession({ start: never });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "80" }); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "turn_timeout" });
  });

  it("abortAll fails every queued run as killed — none is left queued", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session);
    const a = createQueuedTurnRun(store); const q = createQueuedTurnRun(store);
    sup.submit(req(a)); sup.submit({ ...req(q, "later", "schedule"), goal: "g" });
    await new Promise((r) => setTimeout(r, 30));
    await sup.abortAll("guard");
    expect(failedOf(outcome, q)).toMatchObject({ error_type: "killed", error_ref: "guard" });
    expect(store.getRunState(q)).toBe("failed");
    expect(store.getRunState(a)).toBe("failed");
  });
});

describe("PlannerSupervisor — model errors, incidents, crash guard (fix round 1)", () => {
  it("a non-retryable error on a later leg fails model_error with no incident and no further fallback", async () => {
    let calls = 0;
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      session.assistant("", { stopReason: "error", errorMessage: calls++ === 0 ? "429 quota" : "model refusal" });
      e({ type: "agent_end" });
    } });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "model_error", error_ref: "model_refusal" });
    expect(session.models).toHaveLength(1);
    expect(outcome.incidents).toEqual([]);
  });

  it("an assistant message that ended aborted is audited as error{aborted}, never ok", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); session.assistant("", { stopReason: "aborted" }); e({ type: "agent_end" }); } });
    const { store, sup } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    const rows = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload);
    expect(rows).toEqual([expect.objectContaining({ outcome: "error", error_kind: "aborted" })]);
  });

  it("a Seatbelt render failure refuses the start with incident sandbox_unavailable (spec §4)", async () => {
    const { store, sup, outcome, data } = harness(fakeSession(), {}, { skipPreflightForTest: false });
    mkdirSync(join(data, "omp", "planner.sb"), { recursive: true }); // the profile cannot be renamed into place
    copyFileSync(new URL("../../src/omp/shell-wrapper.sh", import.meta.url).pathname, join(data, "omp", "shell-wrapper.sh"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "planner_exit", error_ref: "sandbox_unavailable" });
    expect(incidentKinds(outcome)).toEqual(["sandbox_unavailable"]);
  });

  it("repeated start failures latch the crash guard; it holds past 10 minutes until resetCrashGuard()", async () => {
    let starts = 0;
    const session = fakeSession({ noManifest: true });
    const { store, sup, outcome } = harness(session, {}, { manifestWaitMs: 20 });
    (sup as never as Mutable).d.sessionFactory = (o) => { starts++; return session.bind(o); };
    const turn = async () => { const r = createQueuedTurnRun(store); sup.submit(req(r)); await sup.whenIdle(); return failedOf(outcome, r); };
    for (let i = 0; i < 3; i++) await turn();
    expect(await turn()).toMatchObject({ error_type: "planner_exit", error_ref: "crash_loop" });
    vi.useFakeTimers({ toFake: ["Date"] }); // 11 minutes later (also clears the intake's per-minute rate limit)
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(await turn()).toMatchObject({ error_ref: "crash_loop" });
      expect(starts).toBe(3);
      expect(incidentKinds(outcome).filter((k) => k === "planner_crash_loop")).toHaveLength(1);
      sup.resetCrashGuard();
      await turn();
      expect(starts).toBe(4);
    } finally { vi.useRealTimers(); }
  });

  it("a failed reset to the top string is logged as an incident, the turn answers on the current model, and the next turn retries", async () => {
    let calls = 0;
    const session = fakeSession({
      onPrompt: (_t, e) => { e({ type: "turn_start" }); if (calls++ === 0) session.assistant("", { stopReason: "error", errorMessage: "429 quota" }); else session.assistant("ok"); e({ type: "agent_end" }); },
      setModel: async (n) => { if (n === 2) throw new Error("set_thinking_level failed"); }
    });
    const { store, sup, outcome } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    const second = createQueuedTurnRun(store);
    sup.submit(req(second)); await sup.whenIdle();
    expect(outcome.done.find((d) => (d as { run_id: string }).run_id === second)).toMatchObject({ text: "ok" });
    expect(incidentKinds(outcome)).toContain("planner_model_reset_failed");
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.models).toEqual(["google-antigravity/claude-opus-4-6", "anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"]);
  });
});

describe("PlannerSupervisor — approvals and merged leases (fix round 1)", () => {
  it("two concurrent approval waits keep the deadline paused until both resolve", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await new Promise((r) => setTimeout(r, 30));
    expect(sup.state()).toBe("RUNNING");
    sup.setAwaitingApprovalForTest(true); sup.setAwaitingApprovalForTest(true);
    sup.setAwaitingApprovalForTest(false);
    expect(sup.state()).toBe("AWAITING_APPROVAL");
    sup.setAwaitingApprovalForTest(false);
    expect(sup.state()).toBe("RUNNING");
  });

  it("a steered run whose lease renewal is refused leaves the turn, fails lease_lost and raises an incident", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); } });
    const { store, sup, outcome } = harness(session);
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      sup.submit(req(a)); await new Promise((r) => setTimeout(r, 30)); sup.submit(req(b, "more"));
      await new Promise((r) => setTimeout(r, 10));
      const beat = store.heartbeat.bind(store);
      vi.spyOn(store, "heartbeat").mockImplementation((id, w, ttl) => (id === b ? false : beat(id, w, ttl)));
      await vi.advanceTimersByTimeAsync(30_000);
    } finally { vi.useRealTimers(); }
    expect(failedOf(outcome, b)).toMatchObject({ error_type: "lease_lost" });
    expect(incidentKinds(outcome)).toContain("lease_lost");
    await sup.abortAll("killed");
    expect(outcome.failed.filter((f) => (f as { run_id: string }).run_id === b)).toHaveLength(1); // never also merged_parent_failed
    expect(failedOf(outcome, a)).toMatchObject({ error_type: "killed" });
  });
});
