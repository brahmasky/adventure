import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { lessonSetFingerprint } from "../../src/run/lesson-render.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { PlannerSupervisor, RETRY_NOTE, parseAttachments, type PlannerSessionLike, type SupervisorDeps, type SupervisorState, type TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { PlannerRpcError, type ExitInfo, type PlannerSessionOptions } from "../../src/omp/planner-session.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { BridgeServer } from "../../src/omp/bridge-server.js";
import { chatWorkspace } from "../../src/omp/workspace.js";
import { openManifestClient } from "../helpers/bridge-manifest.js";
import { createQueuedTurnRun } from "../helpers/runs.js";

type Script = {
  /** Event log shared with the test: start/ready/manifest/prompt, tagged with the child's index. */
  log?: string[];
  onPrompt?: (text: string, emit: (f: OmpFrame) => void) => void; noManifest?: boolean;
  /** Replaces start(): e.g. a child that never becomes ready. */
  start?: () => Promise<unknown>;
  /** omp refuses these `provider/model` at spawn (live 18.4.4): the child plays the extension (connects), exits 1, start rejects exited:model_missing. */
  badModels?: string[];
  /** The child answers its manifest, then loses its bridge socket but stays up (a genuine bridge loss during start). */
  dropBridge?: boolean;
  /** With dropBridge: resolves once the supervisor saw the drop (start() returns only then). */
  afterDrop?: () => Promise<void>;
  /** The child exits during start and start rejects with this PlannerRpcError code. */
  exitCode?: string;
  /** Runs after the model is recorded: may throw or never resolve. A throw leaves the child on its previous model. */
  setModel?: (n: number) => Promise<void>;
  /** omp's open_session restores this `provider/model` over --model (a resumed session, live gate 2026-10-01). */
  resumeModel?: string;
  /** Also log each set_model into `log` (`setModel:<provider/model>`), to assert its order against the prompt. */
  logSetModel?: boolean;
  /** Replaces newSession(): e.g. a refusal or a cancelled reset. */
  newSession?: () => Promise<{ cancelled: boolean }>;
  /** The prompt RPC rejects with this PlannerRpcError code (omp refused the prompt). */
  promptError?: string;
};
const never = () => new Promise<never>(() => undefined);
type Fake = PlannerSessionLike & {
  prompts: string[]; steers: string[]; models: string[]; options: PlannerSessionOptions[];
  exit: (c: number) => void; assistant: (text: string, extra?: object) => void; bind: (o: PlannerSessionOptions) => Fake;
  /** The child stays up but its bridge socket closes (its extension never reconnects). */
  dropBridge: () => void;
  /** Emit a frame now, outside any prompt (a late or stray frame). */
  emitForTest: (f: OmpFrame) => void;
  resets: number;
};

/** In-memory omp child. Its start() plays the extension against the REAL bridge socket (ruling 3). */
function fakeSession(script: Script = {}): Fake {
  const frameCbs: Array<(f: OmpFrame) => void> = []; const exitCbs: Array<(i: ExitInfo) => void> = [];
  const sockets: Socket[] = [];
  const emit = (f: OmpFrame) => frameCbs.forEach((cb) => cb(f));
  // the model the child really runs: the spawn's --model, a resumed session's stored one, then each successful set_model
  let current = "anthropic/claude-opus-5-5";
  const assistant = (text: string, extra: object = {}) => {
    const [provider, model] = current.split("/");
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider, model, usage: { input: 10, output: 2 }, stopReason: "stop", ...extra } } as OmpFrame);
  };
  const drop = () => { for (const k of sockets.splice(0)) k.destroy(); };
  const s: Fake = {
    prompts: [], steers: [], models: [], options: [], resets: 0,
    bind: (o) => { s.options.push(o); return s; },
    start: async () => {
      const child = s.options.length; const o = s.options[child - 1] as PlannerSessionOptions;
      script.log?.push(`start:${child}`);
      current = script.resumeModel ?? `${o.model.provider}/${o.model.model}`;
      if (script.start) await script.start();
      if (script.exitCode) { s.exit(1); throw new PlannerRpcError(script.exitCode); }
      if (script.dropBridge) {
        const k = await openManifestClient(o.bridgeSock, o.bridgeToken);
        await new Promise((r) => k.once("data", r)); // the manifest was answered
        k.destroy(); await script.afterDrop?.();
        return { resumed: false, sessionId: "s" };
      }
      if (script.badModels?.includes(`${o.model.provider}/${o.model.model}`)) {
        sockets.push(await openManifestClient(o.bridgeSock, o.bridgeToken)); // the extension loads before omp checks --model
        s.exit(1);
        throw new PlannerRpcError("exited:model_missing");
      }
      if (!script.noManifest) { sockets.push(await openManifestClient(o.bridgeSock, o.bridgeToken)); script.log?.push(`manifest:${child}`); }
      return { resumed: false, sessionId: "s" };
    },
    prompt: async (t: string) => { if (script.promptError) throw new PlannerRpcError(script.promptError); s.prompts.push(t); script.log?.push(`prompt:${s.options.length}`); setTimeout(() => (script.onPrompt ?? ((_t, e) => { e({ type: "turn_start" }); assistant("answer"); e({ type: "agent_end" }); }))(t, emit), 5); },
    steer: async (t: string) => { s.steers.push(t); },
    abort: async () => { setTimeout(() => emit({ type: "agent_end", aborted: true }), 5); },
    setModel: async (m: { provider: string; model: string }) => {
      s.models.push(`${m.provider}/${m.model}`); if (script.logSetModel) script.log?.push(`setModel:${m.provider}/${m.model}`);
      await script.setModel?.(s.models.length);
      current = `${m.provider}/${m.model}`;
    },
    newSession: async () => {
      s.resets += 1; script.log?.push(`newSession:${s.options.length}`);
      return script.newSession ? script.newSession() : { cancelled: false };
    },
    onFrame: (cb: (f: OmpFrame) => void) => { frameCbs.push(cb); }, onExit: (cb: (i: ExitInfo) => void) => { exitCbs.push(cb); },
    stop: async () => { drop(); },
    dropBridge: () => drop(),
    emitForTest: (f) => emit(f),
    exit: (c: number) => { drop(); exitCbs.forEach((cb) => cb({ code: c, signal: null, stopped: false })); },
    assistant
  };
  return s;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

type Outcome = TurnOutcomeSink & { done: unknown[]; failed: unknown[]; incidents: unknown[]; resetOks: number };
function sink(store: RunStore): Outcome {
  const outcome: Outcome = {
    done: [], failed: [], incidents: [], resetOks: 0,
    sessionResetOk: () => { outcome.resetOks++; },
    complete: (i) => { outcome.done.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "completed", report_ref: "r", duration_ms: i.duration_ms, tool_calls: i.tool_calls }); },
    fail: (i) => { outcome.failed.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "failed", error_type: i.error_type, error_ref: i.error_ref }); },
    incident: (k, d) => { outcome.incidents.push({ k, d }); }
  };
  return outcome;
}

function harness(session = fakeSession(), env: Record<string, string> = {}, extra: Partial<SupervisorDeps> = {}, o: { sessionState?: "current" | "none" } = {}) {
  const store = RunStore.openInMemory();
  if ((o.sessionState ?? "current") === "current") {
    store.recordPlannerSessionReset("42", lessonSetFingerprint(store), new Date().toISOString());
    store.claimSessionSeed("42");
    store.promotePlannerSession("42");
  }
  const data = mkdtempSync(join(tmpdir(), "hsv-")); // short: the bridge socket path must fit sun_path (104 bytes)
  const outcome = sink(store);
  const sup = new PlannerSupervisor({
    chatId: "42", store, cfg: resolveOmpConfig({ HOUGE_OMP_SANDBOX: "0", ...env }), ctx: { home: data, repo: data, data }, distDir: data,
    decls: [], env: {}, turnEnvelopeActions: ["shell"],
    turnContext: { store, memoryRoot: new URL("../../memory", import.meta.url).pathname, dataDir: data, skillsReader: () => undefined, coreBlock: () => undefined, retrieve: async () => ({ facts: [], pages: [] }), env: {} },
    buildTools: () => ({ registry: new ToolRegistry(), quarantine: async () => ({ digest: "", contains_instructions: false, source_meta: { tool: "x", bytes: 0 } }) }),
    posture: () => null, outcome, sessionFactory: (o) => session.bind(o), versionCheck: () => ({ ok: true, version: "18.4.4" }),
    skipPreflightForTest: true, manifestWaitMs: 5_000, ...extra
  });
  cleanups.push(async () => { await sup.shutdown(); store.close(); rmSync(data, { recursive: true, force: true }); });
  return { store, sup, outcome, session, data };
}
const req = (run_id: string, text = "hi", source: "telegram" | "schedule" = "telegram") => ({ run_id, text, source, requester: { kind: "user" as const, id: "paco" } });

