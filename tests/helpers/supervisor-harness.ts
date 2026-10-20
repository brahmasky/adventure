import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { RunStore } from "../../src/run/run-store.js";
import { lessonSetFingerprint } from "../../src/run/lesson-render.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { PlannerSupervisor, type PlannerSessionLike, type SupervisorDeps, type SupervisorState, type TurnOutcomeSink } from "../../src/omp/planner-supervisor.js";
import type { OmpFrame } from "../../src/omp/omp-frames.js";
import { PlannerRpcError, type ExitInfo, type PlannerSessionOptions, type PlannerState } from "../../src/omp/planner-session.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { formatModelString, parseModelString, type ModelString } from "../../src/omp/model-string.js";
import { selectorKey } from "../../src/omp/model-roles.js";
import type { TurnRole } from "../../src/jev/tree-policy.js";
import type { JevRequest, JevResult } from "../../src/jev/jev-client.js";
import { openManifestClient } from "./bridge-manifest.js";

export type Script = {
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
  /** Replaces getState(): the todo phases and steer queue. */
  getState?: () => Promise<PlannerState>;
};
export const never = () => new Promise<never>(() => undefined);
export type Fake = PlannerSessionLike & {
  prompts: string[]; steers: string[]; models: string[]; options: PlannerSessionOptions[];
  /** Every set_model with its effort (`provider/model[:effort]`): what set_thinking_level was asked for. */
  pins: string[];
  exit: (c: number) => void; assistant: (text: string, extra?: object) => void; bind: (o: PlannerSessionOptions) => Fake;
  /** The child stays up but its bridge socket closes (its extension never reconnects). */
  dropBridge: () => void;
  /** Emit a frame now, outside any prompt (a late or stray frame). */
  emitForTest: (f: OmpFrame) => void;
  resets: number;
  /** A bridge request over the fake child's own manifest socket, as the extension sends it: resolves with the reply's result (rejects on ok: false). */
  request: (msg: object) => Promise<unknown>;
  /** Replaces getState() for the rest of the test. */
  scriptGetState: (fn: () => Promise<PlannerState>) => void;
};

/** In-memory omp child. Its start() plays the extension against the REAL bridge socket (ruling 3). */
export function fakeSession(script: Script = {}): Fake {
  const frameCbs: Array<(f: OmpFrame) => void> = []; const exitCbs: Array<(i: ExitInfo) => void> = [];
  const sockets: Socket[] = [];
  const emit = (f: OmpFrame) => frameCbs.forEach((cb) => cb(f));
  // the model the child really runs: the spawn's --model, a resumed session's stored one, then each successful set_model
  let current = "anthropic/claude-opus-5-5";
  const assistant = (text: string, extra: object = {}) => {
    const [provider, model] = current.split("/");
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider, model, usage: { input: 10, output: 2 }, stopReason: "stop", ...extra } } as OmpFrame);
  };
  let getStateFn: (() => Promise<PlannerState>) | undefined; let reqN = 0;
  const request = (msg: object): Promise<unknown> => new Promise((resolve, reject) => {
    const sock = sockets[0]; if (!sock) { reject(new Error("no bridge socket")); return; }
    const id = `x${++reqN}`; let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { id?: string; ok?: boolean; result?: unknown; error?: string } | undefined; try { m = JSON.parse(line) as typeof m; } catch { continue; }
        if (m?.id !== id) continue;
        sock.off("data", onData); sock.off("close", onClose);
        if (m.ok) resolve(m.result); else reject(new Error(m.error ?? "bridge error"));
      }
    };
    const onClose = () => { sock.off("data", onData); reject(new Error("bridge socket closed")); };
    sock.on("data", onData); sock.once("close", onClose);
    sock.write(`${JSON.stringify({ ...msg, id })}\n`);
  });
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
    getState: async () => getStateFn?.() ?? script.getState?.() ?? { todoPhases: [], queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] } },
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
    request, scriptGetState: (fn) => { getStateFn = fn; },
    assistant
  };
  return s;
}

export const cleanups: Array<() => Promise<void> | void> = [];

export type Outcome = TurnOutcomeSink & { done: unknown[]; failed: unknown[]; incidents: unknown[]; resetOks: number; routeEnds: unknown[] };
export function sink(store: RunStore): Outcome {
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
export const TEST_ROLES: Record<TurnRole, string[]> = {
  default: ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"],
  fast: ["anthropic/claude-sonnet-5-5:low", "google-antigravity/gemini-3.8-flash:low"],
  thinking: ["anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-4-6:high"]
};
export type Roles = SupervisorDeps["roles"] & { calls: Array<{ role: string; effort: string | null; refused: string[] }>; refreshes: number };
/** A resolver stand-in: the role's list minus the refused set; a routed effort replaces the list's (resolved mode, no clamp). */
export function fakeRoles(over: Partial<Record<TurnRole, string[]>> = {}): Roles {
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

/** turn.settle's default Jev: every question answered at 0.1 (below each per-question bar of 0.6 to 0.8), so a settle the rules pass settles. */
export const jev01 = async (r: JevRequest): Promise<JevResult> => ({ ok: true, model: "jev-1.13.0", input_tokens: 1, latency_ms: 1,
  answers: Object.fromEntries(Object.keys(r.questions).map((id) => [id, { type: "noul" as const, noul: 0.1 }])) });

/** `o.store`: share a store across supervisors (a restart); the caller closes it. */
export function harness(session = fakeSession(), env: Record<string, string> = {}, extra: Partial<SupervisorDeps> = {}, o: { sessionState?: "current" | "none"; store?: RunStore } = {}) {
  const store = o.store ?? RunStore.openInMemory();
  if (!o.store && (o.sessionState ?? "current") === "current") {
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
    skipPreflightForTest: true, manifestWaitMs: 5_000, roles: fakeRoles(), settleClient: () => jev01, ...extra
  });
  cleanups.push(async () => { await sup.shutdown(); if (!o.store) store.close(); rmSync(data, { recursive: true, force: true }); });
  return { store, sup, outcome, session, data };
}
export const req = (run_id: string, text = "hi", source: "telegram" | "schedule" = "telegram") => ({ run_id, text, source, requester: { kind: "user" as const, id: "paco" } });

/** Fake every timer and the clock; setImmediate stays real so the real bridge socket's I/O can complete (ruling 3). */
export const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] };

/**
 * Under fake timers: yield to real I/O (the bridge socket) until the state is reached. Fake time does NOT move, so a
 * test's own advances are the whole timeline; the bound is real time (a loaded machine needs more turns, not more ms).
 */
export async function untilState(sup: PlannerSupervisor, want: SupervisorState): Promise<void> {
  const end = performance.now() + 10_000;
  while (sup.state() !== want && performance.now() < end) await new Promise((r) => setImmediate(r));
  expect(sup.state()).toBe(want);
}

/** Event-based wait (real time, polled every 5 ms): never a fixed sleep that assumes the machine is idle (final review C4). */
export async function until(ok: () => boolean): Promise<void> {
  await vi.waitFor(() => { expect(ok()).toBe(true); }, { timeout: 10_000, interval: 5 });
}

/** A child whose turns stay live until the test ends them: `live(n)` waits for the n-th prompt's frames, `end()` ends the oldest live turn. */
export function heldSession(script: Script = {}) {
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
