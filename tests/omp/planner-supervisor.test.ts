import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { lessonSetFingerprint } from "../../src/run/lesson-render.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { PlannerSupervisor, RETRY_NOTE, isModelRefusal, parseAttachments, settlesTurn, writeHougeConfigFile, type PlannerSessionLike, type SupervisorDeps, type SupervisorState, type TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { PlannerRpcError, type ExitInfo, type PlannerSessionOptions } from "../../src/omp/planner-session.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { BridgeServer } from "../../src/omp/bridge-server.js";
import { chatWorkspace } from "../../src/omp/workspace.js";
import { formatModelString, parseModelString, type ModelString } from "../../src/omp/model-string.js";
import { selectorKey } from "../../src/omp/model-roles.js";
import type { Effort, TurnRole } from "../../src/jev/tree-policy.js";
import { openManifestClient } from "../helpers/bridge-manifest.js";
import { drainOutbox } from "../helpers/omp-worker.js";
import { createQueuedTurnRun } from "../helpers/runs.js";
import { maxLoopGap, slowVersionBin } from "../helpers/event-loop.js";
import { setSharedOmpVersionCacheForTest } from "../../src/omp/omp-version-cache.js";

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
  /** Every set_model with its effort (`provider/model[:effort]`): what set_thinking_level was asked for. */
  pins: string[];
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
    prompts: [], steers: [], models: [], pins: [], options: [], resets: 0,
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
    setModel: async (m: ModelString) => {
      s.models.push(`${m.provider}/${m.model}`); s.pins.push(formatModelString(m)); if (script.logSetModel) script.log?.push(`setModel:${m.provider}/${m.model}`);
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
afterEach(async () => { setSharedOmpVersionCacheForTest(null); for (const c of cleanups.splice(0)) await c(); });

type Outcome = TurnOutcomeSink & { done: unknown[]; failed: unknown[]; incidents: unknown[]; resetOks: number; routeEnds: unknown[] };
function sink(store: RunStore): Outcome {
  const outcome: Outcome = {
    done: [], failed: [], incidents: [], resetOks: 0, routeEnds: [],
    sessionResetOk: () => { outcome.resetOks++; },
    routeEnd: (i) => { outcome.routeEnds.push(i); },
    complete: (i) => { outcome.done.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "completed", report_ref: "r", duration_ms: i.duration_ms, tool_calls: i.tool_calls }); },
    fail: (i) => { outcome.failed.push(i); store.finishRun({ run_id: i.run_id, expected_worker_id: i.worker_id, next: "failed", error_type: i.error_type, error_ref: i.error_ref }); },
    incident: (k, d) => { outcome.incidents.push({ k, d }); }
  };
  return outcome;
}

