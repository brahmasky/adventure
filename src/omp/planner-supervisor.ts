import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { BudgetLedger } from "../budget/budget-ledger.js";
import type { Identity } from "../domain/types.js";
import type { LlmAttempt } from "../llm/audit.js";
import type { ClaimedRun, PlannerFailure, RunStore } from "../run/run-store.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { BridgeRequest } from "./bridge-protocol.js";
import { BridgeServer } from "./bridge-server.js";
import { createBridgeHandler, flushUnreported, type ActiveTurn } from "./bridge-handler.js";
import { familyOf, type ModelString } from "./model-string.js";
import type { OmpConfig } from "./omp-config.js";
import { classifyOmpError, summarizeAssistantMessage, type AssistantSummary, type OmpFrame } from "./omp-frames.js";
import { checkOmpVersion } from "./omp-version.js";
import { PlannerSession, type ExitInfo, type PlannerSessionOptions } from "./planner-session.js";
import { realpathOrSelf, type PathContext } from "./protected-paths.js";
import { writeSeatbeltProfiles } from "./seatbelt.js";
import { verifyInstalledWrapper } from "./shell-wrapper.js";
import type { ToolDeclaration } from "./tool-decls.js";
import { assistantIntentFor, buildTurnPrompt, systemPromptFingerprint, writeSystemPromptFile, type TurnContextDeps } from "./turn-context.js";

export type SupervisorState = "STOPPED" | "STARTING" | "IDLE" | "RUNNING" | "AWAITING_APPROVAL" | "ABORTING";
export type PlannerSessionLike = Pick<PlannerSession, "start" | "prompt" | "steer" | "abort" | "setModel" | "onFrame" | "onExit" | "stop">;
export interface TurnRequest { run_id: string; text: string; source: "telegram" | "schedule"; goal?: string; requester: Identity }
export interface TurnOutcomeSink {
  complete(i: { run_id: string; worker_id: string; text: string; attachments: string[]; duration_ms: number; tool_calls: number; merged_into?: string }): void;
  fail(i: { run_id: string; worker_id: string; error_type: PlannerFailure; error_ref: string; partial?: string }): void;
  incident(kind: string, detail: Record<string, unknown>): void;
}
export interface SupervisorDeps {
  chatId: string; store: RunStore; cfg: OmpConfig; ctx: PathContext; distDir: string; decls: ToolDeclaration[];
  env: NodeJS.ProcessEnv; turnEnvelopeActions: string[]; turnContext: TurnContextDeps;
  buildTools: (claim: ClaimedRun) => { registry: ToolRegistry; quarantine: ActiveTurn["quarantine"] };
  posture: () => string | null; outcome: TurnOutcomeSink;
  sessionFactory?: (o: PlannerSessionOptions) => PlannerSessionLike;
  versionCheck?: () => ReturnType<typeof checkOmpVersion>;
  /** Unit tests only: skips the wrapper hash check and the Seatbelt render (the bridge socket stays real). */
  skipPreflightForTest?: boolean;
  /** How long a started child has to ask for its manifest (default MANIFEST_WAIT_MS). */
  manifestWaitMs?: number;
}

export const RETRY_NOTE = "(The previous model was unavailable. Continue answering my last message.)";
export const KILLED_TEXT = "⏹ Stopped by /kill.";
export const TIMEOUT_TEXT = "⏱ I ran out of time on this one. Here is what I had so far:";
export const PLANNER_EXIT_TEXT = "⚠ My runtime stopped unexpectedly. Nothing was retried; the ledger shows what ran.";
export const MANIFEST_WAIT_MS = 15_000;
const RETRYABLE = new Set(["quota", "auth", "transport", "timeout", "model_missing"]);
const HEARTBEAT_MS = 30_000;
const ABORT_GRACE_MS = 5_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;
/** macOS sun_path is 104 bytes including the terminating NUL. */
const MAX_SOCK_PATH = 103;
const TIMED_OUT = Symbol("timed_out");
/** omp profile config (spec §4): no xdev devices, no update checks, no telemetry. */
const HOUGE_CONFIG_YML = "tools:\n  xdev: false\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\ntelemetry:\n  otlpExportEnabled: false\n";