/** Fake every timer and the clock; setImmediate stays real so the real bridge socket's I/O can complete (ruling 3). */
const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] };

/**
 * Under fake timers: yield to real I/O (the bridge socket) until the state is reached. Fake time does NOT move, so a
 * test's own advances are the whole timeline; the bound is real time (a loaded machine needs more turns, not more ms).
 */
async function untilState(sup: PlannerSupervisor, want: SupervisorState): Promise<void> {
  const end = performance.now() + 10_000;
  while (sup.state() !== want && performance.now() < end) await new Promise((r) => setImmediate(r));
  expect(sup.state()).toBe(want);
}

/** Event-based wait (real time, polled every 5 ms): never a fixed sleep that assumes the machine is idle (final review C4). */
async function until(ok: () => boolean): Promise<void> {
  await vi.waitFor(() => { expect(ok()).toBe(true); }, { timeout: 10_000, interval: 5 });
}

/** A child whose turns stay live until the test ends them: `live(n)` waits for the n-th prompt's frames, `end()` ends the oldest live turn. */
function heldSession(script: Script = {}) {
  const ends: Array<(text: string) => void> = []; let prompted = 0;
  const session: Fake = fakeSession({ ...script, onPrompt: (_t, e) => {
    prompted++; e({ type: "turn_start" });
    ends.push((text) => { session.assistant(text); e({ type: "agent_end" }); });
  } });
  return {
    session,
    live: (n = 1) => until(() => prompted >= n),
    end: (text = "ok") => { (ends.shift() as (t: string) => void)(text); }
  };
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

  it("attributes the spawned prompt's lessons: one the char cap skipped is never credited (memory A1 §1-2)", async () => {
    const { store, sup } = harness();
    (sup as never as { d: { turnContext: { env: NodeJS.ProcessEnv } } }).d.turnContext.env = { HOUGE_LESSON_CHAR_CAP: "40" };
    const shown = store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    const skipped = store.addLesson({ scope: "ask", text: "z".repeat(60), source: "user_feedback" });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    const started = store.getLedgerEvents(run_id).find((e) => e.event_type === "loop_started");
    expect(started?.payload).toMatchObject({ applied_artifacts: { lesson_ids: [shown] } });
    expect(store.getLesson(shown)!.applied_count).toBe(1);
    expect(store.getLesson(skipped)!.applied_count).toBe(0);
  });

  it("credits the SPAWN-time snapshot: a lesson added after the child spawned is not credited by the turn it missed (D2)", async () => {
    const { store, sup } = harness();
    const shown = store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    let late = 0;
    (sup as never as { d: { turnContext: { retrieve: () => Promise<unknown> } } }).d.turnContext.retrieve = async () => {
      late = store.addLesson({ scope: "ask", text: "added after the spawn", source: "user_feedback" }); // after ensureReady
      return { facts: [], pages: [] };
    };
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    const started = store.getLedgerEvents(run_id).find((e) => e.event_type === "loop_started");
    expect(started?.payload).toMatchObject({ applied_artifacts: { lesson_ids: [shown] } });
    expect(store.getLesson(late)!.applied_count).toBe(0);
  });

  it("spawns with the single houge.js extension entry, a minted token and a bridge socket that fits sun_path", async () => {
    const { store, sup, session, data } = harness();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    const o = session.options[0] as PlannerSessionOptions;
    expect(o.extensions).toEqual([join(data, "omp", "extension", "houge.js")]);
    expect(o.bridgeToken).toMatch(/^[0-9a-f]{48}$/);
    expect(o.bridgeSock.startsWith(join(data, "omp", "bridge"))).toBe(true);
    expect(Buffer.byteLength(o.bridgeSock)).toBeLessThan(104);
    expect(o.cwd).toBe(chatWorkspace(data, "42"));
  });

  it("writes one llm_attempt per model request with request_key and family (spec §8)", async () => {
    const { store, sup } = harness(); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    const rows = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ role: "compose", family: "claude", request_key: `${run_id}:1` });
  });

  it("steers a second Telegram message into the live turn and completes both runs with one reply", async () => {
    const h = heldSession(); const session = h.session;
    const { store, sup, outcome } = harness(session);
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    sup.submit(req(a, "first")); await h.live(); sup.submit(req(b, "second"));
    h.end("both answered"); await sup.whenIdle();
    expect(session.steers).toEqual(["second"]);
    expect(outcome.done.map((d) => (d as { run_id: string }).run_id).sort()).toEqual([a, b].sort());
    expect(outcome.done.find((d) => (d as { run_id: string }).run_id === b)).toMatchObject({ merged_into: a });
  });

  it("never steers a schedule fire into a user turn — it waits and runs as its own turn", async () => {
    const h = heldSession(); const session = h.session;
    const { store, sup } = harness(session);
    const a = createQueuedTurnRun(store); const s = createQueuedTurnRun(store);
    sup.submit(req(a, "user")); await h.live(); sup.submit({ ...req(s, "brief", "schedule"), goal: "AI日报" });
    h.end(); await h.live(2); h.end(); await sup.whenIdle();
    expect(session.steers).toEqual([]);
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("[scheduled: AI日报]");
  });

  it("never steers a voice/photo message into a live turn: it queues as its own turn and is ingested first (fix round 1, I-1)", async () => {
    const h = heldSession(); const session = h.session;
    const ingested: string[] = [];
    const { store, sup, outcome } = harness(session, {}, {
      resolveMessage: async (claim) => (claim.run_id === voice ? (ingested.push(claim.run_id), { ok: true, text: "transcript" }) : { ok: true, text: "user" })
    });
    const a = createQueuedTurnRun(store); const voice = createQueuedTurnRun(store, "[voice message]");
    sup.submit(req(a, "user")); await h.live();
    sup.submit({ ...req(voice, "[voice message]"), needsIngest: true });
    h.end(); await h.live(2); h.end(); await sup.whenIdle();
    expect(session.steers).toEqual([]);
    expect(ingested).toEqual([voice]);
    expect(session.prompts).toEqual(["user", "transcript"]);
    expect(outcome.done.find((d) => (d as { run_id: string }).run_id === voice)).not.toHaveProperty("merged_into");
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
    // the fresh child is pinned to its spawn leg first (item 6), then the quota error moves it to the next string
    expect(session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]);
    expect(session.prompts).toEqual(["hi", RETRY_NOTE]); // the next model is told to continue, never sent a blank prompt
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
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(700); // 300 ms of the deadline left
      sup.setAwaitingApprovalForTest(true); await vi.advanceTimersByTimeAsync(5_000);
      expect(sup.state()).toBe("AWAITING_APPROVAL");
      expect(outcome.failed).toEqual([]);
      sup.setAwaitingApprovalForTest(false); await vi.advanceTimersByTimeAsync(200);
      expect(outcome.failed).toEqual([]); // resumed with the 300 ms left …
      await vi.advanceTimersByTimeAsync(150);
      expect(outcome.failed[0]).toMatchObject({ error_type: "turn_timeout" }); // … not a fresh 1000 ms (M-1)
    } finally { vi.useRealTimers(); }
  });

  it("fails the turn and every steered run when the child exits mid-turn, then restarts lazily", async () => {
    const h = heldSession(); const session = h.session;
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store); const steered = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await h.live(); sup.submit(req(steered, "also"));
    session.exit(3); await sup.whenIdle();
    expect(session.steers).toEqual(["also"]);
    expect(outcome.failed.find((f) => (f as { run_id: string }).run_id === run_id)).toMatchObject({ error_type: "planner_exit", error_ref: "exit 3" });
    expect(outcome.failed.find((f) => (f as { run_id: string }).run_id === steered)).toMatchObject({ error_type: "merged_parent_failed" });
    expect(store.getRunState(steered)).toBe("failed");
    expect(sup.state()).toBe("STOPPED");
  });

  it("abortAll('killed') stops the turn within 5 s and records killed", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await until(() => session.prompts.length === 1); // dispatched, no frame yet
    const t0 = Date.now(); await sup.abortAll("killed");
    expect(Date.now() - t0).toBeLessThan(5_500);
    expect(outcome.failed[0]).toMatchObject({ error_type: "killed" });
    // a dispatch that failed before any frame still gets its one audit row (spec §8: n = 0)
    const rows = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload);
    expect(rows).toEqual([expect.objectContaining({ outcome: "error", error_kind: "aborted", request_key: `${run_id}:0` })]);
  });

  it("a daemon shutdown mid-request audits it error{shutdown}, never aborted: the failing-leg sweep ignores only shutdown", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await until(() => session.prompts.length === 1); // dispatched, no frame yet
    await sup.shutdown();
    const rows = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload);
    expect(rows).toEqual([expect.objectContaining({ outcome: "error", error_kind: "shutdown", request_key: `${run_id}:0` })]);
  });

  it("restarts the child at the next turn when the system prompt fingerprint changed (a new lesson must reach a live session)", async () => {
    let starts = 0;
    const session = fakeSession();
    const { store, sup } = harness(session);
    (sup as never as { d: { sessionFactory: (o: PlannerSessionOptions) => unknown } }).d.sessionFactory = (o) => { starts++; return session.bind(o); };
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    store.addLesson({ scope: "ask", text: "new lesson", source: "user_feedback" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(starts).toBe(2);
  });

  it("returns to the top planner string on the next turn after a fallback", async () => {
    let calls = 0;
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); if (calls++ === 0) session.assistant("", { stopReason: "error", errorMessage: "429 quota" }); else session.assistant("ok"); e({ type: "agent_end" }); } });
    const { store, sup } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6", "anthropic/claude-opus-5-5"]);
  });

  it("refuses to start when the omp version is wrong, failing the run with an incident instead of hanging", async () => {
    const { store, sup, outcome } = harness();
    (sup as never as { d: { versionCheck: () => unknown } }).d.versionCheck = () => ({ ok: false, kind: "version_mismatch" as const, version: "18.5.0", reason: "omp 18.5.0 is not the pinned 18.4.4" });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "planner_exit" });
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "omp_version_mismatch" }));
  });

  it("a passing version check tells the outcome sink so an open omp incident can clear (fix round 2)", async () => {
    const { store, sup, outcome } = harness();
    let oks = 0;
    (outcome as unknown as { versionOk: () => void }).versionOk = () => { oks += 1; };
    (sup as never as { d: { versionCheck: () => unknown } }).d.versionCheck = () => ({ ok: false, kind: "version_mismatch" as const, version: "18.5.0", reason: "x" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(oks).toBe(0);
    (sup as never as { d: { versionCheck: () => unknown } }).d.versionCheck = () => ({ ok: true, version: "18.4.4" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(oks).toBe(1);
  });

  it("an omp it cannot run is omp_unavailable, never a version mismatch (I2)", async () => {
    const { store, sup, outcome } = harness();
    (sup as never as { d: { versionCheck: () => unknown } }).d.versionCheck = () => ({ ok: false, kind: "not_runnable" as const, version: null, reason: "omp not runnable: ENOENT" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(outcome.incidents.map((i) => (i as { k: string }).k)).toEqual(["omp_unavailable"]);
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
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(a)); sup.submit({ ...req(b, "brief", "schedule"), goal: "g" });
      await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(160); // a's deadline fires and its abort lands
      await until(() => failedOf(outcome, a) !== undefined && calls === 2); // a timed out; b is building its prompt (fake time stands still)
      expect(failedOf(outcome, a)).toMatchObject({ error_type: "turn_timeout" });
      const t0 = performance.now(); await sup.abortAll("killed");
      expect(performance.now() - t0).toBeLessThan(5_500);
    } finally { vi.useRealTimers(); }
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
    sup.submit(req(run_id)); await until(() => session.models.length === 1);
    const t0 = Date.now(); await sup.abortAll("killed");
    expect(Date.now() - t0).toBeLessThan(5_500);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "killed" });
  });

  it("/kill during a start that never becomes ready resolves within 5 s and records killed", async () => {
    const session = fakeSession({ start: never });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await until(() => session.options.length === 1); // the child is starting
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
    await until(() => session.prompts.length === 1);
    await sup.abortAll("guard");
    expect(failedOf(outcome, q)).toMatchObject({ error_type: "killed", error_ref: "guard" });
    expect(store.getRunState(q)).toBe("failed");
    expect(store.getRunState(a)).toBe("failed");
  });
});

