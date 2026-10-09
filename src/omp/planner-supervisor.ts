import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { BudgetLedger } from "../budget/budget-ledger.js";
import { errorCode, safeReason } from "../domain/error-code.js";
import type { Identity } from "../domain/types.js";
import type { Effort, TurnRole } from "../jev/tree-policy.js";
import type { LlmAttempt, LlmErrorKind } from "../llm/audit.js";
import type { TurnModality } from "../media/media-config.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { ClaimedRun, PlannerFailure, RunStore } from "../run/run-store.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { ACK_NUDGE_TEXT, isBareAck } from "./bare-ack.js";
import type { BridgeRequest } from "./bridge-protocol.js";
import { BridgeServer } from "./bridge-server.js";
import { createBridgeHandler, flushUnreported, type ActiveTurn } from "./bridge-handler.js";
import { selectorKey, STEP_UP } from "./model-roles.js";
import { familyOf, type ModelFamily, type ModelString } from "./model-string.js";
import { PLANNER_HEARTBEAT_MS, type OmpConfig } from "./omp-config.js";
import { classifyOmpError, frameErrorText, RETRYABLE_ERROR_KINDS, summarizeAssistantMessage, type AssistantSummary, type OmpFrame } from "./omp-frames.js";
import type { OmpCheckResult } from "./omp-version.js";
import { sharedOmpVersionCache } from "./omp-version-cache.js";
import { PlannerRpcError, PlannerSession, type ExitInfo, type PlannerSessionOptions } from "./planner-session.js";
import { realpathOrSelf, type PathContext } from "./protected-paths.js";
import type { RoleResolver } from "./role-resolver.js";
import { writeSeatbeltProfiles } from "./seatbelt.js";
import { resolveLessonSessionReset } from "./session-seed.js";
import { verifyInstalledWrapper } from "./shell-wrapper.js";
import { chatWorkspace } from "./workspace.js";
import type { ToolDeclaration } from "./tool-decls.js";
import {
  assistantIntentFor, appliedOf, buildTurnPrompt, claimAtDispatch, promptTextFingerprint, systemPromptFingerprint, writeSystemPromptFile,
  type AppliedSnapshot, type TurnContextDeps,
  type TurnPrompt
} from "./turn-context.js";

export type SupervisorState = "STOPPED" | "STARTING" | "IDLE" | "RUNNING" | "AWAITING_APPROVAL" | "ABORTING";
export type PlannerSessionLike = Pick<PlannerSession, "start" | "prompt" | "steer" | "abort" | "setModel" | "newSession" | "onFrame" | "onExit" | "stop">;
export interface TurnRequest {
  run_id: string; text: string; source: "telegram" | "schedule"; goal?: string; requester: Identity;
  /** A voice/photo turn: its text is a placeholder until resolveMessage ingests it, so it never steers (it queues as its own turn). */
  needsIngest?: boolean;
  /** Who may answer this turn's tool approvals when that is not the requester: the operator, for a schedule-born turn (B2). */
  approver?: Identity;
}
export interface TurnOutcomeSink {
  complete(i: { run_id: string; worker_id: string; text: string; attachments: string[]; duration_ms: number; tool_calls: number; merged_into?: string; buttons?: NotificationButton[] }): void;
  fail(i: { run_id: string; worker_id: string; error_type: PlannerFailure; error_ref: string; partial?: string }): void;
  incident(kind: string, detail: Record<string, unknown>): void;
  /** The version check passed: clear any open omp-check condition (omp_unavailable, a legacy omp_version_mismatch). */
  versionOk?(): void;
  /** A child started and is ready: clear this chat's start-condition incidents (crash loop, start failure, wrapper, sandbox). */
  startOk?(): void;
  /** The spawned child holds a transcript started on the current lesson set: clear this chat's planner_session_reset_failed. */
  sessionResetOk?(): void;
  /** The tree's planner leaf ended (Jev tree spec §6): the verdict row's handler outcome, for a turn routed with a verdict id. */
  routeEnd?(i: {
    run_id: string; verdict_id: string; handler_outcome: "planner_done" | "planner_failed"; model: string | null;
    fast_used_tool: boolean; pin_failed: boolean;
  }): void;
}
/** The tree's route for a planner turn (Jev tree spec §5): the role its own chain resolves from, the effort, the verdict row. */
export interface TurnRoute { role: TurnRole; effort: Effort | null; verdict_id: string | null }
/** A Telegram quote resolved to a stored turn (spec §2.2.1): its id for the new chat turn, its rendered prompt line. */
export interface QuoteRef { turn_id: string; line: string }
/** The decision point's outcome (ADR 0029 §5.1, Jev tree spec §2): a lane reply, or the planner with an optional route. */
export type TriageOutcome =
  | { kind: "fallthrough"; route?: TurnRoute; quote?: QuoteRef }
  | { kind: "inform"; note: string; route?: TurnRoute; quote?: QuoteRef }
  | { kind: "lane_reply"; text: string; buttons: NotificationButton[]; quote?: QuoteRef };