/** The role lists the supervisor tests run on: Default is today's planner chain (the pre-stage-A seat). */
const TEST_ROLES: Record<TurnRole, string[]> = {
  default: ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"],
  fast: ["anthropic/claude-sonnet-5-5:low", "google-antigravity/gemini-3.8-flash:low"],
  thinking: ["anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-4-6:high"]
};
type Roles = SupervisorDeps["roles"] & { calls: Array<{ role: string; effort: string | null; refused: string[] }>; refreshes: number };
/** A resolver stand-in: the role's list minus the refused set; a routed effort replaces the list's (resolved mode, no clamp). */
function fakeRoles(over: Partial<Record<TurnRole, string[]>> = {}): Roles {
  const lists: Record<string, string[]> = { ...TEST_ROLES, ...over };
  const roles: Roles = {
    calls: [], refreshes: 0,
    requestRefresh: () => { roles.refreshes++; },
    candidates: (role, o = {}) => {
      roles.calls.push({ role, effort: o.effort ?? null, refused: [...(o.refused ?? [])] });
      return (lists[role] ?? []).map(parseModelString)
        .filter((m) => !(o.refused?.has(selectorKey(m)) ?? false))
        .map((m) => (o.effort ? { ...m, effort: o.effort } : m));
    }
  };
  return roles;
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
    skipPreflightForTest: true, manifestWaitMs: 5_000, roles: fakeRoles(), ...extra
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
    expect(session.models).toHaveLength(3); // an unrouted turn never steps up past Default (today's chain semantics)
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

  it("refuses to start when omp cannot report a version, failing the run with an incident instead of hanging", async () => {
    const { store, sup, outcome } = harness();
    (sup as never as { d: { versionCheck: () => unknown } }).d.versionCheck = () => ({ ok: false, kind: "no_version" as const, version: null, reason: "omp --version printed no version" });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "planner_exit" });
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "omp_unavailable" }));
  });

  it("a passing version check tells the outcome sink so an open omp incident can clear (fix round 2)", async () => {
    const { store, sup, outcome } = harness();
    let oks = 0;
    (outcome as unknown as { versionOk: () => void }).versionOk = () => { oks += 1; };
    (sup as never as { d: { versionCheck: () => unknown } }).d.versionCheck = () => ({ ok: false, kind: "not_runnable" as const, version: null, reason: "x" });
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

  // The planner preflight reads the shared cache, so a spawn after boot costs no exec.
  it("with no injected check the preflight asks the shared cache and refuses on its failure", async () => {
    const { store, sup, outcome } = harness();
    let asked = 0;
    const cfg = (sup as never as { d: { cfg: Parameters<typeof setSharedOmpVersionCacheForTest>[0] } }).d.cfg;
    setSharedOmpVersionCacheForTest(cfg, {
      current: async () => { asked += 1; return { ok: false, kind: "not_runnable", version: null, reason: "x" }; },
      lastVersion: () => null, setNewVersionListener: () => {}
    });
    delete (sup as never as { d: { versionCheck?: unknown } }).d.versionCheck;
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(asked).toBe(1);
    expect(outcome.incidents.map((i) => (i as { k: string }).k)).toEqual(["omp_unavailable"]);
  });

  // Stage A (Jev tree): triage's Jev call is in flight while the child starts. The default check once ran omp --version
  // synchronously (0.7–0.8 s live), freezing the loop so Jev's 1.5 s budget expired: 5 of 9 gate calls timed out silently.
  it("the default version check at spawn leaves the event loop free while omp answers", async () => {
    const { store, sup, outcome } = harness(fakeSession(), { HOUGE_OMP_BIN: slowVersionBin(800) });
    delete (sup as never as { d: { versionCheck?: unknown } }).d.versionCheck; // the production default, on the slow fake
    const { gap } = await maxLoopGap(async () => { sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); });
    expect(outcome.incidents.map((i) => (i as { k: string }).k)).not.toContain("omp_unavailable");
    expect(sup.ompVersion()).toBe("18.7.0"); // the check really ran on the slow binary, not a stub
    expect(gap).toBeLessThan(400);
  });

  // The awaited check opens a window before the spawn: a second start arriving in it must join the first, never spawn twice.
  it("two starts during a pending version check spawn one child", async () => {
    const session = fakeSession();
    const slow = () => new Promise<{ ok: true; version: string }>((r) => setTimeout(() => r({ ok: true, version: "18.7.0" }), 30));
    const { sup } = harness(session, {}, { versionCheck: slow });
    const ensure = (sup as never as { ensureSession: (fresh: boolean) => Promise<unknown> }).ensureSession.bind(sup);
    expect(await Promise.all([ensure(true), ensure(true)])).toEqual([null, null]);
    expect(session.options).toHaveLength(1);
  });

  // A start is cancelled by generation: /kill (abortAll) or shutdown during the awaited version check must not let the
  // child start afterwards (a child after /kill or SIGTERM, with no idle-exit timer, would outlive the stop).
  for (const [label, stop] of [["abortAll (/kill)", (sup: PlannerSupervisor) => sup.abortAll("killed")], ["shutdown", (sup: PlannerSupervisor) => sup.shutdown()]] as const) {
    it(`a stop during the pending version check (${label}) spawns no child and the start resolves superseded`, async () => {
      const session = fakeSession();
      let answer: (v: { ok: true; version: string }) => void = () => undefined;
      const pending = () => new Promise<{ ok: true; version: string }>((r) => { answer = r; });
      const { sup } = harness(session, {}, { versionCheck: pending });
      const start = (sup as never as { ensureSession: (fresh: boolean) => Promise<unknown> }).ensureSession.call(sup, true);
      await new Promise((r) => setImmediate(r)); // the check is now pending
      await stop(sup);
      answer({ ok: true, version: "18.7.0" });
      expect(await start).toBe("start_failed: superseded");
      expect(session.options).toHaveLength(0);
    });
  }

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

  it("a spawn-refused Default head is never respawned or pinned by a later turn on the same child; a restart clears it (spec §4-5)", async () => {
    // the removed respawn rule cost a cold start per turn; set_model moves the live child, and a selector omp refused
    // stays refused for the child's life (a model can stay catalogued while refusing)
    const bad = [TOP];
    const session = fakeSession({ badModels: bad });
    const { store, sup, outcome } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(spawnedModels(session)).toEqual([TOP, SECOND]);
    expect(session.models).toEqual([SECOND]); // the second turn kept the pinned SECOND: no respawn, no pin of TOP
    bad.length = 0;
    store.addLesson({ scope: "ask", text: "new lesson", source: "user_feedback" }); // the prompt changed: a fresh child
    const third = createQueuedTurnRun(store);
    sup.submit(req(third)); await sup.whenIdle();
    expect(spawnedModels(session)).toEqual([TOP, SECOND, TOP]);
    expect(session.models).toEqual([SECOND, TOP]);
    expect(attempts(store, third).map((r) => r.error_kind)).toEqual([undefined]);
    expect(outcome.done).toHaveLength(3);
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
    const { store, sup, outcome } = harness(session, {}, { roles: fakeRoles({ default: ["anthropic/claude-opus-5-5:medium"] }) }); const run_id = createQueuedTurnRun(store);
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
  it("a fresh child is pinned to the turn's first candidate with set_model before the first prompt", async () => {
    const log: string[] = [];
    const session = fakeSession({ log, logSetModel: true, resumeModel: "anthropic/claude-opus-5-5" });
    const { store, sup, outcome } = harness(session, {}, { roles: fakeRoles({ default: ["kimi-code/k3"] }) });
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
    const { store, sup, outcome } = harness(session, {}, { roles: fakeRoles({ default: ["kimi-code/k3"] }) });
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
    const { store, sup } = harness(session, {}, { roles: fakeRoles({ default: ["kimi-code/k3"] }) });
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

type Done = { run_id: string; text: string; tool_calls: number; buttons?: unknown[] };
const dones = (o: { done: unknown[] }) => o.done as Done[];

describe("ADR 0029 lane 1 slots", () => {
  it("slot A: a bare ack during AWAITING_APPROVAL is nudged, not steered, not queued, approves nothing", async () => {
    const held = heldSession();
    const { sup, store, outcome } = harness(held.session);
    const r1 = createQueuedTurnRun(store, "push it");
    sup.submit(req(r1, "push it")); await held.live(1);
    sup.setAwaitingApprovalForTest(true);
    const r2 = createQueuedTurnRun(store, "好");
    sup.submit(req(r2, "好"));
    await until(() => dones(outcome).some((d) => d.run_id === r2));
    expect(held.session.steers).toHaveLength(0);
    expect(dones(outcome).find((d) => d.run_id === r2)?.text).toContain("waiting for your tap");
    expect(store.getLedgerEvents().some((e) => e.event_type === "ack_nudged" && e.payload.approval_run_id === r1)).toBe(true);
    expect(store.getRunState(r2)).toBe("completed");
    sup.setAwaitingApprovalForTest(false); held.end(); await untilState(sup, "IDLE");
  });
  // A trust card outlives its bounded pause (the TTL resumes the timers, state back to RUNNING) yet still waits on Paco:
  // a bare ack then is still consent to nothing — it must be nudged, never steered into the planner as if it approved.
  it("slot A: a bare ack while a trust card still waits past its bounded pause is nudged, not steered", async () => {
    const held = heldSession();
    const { sup, store, outcome } = harness(held.session);
    const r1 = createQueuedTurnRun(store, "push it");
    sup.submit(req(r1, "push it")); await held.live(1);
    sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: 30 });
    await untilState(sup, "RUNNING"); // the pause ran out; the card is still open
    const r2 = createQueuedTurnRun(store, "好");
    sup.submit(req(r2, "好"));
    await until(() => dones(outcome).some((d) => d.run_id === r2));
    expect(held.session.steers).toHaveLength(0);
    expect(store.getLedgerEvents().some((e) => e.event_type === "ack_nudged" && e.payload.approval_run_id === r1)).toBe(true);
    sup.setAwaitingApprovalForTest(false); held.end(); await untilState(sup, "IDLE");
  });
  it("slot A does not fire for a non-ack: it is steered as today", async () => {
    const held = heldSession();
    const { sup, store } = harness(held.session);
    sup.submit(req(createQueuedTurnRun(store, "push it"), "push it")); await held.live(1);
    sup.setAwaitingApprovalForTest(true);
    sup.submit(req(createQueuedTurnRun(store, "好，再查一次"), "好，再查一次"));
    await until(() => held.session.steers.length === 1);
    sup.setAwaitingApprovalForTest(false); held.end(); await untilState(sup, "IDLE");
  });
  it("slot B lane_reply: completes with tool_calls 0 and buttons, never prompts the child, leaves it idle", async () => {
    const session = fakeSession();
    const buttons = [{ text: "↩️ Undo", data: "memlane:undo:lc_x" }];
    const { sup, store, outcome } = harness(session, {}, { triage: async () => ({ kind: "lane_reply", text: "📒 Saved lesson #51", buttons }) });
    const r = createQueuedTurnRun(store, "以后回复短一点");
    sup.submit(req(r, "以后回复短一点"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts).toHaveLength(0);
    expect(dones(outcome)[0]).toMatchObject({ run_id: r, tool_calls: 0, text: "📒 Saved lesson #51", buttons });
    expect(store.getRecentChatTurns("42", 10).map((t) => t.role)).toEqual(["user", "assistant"]);
    await untilState(sup, "IDLE");
  });
  it("slot B passes the posture reading and the abort signal to the lane", async () => {
    const seen: Array<{ posture: string | null; aborted: boolean }> = [];
    const session = fakeSession();
    const { sup, store, outcome } = harness(session, {}, { posture: () => "killed", triage: async (i) => { seen.push({ posture: i.posture, aborted: i.signal.aborted }); return { kind: "fallthrough" }; } });
    sup.submit(req(createQueuedTurnRun(store, "hi"), "hi"));
    await until(() => outcome.done.length + outcome.failed.length === 1);
    expect(seen).toEqual([{ posture: "killed", aborted: false }]);
  });
  it("slot B inform: the note precedes the message in the prompt and the planner runs", async () => {
    const session = fakeSession();
    const { sup, store, outcome } = harness(session, {}, { triage: async () => ({ kind: "inform", note: "[memory] Lesson #51 (format) was just saved from this message; do not save it again." }) });
    sup.submit(req(createQueuedTurnRun(store, "以后短一点，另外今天天气？"), "以后短一点，另外今天天气？"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts[0]).toMatch(/^\[memory\] Lesson #51[\s\S]*另外今天天气？$/);
  });
  it("slot B: a triage that throws falls through to today's path with a closed-reason incident", async () => {
    const session = fakeSession();
    const { sup, store, outcome } = harness(session, {}, { triage: async () => { throw new Error("boom with a bound value"); } });
    sup.submit(req(createQueuedTurnRun(store, "hi"), "hi"));
    await until(() => outcome.done.length === 1);
    expect(session.prompts).toHaveLength(1); expect(outcome.failed).toHaveLength(0);
    expect((outcome.incidents as Array<{ k: string; d: Record<string, unknown> }>).find((i) => i.k === "triage_threw")?.d.reason).toBe("triage_threw");
  });
  it("slot B lane_reply when the spawn rejects or hangs: the lane still completes; the spawn failure never fails the turn", async () => {
    const rejecting = fakeSession({ start: async () => { throw new PlannerRpcError("exited:1"); } });
    let h = harness(rejecting, {}, { triage: async () => ({ kind: "lane_reply", text: "status: ok", buttons: [] }) });
    let r = createQueuedTurnRun(h.store, "did you restart?");
    h.sup.submit(req(r, "did you restart?"));
    await until(() => h.outcome.done.length + h.outcome.failed.length === 1);
    expect(dones(h.outcome).map((d) => d.run_id)).toEqual([r]); expect(h.outcome.failed).toHaveLength(0);
    const hanging = fakeSession({ start: () => new Promise(() => undefined) });
    h = harness(hanging, {}, { triage: async () => ({ kind: "lane_reply", text: "status: ok", buttons: [] }) });
    r = createQueuedTurnRun(h.store, "did you restart?");
    h.sup.submit(req(r, "did you restart?"));
    await until(() => h.outcome.done.length === 1); // completes after ABORT_GRACE_MS (5 s) through stopSession; within vitest's 10 s
    expect(h.outcome.failed).toHaveLength(0);
  });
  it.each([
    ["recordChatTurn", (h: ReturnType<typeof harness>) => vi.spyOn(h.store, "recordChatTurn").mockImplementationOnce(() => { throw new Error("disk"); }), false],
    ["stopSession", (h: ReturnType<typeof harness>) => vi.spyOn(h.sup as unknown as { stopSession: () => Promise<void> }, "stopSession").mockRejectedValueOnce(new Error("stop")), true],
    ["settleStart", (h: ReturnType<typeof harness>) => vi.spyOn(h.sup as unknown as { settleStart: () => Promise<void> }, "settleStart").mockRejectedValueOnce(new Error("settle")), true]
  ])("a %s failure before laneEnded reaches settle() as exactly one FAILED outcome (start_failed), never a stranded turn", async (_name, inject, hang) => {
    const session = hang ? fakeSession({ start: () => new Promise(() => undefined) }) : fakeSession();
    const h = harness(session, {}, { triage: async () => ({ kind: "lane_reply", text: "x", buttons: [] }) });
    const spy = inject(h);
    h.sup.submit(req(createQueuedTurnRun(h.store, "hi"), "hi"));
    await until(() => h.outcome.done.length + h.outcome.failed.length === 1);
    expect(h.outcome.done).toHaveLength(0);
    expect((h.outcome.failed[0] as { error_ref: string }).error_ref).toMatch(/^start_failed/);
    expect(spy).toHaveBeenCalled(); // the injection really reached the lane's pre-laneEnded path
    spy.mockRestore();
  });
  it("a warm child that exits after it was ready, while the lane runs, never fails the lane turn (spec §5.1)", async () => {
    const session = fakeSession();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    const { sup, store, outcome } = harness(session, {}, { triage: async () => { started = true; await gate; return { kind: "lane_reply", text: "status: ok", buttons: [] }; } });
    const r = createQueuedTurnRun(store, "did you restart?");
    sup.submit(req(r, "did you restart?"));
    await until(() => started && session.options.length === 1 && sup.state() === "IDLE"); // the warm child is ready
    session.exit(1); // a crash exit of the ready child, mid-triage
    release();
    await until(() => outcome.done.length + outcome.failed.length === 1);
    await sup.whenIdle();
    expect(dones(outcome).map((d) => d.run_id)).toEqual([r]);
    expect(outcome.failed).toHaveLength(0);
  });
  it("the same exit during a planner turn (after promptTop) still fails it as today", async () => {
    const held = heldSession();
    const { sup, store, outcome } = harness(held.session, {}, { triage: async () => ({ kind: "fallthrough" }) });
    const r = createQueuedTurnRun(store, "hi");
    sup.submit(req(r, "hi")); await held.live(1);
    held.session.exit(1);
    await until(() => outcome.failed.length === 1);
    expect(outcome.done).toHaveLength(0);
    expect(outcome.failed[0]).toMatchObject({ run_id: r, error_type: "planner_exit", error_ref: "exit 1" });
  });
  it("a sessionFactory that throws synchronously is caught by the warm promise, not the turn", async () => {
    const { sup, store, outcome } = harness(fakeSession(), {}, { sessionFactory: () => { throw new Error("factory"); }, triage: async () => ({ kind: "lane_reply", text: "x", buttons: [] }) });
    sup.submit(req(createQueuedTurnRun(store, "hi"), "hi"));
    await until(() => outcome.done.length === 1);
    expect(outcome.failed).toHaveLength(0);
  });
});

describe("PlannerSupervisor — the turn-owned chain (Jev tree spec §4-5)", () => {
  const attempts = (store: RunStore, run: string) =>
    store.getLedgerEvents(run).filter((e) => e.event_type === "llm_attempt").map((e) => e.payload as Record<string, unknown>);
  const escalations = (store: RunStore, run: string) =>
    store.getLedgerEvents(run).filter((e) => e.event_type === "routed_escalation").map((e) => e.payload);
  /** The decision point's verdict: the planner on `role` at `effort`, joined to verdict `verdict_id`. */
  const routed = (role: TurnRole, effort: Effort | null = null, verdict_id: string | null = "jv_1"): Partial<SupervisorDeps> =>
    ({ triage: async () => ({ kind: "fallthrough", route: { role, effort, verdict_id } }) });
  /** Every prompt fails with `errors[i]` (as an assistant error) until they run out, then answers "ok". */
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

  it("spawns on the Default role's head before triage and pins the routed role's head before the first prompt", async () => {
    // two axes: the child warms on Default (slot B), the turn's own role is applied with set_model, never by a respawn
    const log: string[] = [];
    const session = fakeSession({ log, logSetModel: true });
    const roles = fakeRoles();
    const { store, sup, outcome } = harness(session, {}, { roles, ...routed("fast", "low") });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.options.map((o) => formatModelString(o.model))).toEqual(["anthropic/claude-opus-5-5:medium"]);
    expect(log.filter((l) => !l.startsWith("manifest"))).toEqual(["start:1", "setModel:anthropic/claude-sonnet-5-5", "prompt:1"]);
    expect(roles.calls.filter((c) => c.role === "fast")).toEqual([{ role: "fast", effort: "low", refused: [] }]);
    expect(outcome.routeEnds).toEqual([{
      run_id, verdict_id: "jv_1", handler_outcome: "planner_done", model: "anthropic/claude-sonnet-5-5", fast_used_tool: false, pin_failed: false
    }]);
  });

  it("the pin carries the routed effort, every row records it, and only the turn's FIRST llm_attempt carries routed_by", async () => {
    // set_model + set_thinking_level are one setModel call (planner-session.ts:92); the jev_verdicts join needs exactly one
    // row, and Default and Thinking share a head, so only the row's effort shows which role answered (plan F15, gate case 3)
    const session = failing(["429 usage limit reached"]);
    const { store, sup } = harness(session, {}, routed("default", "low"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.pins).toEqual(["anthropic/claude-opus-5-5:low", "google-antigravity/claude-opus-4-6:low"]);
    const rows = attempts(store, run_id);
    expect(rows.map((r) => [r.model, r.error_kind, r.routed_by, r.effort]))
      .toEqual([["claude-opus-5-5", "quota", "jv_1", "low"], ["claude-opus-4-6", undefined, undefined, "low"]]);
  });

  it("a routed role with no candidate (the catalog emptied Fast) steps up before the first prompt, ledgered", async () => {
    // plan F7 (b): RoleResolver returns [] for an emptied Fast; the turn must still answer, on Default, never fail
    const session = fakeSession();
    const { store, sup, outcome } = harness(session, {}, { roles: fakeRoles({ fast: [] }), ...routed("fast") });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.pins).toEqual(["anthropic/claude-opus-5-5:medium"]);
    expect(escalations(store, run_id)).toEqual([{ from: "fast", to: "default", kind: "model_missing" }]);
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-opus-5-5" });
  });

  it("every Default candidate refused at spawn: no_planner_leg, each row with its selector's effort, and one catalog refresh asked", async () => {
    // plan F7 (d): the catalog may have moved since the last read; the resolver rate-limits the re-read
    const session = fakeSession({ badModels: ["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6", "kimi-code/k3"] });
    const roles = fakeRoles();
    const { store, sup, outcome } = harness(session, {}, { roles });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "no_planner_leg", error_ref: "model_missing" });
    expect(attempts(store, run_id).map((r) => [r.model, r.effort])).toEqual([["claude-opus-5-5", "medium"], ["claude-opus-4-6", "medium"], ["k3", "low"]]);
    expect(roles.refreshes).toBe(1);
  });

  it("a pin omp refuses (`Model not found`) is one model_missing row and walks on: never pin_failed, no incident, never pinned again", async () => {
    // a Default[0] refused at spawn or pin must not become a per-turn failure; the refused set lasts the child's life
    const session = fakeSession({ setModel: async (n) => { if (n === 1) throw new PlannerRpcError("command_failed:set_model", "Model not found: anthropic/claude-sonnet-5-5"); } });
    const roles = fakeRoles();
    const { store, sup, outcome } = harness(session, {}, { roles, ...routed("fast") });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-sonnet-5-5", "google-antigravity/gemini-3.8-flash"]);
    expect(attempts(store, run_id).map((r) => [r.model, r.error_kind, r.routed_by])).toEqual([
      ["claude-sonnet-5-5", "model_missing", "jv_1"], ["gemini-3.8-flash", undefined, undefined]
    ]);
    expect(outcome.incidents).toEqual([]);
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_done", pin_failed: false });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle(); // same child, same route
    expect(session.models).toHaveLength(2); // already on gemini; the refused sonnet is never tried again
    expect(roles.calls.filter((c) => c.role === "fast").at(-1)?.refused).toEqual(["anthropic/claude-sonnet-5-5"]);
  });

  it("a pin that fails in transport answers on the held model: planner_model_reset_failed, pin_failed, no escalation", async () => {
    const session = fakeSession({ setModel: async () => { throw new PlannerRpcError("timeout:set_model"); } });
    const { store, sup, outcome } = harness(session, {}, routed("fast"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ run_id, text: "answer" });
    expect(incidentKinds(outcome)).toEqual(["planner_model_reset_failed"]);
    expect(outcome.routeEnds[0]).toMatchObject({ model: "anthropic/claude-opus-5-5", pin_failed: true });
    expect(escalations(store, run_id)).toEqual([]);
  });

  it("a spent role steps up at the retry boundary (Fast → Default), ledgered as routed_escalation; RETRY_NOTE continues", async () => {
    const session = failing(["429 quota", "429 quota"]);
    const { store, sup, outcome } = harness(session, {}, routed("fast"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-sonnet-5-5", "google-antigravity/gemini-3.8-flash", "anthropic/claude-opus-5-5"]);
    expect(session.prompts).toEqual(["hi", RETRY_NOTE, RETRY_NOTE]);
    expect(escalations(store, run_id)).toEqual([{ from: "fast", to: "default", kind: "quota" }]);
    expect(outcome.done[0]).toMatchObject({ run_id, text: "ok" });
  });

  it("`other` is retried once on a routed turn while no tool ran; a second `other` is final", async () => {
    // spec §4: a deterministic failure is re-spent once on the next model, never in a loop
    const session = failing(["something odd", "something odd"]);
    const { store, sup, outcome } = harness(session, {}, routed("default"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6"]);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "model_error", error_ref: "other" });
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_failed" });
  });

  it("`other` after a tool ran is final at once: a failure after a side effect is never re-spent on another model", async () => {
    const session: Fake = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" }); e({ type: "tool_execution_start" });
      session.assistant("", { stopReason: "error", errorMessage: "something odd" }); e({ type: "agent_end" });
    } });
    const { store, sup, outcome } = harness(session, {}, routed("fast"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.prompts).toEqual(["hi"]);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "model_error", error_ref: "other" });
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_failed", fast_used_tool: true });
  });

  it("a Fast turn that ran a tool finishes on Fast, marked fast_used_tool; a route without a verdict id writes no routeEnd", async () => {
    // no mid-prompt escalation (spec §5): the calibration signal is the mark, not a second model
    const session: Fake = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" }); e({ type: "tool_execution_start" }); session.assistant("done"); e({ type: "agent_end" });
    } });
    const h = harness(session, {}, routed("fast"));
    h.sup.submit(req(createQueuedTurnRun(h.store))); await h.sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(h.outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_done", fast_used_tool: true });
    const bare = harness(fakeSession(), {}, routed("fast", null, null));
    const run_id = createQueuedTurnRun(bare.store);
    bare.sup.submit(req(run_id)); await bare.sup.whenIdle();
    expect(bare.outcome.routeEnds).toEqual([]);
    expect(attempts(bare.store, run_id)[0]).not.toHaveProperty("routed_by");
  });

  it("a Default → Thinking step-up skips what failed this turn with quota, but re-tries a selector that failed with `other` at the higher effort", async () => {
    // Default and Thinking share provider/model pairs: a quota-failed pair fails at any effort, an `other` one may not
    const session = failing(["something odd", "429 quota", "429 quota"]);
    const { store, sup, outcome } = harness(session, {}, routed("default"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.pins).toEqual([
      "anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low", "anthropic/claude-opus-5-5:high"
    ]);
    expect(escalations(store, run_id)).toEqual([{ from: "default", to: "thinking", kind: "quota" }]);
    expect(outcome.done[0]).toMatchObject({ run_id, text: "ok" });
    expect(outcome.routeEnds[0]).toMatchObject({ handler_outcome: "planner_done", model: "anthropic/claude-opus-5-5" });
  });

  it("quota on every Default candidate: the step-up re-spends none of them and ends no_planner_leg, with one catalog refresh asked", async () => {
    // the real lists share all four pairs: without the per-turn set an outage costs four more failing requests + RETRY_NOTEs
    const session = failing(["429 quota", "429 quota", "429 quota"]);
    const roles = fakeRoles();
    const { store, sup, outcome } = harness(session, {}, { roles, ...routed("default") });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-opus-5-5", "google-antigravity/claude-opus-4-6", "kimi-code/k3"]); // the fresh child's first pin, then the walk
    expect(session.prompts).toEqual(["hi", RETRY_NOTE, RETRY_NOTE]);
    expect(failedOf(outcome, run_id)).toMatchObject({ error_type: "no_planner_leg", error_ref: "quota" });
    expect(incidentKinds(outcome)).toEqual(["planner_no_leg"]);
    expect(roles.refreshes).toBe(1);
  });

  it("a routed turn that never dispatched reports model null, never the previous turn's answering model (spec §6)", async () => {
    // `actual` persists across turns for houge_status; the verdict row must not credit a model with a turn it never ran
    let n = 0;
    const session = fakeSession({ setModel: async () => {
      if (n === 2) throw new PlannerRpcError("command_failed:set_model", "Model not found: anthropic/claude-opus-5-5");
    } });
    const triage = async () => ({ kind: "fallthrough" as const, route: ++n === 1
      ? { role: "default" as const, effort: null, verdict_id: "jv_1" } : { role: "thinking" as const, effort: null, verdict_id: "jv_2" } });
    const { store, sup, outcome } = harness(session, {}, { triage });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    const second = createQueuedTurnRun(store);
    sup.submit(req(second)); await sup.whenIdle();
    expect(failedOf(outcome, second)).toMatchObject({ error_type: "no_planner_leg", error_ref: "model_missing" });
    expect(outcome.routeEnds).toEqual([
      expect.objectContaining({ verdict_id: "jv_1", model: "anthropic/claude-opus-5-5" }),
      expect.objectContaining({ verdict_id: "jv_2", handler_outcome: "planner_failed", model: null })
    ]);
  });

  it("a quote: the user turn records quoted_turn_id and the prompt carries the quoted line just before the message (spec §2.2.1)", async () => {
    const quote = { turn_id: "turn_q", line: "[replying to houge, 3600 s ago: 要不要我查一下？]\n" };
    const session = fakeSession();
    const { store, sup } = harness(session, {}, { triage: async () => ({ kind: "fallthrough", quote }) });
    sup.submit(req(createQueuedTurnRun(store, "好"), "好")); await sup.whenIdle();
    expect(session.prompts).toEqual([`${quote.line}好`]);
    expect(store.getRecentChatTurns("42", 10).find((t) => t.role === "user")?.quoted_turn_id).toBe("turn_q");
    const lane = harness(fakeSession(), {}, { triage: async () => ({ kind: "lane_reply", text: "📒 Saved", buttons: [], quote }) });
    lane.sup.submit(req(createQueuedTurnRun(lane.store, "好"), "好")); await lane.sup.whenIdle();
    expect(lane.store.getRecentChatTurns("42", 10).find((t) => t.role === "user")?.quoted_turn_id).toBe("turn_q");
  });

  // Stage B §12: the walk began with quota; the refusal on the next candidate is only how the chain ran out. Ledgering
  // model_missing would hide a real escalation from ompRouteEnd (which skips model_missing step-ups, F7).
  it("a refused pin that exhausts the chain after a quota failure ledgers the step-up with the walk's cause, not model_missing", async () => {
    let calls = 0;
    const session: Fake = fakeSession({
      setModel: async (n) => { if (n === 2) throw new PlannerRpcError("command_failed:set_model", "Model not found: google-antigravity/gemini-3.8-flash"); },
      onPrompt: (_t, e) => {
        e({ type: "turn_start" });
        if (calls++ === 0) session.assistant("", { stopReason: "error", errorMessage: "429 quota" }); else session.assistant("ok");
        e({ type: "agent_end" });
      }
    });
    const { store, sup, outcome } = harness(session, {}, routed("fast"));
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(session.models).toEqual(["anthropic/claude-sonnet-5-5", "google-antigravity/gemini-3.8-flash", "anthropic/claude-opus-5-5"]);
    expect(escalations(store, run_id)).toEqual([{ from: "fast", to: "default", kind: "quota" }]);
    expect(outcome.done[0]).toMatchObject({ run_id, text: "ok" });
  });

  // Stage B §8: a lane reply that arrives while /kill has already ended the turn must not reach Paco. finishLane waits for the
  // warming child first; without a re-check after that wait it assigns the card to the dead turn, and the failure then carries
  // the lane text as `partial`, which the failure reply shows (omp-turn-wiring.ts:73 on a turn timeout). The run is `killed`
  // either way (abortTurn's done("abort") wins the ended race); what the guard changes is that no lane text leaves with it.
  it("a lane reply after an abort during the warm wait leaves no lane text on the killed run", async () => {
    // the child never becomes ready, so finishLane sits in its bounded warm wait; the kill lands there
    const session = fakeSession({ start: never });
    const { store, sup, outcome } = harness(session, {}, { triage: async () => ({ kind: "lane_reply", text: "quick", buttons: [] }) });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await until(() => session.options.length === 1); // the child is starting; triage has already replied
    await sup.abortAll("killed");
    await sup.whenIdle();
    expect(outcome.done.map((d) => (d as { run_id: string }).run_id)).not.toContain(run_id); // no outcome.complete
    const failed = failedOf(outcome, run_id) as { error_type: string; partial?: string } | undefined;
    expect(failed).toMatchObject({ error_type: "killed" });
    expect(failed).not.toHaveProperty("partial"); // the lane's "quick" never became the turn's text
  });
});

// The probe reuses the planner's own config file and refusal classifier, so the two can never drift apart.
describe("probe seams shared with the planner", () => {
  it("writeHougeConfigFile writes the planner's config at <data>/omp/houge-config.yml, 0600", () => {
    const data = mkdtempSync(join(tmpdir(), "hcfg-"));
    try {
      mkdirSync(join(data, "omp"), { recursive: true });
      const p = writeHougeConfigFile({ data });
      expect(p).toBe(join(data, "omp", "houge-config.yml"));
      expect(readFileSync(p, "utf8")).toContain("checkUpdate: false");
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally { rmSync(data, { recursive: true, force: true }); }
  });

  it("isModelRefusal accepts only a classified set_model refusal", () => {
    expect(isModelRefusal(new PlannerRpcError("command_failed:set_model", "Model not found: x/y"))).toBe(true);
    expect(isModelRefusal(new PlannerRpcError("command_failed:set_model", "rate limit"))).toBe(false);
    expect(isModelRefusal(new PlannerRpcError("command_failed:prompt", "Model not found: x/y"))).toBe(false);
  });
});

describe("PlannerSupervisor — settles only on a terminal agent_end (P7, spec §7.3)", () => {
  // omp continues on its own after a NON-terminal agent_end (late steer, its own retry, compaction, empty-stop). Settling
  // there completed the turn on a half answer, and a failed leg could be retried by Houge and by omp at once (double spend).
  const FIXTURES = new URL("../fixtures/omp-frames/", import.meta.url);
  const frames = (name: string): OmpFrame[] => readFileSync(new URL(name, FIXTURES), "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as OmpFrame).filter((f) => typeof f.type === "string");
  const playing = (fs: OmpFrame[]) => fakeSession({ onPrompt: (_t, e) => { for (const f of fs) e(f); } });
  const settledOnce = (o: { done: unknown[]; failed: unknown[] }) => o.done.length + o.failed.length;

  it("the rule: aborted, terminal or async-work-only ends settle; a plain non-terminal end does not", () => {
    expect(settlesTurn({ type: "agent_end" })).toBe(true);
    expect(settlesTurn({ type: "agent_end", isTerminal: true })).toBe(true);
    expect(settlesTurn({ type: "agent_end", isTerminal: false })).toBe(false);
    expect(settlesTurn({ type: "agent_end", isTerminal: false, aborted: true })).toBe(true);
    expect(settlesTurn({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true })).toBe(true);
  });

  for (const name of readdirSync(new URL("../fixtures/omp-frames/", import.meta.url)).filter((f) => f.startsWith("agent-end-"))) {
    it(`replays ${name}: exactly one outcome, and no Houge retry prompt`, async () => {
      const session = playing(frames(name));
      const { store, sup, outcome } = harness(session);
      sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
      expect(settledOnce(outcome)).toBe(1);
      expect(session.prompts).toEqual(["hi"]);
    });
  }

  it("a late steer: completes once, on the text after the continuation", async () => {
    const session = playing(frames("agent-end-late-steer.jsonl"));
    const { store, sup, outcome } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(outcome.done).toHaveLength(1);
    expect((outcome.done[0] as { text: string }).text).not.toBe("ONE");
  });

  it("omp's own retry succeeds: Houge does not retry too, and both model requests are audited", async () => {
    const session = playing(frames("agent-end-omp-retry.jsonl"));
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ text: "recovered" });
    expect(session.prompts).toEqual(["hi"]); // never RETRY_NOTE
    const kinds = store.getLedgerEvents(run_id).filter((e) => e.event_type === "llm_attempt").map((e) => (e.payload as { error_kind?: string }).error_kind);
    // the first request failed (its kind is whatever classifyOmpError says; never pin the string), the second answered
    expect(kinds).toHaveLength(2);
    expect(kinds[0]).toBeDefined();
    expect(kinds[1]).toBeUndefined();
  });

  it("omp's retry also fails and its end is terminal: Houge's own retry runs exactly once", async () => {
    let prompts = 0;
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      if (prompts++ === 0) {
        session.assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" }); e({ type: "agent_end", isTerminal: false });
        e({ type: "turn_start" }); session.assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" }); e({ type: "agent_end", isTerminal: true });
      } else { session.assistant("from the next leg"); e({ type: "agent_end", isTerminal: true }); }
    } });
    const { store, sup, outcome } = harness(session);
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.prompts).toEqual(["hi", RETRY_NOTE]);
    expect(outcome.done[0]).toMatchObject({ text: "from the next leg" });
  });

  it("an async-work-only end settles at once, stops the child, pages once, and its late frames never reach the next turn", async () => {
    let n = 0;
    const session = fakeSession({ onPrompt: (_t, e) => {
      if (n++ === 0) { for (const f of frames("agent-end-async-work.jsonl")) e(f); return; }
      e({ type: "turn_start" }); session.assistant("second turn"); e({ type: "agent_end" });
    } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "60000" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ text: "started the job" });
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "planner_async_wait" }));
    session.emitForTest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "LATE" }], stopReason: "stop" } });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.options.length).toBe(2); // a fresh child for the next turn
    expect(outcome.done[1]).toMatchObject({ text: "second turn" });
  });
  // codex final I1: a child awaiting background work may still send a tool call. It must be stopped (and the turn's
  // signal aborted, so the bridge refuses anything new) BEFORE the run completes and its trust is finalized; otherwise a
  // late call runs against a completed run whose trust can no longer rise, and a write could skip its tap.
  it("an async-work-only end stops the child and aborts the turn's signal before the run completes or trust finalizes", async () => {
    const order: string[] = [];
    const session = fakeSession({ onPrompt: (_t, e) => { for (const f of frames("agent-end-async-work.jsonl")) e(f); } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "60000" });
    const run_id = createQueuedTurnRun(store);
    let signalAtStop: boolean | undefined;
    const stop = session.stop.bind(session);
    session.stop = async () => {
      signalAtStop = sup.activeTurnForTest()?.signal.aborted;
      order.push(`stop:done=${outcome.done.length}:final=${store.getLedgerEvents(run_id).filter((e) => e.event_type === "turn_trust_final").length}`);
      await stop();
    };
    const complete = outcome.complete.bind(outcome);
    outcome.complete = (i) => { order.push("complete"); complete(i); };
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(order).toEqual(["stop:done=0:final=0", "complete"]);
    expect(signalAtStop).toBe(true);
  });

  // codex final I2: an async-work-only end is not omp's last word (the child may still continue), so Houge never starts
  // another leg on it, even with a recorded error frame: a retry would overlap the child's background work.
  it("an async-work-only end with an error frame never enters Houge's retry: it fails once, no RETRY_NOTE", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" });
      session.assistant("", { stopReason: "error", errorMessage: "429 usage limit reached" });
      e({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
    } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "60000" });
    sup.submit(req(createQueuedTurnRun(store))); await sup.whenIdle();
    expect(session.prompts).toEqual(["hi"]);
    expect(outcome.done).toHaveLength(0);
    expect(outcome.failed).toEqual([expect.objectContaining({ error_type: "model_error" })]);
  });

  it("Houge's omp config caps omp's own retries under the frame watchdog (S2b)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hcfg-"));
    mkdirSync(join(dir, "omp"), { recursive: true }); // writeHougeConfigFile creates no directory
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const text = readFileSync(writeHougeConfigFile({ data: dir }), "utf8");
    expect(text).toContain("retry:\n  maxRetries: 2\n  maxDelayMs: 60000\n");
    expect(60_000 + 30_000).toBeLessThan(Number(resolveOmpConfig({}).frameIdleMs));
  });
});