describe("PlannerSupervisor — error refs carry a code, never an fs message (Task 13 fix round 1, M-6)", () => {
  it("a start that fails with an fs error fails the run `start_failed: ENOENT`; neither the run nor the incident holds the path", async () => {
    const session = fakeSession({ start: async () => { throw Object.assign(new Error("ENOENT: no such file, open '/Users/p/secret.sock'"), { code: "ENOENT" }); } });
    const { store, sup, outcome } = harness(session);
    const r = createQueuedTurnRun(store);
    sup.submit(req(r)); await sup.whenIdle();
    expect(failedOf(outcome, r)).toMatchObject({ error_type: "planner_exit", error_ref: "start_failed: ENOENT" });
    expect(JSON.stringify(outcome.incidents)).not.toContain("/Users/p");
  });
});

describe("PlannerSupervisor — shutdown never orphans a queued turn (Task 13 fix round 1, I-2)", () => {
  it("shutdown fails every queued, unstarted request planner_exit (nothing dispatches queued runs at boot)", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session);
    const a = createQueuedTurnRun(store); const q1 = createQueuedTurnRun(store); const q2 = createQueuedTurnRun(store);
    sup.submit(req(a)); sup.submit(req(q1)); sup.submit(req(q2));
    await until(() => session.prompts.length === 1);
    await sup.shutdown();
    for (const q of [q1, q2]) {
      expect(failedOf(outcome, q)).toMatchObject({ error_type: "planner_exit", error_ref: "daemon shutdown" });
      expect(store.getRunState(q)).toBe("failed");
    }
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
    expect(session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]); // the spawn pin, then one fallback
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
      setModel: async (n) => { if (n === 3) throw new Error("set_thinking_level failed"); } // n=1 is the spawn pin, n=2 the fallback
    });
    const { store, sup, outcome } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    const second = createQueuedTurnRun(store);
    sup.submit(req(second)); await sup.whenIdle();
    expect(outcome.done.find((d) => (d as { run_id: string }).run_id === second)).toMatchObject({ text: "ok" });
    expect(incidentKinds(outcome)).toContain("planner_model_reset_failed");
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6", "anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"]);
  });
});

describe("PlannerSupervisor — approvals and merged leases (fix round 1)", () => {
  it("two concurrent approval waits keep the deadline paused until both resolve", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await until(() => sup.state() === "RUNNING");
    sup.setAwaitingApprovalForTest(true); sup.setAwaitingApprovalForTest(true);
    sup.setAwaitingApprovalForTest(false);
    expect(sup.state()).toBe("AWAITING_APPROVAL");
    sup.setAwaitingApprovalForTest(false);
    expect(sup.state()).toBe("RUNNING");
  });

  it("a steered run whose lease renewal is refused leaves the turn with an incident, and the turn never writes its terminal", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); } });
    const { store, sup, outcome } = harness(session);
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      sup.submit(req(a)); await until(() => session.prompts.length === 1); sup.submit(req(b, "more"));
      expect(session.steers).toEqual(["more"]);
      const beat = store.heartbeat.bind(store);
      vi.spyOn(store, "heartbeat").mockImplementation((id, w, ttl) => (id === b ? false : beat(id, w, ttl)));
      await vi.advanceTimersByTimeAsync(30_000);
    } finally { vi.useRealTimers(); }
    expect(incidentKinds(outcome)).toContain("lease_lost");
    await sup.abortAll("killed");
    // refused = not ours any more: no lease_lost write, and never merged_parent_failed with the parent
    expect(failedOf(outcome, b)).toBeUndefined();
    expect(failedOf(outcome, a)).toMatchObject({ error_type: "killed" });
  });
});