/** The lane gets the supervisor's own posture reading and the turn's abort signal; it never looks posture up itself. */
export interface TriageInput { claim: ClaimedRun; text: string; userText: string; modality: TurnModality; posture: string | null; signal: AbortSignal }
export interface SupervisorDeps {
  chatId: string; store: RunStore; cfg: OmpConfig; ctx: PathContext; distDir: string; decls: ToolDeclaration[];
  env: NodeJS.ProcessEnv; turnEnvelopeActions: string[]; turnContext: TurnContextDeps;
  buildTools: (claim: ClaimedRun) => { registry: ToolRegistry; quarantine: ActiveTurn["quarantine"]; preflight?: ActiveTurn["preflight"] };
  posture: () => string | null; outcome: TurnOutcomeSink;
  /**
   * Model roles (Jev tree spec §4-5): the child spawns on "default"'s candidates; each turn pins its own routed role's.
   * `requestRefresh` re-reads omp's catalog after a no_planner_leg (the resolver rate-limits it, plan F7).
   */
  roles: Pick<RoleResolver, "candidates" | "requestRefresh">;
  /**
   * Runs after the claim, before the child starts or is prompted (voice/photo ingest). A failure fails the run `media_failed`.
   * `text` is what the planner is prompted with; `userText`, when present, is what is stored as Paco's chat turn (a photo's
   * caption or placeholder: the image-derived digest is untrusted and never his words).
   */
  resolveMessage?: (claim: ClaimedRun) => Promise<{ ok: true; text: string; userText?: string; modality?: TurnModality } | { ok: false; error_ref: string }>;
  /** Lane 1 (ADR 0029 §5.1, slot B): awaited after resolveMessage, before the planner. Absent or throwing → today's path. */
  triage?: (i: TriageInput) => Promise<TriageOutcome>;
  sessionFactory?: (o: PlannerSessionOptions) => PlannerSessionLike;
  /** Injected check (tests); the default reads the shared per-binary cache (one exec per binary), so the loop stays free while omp answers. */
  versionCheck?: () => OmpCheckResult | Promise<OmpCheckResult>;
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
const ABORT_GRACE_MS = 5_000;
/** The failure ref of a turn the daemon's own stop cut short: its open request is audited error{shutdown}. */
const DAEMON_SHUTDOWN = "daemon shutdown";
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;
/** macOS sun_path is 104 bytes including the terminating NUL. */
const MAX_SOCK_PATH = 103;
const TIMED_OUT = Symbol("timed_out");
/** A turn step whose turn ended (abort, exit) before the step settled. */
const ENDED = Symbol("ended");
/** A start we stopped ourselves (abort, shutdown, replacement): no crash count, no incident. */
const START_SUPERSEDED = "start_failed: superseded";
/** Memory A1 §6 (final-review ruling A4): the consecutive failed lesson-change resets after which a spawn serves resumed. */
export const RESET_DEGRADE_AFTER = 3;
/** A start whose child omp rejected for its --model (live, 18.4.4: exits before ready): Default's next candidate is tried. */
const START_MODEL_MISSING = "exited:model_missing";
/** The Default role has no candidate this child sequence has not refused: the spawn axis is spent (spec §4). */
const NO_SPAWN_MODEL = "no_spawn_model";
/** Before any child: the Default role resolved nothing, so the intended model is unknown (audit rows say so). */
const UNRESOLVED_MODEL: ModelString = { provider: "unresolved", model: "unresolved" };
/** null = a ready child; string = the start failure ref; missing = omp rejected that selector at spawn. */
type StartResult = string | null | { missing: ModelString };
/** One pin: done, refused by omp (walk on), the turn ended, or any other failure (transport, timeout, set_thinking_level). */
type PinResult = "ok" | "refused" | typeof ENDED | { error: unknown };
const exitRef = (i: ExitInfo) => (i.code !== null ? `exit ${i.code}` : `signal ${i.signal ?? "unknown"}`);
/** omp profile config (spec §4): no xdev devices, no update checks, no telemetry. */
const HOUGE_CONFIG_YML = "tools:\n  xdev: false\nstartup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\ntelemetry:\n  otlpExportEnabled: false\n";

interface SpawnRec { gen: number; model: ModelString; exit?: string; started?: Promise<unknown>; bridgeLost?: boolean }

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
  /** The child generation this turn committed to (set as promptTop begins; -1 before): only its bridge loss aborts the turn. */
  childGen: number;
  /** Concurrent approval waits: the deadline stays paused until every one resolved. */
  approvals: number;
  done: (r: "end" | "abort") => void; ended: Promise<"end" | "abort">;
  deadlineLeft: number; deadlineAt: number; deadline: ReturnType<typeof setTimeout> | undefined; idle: ReturnType<typeof setTimeout> | undefined;
  failure?: { type: PlannerFailure; ref: string };
  /** A lane reply's card buttons, handed to finishSuccess (ADR 0029 §5.1). */
  laneButtons?: NotificationButton[];
  /** Spec §5 turn axis: the tree's route (null = unrouted: no step-up, no `other` retry), the role and effort its chain resolves from. */
  route: TurnRoute | null; role: TurnRole; effort: Effort | null;
  /** The turn's candidates (legIndex indexes it), resolved after the child is ready so a spawn refusal is excluded. */
  chain: ModelString[];
  /** The verdict id the turn's FIRST llm_attempt carries as routed_by (spec §6); cleared once written. */
  routedBy: string | undefined;
  /** Spawn refusals (keys `<run>:0:<k>`) and candidates tried (planner_no_leg's legs_tried) in this turn. */
  startMissing: number; legsTried: number;
  /** `other` was retried once (spec §4); the first pin failed in transport (pin_failed: no step-up on this child). */
  retriedOther: boolean; pinFailed: boolean;
  /** Selectors (effort-agnostic) that failed THIS turn with a kind other than `other`: a step-up never re-spends them. */
  failed: Set<string>;
  /** The lane owns this turn's terminal: a late start result may no longer fail or re-enter it. */
  laneEnded: boolean;
}

/** Error text for error_refs, incidents and logs: a code or a short path-free reason, never an fs message (M-6). */
const message = (e: unknown) => safeReason(e);
/** A planner RPC failure as a fixed code (command_failed:<type>, timeout:<type>, …) or an errno code; never omp's text. */
const rpcCode = (e: unknown) => (e instanceof PlannerRpcError ? e.code : errorCode(e));
/** omp refused the pinned model (`Model not found: …`, spec §5): omp's text is read here, classified, and dropped. */
const isModelRefusal = (e: unknown) =>
  e instanceof PlannerRpcError && e.code === "command_failed:set_model" && classifyOmpError(e.detail ?? "") === "model_missing";