// security final I-3: the omp transcript outlives the turn, so text a hostile turn read is still in the planner's context on
// the next turn. Trust is therefore sticky per transcript: a dispatched turn starts at the level the transcript's last
// dispatched turn ended at (its own cause, carried_*), persisted so a daemon restart keeps it, and it returns to clean only
// when the planner starts a fresh transcript (the lesson-change new_session).
describe("PlannerSupervisor — trust is sticky within a planner transcript", () => {
  const trustEvents = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "turn_trust").map((e) => e.payload);
  const finalOf = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).find((e) => e.event_type === "turn_trust_final")?.payload;

  it("turn N hostile → turn N+1 starts hostile (carried_hostile); after a fresh session the next turn is clean", async () => {
    let cause: "injection_withheld" | "wall_read" | null = "injection_withheld";
    let sup: PlannerSupervisor | undefined;
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" }); if (cause) sup?.activeTurnForTest()?.trust?.raise(cause); session.assistant("ok"); e({ type: "agent_end" });
    } });
    const h = harness(session); sup = h.sup; const { store } = h;
    const run = async () => { const id = createQueuedTurnRun(store); h.sup.submit(req(id)); await h.sup.whenIdle(); return id; };
    await run();
    cause = null;
    const second = await run();
    expect(trustEvents(store, second)).toEqual([{ level: "hostile", cause: "carried_hostile" }]);
    expect(finalOf(store, second)).toEqual({ max_level: "hostile" });
    expect(store.getTranscriptTrust("42")).toBe("hostile"); // persisted: a restart resumes the same transcript and the same level
    store.addLesson({ scope: "ask", text: "answer briefly", source: "user_feedback" }); // lesson change → new_session
    const fresh = await run();
    expect(session.resets).toBe(1);
    expect(trustEvents(store, fresh)).toEqual([]);
    expect(finalOf(store, fresh)).toEqual({ max_level: "clean" });
    cause = "wall_read";
    await run();
    cause = null;
    expect(trustEvents(store, await run())).toEqual([{ level: "untrusted", cause: "carried_untrusted" }]);
  });

  it("a carried hostile level queues no second 'this turn read text aimed at the assistant' card", async () => {
    let raise = true; let sup: PlannerSupervisor | undefined;
    const session = fakeSession({ onPrompt: (_t, e) => {
      e({ type: "turn_start" }); if (raise) sup?.activeTurnForTest()?.trust?.raise("injection_withheld"); session.assistant("ok"); e({ type: "agent_end" });
    } });
    const h = harness(session); sup = h.sup;
    h.sup.submit(req(createQueuedTurnRun(h.store))); await h.sup.whenIdle();
    raise = false;
    const second = createQueuedTurnRun(h.store); h.sup.submit(req(second)); await h.sup.whenIdle();
    expect([...drainOutbox(h.store).keys()].filter((k) => k.includes("trust_hostile"))).toHaveLength(1);
  });
});