describe("PlannerSupervisor — start phase (fix round 2)", () => {
  it("a child that exits during start is counted: three such exits raise planner_start_failed each and latch the crash guard", async () => {
    const session: Fake = fakeSession({ start: async () => { session.exit(1); throw new Error("planner exited 1 before ready"); } });
    const { store, sup, outcome } = harness(session);
    const turn = async () => { const r = createQueuedTurnRun(store); sup.submit(req(r)); await sup.whenIdle(); return failedOf(outcome, r); };
    // an exit before ready ends as the start's failure, never the turn's bare exit or "bridge disconnected"
    for (let i = 0; i < 3; i++) expect(await turn()).toMatchObject({ error_type: "planner_exit", error_ref: "start_failed: child exit 1 during start" });
    expect(incidentKinds(outcome)).toEqual(["planner_start_failed", "planner_start_failed", "planner_start_failed"]);
    expect(await turn()).toMatchObject({ error_ref: "crash_loop" });
    expect(incidentKinds(outcome)).toContain("planner_crash_loop");
    expect(session.options).toHaveLength(3);
  });

  it("a start slower than the deadline is cancelled; the queued turn gets a fresh child that is ready before its prompt", async () => {
    const log: string[] = []; let first = true;
    const session = fakeSession({ log, start: async () => { if (first) { first = false; await never(); } } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "80" });
    const stop = vi.spyOn(session, "stop");
    const a = createQueuedTurnRun(store); const b = createQueuedTurnRun(store);
    sup.submit(req(a)); sup.submit({ ...req(b, "brief", "schedule"), goal: "g" });
    await sup.whenIdle();
    expect(failedOf(outcome, a)).toMatchObject({ error_type: "turn_timeout" });
    expect(stop).toHaveBeenCalled(); // the in-flight start was stopped, not left running
    expect(outcome.done.map((d) => (d as { run_id: string }).run_id)).toEqual([b]);
    expect(log).toEqual(["start:1", "start:2", "manifest:2", "prompt:2"]); // child 1 is never prompted
    expect(outcome.incidents).toEqual([]); // a deliberate stop is not a start failure
    expect(sup.state()).toBe("IDLE");
  });
});

describe("PlannerSupervisor — resolveMessage hook (Task 13: voice/photo ingest)", () => {
  it("prompts the planner with the resolved text, not the placeholder (a voice note is answered as words)", async () => {
    const seen: string[] = [];
    const { store, sup, session } = harness(fakeSession(), {}, {
      resolveMessage: async (claim) => { seen.push(claim.run_id); return { ok: true, text: "transcribed" }; }
    });
    const run_id = createQueuedTurnRun(store, "[voice message]");
    sup.submit(req(run_id, "[voice message]")); await sup.whenIdle();
    expect(seen).toEqual([run_id]);
    expect(session.prompts).toEqual(["transcribed"]);
  });

  it("a failed ingest fails the run media_failed with its reply and never spawns a child", async () => {
    const { store, sup, outcome, session } = harness(fakeSession(), {}, {
      resolveMessage: async () => ({ ok: false, error_ref: "couldn't transcribe that right now" })
    });
    const run_id = createQueuedTurnRun(store, "[voice message]");
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.failed).toEqual([expect.objectContaining({ run_id, error_type: "media_failed", error_ref: "couldn't transcribe that right now" })]);
    expect(session.options).toHaveLength(0);
  });
});

describe("PlannerSupervisor — omp rejects the model at spawn (live fix, omp 18.4.4)", () => {
  const TOP = "anthropic/claude-opus-5-5"; const SECOND = "google-antigravity/claude-opus-4-6"; const THIRD = "kimi-code/k3";
  const spawnedModels = (f: Fake) => f.options.map((o) => `${o.model.provider}/${o.model.model}`);
  const attempts = (store: RunStore, run: string) => store.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload as Record<string, unknown>);

  it("a bad first string respawns on the second; the turn completes there with rows [model_missing, ok] and no incident", async () => {
    const session = fakeSession({ badModels: [TOP] });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ run_id, text: "answer" });
    expect(spawnedModels(session)).toEqual([TOP, SECOND]);
    const rows = attempts(store, run_id);
    expect(rows.map((r) => r.error_kind)).toEqual(["model_missing", undefined]);
    expect(rows[0]).toMatchObject({ outcome: "error", model: "claude-opus-5-5", family: "claude", request_key: `${run_id}:0:0` });
    expect(outcome.incidents).toEqual([]);
    expect(session.models).toEqual([SECOND]); // the fallback is a respawn pinned to its own leg, never a set_model to the bad string
  });

  it("every string rejected at spawn fails no_planner_leg with incident planner_no_leg, one row per string", async () => {
    const session = fakeSession({ badModels: [TOP, SECOND, THIRD] });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "no_planner_leg", error_ref: "model_missing" });
    expect(incidentKinds(outcome)).toEqual(["planner_no_leg"]);
    expect(attempts(store, run_id).map((r) => [r.model, r.error_kind])).toEqual([["claude-opus-5-5", "model_missing"], ["claude-opus-4-6", "model_missing"], ["k3", "model_missing"]]);
  });

  it("model rejections never count toward the crash latch", async () => {
    const session = fakeSession({ badModels: [TOP, SECOND, THIRD] });
    const { store, sup, outcome } = harness(session);
    for (let i = 0; i < 4; i++) { sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); }
    expect(incidentKinds(outcome)).not.toContain("planner_crash_loop");
    expect(outcome.failed.map((f) => (f as { error_type: string }).error_type)).toEqual(Array(4).fill("no_planner_leg"));
    expect(session.options).toHaveLength(12); // every turn really tried every string
  });

  it("the next turn retries the top string once (a respawn), and returns to it when it is back", async () => {
    const bad = [TOP];
    const session = fakeSession({ badModels: bad });
    const { store, sup, outcome } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); // still bad: one retry of TOP, then SECOND again
    expect(spawnedModels(session)).toEqual([TOP, SECOND, TOP, SECOND]);
    bad.length = 0;
    const third = createQueuedTurnRun(store);
    sup.submit(req(third)); await sup.whenIdle();
    expect(spawnedModels(session)).toEqual([TOP, SECOND, TOP, SECOND, TOP]);
    expect(attempts(store, third).map((r) => r.error_kind)).toEqual([undefined]);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); // on TOP now: the live child is kept
    expect(session.options).toHaveLength(5);
    expect(outcome.done).toHaveLength(4);
  });
});

describe("PlannerSupervisor — start-phase edges (live-fix round 2)", () => {
  it("a bridge lost during start while the child stays up fails the start (counted, incident); the run is never prompted", async () => {
    let sup: PlannerSupervisor | undefined;
    const session = fakeSession({ dropBridge: true, afterDrop: () => until(() => (sup as never as { spawning?: { bridgeLost?: boolean } }).spawning?.bridgeLost === true) });
    const h = harness(session); sup = h.sup; const { store, outcome } = h; const run_id = createQueuedTurnRun(store);
    const stop = vi.spyOn(session, "stop");
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "planner_exit", error_ref: "start_failed: bridge_lost_during_start" });
    expect(incidentKinds(outcome)).toEqual(["planner_start_failed"]);
    expect(session.prompts).toEqual([]);
    expect(stop).toHaveBeenCalled();
    expect(sup.state()).toBe("STOPPED");
  });

  it("a start refusal and an n = 0 dispatch in one turn keep two distinct audit rows (no request_key collision)", async () => {
    const session = fakeSession({ badModels: ["anthropic/claude-opus-5-5"], onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await until(() => session.prompts.length === 1); // dispatched on the second string, no frame yet
    await sup.abortAll("killed");
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "killed" });
    const rows = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload);
    expect(rows).toEqual([
      expect.objectContaining({ request_key: `${run_id}:0:0`, error_kind: "model_missing" }),
      expect.objectContaining({ request_key: `${run_id}:0`, error_kind: "aborted" })
    ]);
  });

  it("a start crash that merely mentions a model (exited:model_unconfirmed) is a counted crash, never a fallback", async () => {
    const session = fakeSession({ exitCode: "exited:model_unconfirmed" });
    const { store, sup, outcome } = harness(session);
    const turn = async () => { const r = createQueuedTurnRun(store); sup.submit(req(r)); await sup.whenIdle(); return failedOf(outcome, r); };
    for (let i = 0; i < 3; i++) expect(await turn()).toMatchObject({ error_ref: "start_failed: exited:model_unconfirmed" });
    expect(await turn()).toMatchObject({ error_ref: "crash_loop" });
    expect(incidentKinds(outcome)).toEqual(["planner_start_failed", "planner_start_failed", "planner_start_failed", "planner_crash_loop"]);
    expect(session.options.map((o) => o.model.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
    const first = (outcome.failed[0] as { run_id: string }).run_id;
    expect(store.getLedgerEvents(first).filter((e) => e.event_type === "llm_attempt")).toEqual([]); // no model_missing row
  });
});