interface Turn {
  req: TurnRequest; worker: string; startedAt: number; merged: string[];
  active: ActiveTurn; abort: AbortController; heartbeat: ReturnType<typeof setInterval>;
  /** Model requests seen (turn_start frames) and the last one an llm_attempt row was written for. */
  n: number; recorded: number; lastText: string; lastError: string | undefined; usedTool: boolean; legIndex: number;
  /** True while a prompt is out and its agent_end has not arrived: only then is a steer delivered. */
  live: boolean; finished: boolean;
  done: (r: "end" | "abort") => void; ended: Promise<"end" | "abort">;
  deadlineLeft: number; deadlineAt: number; deadline: ReturnType<typeof setTimeout> | undefined; idle: ReturnType<typeof setTimeout> | undefined;
  failure?: { type: PlannerFailure; ref: string };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sameModel = (a: ModelString, b: ModelString) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;

/** Race `p` against a timer that is always cleared (no timer outlives the wait). */
async function bounded<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((r) => { t = setTimeout(() => r(TIMED_OUT), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `[[attach: <path>]]` lines leave the text; a path is kept only if it (and its real target) is inside the workspace. */
export function parseAttachments(text: string, workspace: string): { text: string; attachments: string[] } {
  const attachments: string[] = [];
  const kept = text.split("\n").filter((line) => {
    const m = /^\s*\[\[attach:\s*(.+?)\s*\]\]\s*$/.exec(line);
    if (!m) return true;
    const abs = resolvePath(workspace, m[1] as string);
    if (inside(workspace, abs) && inside(realpathOrSelf(workspace), realpathOrSelf(abs))) attachments.push(abs);
    return false;
  });
  return { text: kept.join("\n").trim(), attachments };
}

function newDeferred(): { done: (r: "end" | "abort") => void; ended: Promise<"end" | "abort"> } {
  let done: (r: "end" | "abort") => void = () => undefined;
  const ended = new Promise<"end" | "abort">((r) => { done = r; });
  return { done, ended };
}

export class PlannerSupervisor {
  private st: SupervisorState = "STOPPED";
  private session: PlannerSessionLike | undefined;
  private bridge: BridgeServer | undefined;
  /** Bumped whenever the child is replaced: frames, exits and disconnects of an older child are ignored. */
  private gen = 0;
  private fingerprint = "";
  private stale = false;
  private turn: Turn | undefined;
  private readonly queue: TurnRequest[] = [];
  private busy = false;
  private draining: Promise<void> | undefined;
  private idleWaiters: Array<() => void> = [];
  private exits: number[] = [];
  private idleExit: ReturnType<typeof setTimeout> | undefined;
  private model: ModelString;

  constructor(private readonly d: SupervisorDeps) { this.model = this.top(); }
  state(): SupervisorState { return this.st; }
  markStale(): void { this.stale = true; }
  whenIdle(): Promise<void> {
    return this.busy || this.queue.length > 0 ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }

  submit(req: TurnRequest): void {
    const t = this.turn;
    if (t?.live && req.source === "telegram" && (this.st === "RUNNING" || this.st === "AWAITING_APPROVAL")) {
      void this.steer(t, req).catch((e) => this.incident("planner_steer_failed", { run_id: req.run_id, reason: message(e) }));
      return;
    }
    this.queue.push(req);
    if (!this.busy) this.draining = this.drain();
  }

  /** @internal Tests only: the same entry point the bridge receives through ActiveTurn.setAwaitingApproval. */
  setAwaitingApprovalForTest(on: boolean): void { this.setAwaitingApproval(on); }

  async abortAll(reason: "killed" | "guard"): Promise<void> {
    this.queue.length = 0;
    await this.abortTurn("killed", reason);
    await this.draining;
    await this.stopSession();
  }

  async shutdown(): Promise<void> {
    this.queue.length = 0;
    const t = this.turn;
    if (t) { t.failure ??= { type: "planner_exit", ref: "daemon shutdown" }; this.clearTimers(t); t.done("abort"); }
    await this.draining;
    await this.stopSession();
  }

  private top(): ModelString { return this.d.cfg.planner[0] as ModelString; }
  private workspace(): string { return join(this.d.ctx.data, "omp", "workspace", `chat-${this.d.chatId}`); }
  private incident(kind: string, detail: Record<string, unknown>): void {
    this.d.outcome.incident(kind, { chat_id: this.d.chatId, ...detail });
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      for (let req = this.queue.shift(); req; req = this.queue.shift()) {
        try { await this.runTurn(req); } catch (e) {
          console.error(`planner supervisor: turn ${req.run_id} crashed: ${message(e)}`);
          this.incident("planner_turn_crashed", { run_id: req.run_id, reason: message(e) });
        }
      }
    } finally {
      this.busy = false;
      this.st = this.session ? "IDLE" : "STOPPED";
      if (this.session) this.armIdleExit();
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private armIdleExit(): void {
    clearTimeout(this.idleExit);
    this.idleExit = setTimeout(() => { if (!this.busy) void this.stopSession(); }, this.d.cfg.idleExitMs);
    this.idleExit.unref();
  }

  /** A Telegram message during a live turn: claimed under the turn's owner, then steered in (spec §7.3). */
  private async steer(turn: Turn, req: TurnRequest): Promise<void> {
    const { store, cfg, chatId } = this.d;
    if (!store.claimRun(req.run_id, turn.worker, cfg.leaseTtlS)) return;
    turn.merged.push(req.run_id);
    store.recordChatTurn({ chat_id: chatId, run_id: req.run_id, role: "user", text: req.text });
    try {
      if (!this.session) throw new Error("planner not running");
      await this.session.steer(req.text);
    } catch (e) {
      if (turn.finished) return; // the parent already finished it with the turn
      turn.merged = turn.merged.filter((m) => m !== req.run_id);
      this.d.outcome.fail({ run_id: req.run_id, worker_id: turn.worker, error_type: "planner_exit", error_ref: `steer_failed: ${message(e)}` });
    }
  }

  private async runTurn(req: TurnRequest): Promise<void> {
    const worker = `planner:${this.d.chatId}:${randomUUID()}`;
    const claim = this.d.store.claimRun(req.run_id, worker, this.d.cfg.leaseTtlS);
    if (!claim) return;
    clearTimeout(this.idleExit);
    const turn = this.newTurn(req, worker, claim);
    this.turn = turn;
    try {
      await this.startTurn(turn);
      await this.settle(turn);
    } finally {
      this.clearTimers(turn);
      clearInterval(turn.heartbeat);
      if (this.turn === turn) this.turn = undefined;
    }
  }

  private newTurn(req: TurnRequest, worker: string, claim: ClaimedRun): Turn {
    const { cfg, chatId } = this.d;
    const abort = new AbortController();
    const tools = this.d.buildTools(claim);
    const active: ActiveTurn = {
      run_id: req.run_id, worker_id: worker, chat_id: chatId, requester: req.requester, contract: claim.contract,
      budget: new BudgetLedger(claim.contract.budget), registry: tools.registry, signal: abort.signal, cwd: this.workspace(),
      step: { n: 0 }, cache: new Map(), unreported: new Map(), quarantine: tools.quarantine,
      setAwaitingApproval: (on) => this.setAwaitingApproval(on), postureOk: this.d.posture
    };
    const heartbeat = setInterval(() => this.renewLeases(), HEARTBEAT_MS);
    return {
      req, worker, startedAt: Date.now(), merged: [], active, abort, heartbeat, n: 0, recorded: 0, lastText: "", lastError: undefined, deadline: undefined, idle: undefined,
      usedTool: false, legIndex: 0, live: false, finished: false, ...newDeferred(),
      deadlineLeft: cfg.turnTimeoutMs, deadlineAt: Date.now()
    };
  }

  /** The lease keeps renewing while AWAITING_APPROVAL; losing the parent's lease aborts the turn (spec §7.1). */
  private renewLeases(): void {
    const t = this.turn;
    if (!t) return;
    const { store, cfg } = this.d;
    if (!store.heartbeat(t.req.run_id, t.worker, cfg.leaseTtlS)) { void this.abortTurn("lease_lost", "heartbeat refused"); return; }
    for (const m of t.merged) {
      if (!store.heartbeat(m, t.worker, cfg.leaseTtlS)) console.warn(`planner supervisor: merged run ${m} lease renewal refused`);
    }
  }

  private failTurn(turn: Turn, type: PlannerFailure, ref: string): void {
    turn.failure ??= { type, ref };
    turn.live = false;
    turn.done("abort");
  }

  private async startTurn(turn: Turn): Promise<void> {
    const { store, chatId, turnContext } = this.d;
    try {
      const fail = await this.ensureSession();
      if (fail) { this.failTurn(turn, "planner_exit", fail); return; }
      if (turn.failure) return; // aborted while the child was starting
      store.recordChatTurn({ chat_id: chatId, run_id: turn.req.run_id, role: "user", text: turn.req.text });
      const prompt = await buildTurnPrompt(turnContext, {
        run_id: turn.req.run_id, chat_id: chatId, message: turn.req.text, source: turn.req.source,
        ...(turn.req.goal !== undefined ? { goal: turn.req.goal } : {})
      });
      if (turn.failure) return;
      await this.promptTop(turn, prompt);
    } catch (e) {
      this.failTurn(turn, "planner_exit", `start_failed: ${message(e)}`);
    }
  }

  /** A later turn retries the top planner string once after a fallback (spec §8). */
  private async promptTop(turn: Turn, prompt: string): Promise<void> {
    const s = this.session;
    if (!s) { this.failTurn(turn, "planner_exit", "planner not running"); return; }
    this.st = "RUNNING";
    this.armDeadline(turn);
    this.armFrameIdle(turn);
    try {
      if (!sameModel(this.model, this.top())) { await s.setModel(this.top()); this.model = this.top(); }
      if (turn.failure) return;
      turn.live = true;
      await s.prompt(prompt);
    } catch (e) {
      this.failTurn(turn, "planner_exit", `prompt_failed: ${message(e)}`);
    }
  }

  private async settle(turn: Turn): Promise<void> {
    for (;;) {
      await turn.ended;
      if (turn.failure || turn.lastError === undefined) break;
      if (!(await this.retryNextLeg(turn, turn.lastError))) break;
    }
    this.clearTimers(turn);
    if (turn.failure) this.finishFailure(turn, turn.failure);
    else this.finishSuccess(turn);
  }

  /** quota|auth|transport|timeout|model_missing → next planner string over live set_model; else final. */
  private async retryNextLeg(turn: Turn, error: string): Promise<boolean> {
    const kind = classifyOmpError(error);
    const planner = this.d.cfg.planner;
    if (!RETRYABLE.has(kind) || turn.legIndex + 1 >= planner.length) {
      turn.failure = { type: "no_planner_leg", ref: kind };
      this.incident("planner_no_leg", { run_id: turn.req.run_id, error_kind: kind, legs_tried: turn.legIndex + 1 });
      return false;
    }
    const s = this.session;
    if (!s) { turn.failure = { type: "planner_exit", ref: "planner not running" }; return false; }
    turn.legIndex++;
    const next = planner[turn.legIndex] as ModelString;
    turn.lastError = undefined;
    Object.assign(turn, newDeferred());
    try {
      await s.setModel(next);
      this.model = next;
      if (turn.failure) { turn.done("abort"); return true; }
      turn.live = true;
      await s.prompt(RETRY_NOTE);
    } catch (e) {
      this.failTurn(turn, "planner_exit", `retry_failed: ${message(e)}`);
    }
    return true;
  }

  // ── child lifecycle ─────────────────────────────────────────────────────────

  /** null when a live, current child is ready; else the failure ref for the run. */
  private async ensureSession(): Promise<string | null> {
    const { turnContext, chatId } = this.d;
    // compared only at turn start: a new lesson, identity edit, skill change or UTC day restarts the child here
    if (this.session && (this.stale || systemPromptFingerprint(turnContext, chatId) !== this.fingerprint)) await this.stopSession();
    if (this.session) return null;
    if (this.crashLooping()) { this.incident("planner_crash_loop", { exits: this.exits.length }); return "crash_loop"; }
    const pre = this.preflight();
    if (pre) return pre;
    return this.spawn();
  }

  private crashLooping(): boolean {
    const cutoff = Date.now() - CRASH_WINDOW_MS;
    this.exits = this.exits.filter((t) => t > cutoff);
    return this.exits.length >= CRASH_LIMIT;
  }

  /** Version pin at every spawn (tests included); wrapper hash and Seatbelt render unless skipped for unit tests. */
  private preflight(): string | null {
    const { cfg, distDir, ctx } = this.d;
    const v = (this.d.versionCheck ?? (() => checkOmpVersion(cfg)))();
    if (!v.ok) { this.incident("omp_version_mismatch", { version: v.version, expected: cfg.version }); return `omp_version_mismatch: ${v.reason}`; }
    if (this.d.skipPreflightForTest) return null;
    const w = verifyInstalledWrapper(distDir);
    if (!w.ok) { this.incident("wrapper_mismatch", { reason: w.reason }); return "wrapper_mismatch"; }
    try { writeSeatbeltProfiles(ctx); } catch (e) {
      this.incident("sandbox_render_failed", { reason: message(e) });
      return "sandbox_render_failed";
    }
    return null;
  }

  /** Daemon-side dirs and files the sandboxed child cannot create itself (Seatbelt pins both roots). */
  private preparePaths(): { sessionDir: string; systemPromptFile: string; configFile: string; bridgeDir: string } {
    const { ctx, chatId, turnContext } = this.d;
    const omp = join(ctx.data, "omp");
    const sessionDir = join(omp, "sessions", `chat-${chatId}`);
    const bridgeDir = join(omp, "bridge");
    for (const dir of [this.workspace(), sessionDir, bridgeDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configFile = join(omp, "houge-config.yml");
    const tmp = `${configFile}.tmp-${process.pid}`;
    writeFileSync(tmp, HOUGE_CONFIG_YML, { mode: 0o600 });
    renameSync(tmp, configFile);
    const systemPromptFile = writeSystemPromptFile(turnContext, chatId);
    this.fingerprint = systemPromptFingerprint(turnContext, chatId);
    this.stale = false;
    return { sessionDir, systemPromptFile, configFile, bridgeDir };
  }

  private async spawn(): Promise<string | null> {
    const { ctx, chatId, distDir, cfg } = this.d;
    this.st = "STARTING";
    const p = this.preparePaths();
    const token = randomBytes(24).toString("hex");
    const sock = join(p.bridgeDir, `${chatId}-${randomUUID().slice(0, 8)}.sock`);
    if (Buffer.byteLength(sock) > MAX_SOCK_PATH) return this.startFailed(`bridge socket path over ${MAX_SOCK_PATH} bytes`);
    const gen = ++this.gen;
    this.model = this.top(); // a fresh child starts on the top planner string
    const opts: PlannerSessionOptions = {
      cfg, sessionDir: p.sessionDir, cwd: this.workspace(), systemPromptFile: p.systemPromptFile,
      extensions: [join(distDir, "omp", "extension", "houge.js")], bridgeSock: sock, bridgeToken: token, model: this.model,
      configFile: p.configFile, plannerProfile: join(ctx.data, "omp", "planner.sb")
    };
    try {
      const { manifestServed } = await this.listen(gen, sock, token);
      const s = (this.d.sessionFactory ?? ((o) => new PlannerSession(o)))(opts);
      s.onFrame((f) => this.onFrame(gen, f));
      s.onExit((i) => this.onExit(gen, i));
      this.session = s;
      await s.start();
      const served = await bounded(manifestServed, this.d.manifestWaitMs ?? MANIFEST_WAIT_MS);
      if (served === TIMED_OUT) throw new Error("no manifest");
    } catch (e) {
      await this.stopSession();
      return this.startFailed(message(e));
    }
    this.st = "IDLE";
    return null;
  }

  private startFailed(reason: string): string {
    this.st = "STOPPED";
    this.incident("planner_start_failed", { reason });
    return `start_failed: ${reason}`;
  }

  /** One listener per child; resolves the returned promise once a manifest request was answered (ruling 2). */
  private async listen(gen: number, sock: string, token: string): Promise<{ manifestServed: Promise<void> }> {
    const { store, cfg, ctx, decls, env, turnEnvelopeActions } = this.d;
    const inner = createBridgeHandler({ store, cfg, ctx, decls, env, turnEnvelopeActions, activeTurn: () => this.turn?.active ?? null });
    let served: () => void = () => undefined;
    const manifestServed = new Promise<void>((r) => { served = r; });
    const handle = async (req: BridgeRequest) => {
      const out = await inner(req);
      if (req.kind === "manifest") served();
      return out;
    };
    const bridge = await BridgeServer.listen(sock, token, handle);
    bridge.onDisconnect(() => { if (gen === this.gen && this.turn) void this.abortTurn("planner_exit", "bridge disconnected"); });
    this.bridge = bridge;
    return { manifestServed }; // wrapped: an async function returning a promise would adopt it and wait for the manifest
  }

  private async stopSession(): Promise<void> {
    const s = this.session; const b = this.bridge;
    this.session = undefined; this.bridge = undefined;
    this.gen++;
    clearTimeout(this.idleExit);
    if (!this.busy) this.st = "STOPPED";
    await s?.stop().catch((e) => console.error(`planner supervisor: stop failed: ${message(e)}`));
    await b?.close();
  }

  private onExit(gen: number, info: ExitInfo): void {
    if (gen !== this.gen) return; // an older child, or one we stopped on purpose
    this.gen++;
    if (!info.stopped) this.exits.push(Date.now());
    this.session = undefined;
    const b = this.bridge; this.bridge = undefined;
    void b?.close();
    clearTimeout(this.idleExit);
    this.st = "STOPPED";
    const t = this.turn;
    if (t && !info.stopped) {
      this.clearTimers(t);
      this.failTurn(t, "planner_exit", info.code !== null ? `exit ${info.code}` : `signal ${info.signal ?? "unknown"}`);
    }
  }

  // ── frames, deadlines, aborts ───────────────────────────────────────────────

  /** State changes only on the four listed frame types; every frame of the current child feeds the watchdog. */
  private onFrame(gen: number, f: OmpFrame): void {
    const t = this.turn;
    if (gen !== this.gen || !t) return;
    if (this.st === "RUNNING") this.armFrameIdle(t);
    if (f.type === "turn_start") t.n++;
    else if (f.type === "tool_execution_start") t.usedTool = true;
    else if (f.type === "message_end") this.onAssistant(t, summarizeAssistantMessage(f));
    else if (f.type === "agent_end") { t.live = false; t.done(f.aborted === true ? "abort" : "end"); }
  }

  /** One llm_attempt per model request, keyed `<run_id>:<n>` (spec §8). */
  private onAssistant(t: Turn, s: AssistantSummary | null): void {
    if (!s) return;
    const error = s.stopReason === "error" || s.errorMessage !== undefined ? (s.errorMessage ?? "error") : undefined;
    const model = s.model ?? this.model.model;
    const attempt: LlmAttempt = {
      provider: s.provider ?? this.model.provider, role: "", outcome: error ? "error" : "ok", model,
      family: familyOf({ model }), request_key: `${t.req.run_id}:${t.n}`,
      ...(error ? { error_kind: classifyOmpError(error) } : s.usage ? { usage: s.usage } : {}),
      ...(s.credentialId !== undefined ? { credential_id: s.credentialId } : {}),
      ...(s.ttftMs !== undefined ? { ttft_ms: s.ttftMs } : {}),
      ...(s.durationMs !== undefined ? { latency_ms: s.durationMs } : {})
    };
    this.d.store.llmAuditSink({ run_id: t.req.run_id, role: "compose" }).record(attempt);
    t.recorded = t.n;
    if (s.text.trim().length > 0) t.lastText = s.text;
    t.lastError = error;
  }

  private armDeadline(t: Turn): void {
    clearTimeout(t.deadline);
    t.deadlineAt = Date.now();
    t.deadline = setTimeout(() => void this.abortTurn("turn_timeout", "turn deadline"), Math.max(0, t.deadlineLeft));
  }

  private armFrameIdle(t: Turn): void {
    clearTimeout(t.idle);
    t.idle = setTimeout(() => void this.abortTurn("frame_idle", "no frame"), this.d.cfg.frameIdleMs);
  }

  private clearTimers(t: Turn): void {
    clearTimeout(t.deadline); clearTimeout(t.idle);
    t.deadline = undefined; t.idle = undefined;
  }

  /** The turn deadline and the frame watchdog pause while Paco is asked; the deadline resumes with what was left. */
  private setAwaitingApproval(on: boolean): void {
    const t = this.turn;
    if (!t) return;
    if (on && this.st === "RUNNING") {
      this.st = "AWAITING_APPROVAL";
      if (t.deadline) t.deadlineLeft -= Date.now() - t.deadlineAt;
      this.clearTimers(t);
    } else if (!on && this.st === "AWAITING_APPROVAL") {
      this.st = "RUNNING";
      this.armDeadline(t);
      this.armFrameIdle(t);
    }
  }

  private async abortTurn(type: PlannerFailure, ref: string): Promise<void> {
    const t = this.turn;
    if (!t) return;
    t.failure ??= { type, ref };
    if (this.st === "ABORTING") return;
    this.st = "ABORTING";
    this.clearTimers(t);
    t.abort.abort(); // in-flight bridge calls and approval waits see the turn's signal
    if (!t.live) { t.done("abort"); return; }
    void this.session?.abort().catch(() => undefined);
    if ((await bounded(t.ended, ABORT_GRACE_MS)) !== TIMED_OUT) return;
    t.live = false;
    t.done("abort");
    await this.stopSession();
  }

  // ── terminal ────────────────────────────────────────────────────────────────

  private finishSuccess(t: Turn): void {
    const { store, outcome, chatId } = this.d;
    t.finished = true;
    flushUnreported(store, t.active);
    const { text, attachments } = parseAttachments(t.lastText, this.workspace());
    const base = { worker_id: t.worker, text, duration_ms: Date.now() - t.startedAt, tool_calls: t.active.budget.usage().tool_calls };
    outcome.complete({ ...base, run_id: t.req.run_id, attachments });
    for (const m of t.merged) outcome.complete({ ...base, run_id: m, merged_into: t.req.run_id, attachments: [] });
    store.recordChatTurn({ chat_id: chatId, run_id: t.req.run_id, role: "assistant", text, intent: assistantIntentFor(text, t.usedTool) });
  }

  private finishFailure(t: Turn, f: { type: PlannerFailure; ref: string }): void {
    const { store, outcome } = this.d;
    t.finished = true;
    flushUnreported(store, t.active);
    if (t.n > t.recorded) this.recordAborted(t);
    const base = { worker_id: t.worker, error_ref: f.ref, ...(t.lastText ? { partial: t.lastText } : {}) };
    outcome.fail({ ...base, run_id: t.req.run_id, error_type: f.type });
    for (const m of t.merged) outcome.fail({ ...base, run_id: m, error_type: "merged_parent_failed" });
  }

  /** A model request that never reached message_end is audited at turn end as error{aborted} (spec §8). */
  private recordAborted(t: Turn): void {
    const model = this.model.model;
    this.d.store.llmAuditSink({ run_id: t.req.run_id, role: "compose" }).record({
      provider: this.model.provider, role: "", outcome: "error", model, family: familyOf({ model }),
      request_key: `${t.req.run_id}:${t.n}`, error_kind: "aborted"
    });
    t.recorded = t.n;
  }
}