describe("PlannerSupervisor — trust-card pause policy and the turn's trust (spec §7.2)", () => {
  // Today every approval wait pauses the deadline and the 180 s watchdog for the full 30-minute approval timeout. A trust
  // card pauses them for its own TTL only, and a turn's trust pauses together never exceed one TTL, so a hostile turn's
  // wall-clock is bounded by deadline + one TTL and Paco's next message is never held for hours (codex round 5 B29).
  const bounded = (ttlMs: number) => ({ pause: "bounded" as const, ttlMs });

  it("a bounded pause holds the deadline for one TTL, then the timers resume while the card still waits", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(700); // 300 ms left
      sup.setAwaitingApprovalForTest(true, bounded(3_000)); await vi.advanceTimersByTimeAsync(2_900);
      expect(sup.state()).toBe("AWAITING_APPROVAL"); expect(outcome.failed).toEqual([]);
      await vi.advanceTimersByTimeAsync(200); // the TTL is spent: timers resume although the card was never answered
      expect(sup.state()).toBe("RUNNING");
      await vi.advanceTimersByTimeAsync(150); expect(outcome.failed).toEqual([]); // resumed at +3 000 with the 300 ms left: 50 remain
      await vi.advanceTimersByTimeAsync(100); expect(outcome.failed[0]).toMatchObject({ error_type: "turn_timeout" });
    } finally { vi.useRealTimers(); }
  });

  it("the turn carries this spawn's bridge token for the judge to mask by value (Rev 4, senior S-R3-2)", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await untilState(sup, "RUNNING");
    const o = session.options[0] as PlannerSessionOptions;
    expect(sup.activeTurnForTest()?.secretValues).toEqual([o.bridgeToken]);
  });

  it("the total trust pause per turn is capped at one TTL across several cards", async () => {
    // Fix round 2 (gate): rescaled so the second card's leftover (6 s) is a usable card time; a leftover under the bridge's
    // minimum counts as spent (tested below), which the original 1 s leftover of a 3 s TTL now would.
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(500); // 500 ms left
      sup.setAwaitingApprovalForTest(true, bounded(10_000)); await vi.advanceTimersByTimeAsync(4_000);
      sup.setAwaitingApprovalForTest(false); // 4 000 ms of the TTL spent
      await vi.advanceTimersByTimeAsync(100); // 400 ms left
      sup.setAwaitingApprovalForTest(true, bounded(10_000)); await vi.advanceTimersByTimeAsync(6_100); // only 6 000 ms more may pause
      expect(sup.state()).toBe("RUNNING");
      sup.setAwaitingApprovalForTest(false); // the second card is answered late; 300 ms of the deadline left
      sup.setAwaitingApprovalForTest(true, bounded(10_000)); // the budget is spent: a third card asks with the timers running
      expect(sup.state()).toBe("RUNNING");
      await vi.advanceTimersByTimeAsync(450); expect(outcome.failed[0]).toMatchObject({ error_type: "turn_timeout" });
    } finally { vi.useRealTimers(); }
  });

  it("a full pause (a code ask) is unchanged: no TTL, the deadline waits for the release", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING");
      sup.setAwaitingApprovalForTest(true, { pause: "full" }); await vi.advanceTimersByTimeAsync(600_000);
      expect(sup.state()).toBe("AWAITING_APPROVAL"); expect(outcome.failed).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("a trust card's wait: the TTL left while the pause budget lasts, then never past the watchdog or the deadline (senior W3)", async () => {
    const h = heldSession();
    const { store, sup } = harness(h.session);
    sup.submit(req(createQueuedTurnRun(store))); await h.live();
    const turn = (sup as unknown as { turn: { trustPausedMs: number; active: { trustWaitMs: (ttl: number) => number } } }).turn;
    expect(turn.active.trustWaitMs(300_000)).toBe(300_000);
    turn.trustPausedMs = 300_000; // the budget is spent
    // the default 180 s watchdog less the margin, less the (real-clock) ms since the child's last frame (review fix 1)
    expect(turn.active.trustWaitMs(300_000)).toBeLessThanOrEqual(180_000 - 15_000);
    expect(turn.active.trustWaitMs(300_000)).toBeGreaterThan(180_000 - 15_000 - 1_000);
    h.end(); await sup.whenIdle();
  });

  type TrustTurn = { trustPausedMs: number; active: { trustWaitMs: (ttl: number) => number } };
  const trustTurn = (sup: PlannerSupervisor) => (sup as unknown as { turn: TrustTurn }).turn;

  it("a trust card's wait counts the watchdog from the child's last frame, not from the ask (review fix 1)", async () => {
    // The watchdog was armed at the last frame, before the call queued and its input was judged: a cap measured from the ask
    // would let the watchdog kill the turn while the card still waits. The card must expire first and the turn go on.
    const h = heldSession();
    const { store, sup, outcome } = harness(h.session); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(10); // last frame at +5
      await vi.advanceTimersByTimeAsync(30_000); // 30 s of silence: queued behind another call, judging
      const turn = trustTurn(sup); turn.trustPausedMs = 300_000; // the pause budget is spent
      const cap = turn.active.trustWaitMs(300_000);
      expect(cap).toBeLessThanOrEqual(180_000 - 30_000 - 15_000);
      expect(cap).toBeGreaterThan(0);
      sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: 300_000 }); // asks with the timers running
      await vi.advanceTimersByTimeAsync(cap);
      sup.setAwaitingApprovalForTest(false); // the card expired on its cap
      expect(outcome.failed).toEqual([]); // the watchdog has not fired
      h.end("after the expiry");
    } finally { vi.useRealTimers(); }
    await sup.whenIdle();
    expect(outcome.done[0]).toMatchObject({ run_id, text: "after the expiry" });
    expect(store.getLedgerEvents(run_id).some((e) => e.event_type === "loop_halted")).toBe(false);
  });

  it("a trust card's wait never passes the deadline less the margin, and is 0 when the deadline is that near (review fix 2)", async () => {
    // A card that outlives the deadline it cannot pause is killed mid-wait with the turn (a schedule-born turn's bound, C5).
    const h = heldSession();
    const { store, sup } = harness(h.session, { HOUGE_OMP_TURN_TIMEOUT_MS: "60000", HOUGE_OMP_FRAME_IDLE_MS: "600000" });
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(createQueuedTurnRun(store))); await untilState(sup, "RUNNING");
      const startedAt = Date.now(); await vi.advanceTimersByTimeAsync(30_000);
      const turn = trustTurn(sup); turn.trustPausedMs = 300_000;
      const elapsed = Date.now() - startedAt; // the deadline also covered the start
      expect(turn.active.trustWaitMs(300_000)).toBeLessThanOrEqual(60_000 - elapsed - 15_000);
      expect(turn.active.trustWaitMs(300_000)).toBeGreaterThan(60_000 - elapsed - 15_000 - 1_000);
      await vi.advanceTimersByTimeAsync(16_000); // under 15 s of deadline left
      expect(turn.active.trustWaitMs(300_000)).toBe(0);
      h.end();
    } finally { vi.useRealTimers(); }
    await sup.whenIdle();
  });

  it("a trust card asked during a bounded pause gets only what that pause has not yet used (ruling 2)", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup } = harness(session);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(createQueuedTurnRun(store))); await untilState(sup, "RUNNING");
      sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: 10_000 }); await vi.advanceTimersByTimeAsync(4_000);
      expect(trustTurn(sup).active.trustWaitMs(10_000)).toBe(6_000);
    } finally { vi.useRealTimers(); }
  });

  it("every turn end writes turn_trust_final once, success and failure", async () => {
    const ok = harness(); const a = createQueuedTurnRun(ok.store);
    ok.sup.submit(req(a)); await ok.sup.whenIdle();
    expect(ok.store.getLedgerEvents(a).filter((e) => e.event_type === "turn_trust_final").map((e) => e.payload)).toEqual([{ max_level: "clean" }]);
    const bad = harness(fakeSession({ promptError: "exited:boom" })); const b = createQueuedTurnRun(bad.store);
    bad.sup.submit(req(b)); await bad.sup.whenIdle();
    expect(bad.outcome.failed).toHaveLength(1);
    expect(bad.store.getLedgerEvents(b).filter((e) => e.event_type === "turn_trust_final")).toHaveLength(1);
  });

  it("the active turn carries a trust state and the judge buildTools returned", async () => {
    const judge = vi.fn();
    const h = heldSession();
    const { store, sup } = harness(h.session, {}, { buildTools: () => ({ registry: new ToolRegistry(), quarantine: async () => ({ digest: "", contains_instructions: false, source_meta: { tool: "x", bytes: 0 } }), judge }) });
    sup.submit(req(createQueuedTurnRun(store))); await h.live();
    const active = (sup as unknown as { turn: { active: { trust?: { level(): string }; judge?: unknown } } }).turn.active;
    expect(active.trust?.level()).toBe("clean");
    expect(active.judge).toBe(judge);
    h.end(); await sup.whenIdle();
  });
});