describe("PlannerSupervisor — a lost bridge retires the child (live-fix round 3)", () => {
  /** The supervisor saw the bridge drop (the child is marked stale for retirement). */
  const sawDrop = (sup: PlannerSupervisor) => until(() => (sup as never as { stale: boolean }).stale);

  it("bridge dropped mid-turn with the child up: turn 1 fails planner_exit, turn 2 runs on a fresh child, child 1 is stopped", async () => {
    let calls = 0;
    const session: Fake = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      if (calls++ === 0) { session.dropBridge(); return; } // no agent_end: only the abort ends it
      session.assistant("fresh"); e({ type: "agent_end" });
    } });
    const { store, sup, outcome } = harness(session);
    const stop = vi.spyOn(session, "stop");
    const a = createQueuedTurnRun(store);
    sup.submit(req(a)); await sup.whenIdle();
    expect(failedOf(outcome, a)).toMatchObject({ error_type: "planner_exit", error_ref: "bridge disconnected" });
    const b = createQueuedTurnRun(store);
    sup.submit(req(b)); await sup.whenIdle();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(session.options).toHaveLength(2);
    expect(outcome.done[0]).toMatchObject({ run_id: b, text: "fresh" });
  });

  it("bridge dropped while IDLE: the next turn stops child 1 and runs on child 2", async () => {
    const session = fakeSession();
    const { store, sup, outcome } = harness(session);
    const stop = vi.spyOn(session, "stop");
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    session.dropBridge(); await sawDrop(sup);
    expect(sup.state()).toBe("IDLE");
    const b = createQueuedTurnRun(store);
    sup.submit(req(b)); await sup.whenIdle();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(session.options).toHaveLength(2);
    expect(outcome.done.map((d) => (d as { run_id: string }).run_id)).toContain(b);
    expect(outcome.failed).toEqual([]);
  });

  it("the old child's bridge dropping while a fresh turn builds its prompt does not fail that turn; it gets a fresh child", async () => {
    const log: string[] = [];
    const session = fakeSession({ log });
    const { store, sup, outcome } = harness(session);
    let release: () => void = () => undefined; let calls = 0;
    (sup as never as Mutable).d.turnContext.retrieve = async () => {
      if (calls++ > 0) await new Promise<void>((r) => { release = r; }); // turn 2's prompt build waits
      return { facts: [], pages: [] };
    };
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    const b = createQueuedTurnRun(store);
    sup.submit(req(b)); await until(() => calls === 2); // turn 2 is inside buildTurnPrompt on child 1
    session.dropBridge(); await sawDrop(sup);
    release(); await sup.whenIdle();
    expect(failedOf(outcome, b)).toBeUndefined();
    expect(outcome.done.map((d) => (d as { run_id: string }).run_id)).toContain(b);
    expect(log).toEqual(["start:1", "manifest:1", "prompt:1", "start:2", "manifest:2", "prompt:2"]);
  });
});

describe("PlannerSupervisor — omp error frames and aborted ends (final review B5, B6)", () => {
  const attempts = (store: RunStore, run_id: string) =>
    store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload as { outcome: string; error_kind?: string; request_key: string });

  it("an error frame with no assistant message is audited and falls back like any retryable error — never an empty 'success'", async () => {
    let calls = 0;
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      if (calls++ === 0) { e({ type: "error", error: "429 usage limit reached" }); e({ type: "agent_end" }); return; }
      session.assistant("from 4.6"); e({ type: "agent_end" });
    } });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]); // the spawn pin, then the fallback
    expect(outcome.done[0]).toMatchObject({ run_id, text: "from 4.6" });
    expect(attempts(store, run_id).map((a) => [a.outcome, a.error_kind])).toEqual([["error", "quota"], ["ok", undefined]]);
  });

  it("a non-retryable error frame fails the run model_error with its audit row (no completed run with a placeholder)", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); e({ type: "error", error: { message: "something odd" } }); e({ type: "agent_end" }); } });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done).toEqual([]);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "model_error", error_ref: "other" });
    expect(attempts(store, run_id)).toEqual([expect.objectContaining({ outcome: "error", error_kind: "other", request_key: `${run_id}:1` })]);
  });

  it("a prompt that failed before reaching the agent (prompt_result error, no agent_end) ends the turn at once, classified", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "fetch failed", retryable: false } }); } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_PLANNER: "anthropic/claude-opus-5-5:medium" }); const run_id = createQueuedTurnRun(store);
    const t0 = Date.now();
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(Date.now() - t0).toBeLessThan(2_000); // not the 180 s frame watchdog
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "no_planner_leg", error_ref: "transport" });
    expect(attempts(store, run_id)).toEqual([expect.objectContaining({ outcome: "error", error_kind: "transport", request_key: `${run_id}:0` })]);
  });

  it("an aborted agent_end the supervisor did not ask for fails planner_exit agent_aborted, never completed", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); e({ type: "agent_end", aborted: true }); } });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done).toEqual([]);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "planner_exit", error_ref: "agent_aborted" });
  });
});

describe("PlannerSupervisor — an abort that lands while the bridge listens (final review B9, parked T12)", () => {
  type Internals = { session?: unknown; bridge?: unknown };
  /** Hold the first BridgeServer.listen until released; resolves `entered` once the spawn is inside it. */
  function gateListen() {
    const real = BridgeServer.listen.bind(BridgeServer);
    let release: () => void = () => undefined; let entered: () => void = () => undefined;
    const inside = new Promise<void>((r) => { entered = r; });
    let n = 0;
    const spy = vi.spyOn(BridgeServer, "listen").mockImplementation(async (...a: Parameters<typeof BridgeServer.listen>) => {
      if (n++ === 0) { entered(); await new Promise<void>((r) => { release = r; }); }
      return real(...a);
    });
    cleanups.push(() => spy.mockRestore());
    return { inside, release: () => release() };
  }

  /** The superseded spawn closes its bridge after listen() returns: wait for it, bounded (the bug kept both registered forever). */
  const unregistered = (h: ReturnType<typeof harness>) =>
    until(() => (h.sup as never as Internals).session === undefined && (h.sup as never as Internals).bridge === undefined).catch(() => undefined);

  async function nextTurnRunsOnAFreshChild(h: ReturnType<typeof harness>, log: string[]) {
    const internals = h.sup as never as Internals;
    expect(internals.session).toBeUndefined(); // nothing left registered by the superseded spawn
    expect(internals.bridge).toBeUndefined();
    const b = createQueuedTurnRun(h.store);
    h.sup.submit(req(b)); await h.sup.whenIdle();
    expect(h.outcome.done.map((d) => (d as { run_id: string }).run_id)).toContain(b);
    expect(log).toEqual(["start:1", "manifest:1", "prompt:1"]); // the superseded spawn never made a child; b's own child answered
  }

  it("a turn-deadline abort inside listen() leaves no orphan child; the next turn is answered on a fresh child", async () => {
    const log: string[] = [];
    const h = harness(fakeSession({ log }), { HOUGE_OMP_TURN_TIMEOUT_MS: "150" });
    const gate = gateListen();
    const a = createQueuedTurnRun(h.store);
    h.sup.submit(req(a)); await gate.inside;
    await until(() => (h.sup as never as { turn?: { failure?: unknown } }).turn?.failure !== undefined); // the deadline fired inside listen()
    gate.release(); await h.sup.whenIdle(); await unregistered(h);
    expect(failedOf(h.outcome, a)).toMatchObject({ error_type: "turn_timeout" });
    (h.sup as never as { d: { cfg: { turnTimeoutMs: number } } }).d.cfg.turnTimeoutMs = 600_000;
    await nextTurnRunsOnAFreshChild(h, log);
  });

  it("a lease-lost abort inside listen() leaves no orphan child; the next turn is answered on a fresh child", async () => {
    const log: string[] = [];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    cleanups.push(() => { vi.useRealTimers(); });
    const h = harness(fakeSession({ log }));
    const gate = gateListen();
    const a = createQueuedTurnRun(h.store);
    h.sup.submit(req(a)); await gate.inside;
    const beat = vi.spyOn(h.store, "heartbeat").mockReturnValue(false);
    vi.advanceTimersByTime(30_000); // the lease renewal is refused while the spawn waits in listen()
    beat.mockRestore(); vi.useRealTimers();
    gate.release(); await h.sup.whenIdle(); await unregistered(h);
    expect(failedOf(h.outcome, a)).toMatchObject({ error_type: "lease_lost" });
    await nextTurnRunsOnAFreshChild(h, log);
  });
});

describe("PlannerSupervisor — a schedule-born turn is never steered into (final review B2)", () => {
  it("Paco's message during a live schedule turn queues behind it and runs as its own turn under his own requester", async () => {
    const h = heldSession(); const session = h.session;
    const { store, sup, outcome } = harness(session);
    const s = createQueuedTurnRun(store); const m = createQueuedTurnRun(store);
    sup.submit({ ...req(s, "brief", "schedule"), goal: "AI日报" }); await h.live();
    sup.submit(req(m, "hello"));
    h.end(); await h.live(2); h.end(); await sup.whenIdle();
    expect(session.steers).toEqual([]);
    expect(session.prompts).toHaveLength(2);
    expect(outcome.done.find((d) => (d as { run_id: string }).run_id === m)).not.toHaveProperty("merged_into");
  });
});