const quotedId = (q: QuoteRef | undefined) => (q ? { quoted_turn_id: q.turn_id } : {});
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
  /** What the live child's system prompt holds (spawn-time): each turn's attribution credits exactly these ids. */
  private applied: AppliedSnapshot = { lessonIds: [], lessonScopes: [], skillScopes: [], coreFactIds: [], skippedLessonIds: [] };
  /** The lesson set the spawned prompt rendered (memory A1 §6): what a reset compares and records. */
  private lessonFingerprint: string | undefined;
  /** Consecutive failed lesson-change resets for one fingerprint: the 3rd serves the resumed session (fail loud, not closed). */
  private resetFailures = { fingerprint: "", count: 0 };
  /**
   * The child generation whose own new_session succeeded (0: none). Only a dispatch to THAT child may commit the pending
   * reset: a child that resumed (degraded, flag off, unreadable lessons) holds the OLD transcript, since omp skips the
   * empty new one.
   */
  private resetGen = 0;
  private stale = false;
  private turn: Turn | undefined;
  private readonly queue: TurnRequest[] = [];
  private busy = false;
  private draining: Promise<void> | undefined;
  private idleWaiters: Array<() => void> = [];
  private exits: number[] = [];
  /** Latched by 3 crash exits in 10 min; only resetCrashGuard() (/rearm, or the daemon after each sweep) clears it. */
  private crashLatched = false;
  /** The one start in flight (never two spawns); a child is ready only once it resolved null. */
  private startInFlight: Promise<StartResult> | undefined;
  /** The spawn in progress: onExit records a start-phase crash here (counted once, there). */
  private spawning: SpawnRec | undefined;
  /** Selectors this child refused at spawn or at a pin (spec §4 step 4): skipped for its life; cleared when a fresh spawn starts. */
  private refused = new Set<string>();
  /** Resolves the current child's pending start/manifest waits when that child is replaced or stopped. */
  private supersede: () => void = () => undefined;
  /** A setModel failed or was cut off: the applied model is unknown, so the next turn re-pins its own first candidate. */
  private modelUnknown = false;
  private idleExit: ReturnType<typeof setTimeout> | undefined;
  /** The model the supervisor intends the child to run (the spawn candidate, then each turn's pinned candidate). */
  private model: ModelString;
  /** The model omp last reported in an assistant message_end: what really answered (live gate 2026-10-01). */
  private actual: { provider: string; model: string } | undefined;
  /** The omp version the last spawn's preflight read (houge_status reports it; never a new spawn). */
  private checkedVersion: string | null = null;

  constructor(private readonly d: SupervisorDeps) { this.model = this.spawnChain()[0] ?? UNRESOLVED_MODEL; }

  /** The planner's CURRENT family — the model it actually ran on when known, else the intended one (D10 reader check). */
  plannerFamily(): ModelFamily { return familyOf(this.actual ?? this.model); }
  /** The omp version the last spawn check read; null before any child started. */
  ompVersion(): string | null { return this.checkedVersion; }
  /** The provider/model omp last reported answering with; undefined until a message_end since the last spawn. */
  answeredModel(): { provider: string; model: string } | undefined { return this.actual ? { ...this.actual } : undefined; }
  state(): SupervisorState { return this.st; }
  markStale(): void { this.stale = true; }
  resetCrashGuard(): void { this.crashLatched = false; this.exits = []; }
  whenIdle(): Promise<void> {
    return this.busy || this.queue.length > 0 ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }

  submit(req: TurnRequest): void {
    const t = this.turn;
    // a message steers only into a Telegram turn: never into a schedule-born one (provenance, B2) — it queues behind it
    const live = t?.live && t.req.source === "telegram" && req.source === "telegram" && !req.needsIngest;
    // Slot A (ADR 0029 §5.1): a bare ack while an approval card waits is consent to nothing — nudge, never steer or queue.
    if (live && this.st === "AWAITING_APPROVAL" && isBareAck(req.text)) { this.nudgeAck(t, req); return; }
    if (live && (this.st === "RUNNING" || this.st === "AWAITING_APPROVAL")) {
      void this.steer(t, req).catch((e) => this.incident("planner_steer_failed", { run_id: req.run_id, reason: rpcCode(e) }));
      return;
    }
    this.queue.push(req);
    if (!this.busy) this.draining = this.drain();
  }

  /** The nudged run completes on its own, code-owned, with zero tool calls; the waiting turn is untouched. */
  private nudgeAck(waiting: Turn, req: TurnRequest): void {
    const { store, chatId, cfg, outcome } = this.d;
    const worker = `planner:${chatId}:nudge:${randomUUID()}`;
    if (!store.claimRun(req.run_id, worker, cfg.leaseTtlS)) return;
    store.recordChatTurn({ chat_id: chatId, run_id: req.run_id, role: "user", text: req.text });
    store.appendRunLedgerEvent(req.run_id, "ack_nudged", "core", { approval_run_id: waiting.req.run_id });
    store.recordChatTurn({ chat_id: chatId, run_id: req.run_id, role: "assistant", text: ACK_NUDGE_TEXT, intent: "loop" });
    outcome.complete({ run_id: req.run_id, worker_id: worker, text: ACK_NUDGE_TEXT, attachments: [], duration_ms: 0, tool_calls: 0 });
  }

  /** @internal Tests only: the same entry point the bridge receives through ActiveTurn.setAwaitingApproval. */
  setAwaitingApprovalForTest(on: boolean): void { if (this.turn) this.setAwaitingApproval(this.turn, on); }

  /** /kill and a guard pause: every queued run fails `killed`, the live turn aborts, the child stops (≈5 s bound). */
  async abortAll(reason: "killed" | "guard"): Promise<void> {
    this.failQueued("killed", reason);
    await this.abortTurn("killed", reason);
    await bounded(this.draining ?? Promise.resolve(), ABORT_GRACE_MS);
    await this.stopSession();
  }

  /** Daemon exit: nothing dispatches queued runs at boot, so every unstarted request fails planner_exit now (never orphaned). */
  async shutdown(): Promise<void> {
    this.failQueued("planner_exit", DAEMON_SHUTDOWN);
    const t = this.turn;
    // the turn's signal wakes approval waiters and in-flight adapters: nothing holds the process after SIGTERM (M4)
    if (t) { t.failure ??= { type: "planner_exit", ref: DAEMON_SHUTDOWN }; this.clearTimers(t); t.abort.abort(); t.live = false; t.done("abort"); }
    await bounded(this.draining ?? Promise.resolve(), ABORT_GRACE_MS);
    await this.stopSession();
  }

  /** A queued run is claimed under its own planner owner so it can be failed (never left `queued`). */
  private failQueued(type: "killed" | "planner_exit", reason: string): void {
    const { store, cfg, chatId, outcome } = this.d;
    for (const q of this.queue.splice(0)) {
      const worker = `planner:${chatId}:${randomUUID()}`;
      if (store.claimRun(q.run_id, worker, cfg.leaseTtlS)) outcome.fail({ run_id: q.run_id, worker_id: worker, error_type: type, error_ref: reason });
    }
  }

  /** The spawn axis (spec §5): the Default role's candidates, minus what this child sequence refused. */
  private spawnChain(): ModelString[] { return this.d.roles.candidates("default", { refused: this.refused }); }
  /** The turn axis (spec §5): the routed role's candidates at the routed effort, minus what this child refused. */
  private turnChain(role: TurnRole, effort: Effort | null): ModelString[] {
    return this.d.roles.candidates(role, { refused: this.refused, effort });
  }
  private workspace(): string { return chatWorkspace(this.d.ctx.data, this.d.chatId); }
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
      this.d.outcome.fail({ run_id: req.run_id, worker_id: turn.worker, error_type: "planner_exit", error_ref: `steer_failed: ${rpcCode(e)}` });
    }
  }

  private async runTurn(req: TurnRequest): Promise<void> {
    const worker = `planner:${this.d.chatId}:${randomUUID()}`;
    const claim = this.d.store.claimRun(req.run_id, worker, this.d.cfg.leaseTtlS);
    if (!claim) return;
    clearTimeout(this.idleExit);
    const turn = this.newTurnOrFail(req, worker, claim);
    if (!turn) return;
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

  /** A setup throw after the claim (tools, fs, SQLite busy) fails the run now instead of stranding it to lease expiry (B1). */
  private newTurnOrFail(req: TurnRequest, worker: string, claim: ClaimedRun): Turn | undefined {
    try { return this.newTurn(req, worker, claim); } catch (e) {
      this.incident("planner_turn_crashed", { run_id: req.run_id, reason: message(e) });
      this.d.outcome.fail({ run_id: req.run_id, worker_id: worker, error_type: "planner_exit", error_ref: `turn_setup_failed: ${message(e)}` });
      return undefined;
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
      setAwaitingApproval: (on) => this.setAwaitingApproval(turn, on), postureOk: this.d.posture,
      ...(req.approver ? { approver: req.approver } : {}), ...(tools.preflight ? { preflight: tools.preflight } : {})
    };
    const heartbeat = setInterval(() => this.renewLeases(), PLANNER_HEARTBEAT_MS);
    const turn: Turn = {
      req, claim, worker, startedAt: Date.now(), merged: [], active, abort, heartbeat, n: 0, recorded: 0, lastText: "", lastError: undefined, deadline: undefined, idle: undefined,
      usedTool: false, legIndex: 0, live: false, finished: false, laneEnded: false, aborting: false, dispatched: false, childGen: -1, approvals: 0, ...newDeferred(),
      route: null, role: "default", effort: null, chain: [], routedBy: undefined, startMissing: 0, legsTried: 0, retriedOther: false, pinFailed: false, failed: new Set(),
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
    if (turn.finished || turn.laneEnded) return; // ADR 0029 §5.1: a late spawn result never mutates a lane-ended turn
    turn.failure ??= { type, ref };
    turn.live = false;
    turn.done("abort");
  }

  private async startTurn(turn: Turn): Promise<void> {
    const { store, chatId, turnContext } = this.d;
    try {
      const resolved = await this.resolveText(turn);
      if (resolved === ENDED || turn.failure) return;
      const { text, userText, modality } = resolved;
      // Slot B (ADR 0029 §5.1): the child starts now; only planner paths await it. `warm` never rejects: a start failure
      // is the spawn's own incident (or a string result), never this turn's.
      const warm: Promise<StartResult> = this.ensureSession(true).catch((e): StartResult => `spawn_failed: ${message(e)}`);
      const verdict = await this.triage(turn, { claim: turn.claim, text, userText, modality, posture: this.d.posture(), signal: turn.abort.signal });
      if (verdict === ENDED || turn.failure) return;
      if (verdict.kind === "lane_reply") { await this.finishLane(turn, userText, verdict, warm); return; }
      this.routeTurn(turn, verdict.route);
      const promptMessage = verdict.kind === "inform" ? `${verdict.note}\n\n${text}` : text;
      if (!(await this.ensureReady(turn, warm))) return;
      store.recordChatTurn({ chat_id: chatId, run_id: turn.req.run_id, role: "user", text: userText, ...quotedId(verdict.quote) });
      const prompt = await this.step(turn, buildTurnPrompt(turnContext, {
        run_id: turn.req.run_id, chat_id: chatId, message: promptMessage, source: turn.req.source, applied: this.applied,
        ...(turn.req.goal !== undefined ? { goal: turn.req.goal } : {}), ...(verdict.quote ? { quoted: verdict.quote.line } : {})
      }));
      if (prompt === ENDED || turn.failure) return;
      if (this.stale && !(await this.ensureReady(turn))) return; // the child lost its bridge during the prompt build
      await this.promptTop(turn, prompt);
    } catch (e) {
      this.failTurn(turn, "planner_exit", `start_failed: ${message(e)}`);
    }
  }

  /** The tree's route for this turn (spec §5); an unrouted turn (no triage, a schedule fire, a throw) runs on Default. */
  private routeTurn(turn: Turn, route: TurnRoute | undefined): void {
    turn.route = route ?? null;
    turn.role = route?.role ?? "default";
    turn.effort = route?.effort ?? null;
    turn.routedBy = route?.verdict_id ?? undefined;
  }

  /** Any triage error is today's path; the reason is a closed enum (an Error message may carry bound values). */
  private async triage(turn: Turn, i: TriageInput): Promise<TriageOutcome | typeof ENDED> {
    if (!this.d.triage || turn.req.source !== "telegram") return { kind: "fallthrough" };
    try {
      return await this.step(turn, this.d.triage(i));
    } catch (e) {
      console.error(`planner supervisor: triage threw: ${message(e)}`);
      this.incident("triage_threw", { run_id: turn.req.run_id, reason: "triage_threw" });
      return { kind: "fallthrough" };
    }
  }

  /**
   * Lane terminal (spec §5.1 "one terminal owner"): record the user turn, hand the card to finishSuccess through
   * lastText/laneButtons, make sure no start can still touch this turn, then end it. settle() → finishSuccess records
   * the assistant turn and completes the run once, with tool_calls 0 from the untouched budget.
   */
  private async finishLane(turn: Turn, userText: string, v: Extract<TriageOutcome, { kind: "lane_reply" }>, warm: Promise<StartResult>): Promise<void> {
    // Order matters (Codex plan review): everything that can throw runs BEFORE laneEnded; after it, completion is
    // guaranteed by the finally. A throw before laneEnded reaches startTurn's catch → failTurn.
    this.d.store.recordChatTurn({ chat_id: this.d.chatId, run_id: turn.req.run_id, role: "user", text: userText, ...quotedId(v.quote) });
    if ((await bounded(warm, ABORT_GRACE_MS)) === TIMED_OUT) { await this.stopSession(); await this.settleStart(); } // supersede a start that will not settle (gen bump)
    turn.lastText = v.text;
    turn.laneButtons = v.buttons;
    turn.laneEnded = true; // from here a late start result may not fail or re-enter this turn
    try { turn.live = false; } finally { turn.done("end"); }
  }

  /** A ready child for the turn, or false with the turn already failed/ended. */
  private async ensureReady(turn: Turn, warm?: Promise<StartResult>): Promise<boolean> {
    if (turn.finished || turn.laneEnded) return false;
    const fail = await this.startSession(turn, warm);
    if (fail === ENDED) { await this.settleStart(); return false; } // ended while the child was starting
    if (turn.failure) return false;
    if (fail) { this.failTurn(turn, "planner_exit", fail); return false; }
    return true;
  }

  /**
   * The message the planner sees (the ingest hook's text; a failed ingest fails the turn `media_failed`, else the request
   * text) and the text stored as the user's turn (the hook's userText when it gives one, else the same text).
   */
  private async resolveText(turn: Turn): Promise<{ text: string; userText: string; modality: TurnModality } | typeof ENDED> {
    if (!this.d.resolveMessage) return { text: turn.req.text, userText: turn.req.text, modality: "text" };
    const r = await this.step(turn, this.d.resolveMessage(turn.claim));
    if (r === ENDED) return ENDED;
    if (!r.ok) { this.failTurn(turn, "media_failed", r.error_ref); return ENDED; }
    return { text: r.text, userText: r.userText ?? r.text, modality: r.modality ?? "text" };
  }

  /** A turn that ended mid-start finishes only after its start settled (stopped or failed): no late incident, no orphan child. */
  private async settleStart(): Promise<void> {
    if (this.startInFlight) await bounded(this.startInFlight, ABORT_GRACE_MS);
  }

  /** Spec §5: before the first prompt the child is pinned to the turn's OWN first candidate, never to the spawn leg. */
  private async promptTop(turn: Turn, prompt: TurnPrompt): Promise<void> {
    const s = this.session;
    if (!s) { this.failTurn(turn, "planner_exit", "planner not running"); return; }
    turn.childGen = this.gen;
    this.st = "RUNNING";
    this.armFrameIdle(turn);
    turn.legIndex = 0;
    turn.chain = this.turnChain(turn.role, turn.effort);
    if ((await this.pinFirst(turn, s)) === ENDED || turn.failure) return;
    try {
      const sent = claimAtDispatch(this.d.store, this.d.chatId, prompt, this.d.turnContext.pid);
      turn.live = true;
      turn.dispatched = true;
      if ((await this.step(turn, s.prompt(sent))) !== ENDED) this.commitReset(turn);
    } catch (e) {
      this.failTurn(turn, "planner_exit", `prompt_failed: ${rpcCode(e)}`);
    }
  }

  /**
   * A refused pin already walked on inside pinWalk; no candidate left is no_planner_leg. Any other pin failure is not
   * fatal: incident, answer on the model the child holds, row marked pin_failed, no step-up (spec §5).
   */
  private async pinFirst(turn: Turn, s: PlannerSessionLike): Promise<void | typeof ENDED> {
    const r = await this.pinWalk(turn, s, "model_missing");
    if (r === ENDED) return ENDED;
    if (r === "exhausted") { this.noLeg(turn, "model_missing", turn.legsTried); this.failTurn(turn, "no_planner_leg", "model_missing"); return; }
    if (r === "ok") return;
    turn.pinFailed = true;
    console.error(`planner supervisor: pinning the turn's model failed: ${rpcCode(r.error)}`);
    this.incident("planner_model_reset_failed", { run_id: turn.req.run_id, reason: rpcCode(r.error) });
  }

  /** The turn's current candidate on the child; a pin omp refuses is one model_missing row and the walk moves on (spec §5). */
  private async pinWalk(turn: Turn, s: PlannerSessionLike, kind: LlmErrorKind): Promise<Exclude<PinResult, "refused"> | "exhausted"> {
    for (let why = kind; ; why = "model_missing") {
      const target = this.currentCandidate(turn, why);
      if (!target) return "exhausted";
      turn.legsTried++;
      if (!this.modelUnknown && sameModel(this.model, target)) return "ok";
      const r = await this.pin(turn, s, target);
      if (r !== "refused") return r;
      turn.legIndex++;
    }
  }

  /** chain[legIndex]; a spent chain steps a routed turn up a role (spec §4: Fast → Default → Thinking), ledgered. */
  private currentCandidate(turn: Turn, kind: LlmErrorKind): ModelString | undefined {
    for (;;) {
      const m = turn.chain[turn.legIndex];
      if (m) return m;
      if (!this.stepUp(turn, kind)) return undefined;
    }
  }

  /** Only a routed turn steps up, and never one whose first pin failed (the child's model is unknown). */
  private stepUp(turn: Turn, kind: LlmErrorKind): boolean {
    const to = turn.route && !turn.pinFailed ? STEP_UP[turn.role] : null;
    if (!to) return false;
    this.d.store.appendRunLedgerEvent(turn.req.run_id, "routed_escalation", "core", { from: turn.role, to, kind });
    turn.role = to;
    turn.legIndex = 0;
    // Default and Thinking share provider/model pairs: one that failed this turn (quota, auth, …) fails at any effort
    turn.chain = this.turnChain(to, turn.effort).filter((m) => !turn.failed.has(selectorKey(m)));
    return true;
  }

  /** set_model then set_thinking_level (planner-session.ts setModel); `model` moves only when both succeeded. */
  private async pin(turn: Turn, s: PlannerSessionLike, target: ModelString): Promise<PinResult> {
    this.modelUnknown = true; // until set_model AND set_thinking_level both succeeded
    try {
      if ((await this.step(turn, s.setModel(target))) === ENDED) return ENDED;
    } catch (e) {
      if (!isModelRefusal(e)) return { error: e };
      this.refused.add(selectorKey(target)); // a model can stay catalogued while refusing: never pinned again on this child
      this.recordPinMissing(turn, target);
      return "refused";
    }
    this.model = target;
    this.modelUnknown = false;
    this.actual = undefined; // the next message_end reports what the pin really produced
    return "ok";
  }

  /** planner_no_leg (spec §4: Thinking spent, or an unrouted Default spent), as today. */
  private noLeg(turn: Turn, kind: LlmErrorKind, tried: number): void {
    this.incident("planner_no_leg", { run_id: turn.req.run_id, error_kind: kind, legs_tried: tried });
    this.d.roles.requestRefresh(); // the catalog may have moved since the last read (plan F7 d; at most once per 10 min)
  }

  /** The prompt RPC succeeded on the child that made the pending reset: its transcript now holds a turn, so commit it. */
  private commitReset(turn: Turn): void {
    if (this.resetGen === 0 || this.resetGen !== turn.childGen || this.session === undefined) return;
    this.d.store.promotePlannerSession(this.d.chatId);
    this.resetGen = 0;
  }

  private async settle(turn: Turn): Promise<void> {
    for (;;) {
      const how = await turn.ended;
      // an abort omp reported itself (no supervisor failure set) is never a success (B6)
      if (how === "abort" && !turn.failure) turn.failure = { type: "planner_exit", ref: "agent_aborted" };
      if (turn.failure || turn.lastError === undefined) break;
      if (!(await this.retryNextLeg(turn, turn.lastError))) break;
    }
    this.clearTimers(turn);
    if (turn.failure) this.finishFailure(turn, turn.failure);
    else this.finishSuccess(turn);
  }

  /**
   * Spec §4: a retryable kind — or `other` once, on a routed turn, while no tool has run (a failure after a side effect
   * is never re-spent on another model) — walks the turn's chain, then steps a routed turn up; else final.
   */
  private async retryNextLeg(turn: Turn, error: string): Promise<boolean> {
    const kind = classifyOmpError(error);
    if (kind !== "other") turn.failed.add(selectorKey(this.model));
    if (!this.mayRetry(turn, kind)) { turn.failure = { type: "model_error", ref: kind }; return false; }
    const s = this.session;
    if (!s) { turn.failure = { type: "planner_exit", ref: "planner not running" }; return false; }
    if (kind === "other") turn.retriedOther = true;
    turn.legIndex++;
    turn.lastError = undefined;
    Object.assign(turn, newDeferred());
    return this.promptRetry(turn, s, kind);
  }

  private mayRetry(turn: Turn, kind: LlmErrorKind): boolean {
    if (RETRYABLE_ERROR_KINDS.has(kind)) return true;
    return kind === "other" && turn.route !== null && !turn.usedTool && !turn.retriedOther;
  }

  /** Pin the next candidate and tell it to continue (RETRY_NOTE); the transcript already holds every executed tool's result. */
  private async promptRetry(turn: Turn, s: PlannerSessionLike, kind: LlmErrorKind): Promise<boolean> {
    try {
      const r = await this.pinWalk(turn, s, kind);
      if (r === ENDED) return true;
      if (r === "exhausted") {
        turn.failure = { type: "no_planner_leg", ref: kind };
        this.noLeg(turn, kind, turn.legsTried);
        return false;
      }
      if (r !== "ok") throw r.error;
      if (turn.failure) { turn.done("abort"); return true; }
      turn.live = true;
      await this.step(turn, s.prompt(RETRY_NOTE));
    } catch (e) {
      this.failTurn(turn, "planner_exit", `retry_failed: ${rpcCode(e)}`);
    }
    return true;
  }

  // ── child lifecycle ─────────────────────────────────────────────────────────

  /**
   * null when a live, current child is ready; else the failure ref for the run. `fresh` = a new spawn sequence: the last
   * child's refused set is no evidence for this one (spec §4 step 4), so it clears; false after a start refusal.
   */
  private async ensureSession(fresh: boolean): Promise<StartResult> {
    const { turnContext, chatId } = this.d;
    // never two spawns: join the start in flight; if it did not produce a ready child, this turn makes its own attempt
    while (this.startInFlight) if ((await this.startInFlight) === null && this.session) return null;
    // compared only at turn start: a new lesson, identity edit, skill change or UTC day restarts the child here.
    // A child on a later Default candidate is kept (spec §5): set_model moves it to any turn's candidate.
    const refresh = this.stale || systemPromptFingerprint(turnContext, chatId) !== this.fingerprint;
    if (this.session && refresh) await this.stopSession();
    if (this.session) return null;
    if (this.crashLooping()) return "crash_loop";
    // in flight from here: the preflight awaits omp --version, and a turn arriving meanwhile must join, not spawn twice
    const p: Promise<StartResult> = this.preflightThenSpawn(fresh).finally(() => { if (this.startInFlight === p) this.startInFlight = undefined; });
    this.startInFlight = p;
    return p;
  }

  private async preflightThenSpawn(fresh: boolean): Promise<StartResult> {
    const gen0 = this.gen; // a stop (abortAll, shutdown, finishLane) bumps gen during the awaited check: never spawn after it
    const pre = await this.preflight();
    if (this.gen !== gen0) return START_SUPERSEDED;
    if (pre) return pre;
    if (fresh) this.refused.clear();
    const head = this.spawnChain()[0];
    if (!head) return NO_SPAWN_MODEL;
    return this.spawn(head);
  }

  /**
   * The turn's child on the spawn axis (spec §5): omp rejects an unknown --model at process start (live, 18.4.4), so
   * live set_model can never rescue it. Each rejected selector gets one error{model_missing} row, joins the child's
   * refused set, and Default's next candidate is spawned; none left → no_planner_leg + incident. Not a crash-latch count.
   */
  private async startSession(turn: Turn, warm?: Promise<StartResult>): Promise<string | null | typeof ENDED> {
    for (let fresh = true; ; fresh = false, warm = undefined) {
      const r = await this.step(turn, warm ? this.afterWarm(warm) : this.ensureSession(fresh));
      if (r === NO_SPAWN_MODEL) {
        this.noLeg(turn, "model_missing", turn.startMissing);
        this.failTurn(turn, "no_planner_leg", "model_missing");
        return ENDED;
      }
      if (r === ENDED || r === null || typeof r === "string") return r;
      this.recordStartMissing(turn, r.missing);
    }
  }

  /**
   * The first spawn after slot B's warm start: its failure (a start_failed ref, or omp refusing Default's head) IS this
   * turn's result, never a second spawn (one start, one incident, one crash count, as before the lane). The warm call
   * was this turn's start-time fingerprint compare; a ready child is replaced only if it exited or went stale meanwhile.
   */
  private async afterWarm(warm: Promise<StartResult>): Promise<StartResult> {
    const r = await warm;
    if (r !== null) return r;
    return this.session && !this.stale ? null : this.ensureSession(true);
  }

  /** One llm_attempt per selector omp refused at spawn, keyed `<run>:0:<k>` (never `<run>:0`, the n = 0 dispatch row's key). */
  private recordStartMissing(turn: Turn, m: ModelString): void {
    this.refused.add(selectorKey(m));
    this.audit(turn, {
      provider: m.provider, role: "", outcome: "error", model: m.model, family: familyOf(m),
      request_key: `${turn.req.run_id}:0:${turn.startMissing++}`, error_kind: "model_missing"
    }, m);
  }

  /** One llm_attempt per pin omp refused, keyed `<run>:pin:<k>` (distinct from `<run>:<n>` and `<run>:0:<k>`). */
  private recordPinMissing(turn: Turn, m: ModelString): void {
    this.audit(turn, {
      provider: m.provider, role: "", outcome: "error", model: m.model, family: familyOf(m),
      request_key: `${turn.req.run_id}:pin:${turn.legsTried}`, error_kind: "model_missing"
    }, m);
  }

  /**
   * Every compose llm_attempt goes through here. Each carries the effort of the selector it was made on (`m`: the spawn
   * or pin candidate, default the model the child was pinned to; plan F15), and the first one of a routed turn carries
   * routed_by = its verdict id (spec §6).
   */
  private audit(t: Turn, a: LlmAttempt, m: ModelString = this.model): void {
    const routedBy = t.routedBy;
    t.routedBy = undefined;
    this.d.store.llmAuditSink({ run_id: t.req.run_id, role: "compose" }).record({
      ...a, ...(m.effort ? { effort: m.effort } : {}), ...(routedBy ? { routed_by: routedBy } : {})
    });
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

  /** omp's version comes from the shared per-binary cache (one exec per binary); wrapper hash and Seatbelt render unless skipped for unit tests. */
  private async preflight(): Promise<string | null> {
    const { cfg, distDir, ctx } = this.d;
    const v = await (this.d.versionCheck ?? (() => sharedOmpVersionCache(cfg).current()))();
    if (!v.ok) {
      // No pinned version (2026-10-07): only an unrunnable or silent omp refuses a spawn.
      this.incident("omp_unavailable", { check: v.kind, version: v.version });
      return `omp_unavailable: ${v.reason}`;
    }
    this.checkedVersion = v.version;
    this.d.outcome.versionOk?.();
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
    const { path: systemPromptFile, snapshot } = writeSystemPromptFile(turnContext, chatId);
    this.fingerprint = promptTextFingerprint(snapshot.text);
    this.applied = appliedOf(snapshot);
    this.lessonFingerprint = snapshot.lessonFingerprint;
    this.stale = false;
    return { sessionDir, systemPromptFile, configFile, bridgeDir };
  }

  private async spawn(model: ModelString): Promise<StartResult> {
    const { ctx, chatId, distDir, cfg } = this.d;
    this.st = "STARTING";
    const p = this.preparePaths();
    const token = randomBytes(24).toString("hex");
    const sock = join(p.bridgeDir, `${chatId}-${randomUUID().slice(0, 8)}.sock`);
    if (Buffer.byteLength(sock) > MAX_SOCK_PATH) return this.startFailed(`bridge socket path over ${MAX_SOCK_PATH} bytes`);
    const gen = this.bumpGen();
    const rec: SpawnRec = { gen, model };
    this.spawning = rec;
    const superseded = new Promise<void>((r) => { this.supersede = r; });
    this.model = model; // Default's head, or its next candidate after a start-time rejection
    // omp's open_session restores the model a resumed session last used, over --model (live gate 2026-10-01): the
    // child's model is unknown until promptTop pins it with set_model before the first prompt
    this.modelUnknown = true;
    this.actual = undefined;
    const opts: PlannerSessionOptions = {
      cfg, sessionDir: p.sessionDir, cwd: this.workspace(), systemPromptFile: p.systemPromptFile,
      extensions: [join(distDir, "omp", "extension", "houge.js")], bridgeSock: sock, bridgeToken: token, model: this.model,
      configFile: p.configFile, plannerProfile: join(ctx.data, "omp", "planner.sb")
    };
    try {
      const { bridge, manifestServed } = await this.listen(gen, sock, token);
      // an abort or stop landed while the socket opened (B9): this child was superseded before it existed
      if (gen !== this.gen) { await bridge.close(); return START_SUPERSEDED; }
      this.bridge = bridge;
      const s = (this.d.sessionFactory ?? ((o) => new PlannerSession(o)))(opts);
      s.onFrame((f) => this.onFrame(gen, f));
      s.onExit((i) => this.onExit(gen, i));
      this.session = s;
      rec.started = s.start();
      await this.awaitStart(rec.started, superseded, this.d.startWaitMs ?? START_WAIT_MS, "start timed out");
      await this.awaitStart(manifestServed, superseded, this.d.manifestWaitMs ?? MANIFEST_WAIT_MS, "no manifest");
      if (rec.bridgeLost && rec.exit === undefined) throw new PlannerRpcError("bridge_lost_during_start");
    } catch (e) {
      return this.spawnFailed(rec, e);
    } finally { if (this.spawning === rec) this.spawning = undefined; }
    const refused = await this.resetOrRefuse(gen);
    if (refused) return refused;
    if (!this.turn?.live) this.st = "IDLE";
    this.d.outcome.startOk?.();
    return null;
  }

  /** Null when the child is ready to serve; otherwise why this spawn must not (superseded, or a failed lesson reset). */
  private async resetOrRefuse(gen: number): Promise<string | null> {
    const live = this.session;
    if (!live || gen !== this.gen) return START_SUPERSEDED;
    const failure = await this.resetForLessonChange(live, gen);
    if (!failure) return null;
    if (failure === START_SUPERSEDED) return failure; // whoever superseded this start already stopped the child
    await this.stopSession();
    this.st = "STOPPED";
    return failure;
  }

  /**
   * Memory A1 §6: the child resumed the newest transcript (open_session). When the lesson set the spawned prompt rendered
   * differs from the one this chat's transcript was COMMITTED on (persisted, so a change made while the daemon was down
   * is caught; committed only at the first dispatch, since omp resumes the old transcript until the new one holds a
   * turn), start a fresh session instead of keeping a transcript that carries the old habit. A failed or cancelled
   * new_session fails the spawn with an incident (degrading on the 3rd, see resetFailed). Flag-gated
   * (HOUGE_LESSON_SESSION_RESET, default on).
   */
  private async resetForLessonChange(s: PlannerSessionLike, gen: number): Promise<string | null> {
    const { store, chatId, env } = this.d;
    const fingerprint = this.lessonFingerprint;
    if (!resolveLessonSessionReset(env) || fingerprint === undefined) return null; // no read, no reset decision
    if (store.getPlannerSessionState(chatId)?.lesson_fingerprint === fingerprint) {
      store.dropPendingPlannerSession(chatId); // resuming the committed transcript: an unprompted reset no longer applies
      return this.resetOk();
    }
    try {
      if ((await s.newSession()).cancelled) throw new PlannerRpcError("new_session_cancelled");
    } catch (e) {
      // a /kill or abort stopped the child mid-reset: its pending new_session rejects, which is not a failed reset
      if (gen !== this.gen || this.session !== s) return START_SUPERSEDED;
      return this.resetFailed(fingerprint, e);
    }
    // omp already made the new transcript: record it even when the start was superseded meanwhile (but never serve it)
    store.recordPlannerSessionReset(chatId, fingerprint, new Date().toISOString());
    if (gen !== this.gen || this.session !== s) return START_SUPERSEDED;
    this.resetGen = gen;
    return this.resetOk();
  }

  private resetOk(): null {
    this.resetFailures = { fingerprint: "", count: 0 };
    this.d.outcome.sessionResetOk?.();
    return null;
  }

  /**
   * Failures 1-2 for one lesson set fail the spawn. The 3rd (and later) serves the resumed session, as with the flag off:
   * AGENTS.md's "no adverse impact to Houge's own operation" outranks a fail-closed reset. The incident stays open
   * (sessionResetOk is not called) and the degradation is ledgered; a later successful reset clears both.
   */
  private resetFailed(fingerprint: string, e: unknown): string | null {
    const prior = this.resetFailures.fingerprint === fingerprint ? this.resetFailures.count : 0;
    this.resetFailures = { fingerprint, count: prior + 1 };
    this.incident("planner_session_reset_failed", { reason: rpcCode(e) });
    if (this.resetFailures.count < RESET_DEGRADE_AFTER) return `session_reset_failed: ${rpcCode(e)}`;
    this.d.store.recordMemoryEvent(
      "planner_session_reset_degraded", { chat_id: this.d.chatId, failures: this.resetFailures.count }, `planner:${this.d.chatId}`
    );
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

  /**
   * A child that exited during start (its start() rejection carries the classified code; omp refusing the model is
   * model_missing → Default's next candidate, no crash count, no incident), one we stopped (superseded), or any other failure.
   */
  private async spawnFailed(rec: SpawnRec, e: unknown): Promise<StartResult> {
    const exited = rec.exit !== undefined;
    if (!exited && rec.gen !== this.gen) return START_SUPERSEDED;
    // the exit superseded the wait: read start()'s own rejection, which carries the classified code
    const err = exited && rec.started ? await bounded(rec.started.then(() => undefined, (x: unknown) => x), 1_000) : e;
    await this.stopSession();
    const code = err instanceof PlannerRpcError ? err.code : undefined;
    if (code === START_MODEL_MISSING) return { missing: rec.model };
    this.exits.push(Date.now()); // any other failed start (exit, timeout, no manifest, spawn error) is a crash exit
    return this.startFailed(code ?? (exited ? `child ${rec.exit} during start` : message(e)));
  }

  private startFailed(reason: string): string {
    this.st = "STOPPED";
    this.incident("planner_start_failed", { reason });
    return `start_failed: ${reason}`;
  }

  /** One listener per child; resolves the returned promise once a manifest request was answered (ruling 2). */
  private async listen(gen: number, sock: string, token: string): Promise<{ bridge: BridgeServer; manifestServed: Promise<void> }> {
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
    bridge.onDisconnect(() => this.onBridgeLost(gen));
    return { bridge, manifestServed }; // wrapped: an async function returning a promise would adopt it and wait for the manifest
  }

  /**
   * During start the loss is recorded, not acted on: a child dying at start closes its bridge first (its start failure,
   * with its code, is the outcome); a child that stays up without its bridge fails the start after the waits. Later: the
   * child is always marked stale (retired at the next ensureSession); a turn aborts only if it committed to this child —
   * one still resolving its text or building its prompt re-checks and gets a fresh child instead.
   */
  private onBridgeLost(gen: number): void {
    if (gen !== this.gen) return;
    if (this.spawning?.gen === gen) { this.spawning.bridgeLost = true; return; }
    this.stale = true; // its extension never reconnects: the next ensureSession retires this child
    const t = this.turn;
    if (t && t.childGen === gen) void this.abortTurn("planner_exit", "bridge disconnected");
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
    if (!info.stopped && rec) rec.exit = exitRef(info); // during start: spawnFailed classifies, counts and reports it
    else if (!info.stopped) this.exits.push(Date.now());
    this.session = undefined;
    const b = this.bridge; this.bridge = undefined;
    void b?.close();
    clearTimeout(this.idleExit);
    this.st = "STOPPED";
    const t = this.turn;
    // a start-phase exit is the start's result, not the turn's; a turn fails only if it committed to this child (as in
    // onBridgeLost): a lane turn never awaits the warm child (ADR 0029 §5.1), and a planner turn still before promptTop
    // gets a fresh child (afterWarm / ensureSession) or fails "planner not running" there
    if (t && !info.stopped && !rec && t.childGen === gen) {
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
    // only a prompt in flight owns frames: one arriving after its agent_end (or once the turn finished, or between a
    // failed leg and the retry's prompt) is ignored and can never fail or end a completed turn (round 2 N6)
    if (!t.live || t.finished) return;
    if (f.type === "turn_start") t.n++;
    else if (f.type === "tool_execution_start") t.usedTool = true;
    else if (f.type === "message_end") this.onAssistant(t, summarizeAssistantMessage(f));
    else if (f.type === "error") this.onErrorFrame(t, frameErrorText(f));
    else if (f.type === "prompt_result" && f.agentInvoked === false && f.status === "error") this.onPromptRejected(t, frameErrorText(f));
    else if (f.type === "agent_end") { t.live = false; t.done(f.aborted === true ? "abort" : "end"); }
  }

  /**
   * An omp `error` frame (B5): classified, audited as this request's llm_attempt (unless its message_end already
   * was), and left for settle()'s retry-or-fail rule — a turn that ends on it never completes with an empty reply.
   */
  private onErrorFrame(t: Turn, text: string): void {
    t.lastError = text;
    if (t.n > 0 && t.recorded === t.n) return;
    const model = this.model.model;
    this.audit(t, {
      provider: this.model.provider, role: "", outcome: "error", model, family: familyOf({ model }),
      request_key: `${t.req.run_id}:${t.n}`, error_kind: classifyOmpError(text)
    });
    t.recorded = t.n;
  }

  /** A prompt omp failed before it reached the agent: no agent_end follows, so the error also ends the turn. */
  private onPromptRejected(t: Turn, text: string): void {
    this.onErrorFrame(t, text);
    if (!t.live) return;
    t.live = false;
    t.done("end");
  }

  /** What really answered. A model other than the intended one (a pin that failed) is re-pinned at the next turn. */
  private noteActualModel(provider: string, model: string): void {
    this.actual = { provider, model };
    if (provider !== this.model.provider || model !== this.model.model) this.modelUnknown = true;
  }

  /** One llm_attempt per model request, keyed `<run_id>:<n>` (spec §8). */
  private onAssistant(t: Turn, s: AssistantSummary | null): void {
    if (!s) return;
    if (s.provider !== undefined && s.model !== undefined) this.noteActualModel(s.provider, s.model);
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
    this.audit(t, attempt);
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
    outcome.complete({ ...base, run_id: t.req.run_id, attachments, ...(t.laneButtons ? { buttons: t.laneButtons } : {}) });
    for (const m of t.merged) outcome.complete({ ...base, run_id: m, merged_into: t.req.run_id, attachments: [] });
    store.recordChatTurn({ chat_id: chatId, run_id: t.req.run_id, role: "assistant", text, intent: assistantIntentFor(text, t.usedTool) });
    this.routeEnd(t, "planner_done");
  }

  private finishFailure(t: Turn, f: { type: PlannerFailure; ref: string }): void {
    const { store, outcome } = this.d;
    t.finished = true;
    flushUnreported(store, t.active);
    if (t.n > t.recorded || (t.dispatched && t.n === 0)) this.recordAborted(t, f.ref === DAEMON_SHUTDOWN ? "shutdown" : "aborted");
    if (f.type === "turn_timeout" || f.type === "frame_idle") store.recordLoopHalted(t.req.run_id, { reason: f.type, steps: t.n });
    const base = { worker_id: t.worker, error_ref: f.ref, ...(t.lastText ? { partial: t.lastText } : {}) };
    outcome.fail({ ...base, run_id: t.req.run_id, error_type: f.type });
    for (const m of t.merged) outcome.fail({ ...base, run_id: m, error_type: "merged_parent_failed" });
    this.routeEnd(t, "planner_failed");
  }

  /** The verdict row's handler outcome (spec §6) for a turn the tree routed with a verdict id; a lane turn has no route. */
  private routeEnd(t: Turn, handler_outcome: "planner_done" | "planner_failed"): void {
    const verdict_id = t.route?.verdict_id;
    if (!verdict_id || !this.d.outcome.routeEnd) return;
    // no prompt went out → null: `actual` persists across turns (plannerFamily/answeredModel read it), so it is not this turn's
    const model = !t.dispatched ? null : this.actual ? `${this.actual.provider}/${this.actual.model}` : selectorKey(this.model);
    this.d.outcome.routeEnd({
      run_id: t.req.run_id, verdict_id, handler_outcome, model, fast_used_tool: t.role === "fast" && t.usedTool, pin_failed: t.pinFailed
    });
  }

  /**
   * A model request that never reached message_end is audited at turn end (spec §8): error{shutdown} when the
   * daemon's own stop cut it (ignored by the failing-leg sweep), else error{aborted} (a hung or killed turn counts).
   */
  private recordAborted(t: Turn, kind: "aborted" | "shutdown"): void {
    const model = this.model.model;
    this.audit(t, {
      provider: this.model.provider, role: "", outcome: "error", model, family: familyOf({ model }),
      request_key: `${t.req.run_id}:${t.n}`, error_kind: kind
    });
    t.recorded = t.n;
  }
}