describe("PlannerSupervisor — turn_trust_final at every turn end (spec §7.2)", () => {
  // A turn with no turn_trust_final reads as "not clean" forever (turnTrustFinal → null), and the digest and the gate count
  // hostile turns by it: each way a turn can end must write it exactly once, never zero and never twice.
  const finals = (store: RunStore, run_id: string) => store.getLedgerEvents(run_id).filter((e) => e.event_type === "turn_trust_final").map((e) => e.payload);

  it("is written before the run's terminal outcome, so a reader at completion or failure already sees it", async () => {
    const seen: number[] = [];
    for (const session of [fakeSession(), fakeSession({ promptError: "exited:boom" })]) {
      const h = harness(session); const run_id = createQueuedTurnRun(h.store);
      const { complete, fail } = h.outcome;
      h.outcome.complete = (i) => { seen.push(finals(h.store, i.run_id).length); complete(i); };
      h.outcome.fail = (i) => { seen.push(finals(h.store, i.run_id).length); fail(i); };
      h.sup.submit(req(run_id)); await h.sup.whenIdle();
    }
    expect(seen).toEqual([1, 1]);
  });

  it("an aborted turn (/kill) writes it once", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await until(() => session.prompts.length === 1);
    await sup.abortAll("killed");
    expect(outcome.failed[0]).toMatchObject({ error_type: "killed" });
    expect(finals(store, run_id)).toEqual([{ max_level: "clean" }]);
  });

  it("a watchdog end (frame_idle) writes it once, at the level the turn reached", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => e({ type: "turn_start" }) });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(10);
      sup.activeTurnForTest()?.trust?.raise("wall_read");
      await vi.advanceTimersByTimeAsync(1_200);
    } finally { vi.useRealTimers(); }
    await sup.whenIdle();
    expect(outcome.failed[0]).toMatchObject({ error_type: "frame_idle" });
    expect(finals(store, run_id)).toEqual([{ max_level: "untrusted" }]);
  });

  it("an async-work-only settle (P7) writes it once", async () => {
    const FIXTURES = new URL("../fixtures/omp-frames/", import.meta.url);
    const fs = readFileSync(new URL("agent-end-async-work.jsonl", FIXTURES), "utf8").split("\n").filter((l) => l.trim())
      .map((l) => JSON.parse(l) as OmpFrame).filter((f) => typeof f.type === "string");
    const session = fakeSession({ onPrompt: (_t, e) => { for (const f of fs) e(f); } });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "60000" }); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.incidents).toContainEqual(expect.objectContaining({ k: "planner_async_wait" }));
    expect(finals(store, run_id)).toEqual([{ max_level: "clean" }]);
  });

  it("a lane reply writes it once", async () => {
    const session = fakeSession();
    const { store, sup, outcome } = harness(session, {}, { triage: async () => ({ kind: "lane_reply", text: "📒 Saved", buttons: [] }) });
    const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await sup.whenIdle();
    expect(outcome.done).toHaveLength(1);
    expect(finals(store, run_id)).toEqual([{ max_level: "clean" }]);
  });

  it("daemon shutdown mid-turn writes it once", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session); const run_id = createQueuedTurnRun(store);
    sup.submit(req(run_id)); await until(() => session.prompts.length === 1);
    await sup.shutdown();
    expect(outcome.failed[0]).toMatchObject({ error_type: "planner_exit" });
    expect(finals(store, run_id)).toEqual([{ max_level: "clean" }]);
  });

  it("a schedule-born hostile turn whose trust card is never answered ends within deadline + one TTL, final hostile", async () => {
    // Nobody taps a schedule-born card at night: the turn must still end on its own deadline plus at most one TTL of pause
    // (live gate C5), never hold Paco's next message for the 30-minute approval timeout.
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_TURN_TIMEOUT_MS: "1000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id, "nightly", "schedule")); await untilState(sup, "RUNNING");
      const t0 = Date.now();
      sup.activeTurnForTest()?.trust?.raise("injection_withheld");
      sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: 3_000 }); // the card is never released
      await vi.advanceTimersByTimeAsync(4_100);
      expect(outcome.failed[0]).toMatchObject({ error_type: "turn_timeout" });
      expect(Date.now() - t0).toBeLessThanOrEqual(4_100);
    } finally { vi.useRealTimers(); }
    await sup.whenIdle();
    expect(finals(store, run_id)).toEqual([{ max_level: "hostile" }]);
  });
});