describe("PlannerSupervisor — a good start clears the start incidents (final review B3)", () => {
  it("tells the outcome sink once per successful child start, never on a failed one", async () => {
    const startOk = vi.fn();
    const session = fakeSession({ exitCode: "exited:crash" });
    const { store, sup, outcome } = harness(session);
    outcome.startOk = startOk;
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(startOk).not.toHaveBeenCalled();
    const ok = harness(fakeSession());
    ok.outcome.startOk = startOk;
    ok.sup.submit(req(createQueuedTurnRun(ok.store))); await ok.sup.whenIdle();
    ok.sup.submit(req(createQueuedTurnRun(ok.store))); await ok.sup.whenIdle();
    expect(startOk).toHaveBeenCalledTimes(1); // the second turn reuses the live child
  });
});

describe("PlannerSupervisor — a throw after the claim never strands the run (final review B1)", () => {
  it("a turn whose tools cannot be built fails planner_exit at once (not left running until lease expiry)", async () => {
    const { store, sup, outcome } = harness(fakeSession(), {}, { buildTools: () => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); } });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(store.getRunState(run_id)).toBe("failed");
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "planner_exit", error_ref: "turn_setup_failed: SQLITE_BUSY" });
  });
});

describe("PlannerSupervisor — shutdown wakes in-turn waiters (final review B12, correctness M4)", () => {
  it("shutdown aborts the live turn's signal, so an approval waiter or adapter stops instead of holding the process", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => { e({ type: "turn_start" }); } }); // never ends on its own
    const { store, sup } = harness(session);
    sup.submit(req(createQueuedTurnRun(store)));
    await vi.waitFor(() => { expect(session.prompts).toHaveLength(1); });
    const signal = (sup as never as { turn: { abort: AbortController } }).turn.abort.signal;
    expect(signal.aborted).toBe(false);
    await sup.shutdown();
    expect(signal.aborted).toBe(true);
  });
});

describe("PlannerSupervisor — frame watchdog, parent lease, stale children (final review C3)", () => {
  type Emit = (f: OmpFrame) => void;
  /** A child whose turn streams only what the test emits; `emit` is set once the prompt arrived. */
  function streaming() {
    const h = { emit: undefined as Emit | undefined };
    const session = fakeSession({ onPrompt: (_t, e) => { h.emit = e; e({ type: "turn_start" }); } });
    return { h, session };
  }

  it("re-arms the frame watchdog on every frame: a turn that keeps streaming past frameIdleMs is never aborted (testing I-3)", async () => {
    const { h, session } = streaming();
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(500); h.emit?.({ type: "message_update" }); } // 3 s, a frame every 500 ms
      expect(outcome.failed).toEqual([]);
      expect(sup.state()).toBe("RUNNING");
      session.assistant("done"); h.emit?.({ type: "agent_end" });
    } finally { vi.useRealTimers(); }
    await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ run_id, text: "done" });
  });

  it("aborts a silent child frame_idle after frameIdleMs and records the halt reason (testing I-3)", async () => {
    const { session } = streaming();
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(10); // last frame at +5
      await vi.advanceTimersByTimeAsync(900);
      expect(outcome.failed).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
    } finally { vi.useRealTimers(); }
    await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "frame_idle" });
    expect(store.getLedgerEvents(run_id).find((e) => e.event_type === "loop_halted")?.payload).toEqual({ reason: "frame_idle", steps: 1 });
  });

  it("pauses the frame watchdog while Paco is asked, and re-arms it in full on release (testing I-3)", async () => {
    const { session } = streaming();
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(10);
      sup.setAwaitingApprovalForTest(true); await vi.advanceTimersByTimeAsync(5_000); // silent, but waiting on Paco
      expect(outcome.failed).toEqual([]);
      sup.setAwaitingApprovalForTest(false); await vi.advanceTimersByTimeAsync(900);
      expect(outcome.failed).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
    } finally { vi.useRealTimers(); }
    await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "frame_idle" });
  });

  it("a refused renewal of the PARENT's lease aborts the live turn lease_lost; it never completes (spec §7.1, testing I-4)", async () => {
    const { h, session } = streaming();
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(10);
      const beat = vi.spyOn(store, "heartbeat").mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(30_010); // one renewal, refused: another owner holds the run now
      beat.mockRestore();
      session.assistant("late"); h.emit?.({ type: "agent_end" }); // a child that answers anyway must not complete it
    } finally { vi.useRealTimers(); }
    await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "lease_lost" });
    expect(outcome.done).toEqual([]);
  });

  it("frames from a replaced child are ignored: child 1's late agent_end never ends turn 2 on child 2 (testing I-5)", async () => {
    let emit1: Emit = () => undefined; let prompted2 = false; let end2: () => void = () => undefined;
    const c1: Fake = fakeSession({ onPrompt: (_t, e) => { emit1 = e; e({ type: "turn_start" }); c1.assistant("one"); e({ type: "agent_end" }); } });
    const c2: Fake = fakeSession({ onPrompt: (_t, e) => { prompted2 = true; e({ type: "turn_start" }); end2 = () => { c2.assistant("two"); e({ type: "agent_end" }); }; } });
    const children = [c1, c2];
    const { store, sup, outcome } = harness(c1);
    (sup as never as Mutable).d.sessionFactory = (o) => (children.shift() as Fake).bind(o);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    store.addLesson({ scope: "ask", text: "new lesson", source: "user_feedback" }); // child 1 is replaced
    const b = createQueuedTurnRun(store);
    sup.submit(req(b)); await vi.waitFor(() => { expect(prompted2).toBe(true); }, { timeout: 10_000 });
    emit1({ type: "turn_start" }); c1.assistant("stale"); emit1({ type: "agent_end" });
    await new Promise((r) => setImmediate(r));
    expect(sup.state()).toBe("RUNNING");
    expect(outcome.done).toHaveLength(1);
    end2(); await sup.whenIdle();
    expect(outcome.done[1]).toMatchObject({ run_id: b, text: "two" });
  });
});

describe("PlannerSupervisor — frames after a turn's agent_end are ignored (round 2 N6)", () => {
  it("a late error frame after a successful agent_end never fails the completed turn", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" }); session.assistant("the answer"); e({ type: "agent_end" });
      e({ type: "error", error: "extension hiccup" }); // same tick: before settle() runs
    } });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.failed).toEqual([]);
    expect(outcome.done[0]).toMatchObject({ run_id, text: "the answer" });
  });

  it("a stray agent_end from the failed leg never ends the retry leg before its prompt (no success with the old text)", async () => {
    let calls = 0;
    const session = fakeSession({
      onPrompt: (_t, e) => {
        e({ type: "turn_start" });
        if (calls++ === 0) { session.assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" }); e({ type: "agent_end" }); return; }
        session.assistant("from the next leg"); e({ type: "agent_end" });
      },
      setModel: async () => { session.emitForTest({ type: "agent_end" }); session.emitForTest({ type: "error", error: "late" }); }
    });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ run_id, text: "from the next leg" });
  });
});

// Live gate 2026-10-01, item 6: omp's open_session restores the session's last model over --model, so a fallback
// leg or a HOUGE_OMP_PLANNER change never reached a resumed chat, and the D10 family check used the configured model.
describe("PlannerSupervisor — the planner runs the configured model after a session resume", () => {
  it("a fresh child is pinned to the leg it spawned on with set_model before the first prompt", async () => {
    const log: string[] = [];
    const session = fakeSession({ log, logSetModel: true, resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_PLANNER: "kimi-code/k3" });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(log.filter((l) => !l.startsWith("manifest"))).toEqual(["start:1", "setModel:kimi-code/k3", "prompt:1"]);
    const row = store.getLedgerEvents(run_id).find((e) => e.event_type === "llm_attempt")?.payload;
    expect(row).toMatchObject({ provider: "kimi-code", model: "k3", family: "kimi" });
    expect(sup.plannerFamily()).toBe("kimi");
    expect(outcome.incidents).toEqual([]);
  });

  it("a spawn-time fallback pins the fallback leg, never the refused top string", async () => {
    const session = fakeSession({ badModels: ["anthropic/claude-opus-5-5"], resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup } = harness(session);
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["google-antigravity/claude-opus-4-6"]);
    expect(store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").at(-1)?.payload).toMatchObject({ model: "claude-opus-4-6" });
  });

  it("a failed pin follows the reset-failure path, and the family is the ACTUAL model's from message_end (D10)", async () => {
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5", setModel: async () => { throw new Error("set_model refused"); } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_PLANNER: "kimi-code/k3" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(outcome.done).toHaveLength(1); // answered on the model it really has
    expect(incidentKinds(outcome)).toContain("planner_model_reset_failed");
    expect(sup.plannerFamily()).toBe("claude"); // not the configured kimi: the reader's family_collapse compares this
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.models).toEqual(["kimi-code/k3", "kimi-code/k3"]); // the next turn tries the pin again
  });
});

