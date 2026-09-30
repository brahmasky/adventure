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
  /** Runs after the claim, before the child starts or is prompted (voice/photo ingest). A failure fails the run `media_failed`. */
  resolveMessage?: (claim: ClaimedRun) => Promise<{ ok: true; text: string } | { ok: false; error_ref: string }>;
  sessionFactory?: (o: PlannerSessionOptions) => PlannerSessionLike;
  versionCheck?: () => ReturnType<typeof checkOmpVersion>;
  /** Unit tests only: skips the wrapper hash check and the Seatbelt render (the bridge socket stays real). */
  skipPreflightForTest?: boolean;
  /** How long a started child has to ask for its manifest (default MANIFEST_WAIT_MS). */
  manifestWaitMs?: number;
  /** How long `start()` (spawn → ready → open_session) may take (default START_WAIT_MS). */
  startWaitMs?: number;
}

export const RETRY_NOTE = "(The previous model was unavailable. Continue answering my last message.)";
export const KILLED_TEXT = "⏹ Stopped by /kill.";
export const TIMEOUT_TEXT = "⏱ I ran out of time on this one. Here is what I had so far:";
export const PLANNER_EXIT_TEXT = "⚠ My runtime stopped unexpectedly. Nothing was retried; the ledger shows what ran.";
export const MANIFEST_WAIT_MS = 15_000;
export const START_WAIT_MS = 30_000;
const RETRYABLE = new Set(["quota", "auth", "transport", "timeout", "model_missing"]);
const HEARTBEAT_MS = 30_000;
const ABORT_GRACE_MS = 5_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;
/** macOS sun_path is 104 bytes including the terminating NUL. */
const MAX_SOCK_PATH = 103;
const TIMED_OUT = Symbol("timed_out");
/** A turn step whose turn ended (abort, exit) before the step settled. */
const ENDED = Symbol("ended");
/** A start we stopped ourselves (abort, shutdown, replacement): no crash count, no incident. */
const START_SUPERSEDED = "start_failed: superseded";
const exitRef = (i: ExitInfo) => (i.code !== null ? `exit ${i.code}` : `signal ${i.signal ?? "unknown"}`);
/** omp profile config (spec §4): no xdev devices, no update checks, no telemetry. */
const HOUGE_CONFIG_YML = "tools:\n  xdev: false\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\ntelemetry:\n  otlpExportEnabled: false\n";

interface Turn {
  req: TurnRequest; claim: ClaimedRun; worker: string; startedAt: number; merged: string[];
  active: ActiveTurn; abort: AbortController; heartbeat: ReturnType<typeof setInterval>;
  /** Model requests seen (turn_start frames) and the last one an llm_attempt row was written for. */
  n: number; recorded: number; lastText: string; lastError: string | undefined; usedTool: boolean; legIndex: number;
  /** True while a prompt is out and its agent_end has not arrived: only then is a steer delivered. */
  live: boolean; finished: boolean;
  /** Per-turn abort guard (never the supervisor-wide state, which a previous turn may have left ABORTING). */
  aborting: boolean;
  /** A prompt was sent for this turn (an n = 0 failure still gets its llm_attempt row). */
  dispatched: boolean;
  /** Concurrent approval waits: the deadline stays paused until every one resolved. */
  approvals: number;
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
  /** Latched by 3 crash exits in 10 min; only resetCrashGuard() (/rearm, the sweep) clears it. */
  private crashLatched = false;
  /** The one start in flight (never two spawns); a child is ready only once it resolved null. */
  private startInFlight: Promise<string | null> | undefined;
  /** The spawn in progress: onExit records a start-phase crash here (counted once, there). */
  private spawning: { gen: number; exit?: string } | undefined;
  /** Resolves the current child's pending start/manifest waits when that child is replaced or stopped. */
  private supersede: () => void = () => undefined;
  /** A setModel failed or was cut off: the applied model is unknown, so the next turn resets to the top string. */
  private modelUnknown = false;
  private idleExit: ReturnType<typeof setTimeout> | undefined;
  private model: ModelString;

  constructor(private readonly d: SupervisorDeps) { this.model = this.top(); }
  state(): SupervisorState { return this.st; }
  markStale(): void { this.stale = true; }
  resetCrashGuard(): void { this.crashLatched = false; this.exits = []; }
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
  setAwaitingApprovalForTest(on: boolean): void { if (this.turn) this.setAwaitingApproval(this.turn, on); }