describe("PlannerSupervisor — a pause leftover too short for a card counts as spent (fix round 2, live gate C4)", () => {
  // Live gate runs 2, 4, 5, 6: Node timers fire ~1 ms early against Date.now(), so the turn's one 45 s pause was recorded as
  // 44 999 ms and the next trust card got a 1 ms "leftover" — refused (trust_ask_no_time) although the watchdog left ~15 s.
  // A leftover under the bridge's minimum card time must fall through to the post-budget (watchdog/deadline) cap.
  type T = { trustPausedMs: number; active: { trustWaitMs: (ttl: number) => number } };
  const turnOf = (sup: PlannerSupervisor) => (sup as unknown as { turn: T }).turn;
  const TTL = 300_000; // larger than the default watchdog's cap (165 s), so the post-budget cap differs from the TTL

  for (const leftover of [1, 4_999]) {
    it(`a ${leftover} ms leftover gets the post-budget cap, and pauses nothing`, async () => {
      const session = fakeSession({ onPrompt: () => undefined });
      const { store, sup } = harness(session);
      vi.useFakeTimers(FAKE_CLOCK);
      try {
        sup.submit(req(createQueuedTurnRun(store))); await untilState(sup, "RUNNING");
        const turn = turnOf(sup); turn.trustPausedMs = TTL - leftover;
        expect(turn.active.trustWaitMs(TTL)).toBe(180_000 - 15_000);
        sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: TTL });
        expect(sup.state()).toBe("RUNNING"); // the card waits with the timers running, within the cap above
      } finally { vi.useRealTimers(); }
    });
  }

  it("a 5 000 ms leftover is still a card's time: it is used, and pauses for it", async () => {
    const session = fakeSession({ onPrompt: () => undefined });
    const { store, sup } = harness(session);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(createQueuedTurnRun(store))); await untilState(sup, "RUNNING");
      const turn = turnOf(sup); turn.trustPausedMs = TTL - 5_000;
      expect(turn.active.trustWaitMs(TTL)).toBe(5_000);
      sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: TTL });
      expect(sup.state()).toBe("AWAITING_APPROVAL");
    } finally { vi.useRealTimers(); }
  });

  it("the gate's run-6 sequence: the first card expires on the TTL with the clock 1 ms behind, the second is granted a positive cap", async () => {
    const session = fakeSession({ onPrompt: (_t, e) => e({ type: "turn_start" }) });
    const { store, sup, outcome } = harness(session, { HOUGE_OMP_FRAME_IDLE_MS: "30000" }); const run_id = createQueuedTurnRun(store);
    vi.useFakeTimers(FAKE_CLOCK);
    try {
      sup.submit(req(run_id)); await untilState(sup, "RUNNING"); await vi.advanceTimersByTimeAsync(10);
      const turn = turnOf(sup);
      expect(turn.active.trustWaitMs(45_000)).toBe(45_000); // the first card waits the whole TTL
      sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: 45_000 });
      await vi.advanceTimersByTimeAsync(20_000);
      vi.setSystemTime(Date.now() - 1); // Date.now() now trails the timers by 1 ms, as the live timers did
      await vi.advanceTimersByTimeAsync(25_000); // the pause timer fires; the card expires with it
      sup.setAwaitingApprovalForTest(false);
      expect(turn.trustPausedMs).toBe(45_000); // the span is recorded as scheduled, not 44 999
      session.emitForTest({ type: "turn_start" }); // the planner reads the expiry and goes on
      const cap = turn.active.trustWaitMs(45_000);
      expect(cap).toBe(30_000 - 15_000); // the watchdog less the margin: at least the bridge's 5 s, so the card is asked
      sup.setAwaitingApprovalForTest(true, { pause: "bounded", ttlMs: 45_000 }); await vi.advanceTimersByTimeAsync(cap);
      sup.setAwaitingApprovalForTest(false); // the second card expires before the watchdog
      expect(outcome.failed).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