// houge_status (2026-10-02): the tool reports the omp version the spawn check read (never a new spawn)
// and the model that really answered, both from the supervisor.
describe("PlannerSupervisor — what houge_status reads from it", () => {
  it("knows nothing before a child started, then the checked omp version and the model that answered", async () => {
    const session = fakeSession({ resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup } = harness(session, { HOUGE_OMP_PLANNER: "kimi-code/k3" });
    expect(sup.ompVersion()).toBeNull();
    expect(sup.answeredModel()).toBeUndefined();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(sup.ompVersion()).toBe("18.4.4");
    expect(sup.answeredModel()).toEqual({ provider: "kimi-code", model: "k3" });
  });
});

// houge_status item 2: the restart note is code-owned text for the planner only. Stored as Paco's turn it would trip
// lesson_write's code-owned check on later turns (the 7099a02 photo-header class), so the chat turn never holds it.
describe("PlannerSupervisor — the restart note reaches the prompt, never the stored user turn", () => {
  it("the first prompt after a boot carries the note, the second does not, and no user turn contains it", async () => {
    const session = fakeSession();
    const { store, sup } = harness(session);
    store.recordDaemonBoot({
      boot_id: "boot_1", started_at: new Date().toISOString(), pid: process.pid, reason: "kickstart", reload_sha: null, reload_subject: null,
      reload_branch: null, reload_merged_at: null, head_sha: "4431d13aaaa", head_subject: "s", head_committed_at: null, dist_built_at: null
    });
    sup.submit(req(createQueuedTurnRun(store), "first")); await sup.whenIdle();
    sup.submit(req(createQueuedTurnRun(store), "second")); await sup.whenIdle();
    expect(session.prompts[0]).toMatch(/^\[runtime\] Houge restarted .* \(kickstart\); now running 4431d13\.\nfirst$/);
    expect(session.prompts[1]).toBe("second");
    const userTurns = store.getRecentChatTurns("42", 10).filter((t) => t.role === "user").map((t) => t.text);
    expect(userTurns).toEqual(["first", "second"]);
  });

  it("a turn that ends before dispatch leaves the note for the next turn", async () => {
    // Round 2: the note used to be claimed while the prompt was built, so a turn killed before its prompt went out lost it.
    const session = fakeSession({ setModel: (n) => (n === 1 ? never() : Promise.resolve()) });
    const { store, sup, outcome } = harness(session);
    store.recordDaemonBoot({
      boot_id: "boot_1", started_at: new Date().toISOString(), pid: process.pid, reason: "kickstart", reload_sha: null, reload_subject: null,
      reload_branch: null, reload_merged_at: null, head_sha: "4431d13aaaa", head_subject: "s", head_committed_at: null, dist_built_at: null
    });
    const killed = createQueuedTurnRun(store);
    sup.submit(req(killed, "first")); await until(() => session.models.length === 1); // hung in the pin, before dispatch
    await sup.abortAll("killed");
    expect(failedOf(outcome, killed)).toMatchObject({ error_type: "killed" });
    expect(session.prompts).toEqual([]);
    sup.submit(req(createQueuedTurnRun(store), "second")); await sup.whenIdle();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toMatch(/^\[runtime\] Houge restarted .* \(kickstart\); now running 4431d13\.\nsecond$/);
  });
});

describe("PlannerSupervisor — a message starting with [runtime] reaches the child intact (round 3, N1)", () => {
  const message = "[runtime] Houge restarted 07:34 (kickstart) — why did this happen?\nalso check logs";
  it("with no boot record, and after the note was delivered, the message is never cut", async () => {
    const session = fakeSession();
    const { store, sup } = harness(session);
    sup.submit(req(createQueuedTurnRun(store), message)); await sup.whenIdle();
    expect(session.prompts[0]).toBe(message);
    store.recordDaemonBoot({
      boot_id: "boot_1", started_at: new Date().toISOString(), pid: process.pid, reason: "kickstart", reload_sha: null, reload_subject: null,
      reload_branch: null, reload_merged_at: null, head_sha: "4431d13aaaa", head_subject: "s", head_committed_at: null, dist_built_at: null
    });
    sup.submit(req(createQueuedTurnRun(store), message)); await sup.whenIdle();
    expect(session.prompts[1]).toMatch(/^\[runtime\] Houge restarted .* \(kickstart\); now running 4431d13\.\n\[runtime\] Houge restarted 07:34 \(kickstart\) — why/);
    expect(session.prompts[1]!.endsWith(`\n${message}`)).toBe(true);
    sup.submit(req(createQueuedTurnRun(store), message)); await sup.whenIdle();
    expect(session.prompts[2]).toBe(message);
  });
});

describe("PlannerSupervisor — a lesson change starts a fresh omp session (memory A1 §6)", () => {
  const swap = (sup: PlannerSupervisor, session: Fake, onStart: () => void) => {
    (sup as never as { d: { sessionFactory: (o: PlannerSessionOptions) => unknown } }).d.sessionFactory = (o) => { onStart(); return session.bind(o); };
  };

  it("first spawn with no stored fingerprint: new_session, the ledger row and the persisted fingerprint; the seed is claimed at dispatch", async () => {
    const { store, sup, session } = harness(fakeSession(), {}, {}, { sessionState: "none" });
    store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.resets).toBe(1);
    expect(store.getPlannerSessionState("42")).toMatchObject({ lesson_fingerprint: lessonSetFingerprint(store), seed_pending: 0 });
    expect(store.getLedgerEvents().filter((e) => e.event_type === "planner_session_reset").map((e) => e.payload))
      .toEqual([{ reason: "lesson_change", chat_id: "42" }]);
  });

  it("a rating or a date flip respawns (or not) without new_session; a lesson edit respawns with it", async () => {
    let starts = 0;
    const session = fakeSession();
    const { store, sup } = harness(session, {}, {}, { sessionState: "none" });
    swap(sup, session, () => { starts++; });
    const a = store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    store.applyRatingToLessons([a], 3, new Date().toISOString());
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect([starts, session.resets]).toEqual([1, 1]); // a rating does not reorder the prompt nor change the set
    (sup as never as { d: { turnContext: { now: () => Date } } }).d.turnContext.now = () => new Date(Date.now() + 86_400_000);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect([starts, session.resets]).toEqual([2, 1]); // the date line respawned the child; the set is the same: resume
    store.addLesson({ scope: "research", text: "cite sources", source: "user_feedback" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect([starts, session.resets]).toEqual([3, 2]);
  });

  it("a change made while the daemon was down is caught at the first spawn; a matching stored fingerprint resumes", async () => {
    const down = harness();
    down.store.recordPlannerSessionReset("42", "fingerprint-before-the-edit", new Date().toISOString());
    down.store.promotePlannerSession("42");
    down.sup.submit(req(createQueuedTurnRun(down.store))); await down.sup.whenIdle();
    expect(down.session.resets).toBe(1);
    const same = harness();
    same.store.recordPlannerSessionReset("42", lessonSetFingerprint(same.store), new Date().toISOString());
    same.store.promotePlannerSession("42");
    same.sup.submit(req(createQueuedTurnRun(same.store))); await same.sup.whenIdle();
    expect(same.session.resets).toBe(0);
  });

  it("a failed new_session (1st of 3) fails the spawn with an incident and never prompts the resumed session", async () => {
    const { store, sup, session, outcome } = harness(fakeSession({ newSession: async () => { throw new PlannerRpcError("command_failed:new_session"); } }), {}, {}, { sessionState: "none" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(outcome.failed).toEqual([expect.objectContaining({ error_type: "planner_exit", error_ref: "session_reset_failed: command_failed:new_session" })]);
    expect(outcome.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ k: "planner_session_reset_failed" })]));
    expect(session.prompts).toEqual([]);
    expect(store.getPlannerSessionState("42")).toBeUndefined();
  });

  const stalledReset = () => {
    let settle: { ok: () => void; fail: (e: unknown) => void } = { ok: () => undefined, fail: () => undefined };
    const newSession = () => new Promise<{ cancelled: boolean }>((resolve, reject) => { settle = { ok: () => resolve({ cancelled: false }), fail: reject }; });
    return { newSession, settle: () => settle };
  };
  const untilReset = async (session: Fake) => { for (let i = 0; i < 200 && session.resets === 0; i++) await new Promise((r) => setTimeout(r, 10)); };

  it("a /kill during new_session is a superseded start: no reset incident, no startOk, no stored fingerprint", async () => {
    const stall = stalledReset();
    const session = fakeSession({ newSession: stall.newSession });
    const { store, sup, outcome } = harness(session, {}, {}, { sessionState: "none" });
    let startOk = 0; outcome.startOk = () => { startOk++; };
    sup.submit(req(createQueuedTurnRun(store)));
    await untilReset(session);
    await sup.abortAll("killed");
    stall.settle().fail(new PlannerRpcError("not_running")); // the killed child's pending new_session rejects
    await sup.whenIdle(); await new Promise((r) => setTimeout(r, 30));
    expect(outcome.incidents).toEqual([]);
    expect(startOk).toBe(0);
    expect(store.getPlannerSessionState("42")).toBeUndefined();
  });

  it("a /kill that lands just before new_session answers: the reset is recorded (omp made the transcript) but the start stays superseded", async () => {
    const stall = stalledReset();
    const session = fakeSession({ newSession: stall.newSession });
    const { store, sup, outcome } = harness(session, {}, {}, { sessionState: "none" });
    let startOk = 0; outcome.startOk = () => { startOk++; };
    sup.submit(req(createQueuedTurnRun(store)));
    await untilReset(session);
    await sup.abortAll("killed");
    stall.settle().ok();
    await sup.whenIdle(); await new Promise((r) => setTimeout(r, 30));
    expect(startOk).toBe(0);
    expect(sup.state()).toBe("STOPPED");
    expect(store.getPlannerSessionState("42")).toMatchObject({ seed_pending: 1 });
  });

  it("a cancelled new_session is a failure too", async () => {
    const { store, sup, outcome } = harness(fakeSession({ newSession: async () => ({ cancelled: true }) }), {}, {}, { sessionState: "none" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(outcome.failed).toEqual([expect.objectContaining({ error_ref: "session_reset_failed: new_session_cancelled" })]);
  });

  it("HOUGE_LESSON_SESSION_RESET=off respawns and resumes as before", async () => {
    const { store, sup, session } = harness(fakeSession(), {}, { env: { HOUGE_LESSON_SESSION_RESET: "off" } }, { sessionState: "none" });
    store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.resets).toBe(0);
  });

  it("a respawn between a reset and the first dispatch resets again (omp resumes the OLD transcript until the new one holds a turn)", async () => {
    const stall = stalledReset();
    let calls = 0;
    const session = fakeSession({ newSession: () => (++calls === 1 ? stall.newSession() : Promise.resolve({ cancelled: false })) });
    const { store, sup } = harness(session, {}, {}, { sessionState: "none" });
    store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    sup.submit(req(createQueuedTurnRun(store)));
    await untilReset(session);
    await sup.abortAll("killed"); // the reset lands, then the child dies before any prompt reached it
    stall.settle().ok();
    await sup.whenIdle(); await new Promise((r) => setTimeout(r, 30));
    expect(store.getPlannerSessionState("42")!.lesson_fingerprint).toBe(""); // nothing committed: no turn reached omp
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.resets).toBe(2);
    expect(session.prompts).toHaveLength(1);
    expect(store.getPlannerSessionState("42")).toMatchObject({ lesson_fingerprint: lessonSetFingerprint(store), pending_fingerprint: null });
    (sup as never as { d: { turnContext: { now: () => Date } } }).d.turnContext.now = () => new Date(Date.now() + 86_400_000);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.resets).toBe(2); // dispatched, then respawned on the date flip: the committed set matches, resume
  });

  it("the reset compares the lesson set the spawned prompt RENDERED, not one read after the spawn awaits", async () => {
    const session = fakeSession();
    const { store, sup } = harness(session, {}, {}, { sessionState: "none" });
    store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    const rendered = lessonSetFingerprint(store);
    let first = true;
    swap(sup, session, () => { if (first) store.addLesson({ scope: "ask", text: "written mid-spawn", source: "user_feedback" }); first = false; });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(store.getPlannerSessionState("42")!.lesson_fingerprint).toBe(rendered);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.resets).toBe(2); // the mid-spawn lesson is not in the transcript's prompt: the next spawn resets for it
  });

  it("3 consecutive reset failures serve the resumed session, keep the incident open and ledger the degradation; a later success clears it", async () => {
    let fail = true;
    const session = fakeSession({ newSession: async () => { if (fail) throw new PlannerRpcError("command_failed:new_session"); return { cancelled: false }; } });
    const { store, sup, outcome } = harness(session, {}, {}, { sessionState: "none" });
    store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
    for (let i = 0; i < 3; i++) { sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); }
    expect(outcome.failed).toHaveLength(2); // failures 1-2 fail the turn
    expect(outcome.done).toHaveLength(1); // failure 3 answers on the resumed transcript
    expect(session.prompts).toHaveLength(1);
    expect(outcome.incidents.filter((i) => (i as { k: string }).k === "planner_session_reset_failed")).toHaveLength(3);
    expect(outcome.resetOks).toBe(0);
    expect(store.getLedgerEvents().filter((e) => e.event_type === "planner_session_reset_degraded").map((e) => e.payload))
      .toEqual([{ chat_id: "42", failures: 3 }]);
    expect(store.getPlannerSessionState("42")).toBeUndefined(); // nothing committed: the next spawn tries the reset again
    fail = false;
    (sup as never as { d: { turnContext: { now: () => Date } } }).d.turnContext.now = () => new Date(Date.now() + 86_400_000);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(outcome.resetOks).toBe(1);
    expect(store.getPlannerSessionState("42")!.lesson_fingerprint).toBe(lessonSetFingerprint(store));
  });

  describe("a pending reset is committed only by a dispatch to the child that made it (follow-up)", () => {
    const flip = (sup: PlannerSupervisor, days: number) => {
      (sup as never as { d: { turnContext: { now: () => Date } } }).d.turnContext.now = () => new Date(Date.now() + days * 86_400_000);
    };

    it("reset OK → respawn → 3 failures → degraded dispatch on the OLD transcript: nothing committed, next spawn resets again, incident open", async () => {
      const stall = stalledReset();
      let calls = 0;
      const session = fakeSession({ newSession: () => (++calls === 1 ? stall.newSession() : Promise.reject(new PlannerRpcError("command_failed:new_session"))) });
      const { store, sup, outcome } = harness(session, {}, {}, { sessionState: "none" });
      store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
      sup.submit(req(createQueuedTurnRun(store)));
      await untilReset(session);
      await sup.abortAll("killed"); // the reset landed (pending), the child died before any prompt: its transcript is empty
      stall.settle().ok();
      await sup.whenIdle(); await new Promise((r) => setTimeout(r, 30));
      for (let i = 0; i < 3; i++) { sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); }
      expect(session.prompts).toHaveLength(1); // the 3rd failure degraded: omp resumed the OLD transcript and served it
      expect(store.getPlannerSessionState("42")).toMatchObject({ lesson_fingerprint: "", pending_fingerprint: lessonSetFingerprint(store) });
      flip(sup, 1);
      sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
      expect(session.resets).toBe(5); // new_session attempted again
      expect(outcome.resetOks).toBe(0); // planner_session_reset_failed never cleared
      expect(store.getPlannerSessionState("42")!.lesson_fingerprint).toBe("");
    });

    it("HOUGE_LESSON_SESSION_RESET off with a reset pending: the dispatch does not commit it", async () => {
      const { store, sup } = harness(fakeSession(), {}, { env: { HOUGE_LESSON_SESSION_RESET: "off" } }, { sessionState: "none" });
      store.recordPlannerSessionReset("42", "fp-pending", new Date().toISOString());
      sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
      expect(store.getPlannerSessionState("42")).toMatchObject({ lesson_fingerprint: "", pending_fingerprint: "fp-pending" });
    });

    it("a prompt RPC that fails commits nothing: the new transcript may still be empty", async () => {
      const { store, sup, outcome } = harness(fakeSession({ promptError: "command_failed:prompt" }), {}, {}, { sessionState: "none" });
      store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" });
      sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
      expect(outcome.failed).toHaveLength(1);
      expect(store.getPlannerSessionState("42")).toMatchObject({ lesson_fingerprint: "", pending_fingerprint: lessonSetFingerprint(store) });
    });
  });
});