  /** /kill and a guard pause: every queued run fails `killed`, the live turn aborts, the child stops (≈5 s bound). */
  async abortAll(reason: "killed" | "guard"): Promise<void> {
    this.failQueued(reason);
    await this.abortTurn("killed", reason);
    await bounded(this.draining ?? Promise.resolve(), ABORT_GRACE_MS);
    await this.stopSession();
  }

  async shutdown(): Promise<void> {
    this.queue.length = 0; // left queued in the DB: the next boot dispatches them
    const t = this.turn;
    if (t) { t.failure ??= { type: "planner_exit", ref: "daemon shutdown" }; this.clearTimers(t); t.live = false; t.done("abort"); }
    await bounded(this.draining ?? Promise.resolve(), ABORT_GRACE_MS);
    await this.stopSession();
  }

  /** A queued run is claimed under its own planner owner so it can be failed (never left `queued`). */
  private failQueued(reason: string): void {
    const { store, cfg, chatId, outcome } = this.d;
    for (const q of this.queue.splice(0)) {
      const worker = `planner:${chatId}:${randomUUID()}`;
      if (store.claimRun(q.run_id, worker, cfg.leaseTtlS)) outcome.fail({ run_id: q.run_id, worker_id: worker, error_type: "killed", error_ref: reason });
    }
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
    this.st = this.session ? "IDLE" : "STARTING"; // never inherit a previous turn's ABORTING
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
      setAwaitingApproval: (on) => this.setAwaitingApproval(turn, on), postureOk: this.d.posture
    };
    const heartbeat = setInterval(() => this.renewLeases(), HEARTBEAT_MS);
    const turn: Turn = {
      req, claim, worker, startedAt: Date.now(), merged: [], active, abort, heartbeat, n: 0, recorded: 0, lastText: "", lastError: undefined, deadline: undefined, idle: undefined,
      usedTool: false, legIndex: 0, live: false, finished: false, aborting: false, dispatched: false, approvals: 0, ...newDeferred(),
      deadlineLeft: cfg.turnTimeoutMs, deadlineAt: Date.now()
    };
    this.armDeadline(turn); // the deadline covers child start and prompt build too
    return turn;
  }

  /** The lease keeps renewing while AWAITING_APPROVAL; losing the parent's lease aborts the turn (spec §7.1). */
  private renewLeases(): void {
    const t = this.turn;
    if (!t) return;
    const { store, cfg } = this.d;
    if (!store.heartbeat(t.req.run_id, t.worker, cfg.leaseTtlS)) { void this.abortTurn("lease_lost", "heartbeat refused"); return; }
    for (const m of [...t.merged]) if (!store.heartbeat(m, t.worker, cfg.leaseTtlS)) this.mergedLeaseLost(t, m);
  }

  /** A steered run whose renewal was refused leaves the turn (its terminal write belongs to its new owner). */
  private mergedLeaseLost(t: Turn, m: string): void {
    t.merged = t.merged.filter((x) => x !== m); // refused = no longer ours or no longer running: no terminal write
    this.incident("lease_lost", { run_id: m, parent_run_id: t.req.run_id });
  }

  /** Await a turn step, but give up as soon as the turn ended (an abort must never wait on a hung child call). */
  private step<T>(t: Turn, p: Promise<T>): Promise<T | typeof ENDED> {
    return Promise.race([p, t.ended.then((): typeof ENDED => ENDED)]);
  }

  private failTurn(turn: Turn, type: PlannerFailure, ref: string): void {
    turn.failure ??= { type, ref };
    turn.live = false;
    turn.done("abort");
  }

  private async startTurn(turn: Turn): Promise<void> {
    const { store, chatId, turnContext } = this.d;
    try {
      const text = await this.resolveText(turn);
      if (text === ENDED || turn.failure) return;
      const fail = await this.step(turn, this.ensureSession());
      if (fail === ENDED) { await this.settleStart(); return; } // ended while the child was starting
      if (turn.failure) return;
      if (fail) { this.failTurn(turn, "planner_exit", fail); return; }
      store.recordChatTurn({ chat_id: chatId, run_id: turn.req.run_id, role: "user", text });
      const prompt = await this.step(turn, buildTurnPrompt(turnContext, {
        run_id: turn.req.run_id, chat_id: chatId, message: text, source: turn.req.source,
        ...(turn.req.goal !== undefined ? { goal: turn.req.goal } : {})
      }));
      if (prompt === ENDED || turn.failure) return;
      await this.promptTop(turn, prompt);
    } catch (e) {
      this.failTurn(turn, "planner_exit", `start_failed: ${message(e)}`);
    }
  }

  /** The message the planner sees: the ingest hook's text (a failed ingest fails the turn `media_failed`), else the request text. */
  private async resolveText(turn: Turn): Promise<string | typeof ENDED> {
    if (!this.d.resolveMessage) return turn.req.text;
    const r = await this.step(turn, this.d.resolveMessage(turn.claim));
    if (r === ENDED) return ENDED;
    if (!r.ok) { this.failTurn(turn, "media_failed", r.error_ref); return ENDED; }
    return r.text;
  }

  /** A turn that ended mid-start finishes only after its start settled (stopped or failed): no late incident, no orphan child. */
  private async settleStart(): Promise<void> {
    if (this.startInFlight) await bounded(this.startInFlight, ABORT_GRACE_MS);
  }

  /** A later turn retries the top planner string once after a fallback (spec §8). */
  private async promptTop(turn: Turn, prompt: string): Promise<void> {
    const s = this.session;
    if (!s) { this.failTurn(turn, "planner_exit", "planner not running"); return; }
    this.st = "RUNNING";
    this.armFrameIdle(turn);
    if ((this.modelUnknown || !sameModel(this.model, this.top())) && (await this.resetTop(turn, s)) === ENDED) return;
    if (turn.failure) return;
    try {
      turn.live = true;
      turn.dispatched = true;
      await this.step(turn, s.prompt(prompt));
    } catch (e) {
      this.failTurn(turn, "planner_exit", `prompt_failed: ${message(e)}`);
    }
  }

  /** A failed reset is not fatal: log, raise an incident, answer on the current model; the next turn retries it. */
  private async resetTop(turn: Turn, s: PlannerSessionLike): Promise<void | typeof ENDED> {
    this.modelUnknown = true; // until set_model AND set_thinking_level both succeeded
    try {
      if ((await this.step(turn, s.setModel(this.top()))) === ENDED) return ENDED;
      this.model = this.top();
      this.modelUnknown = false;
    } catch (e) {
      console.error(`planner supervisor: reset to the top planner string failed: ${message(e)}`);
      this.incident("planner_model_reset_failed", { run_id: turn.req.run_id, reason: message(e) });
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
    if (!RETRYABLE.has(kind)) { turn.failure = { type: "model_error", ref: kind }; return false; }
    if (turn.legIndex + 1 >= planner.length) {
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
      this.modelUnknown = true;
      if ((await this.step(turn, s.setModel(next))) === ENDED) return true;
      this.model = next;
      this.modelUnknown = false;
      if (turn.failure) { turn.done("abort"); return true; }
      turn.live = true;
      await this.step(turn, s.prompt(RETRY_NOTE));
    } catch (e) {
      this.failTurn(turn, "planner_exit", `retry_failed: ${message(e)}`);
    }
    return true;
  }

  // ── child lifecycle ─────────────────────────────────────────────────────────

  /** null when a live, current child is ready; else the failure ref for the run. */
  private async ensureSession(): Promise<string | null> {
    const { turnContext, chatId } = this.d;
    // never two spawns: join the start in flight; if it did not produce a ready child, this turn makes its own attempt
    while (this.startInFlight) if ((await this.startInFlight) === null && this.session) return null;
    // compared only at turn start: a new lesson, identity edit, skill change or UTC day restarts the child here
    if (this.session && (this.stale || systemPromptFingerprint(turnContext, chatId) !== this.fingerprint)) await this.stopSession();
    if (this.session) return null;
    if (this.crashLooping()) return "crash_loop";
    const pre = this.preflight();
    if (pre) return pre;
    const p: Promise<string | null> = this.spawn().finally(() => { if (this.startInFlight === p) this.startInFlight = undefined; });
    this.startInFlight = p;
    return p;
  }

  /** 3 crash exits within 10 min latch the guard (incident once); it holds until resetCrashGuard(). */
  private crashLooping(): boolean {
    if (this.crashLatched) return true;
    const cutoff = Date.now() - CRASH_WINDOW_MS;
    this.exits = this.exits.filter((t) => t > cutoff);
    if (this.exits.length < CRASH_LIMIT) return false;
    this.crashLatched = true;
    this.incident("planner_crash_loop", { exits: this.exits.length });
    return true;
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
      this.incident("sandbox_unavailable", { reason: message(e) });
      return "sandbox_unavailable";
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
    const gen = this.bumpGen();
    const rec: { gen: number; exit?: string } = { gen };
    this.spawning = rec;
    const superseded = new Promise<void>((r) => { this.supersede = r; });
    this.model = this.top(); // a fresh child starts on the top planner string
    this.modelUnknown = false;
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
      await this.awaitStart(s.start(), superseded, this.d.startWaitMs ?? START_WAIT_MS, "start timed out");
      await this.awaitStart(manifestServed, superseded, this.d.manifestWaitMs ?? MANIFEST_WAIT_MS, "no manifest");
    } catch (e) {
      return this.spawnFailed(rec, e);
    } finally { if (this.spawning === rec) this.spawning = undefined; }
    if (!this.turn?.live) this.st = "IDLE";
    return null;
  }

  /** Bounded start wait that also ends (throws) the moment this child is stopped or replaced. */
  private async awaitStart(p: Promise<unknown>, superseded: Promise<void>, ms: number, timeoutReason: string): Promise<void> {
    const r = await bounded(Promise.race([p, superseded.then((): typeof ENDED => ENDED)]), ms);
    if (r === TIMED_OUT) throw new Error(timeoutReason);
    if (r === ENDED) throw new Error("superseded");
  }

  private bumpGen(): number {
    this.supersede();
    this.supersede = () => undefined;
    return ++this.gen;
  }

  /** Tell a child that crashed during start (counted by onExit) from one we stopped (superseded) from any other failure. */
  private async spawnFailed(rec: { gen: number; exit?: string }, e: unknown): Promise<string> {
    if (rec.exit !== undefined) { await this.stopSession(); return this.startFailed(`child ${rec.exit} during start`); }
    if (rec.gen !== this.gen) return START_SUPERSEDED;
    this.exits.push(Date.now()); // a failed start (timeout, no manifest, spawn error) is a crash exit
    await this.stopSession();
    return this.startFailed(message(e));
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
    this.bumpGen();
    clearTimeout(this.idleExit);
    if (!this.busy) this.st = "STOPPED";
    await s?.stop().catch((e) => console.error(`planner supervisor: stop failed: ${message(e)}`));
    await b?.close();
  }

  private onExit(gen: number, info: ExitInfo): void {
    if (gen !== this.gen) return; // an older child, or one we stopped on purpose
    const rec = this.spawning?.gen === gen ? this.spawning : undefined;
    this.bumpGen();
    if (!info.stopped) {
      this.exits.push(Date.now());
      if (rec) rec.exit = exitRef(info); // spawnFailed reports it; not counted twice
    }
    this.session = undefined;
    const b = this.bridge; this.bridge = undefined;
    void b?.close();
    clearTimeout(this.idleExit);
    this.st = "STOPPED";
    const t = this.turn;
    if (t && !info.stopped) {
      this.clearTimers(t);
      this.failTurn(t, "planner_exit", exitRef(info));
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
    const failed = s.stopReason === "error" || s.stopReason === "aborted" || s.errorMessage !== undefined;
    const error = failed ? (s.errorMessage ?? s.stopReason ?? "error") : undefined;
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
  private setAwaitingApproval(t: Turn, on: boolean): void {
    t.approvals = Math.max(0, t.approvals + (on ? 1 : -1));
    if (this.turn !== t) return; // a finished turn's late release never touches the next turn
    if (on && t.approvals === 1 && this.st === "RUNNING") {
      this.st = "AWAITING_APPROVAL";
      if (t.deadline) t.deadlineLeft -= Date.now() - t.deadlineAt;
      this.clearTimers(t);
    } else if (!on && t.approvals === 0 && this.st === "AWAITING_APPROVAL") {
      this.st = "RUNNING";
      this.armDeadline(t);
      this.armFrameIdle(t);
    }
  }

  private async abortTurn(type: PlannerFailure, ref: string): Promise<void> {
    const t = this.turn;
    if (!t) return;
    t.failure ??= { type, ref };
    if (t.aborting) return;
    t.aborting = true;
    this.st = "ABORTING";
    this.clearTimers(t);
    t.abort.abort(); // in-flight bridge calls and approval waits see the turn's signal
    if (!t.live) { // not prompted yet (or between legs): its pending step races `ended`
      t.done("abort");
      if (this.startInFlight) await this.stopSession(); // cancel the start: the next turn gets a fresh child
      return;
    }
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
    if (t.n > t.recorded || (t.dispatched && t.n === 0)) this.recordAborted(t);
    if (f.type === "turn_timeout" || f.type === "frame_idle") store.recordLoopHalted(t.req.run_id, { reason: f.type, steps: t.n });
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
