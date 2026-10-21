import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { CapabilityRunner, type ApprovalRequestSink, type CapabilityExecutionInput, type CapabilityResult } from "../capabilities/capability-runner.js";
import type { JEV_PROVIDER } from "../llm/metered-pricing.js";
import { decideCapability } from "../policy/capability-policy.js";
import type { BudgetLedger } from "../budget/budget-ledger.js";
import { digestOutput } from "../core/output-digest.js";
import { READER_INPUT_CHAR_CAP } from "../core/quarantine.js";
import { decideSync } from "../decisions/decide.js";
import { recordApprovalExpired } from "../decisions/improve-signals.js";
import { KEY_MASK, pathOperands, SECRET_MASK } from "../decisions/egress.js";
import { TOOL_SHELL_NETREAD } from "../decisions/entries/shell-netread.js";
import { WITHHELD_UNJUDGED_TEXT } from "../decisions/entries/tool-injection.js";
import { localOutcome, type InjectionJudge, type InjectionSource, type JudgeInput, type JudgeOutcome } from "../decisions/injection-judge.js";
import { storeRecorder } from "../decisions/record.js";
import { countTrustAsk, effectiveAsk, HOSTILE_REASON, MASKED_READ_REASON, targetsLine, type TrustAsk } from "../decisions/trust-ask.js";
import { resolveTrustAskTtlMs, type TurnTrust } from "../decisions/trust.js";
import type { CompiledTaskContract, Identity } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { BridgeRequest, SettleReply } from "./bridge-protocol.js";
import { BUILTIN_CAPABILITY, capabilityFor, type RegistryEntry } from "./capability-map.js";
import { classifyCommand } from "./command-matcher.js";
import { gateTargets } from "./gate-path.js";
import { handleJudgeRead, maskedKey, noteReportApplied, raisePendingAtFlush, raiseStalePending, type JudgedOutcome, type JudgePending, type PathDeps } from "./bridge-read-judge.js";
import { sharedOmpVersionCache } from "./omp-version-cache.js";
import { syncReadFormatDrift } from "./read-format.js";
import { capResponse, RESPONSE_CAP, TRUNCATION_NOTE } from "./response-cap.js";
import { renderExternalRead, UNTRUSTED_READ_ENTRIES, type ExternalReadResult } from "./external-read.js";
import type { OmpConfig } from "./omp-config.js";
import { isDeniedRead, isDeniedWrite, type PathContext } from "./protected-paths.js";
import { isToolArmed } from "./tool-arming.js";
import { createToolApprovalSink, toolApprovalWaiters } from "./tool-approval-sink.js";
import { validateInput, type ToolDeclaration } from "./tool-decls.js";

type FsEntry = "fs_read" | "fs_write";

/**
 * How long an approval wait pauses the turn's deadline and frame watchdog (spec §7.2, senior round 4 B9): a code ask pauses
 * for the whole approval timeout, as before; a trust-only ask for its own TTL, at most one TTL per turn in total.
 */
export type PausePolicy = { pause: "full" } | { pause: "bounded"; ttlMs: number };
export const FULL_PAUSE: PausePolicy = { pause: "full" };

/** Who sent the turn back (spec §3.5): a code rule, or the Jev rung (the literal lives in the LLM layer: the metered-provider guard scans for it). */
export type SendBackKind = "rule" | typeof JEV_PROVIDER;

export interface ActiveTurn {
  run_id: string; worker_id: string; chat_id: string; requester: Identity; contract: CompiledTaskContract;
  budget: BudgetLedger; registry: ToolRegistry; signal: AbortSignal; cwd: string; step: { n: number };
  cache: Map<string, Promise<unknown>>; unreported: Map<string, FsEntry>;
  quarantine: (tool: string, output: Record<string, unknown>) => Promise<ExternalReadResult>;
  setAwaitingApproval: (on: boolean, pause?: PausePolicy) => void; postureOk: () => string | null;
  /** What the turn has read (spec §7.2), created by the supervisor; absent only in tests that build a bare turn. */
  readonly trust?: TurnTrust;
  /** tool.injection for this turn's results (spec §7.1); absent only in tests that build a bare turn. */
  judge?: InjectionJudge;
  /** Values the judge masks by value that the broker does not hold: this spawn's bridge token (Rev 4, senior S-R3-2). */
  secretValues?: readonly string[];
  /**
   * How long a trust-only card may wait now (senior W3): what is left of the turn's one TTL of pause; once that is spent,
   * no longer than the timers it can no longer pause allow (frame watchdog and deadline, each less a margin).
   */
  trustWaitMs?: (ttlMs: number) => number;
  /** Who answers this turn's approvals when not the requester (the operator, for a schedule-born turn). */
  approver?: Identity;
  /** Per-turn call queue: at most one call (and so one approval) in flight per turn. */
  serial?: Promise<unknown>;
  /** Code checks before any approval card (memory_correct writes): a refusal never shows a card; else the card's detail. */
  preflight?: (entry: RegistryEntry, input: Record<string, unknown>) => Preflight | null;
  /** Spec §4: the lexical targets of each allowed built-in read, set at its gate; judge_read refuses an id not in it (unknown_call). */
  readTargets?: Map<string, string[]>;
  /** Spec §4: masked keys (`maskedKey`) of local reads whose judgement mirrored a mask; an edit or write to one asks Paco. */
  maskedPaths?: Set<string>;
  /** Spec §4: each judged built-in read, keyed from the judge_read arrival, until its report or the flush reconciles it. */
  judgePending?: Map<string, JudgePending>;
  /** Spec §4: the judgements still running, so the flush can wait for them (bounded). */
  judgeInFlight?: Map<string, Promise<void>>;
  /** Spec §3.3: this turn continues a Jev-rung send-back, so every Houge effect asks as a hostile turn would. */
  settleAsk?: boolean;
  /** The send-back callback (spec §3.5): installed by the supervisor; the bridge calls it with the settle request's text before it writes a sendBack reply (Task 10). */
  onSendBack?: (kind: SendBackKind, settleText: string) => void;
}

/** A preflight verdict: refuse with a code-owned reason, or go on with the card detail Paco approves. */
export type Preflight = { refused: { reason: string; text: string } } | { card_detail: string };

export interface BridgeHandlerDeps {
  store: RunStore; cfg: OmpConfig; ctx: PathContext; decls: ToolDeclaration[]; env: NodeJS.ProcessEnv;
  /** The Telegram turn contract's allowed_actions: the manifest is fixed before any turn exists. */
  turnEnvelopeActions: string[];
  activeTurn: () => ActiveTurn | null;
  /** Live-gate holds (spec §4/§5): how long the bridge sits on a judge_read or settle before answering. Nothing sets it in production. */
  gateHold?: GateHold;
  /** turn.settle (2b-i §3): the supervisor decides; absent only in bare tests (then every settle answers false). */
  settle?: (turn: ActiveTurn, req: SettleReq) => Promise<SettleDecisionReply>;
}
export interface GateHold { judgeReadMs?: number; settleMs?: number }

export interface CallResult { content: string; isError: boolean }

export const APPROVAL_DENIED_TEXT = "Paco denied this action. It did not run. Do not retry it; tell him what you were trying to do.";
export const APPROVAL_EXPIRED_TEXT = "The approval request got no answer in time. The action did not run.";
export const QUARANTINE_FAILED_TEXT = "The reader could not process this source, so none of it is shown. Try another source.";
export const READ_TOOL_FAILED_TEXT = "The read tool failed; its error text is withheld (it may carry source bytes). Status:";
export const TURN_ABORTED_TEXT = "The turn was aborted; this call did not run.";
/** A trust card that ran out its own TTL (spec §7.2). */
export const TRUST_ASK_EXPIRED_TEXT = "Paco did not approve in time. The action did not run.";
/** A trust ask with no time left in the turn to reach Paco (senior W3): refused without a card. */
export const TRUST_ASK_NO_TIME_TEXT = "There is no time left in this turn to ask Paco, so the action did not run. Tell him what you wanted to do.";
/** ADR 0030's one named exception: at hostile the built-in writer is refused toward its asking equivalent (spec §7.2). */
export const HOSTILE_WRITE_REDIRECT = "This turn read text aimed at the assistant; make this change through bash, which will ask Paco.";
export const HOSTILE_REDIRECT_CODE = "hostile_redirect";
export const SETTLE_WRITE_REDIRECT = "This reply was sent back for one more pass; make this change through bash, which will ask Paco.";
export const SETTLE_REDIRECT_CODE = "settle_redirect";
export const MASKED_WRITE_REDIRECT = "This file was read with values masked; make this change through bash, which will ask Paco.";
export const MASKED_REDIRECT_CODE = "masked_redirect";
const REDIRECT_TEXT: Record<string, string> = { [HOSTILE_REDIRECT_CODE]: HOSTILE_WRITE_REDIRECT, [SETTLE_REDIRECT_CODE]: SETTLE_WRITE_REDIRECT,
  [MASKED_REDIRECT_CODE]: MASKED_WRITE_REDIRECT };
const SHELL_ENTRIES: ReadonlySet<RegistryEntry> = new Set<RegistryEntry>(["shell", "shell_external", "shell_destructive"]);
/** Statuses whose text is code-built (no tool bytes): never judged, never a netread. */
const NO_TOOL_BYTES: ReadonlySet<string> = new Set(["denied", "denied_on_revalidation", "requires_approval"]);
export const POLICY_VERSION = "omp-1";
export { RESPONSE_CAP, TRUNCATION_NOTE };
/** The approval card shows the command whole up to this many characters (security I1: never a silent cut). */
export const CARD_DETAIL_CAP = 3000;
export const cardTruncationNote = (cut: number): string => `…[truncated ${cut} chars]`;
/** The card's Command line: the whole command, or its first CARD_DETAIL_CAP characters plus how many were cut. */
function cardDetail(command: string): string {
  return command.length <= CARD_DETAIL_CAP ? command : `${command.slice(0, CARD_DETAIL_CAP)}${cardTruncationNote(command.length - CARD_DETAIL_CAP)}`;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
type CallReq = Extract<BridgeRequest, { kind: "call" }>;
type GateReq = Extract<BridgeRequest, { kind: "gate" }>;
type ReportReq = Extract<BridgeRequest, { kind: "report" }>;
export type SettleReq = Extract<BridgeRequest, { kind: "settle" }>;
/** The supervisor's answer: the bridge strips `kind` (who sent it back) after handing it to onSendBack. */
export type SettleDecisionReply = { sendBack: false } | { sendBack: true; note: string; kind: SendBackKind };

/** Built-in name per allowed gate (edit and write share fs_write); read back by report/flush. */
const builtinNames = new WeakMap<ActiveTurn, Map<string, string>>();

const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Shape check on the decoded wire value; a malformed request is never memoised. */
function wellFormed(req: BridgeRequest): boolean {
  const r = req as unknown as Record<string, unknown>;
  if (r.kind === "call") return nonEmpty(r.toolCallId) && typeof r.tool === "string" && isObject(r.input);
  if (r.kind === "gate") return nonEmpty(r.toolCallId) && typeof r.tool === "string" && isObject(r.input);
  if (r.kind === "judge_read") return nonEmpty(r.toolCallId) && typeof r.text === "string";
  if (r.kind === "settle") return typeof r.stop_hook_active === "boolean" && typeof r.text === "string";
  if (r.kind === "report") return typeof r.toolCallId === "string" && (r.applied === undefined || typeof r.applied === "boolean") && (r.tool === undefined || typeof r.tool === "string");
  return true;
}

export function createBridgeHandler(deps: BridgeHandlerDeps): (req: BridgeRequest) => Promise<unknown> {
  return async (req) => {
    if (!wellFormed(req)) { recordBadRequest(deps, req); throw new Error("bad_request"); }
    if (req.kind === "manifest") return manifestFor(deps);
    const turn = deps.activeTurn();
    if (!turn) throw new Error("no_active_turn");
    raiseStalePending(turn, Date.now());
    if (req.kind === "judge_read") return memo(turn, `judge:${req.toolCallId}`, () => handleJudgeRead(deps, turn, req, judgeAsRead, deps.gateHold?.judgeReadMs ?? 0));
    if (req.kind === "call") return memo(turn, `call:${req.toolCallId}`, () => serialise(turn, () => handleCall(deps, turn, req)));
    if (req.kind === "gate") return memo(turn, `gate:${req.toolCallId}`, async () => handleGate(deps, turn, req));
    if (req.kind === "report") return handleReport(deps, turn, req);
    if (req.kind === "settle") return settleMemo(deps, turn, req);
    throw new Error("unknown request kind");
  };
}

/**
 * Ruling 1: keyed by run and fire, so a duplicate of either fire replays its answer and never decides twice. 2b-i final review
 * A11.2: the continuation's own fire (stop_hook_active) retires the first fire's memo — omp then resets stop_hook_active, and
 * a queued steer's auto-continue must be decided afresh, never answered with the replayed sendBack.
 */
function settleMemo(deps: BridgeHandlerDeps, turn: ActiveTurn, req: SettleReq): Promise<unknown> {
  if (req.stop_hook_active) turn.cache.delete(`settle:${turn.run_id}:false`);
  return memo(turn, `settle:${turn.run_id}:${req.stop_hook_active}`, () => handleSettle(deps, turn, req));
}

async function handleSettle(deps: BridgeHandlerDeps, turn: ActiveTurn, req: SettleReq): Promise<SettleReply> {
  if (!deps.settle) return { sendBack: false };
  const capped = { ...req, text: capResponse(req.text) }; // A11.1: defence in depth (the extension already caps)
  const r = await deps.settle(turn, capped);
  if (!r.sendBack) return { sendBack: false };
  // before the reply leaves (BridgeServer.answer writes after this resolves); pass 1 itself opens at the continuation's agent_start (ruling 12)
  turn.onSendBack?.(r.kind, capped.text);
  return { sendBack: true, note: r.note };
}

/** Replay: a toolCallId executes at most once per turn; a duplicate gets the same promise. */
function memo(turn: ActiveTurn, key: string, fn: () => Promise<unknown>): Promise<unknown> {
  const hit = turn.cache.get(key);
  if (hit) return hit;
  const p = fn(); turn.cache.set(key, p); return p;
}

function serialise<T>(turn: ActiveTurn, fn: () => Promise<T>): Promise<T> {
  const run = (turn.serial ?? Promise.resolve()).then(fn);
  turn.serial = run.catch(() => undefined);
  return run;
}

function manifestFor(deps: BridgeHandlerDeps): ToolDeclaration[] {
  const allowed = new Set(deps.turnEnvelopeActions);
  return deps.decls.filter((d) => isToolArmed(d.name, deps.env) && (d.name === "bash" ? allowed.has("shell") : allowed.has(d.name)));
}

interface Finish {
  toolCallId: string; tool: string; capability: string; status: "succeeded" | "failed" | "denied";
  content: string; started: number; digest: string; reason?: string; bytesIn?: number;
}

/** tool_finished + loop_step: counts, hashes, ids and code-owned reasons only (never bodies). */
function finish(deps: BridgeHandlerDeps, turn: ActiveTurn, f: Finish): void {
  deps.store.appendRunLedgerEvent(turn.run_id, "tool_finished", "capability_runner", {
    tool_call_id: f.toolCallId, status: f.status, output_hash: sha(f.content), duration_ms: Date.now() - f.started,
    bytes_out: bytes(f.content), tool: f.tool,
    ...(f.bytesIn !== undefined ? { bytes_in: f.bytesIn } : {}), ...(f.reason !== undefined ? { reason: f.reason } : {})
  });
  deps.store.appendRunLedgerEvent(turn.run_id, "loop_step", "core", {
    step: ++turn.step.n, action: f.tool, capability: f.capability, ok: f.status === "succeeded", result_digest: f.digest
  });
}

/** A call that never reached the runner still counts (B7): tool_finished{failed, reason} + loop_step, and one budget unit. */
function recordInvalid(deps: BridgeHandlerDeps, turn: ActiveTurn, f: { toolCallId: string; tool: string; capability: string; reason: string; started: number; content?: string }): void {
  turn.budget.reserveToolCall();
  finish(deps, turn, { toolCallId: f.toolCallId, tool: f.tool, capability: f.capability, status: "failed", content: f.content ?? f.reason,
    started: f.started, digest: f.reason, reason: f.reason });
}

/** A malformed call or gate with a turn in flight is recorded like any invalid call; a malformed report is not a call. */
function recordBadRequest(deps: BridgeHandlerDeps, req: BridgeRequest): void {
  const r = req as unknown as Record<string, unknown>;
  const turn = r.kind === "call" || r.kind === "gate" ? deps.activeTurn() : null;
  if (!turn) return;
  recordInvalid(deps, turn, { toolCallId: typeof r.toolCallId === "string" ? r.toolCallId : "", tool: typeof r.tool === "string" ? r.tool : "unknown",
    capability: "unknown", reason: "bad_request", started: Date.now() });
}

function refuse(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, capability: string, reason: string, text: string, started: number): CallResult {
  finish(deps, turn, { toolCallId: req.toolCallId, tool: req.tool, capability, status: "denied", content: text, started, digest: reason, reason });
  return { content: text, isError: true };
}

async function handleCall(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq): Promise<CallResult> {
  const started = Date.now();
  const decl = deps.decls.find((d) => d.name === req.tool);
  const entry = capabilityFor(req.tool, req.input ?? {});
  if (!decl || !entry) {
    recordInvalid(deps, turn, { toolCallId: req.toolCallId, tool: String(req.tool), capability: "unknown", reason: "unknown_tool", started });
    throw new Error(`unknown_tool: ${String(req.tool)}`);
  }
  if (turn.signal.aborted) return refuse(deps, turn, req, entry, "turn_aborted", TURN_ABORTED_TEXT, started);
  const posture = turn.postureOk();
  if (posture) return refuse(deps, turn, req, entry, posture, posture, started);
  if (!isToolArmed(req.tool, deps.env)) return refuse(deps, turn, req, entry, "not_armed", `${req.tool} is not armed`, started);
  const errors = validateInput(decl.parameters, req.input);
  if (errors.length > 0) {
    const content = errors.join("; ");
    recordInvalid(deps, turn, { toolCallId: req.toolCallId, tool: req.tool, capability: entry, reason: "schema_invalid", started, content });
    return { content, isError: true };
  }
  const pre = turn.preflight?.(entry, req.input) ?? null;
  if (pre && "refused" in pre) return refuse(deps, turn, req, entry, pre.refused.reason, pre.refused.text, started);
  const command = req.tool === "bash" && typeof req.input.command === "string" ? req.input.command : undefined;
  const ask = askFor(deps, turn, entry, command);
  const executed = await executeWithApproval(deps, turn, req, entry, pre?.card_detail, ask);
  if ("refusal" in executed) return refuse(deps, turn, req, entry, executed.refusal.reason, executed.refusal.text, started);
  const r = executed.result;
  const rendered = await render(deps, turn, req, entry, r);
  const status = rendered.failed ? "failed" : statusOf(r);
  const reason = rendered.failed ?? (status === "succeeded" ? undefined : reasonCode(r));
  finish(deps, turn, { toolCallId: req.toolCallId, tool: req.tool, capability: entry, status, content: rendered.content, started,
    digest: rendered.digest, bytesIn: bytes(JSON.stringify(req.input)), ...(reason !== undefined ? { reason } : {}) });
  return { content: rendered.content, isError: status !== "succeeded" };
}

/**
 * 2b-i final review A10, stateless: a write or command carrying a mask would save it over real values. maskedPaths lives one
 * turn and a shell read never adds to it, so the mask itself is the signal. Accepted residual: a mask-free write to a file
 * masked in an EARLIER turn is not asked (no cross-turn record is kept).
 */
const carriesMask = (s: string): boolean => s.includes(SECRET_MASK) || s.includes(KEY_MASK);

/** The ask (spec §7.2 + 2b-i): the trust level's own, settleAsk's hostile form, a command carrying a mask (A10), or a masked file named by a shell command (ruling 5). */
function askFor(deps: BridgeHandlerDeps, turn: ActiveTurn, entry: RegistryEntry, command: string | undefined): TrustAsk {
  const ask = effectiveAsk(turn.trust?.level() ?? "clean", turn.settleAsk === true, entry, command);
  if (ask.ask || command === undefined) return ask;
  if (carriesMask(command)) return { ask: true, reason: MASKED_READ_REASON };
  if (!turn.maskedPaths?.size) return ask;
  return namesMaskedFile(command, turn, deps.ctx.home) ? { ask: true, reason: MASKED_READ_REASON } : ask;
}

/**
 * pathOperands keeps only slash/dot/tilde words; a bare `cfg.yml` in the cwd must ask too, so EVERY non-flag word is resolved
 * against the cwd as well. A11.8: backticks, braces and commas split too (`` `cat cfg.yml` ``, `{cfg.yml,x}`). Residual (not
 * modelled): globs (`cf?.yml`), quote splicing (`c"f"g.yml`), `$PWD`/variables, and interpreters that open the file themselves.
 */
function namesMaskedFile(command: string, turn: ActiveTurn, home: string): boolean {
  const words = command.split(/[\s;|&<>()`{},]+/).map((w) => w.replace(/^["']|["']$/g, "")).filter((w) => w.length > 0 && !w.startsWith("-"));
  const candidates = [...pathOperands(command, turn.cwd, home), ...words.map((w) => resolvePath(turn.cwd, w))];
  return candidates.some((p) => turn.maskedPaths!.has(maskedKey(p)));
}

function statusOf(r: CapabilityResult): "succeeded" | "failed" | "denied" {
  if (r.status === "succeeded") return "succeeded";
  return r.status === "denied" || r.status === "denied_on_revalidation" ? "denied" : "failed";
}

type Executed = { result: CapabilityResult } | { refusal: { reason: string; text: string } };

/** `trustTap`: the card exists only because trust asks (no code gate): the one kind the trust tap budget counts. */
interface WaitPolicy { timeoutMs: number; pause: PausePolicy; trustTap: boolean }
/**
 * Below this a trust card cannot reach Paco in time: the call is refused without a card (senior W3). The supervisor counts a
 * pause leftover below it as spent, so such a card gets the watchdog/deadline cap instead (fix round 2, live gate C4).
 */
export const TRUST_WAIT_MIN_MS = 5_000;

/**
 * A trust-only ask (no code gate on this capability) waits its own TTL with a bounded pause, cut to what the turn's timers
 * allow (ActiveTurn.trustWaitMs, senior W3); any code ask keeps today's full wait.
 */
function waitPolicy(deps: BridgeHandlerDeps, turn: ActiveTurn, entry: RegistryEntry, ask: TrustAsk): WaitPolicy {
  const meta = turn.registry.get(entry);
  const codeAsk = meta !== undefined && turn.contract.approval_gates.includes(meta.side_effect_level);
  if (!ask.ask || codeAsk) return { timeoutMs: deps.cfg.approvalTimeoutMs, pause: FULL_PAUSE, trustTap: false };
  const ttlMs = resolveTrustAskTtlMs(deps.env);
  return { timeoutMs: turn.trustWaitMs ? turn.trustWaitMs(ttlMs) : ttlMs, pause: { pause: "bounded", ttlMs }, trustTap: true };
}

/** The card: the command (cut at the cap; a hostile one past it also names its targets), and why trust asks. */
function approvalSink(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, command: string | undefined, preDetail: string | undefined, ask: TrustAsk,
  policy: WaitPolicy): ApprovalRequestSink {
  const targets = ask.ask && ask.reason === HOSTILE_REASON && command !== undefined && command.length > CARD_DETAIL_CAP ? `\n${targetsLine(command)}` : "";
  const detail = command !== undefined ? `${cardDetail(command)}${targets}` : preDetail;
  return createToolApprovalSink({ store: deps.store, worker_id: turn.worker_id, tool_call_id: req.toolCallId, approvalTimeoutMs: policy.timeoutMs,
    ...(detail !== undefined ? { card_detail: detail } : {}), ...(ask.ask ? { reason: ask.reason } : {}), ...(turn.approver ? { approver: turn.approver } : {}) });
}

/** First execute; on requires_approval wait in-turn (policy by ask kind), then re-execute on the reserved budget unit. */
async function executeWithApproval(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, entry: RegistryEntry, preDetail: string | undefined, ask: TrustAsk): Promise<Executed> {
  const command = req.tool === "bash" && typeof req.input.command === "string" ? req.input.command : undefined;
  const policy = waitPolicy(deps, turn, entry, ask);
  if (policy.pause.pause === "bounded" && policy.timeoutMs < Math.min(TRUST_WAIT_MIN_MS, policy.pause.ttlMs)) return { refusal: { reason: "trust_ask_no_time", text: TRUST_ASK_NO_TIME_TEXT } };
  const runner = new CapabilityRunner(turn.registry, approvalSink(deps, turn, req, command, preDetail, ask, policy));
  const base: CapabilityExecutionInput = { run_id: turn.run_id, requester: turn.requester, contract: turn.contract, capability: entry,
    input: req.input, budget: turn.budget, signal: turn.signal, tool_call_id: req.toolCallId, action_summary: summaryFor(req.tool, command),
    ...(ask.ask ? { trust_ask: true } : {}) };
  const first = await runner.execute(base);
  if (first.status !== "requires_approval") return { result: first };
  if (policy.trustTap) countTrustAsk(deps.store, deps.env, new Date().toISOString()); // added taps only (spec §7.2)
  const outcome = await awaitApproval(turn, first.approval_id, policy);
  if (outcome === "approved") return { result: await runner.execute({ ...base, approved_approval_id: first.approval_id, budget_reserved: true }) };
  if (outcome === "denied") return { refusal: { reason: "denied_by_paco", text: APPROVAL_DENIED_TEXT } };
  deps.store.expireToolApproval(first.approval_id, new Date().toISOString());
  if (outcome === "expired") recordApprovalExpired(deps.store, { run_id: turn.run_id, approval_id: first.approval_id }); // an aborted wait is not Paco's silence
  const trustExpired = outcome === "expired" && policy.pause.pause === "bounded";
  return { refusal: { reason: `approval_${outcome}`, text: trustExpired ? TRUST_ASK_EXPIRED_TEXT : APPROVAL_EXPIRED_TEXT } };
}

/** The card's action line and the ledger's action_summary: the matcher label, never the command text. */
function summaryFor(tool: string, command: string | undefined): string {
  if (command === undefined) return tool;
  const c = classifyCommand(command);
  return c.kind === "plain" ? tool : c.label;
}

async function awaitApproval(turn: ActiveTurn, approval_id: string, policy: WaitPolicy) {
  turn.setAwaitingApproval(true, policy.pause);
  try { return await toolApprovalWaiters.wait(approval_id, policy.timeoutMs, turn.signal); } finally { turn.setAwaitingApproval(false); }
}

interface Rendered { content: string; digest: string; failed?: string }

/** Tools whose code-rendered `answer` reaches the planner as text, not a JSON envelope. */
const PLAIN_TEXT_ENTRIES: ReadonlySet<RegistryEntry> = new Set<RegistryEntry>(["houge_status", "memory_correct", "memory_correct_write"]);

/** Read tools cross the wall ALWAYS (D3), judged first (spec §7.1); bash is judged raw (D12 + §7.1); a ledger digest carries counts and hashes only. */
async function render(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, entry: RegistryEntry, r: CapabilityResult): Promise<Rendered> {
  if (UNTRUSTED_READ_ENTRIES.has(entry)) {
    return r.status === "succeeded" ? renderRead(deps, turn, req.toolCallId, entry, r.output) : { content: `${READ_TOOL_FAILED_TEXT} ${r.status}`, digest: r.status };
  }
  if (SHELL_ENTRIES.has(entry)) return renderShell(deps, turn, req, r);
  if (r.status !== "succeeded") return { content: capResponse(failureText(r)), digest: r.status };
  if (PLAIN_TEXT_ENTRIES.has(entry) && typeof r.output.answer === "string") {
    const text = r.output.answer;
    return { content: capResponse(text), digest: `${bytes(text)} bytes` };
  }
  const json = JSON.stringify(r.output);
  return { content: capResponse(json), digest: `${bytes(json)} bytes` };
}

/** Shell output, success and failure (failureText renders output from error_ref), judged after its 32 KiB cap (spec §7.1). */
async function renderShell(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, r: CapabilityResult): Promise<Rendered> {
  if (r.status !== "succeeded" && NO_TOOL_BYTES.has(r.status)) return { content: capResponse(failureText(r)), digest: r.status };
  const command = typeof req.input.command === "string" ? req.input.command : "";
  const network = raiseNetread(deps, turn, req.toolCallId, command);
  const paths = pathOperands(command, turn.cwd, deps.ctx.home);
  if (r.status !== "succeeded") return { content: await judged(deps, turn, req.toolCallId, "shell", capResponse(failureText(r)), { outside: network, paths }), digest: r.status };
  const out = typeof r.output.output === "string" ? r.output.output : "";
  const code = String(r.output.exit_code ?? "none");
  return { content: `${await judged(deps, turn, req.toolCallId, "shell", capResponse(out), { outside: network, paths })}\n[exit ${code}]`, digest: `exit ${code}, ${bytes(out)} bytes` };
}

/** tool.shell_netread decides; a network read makes the turn untrusted (spec §7.2). Returns whether the output came from outside. */
function raiseNetread(deps: BridgeHandlerDeps, turn: ActiveTurn, toolCallId: string, command: string): boolean {
  const r = decideSync(TOOL_SHELL_NETREAD, { command }, { run_id: turn.run_id, tool_call_id: toolCallId, recorder: storeRecorder(deps.store, { env: deps.env }) });
  if (r.verdict === "network") turn.trust?.raise("shell_netread", toolCallId);
  return r.verdict === "network";
}

type Judged = Pick<JudgeOutcome, "text" | "withheld" | "withheldUnjudged" | "framed" | "notChecked" | "unanswered" | "skipped" | "masked">;

type JudgeOpts = Pick<JudgeInput, "outside" | "paths" | "extracted" | "linkTokens" | "late">;

/**
 * tool.injection on bytes that reach a model (spec §7.1). `outside`: the text came from a wall tool or network shell output.
 * A judge that throws, or none wired (security final M-3: fail closed, never pass-through): `localOutcome`, the same floor,
 * content and path checks as the normal path (codex B2, Ruling 28), and the judgement counts as lost (outside text framed as
 * not checked); if that throws too, the whole result is withheld unjudged (fail closed).
 */
async function judged(deps: BridgeHandlerDeps, turn: ActiveTurn, toolCallId: string, source: InjectionSource, text: string, o: JudgeOpts): Promise<string> {
  return (await judgedOutcome(deps, turn, toolCallId, source, text, o)).text;
}

/** The `read` source's adapter handed to handleJudgeRead (bridge-read-judge.ts holds no judge of its own). */
const judgeAsRead: JudgedOutcome = (deps, turn, toolCallId, text, o) => judgedOutcome(deps, turn, toolCallId, "read", text, o);

/** `judged` with the judgement's mirrored-mask count, for a local read (2b-R8). */
async function judgedOutcome(deps: BridgeHandlerDeps, turn: ActiveTurn, toolCallId: string, source: InjectionSource, text: string, o: JudgeOpts): Promise<{ text: string; masked: number }> {
  const input: JudgeInput = { run_id: turn.run_id, tool_call_id: toolCallId, source, text, ...o, extracted: o.extracted ?? [...extractedFor(turn)], known: turn.secretValues ?? [] };
  const out = await judgeOrLocal(deps, turn, input);
  raiseFor(turn, toolCallId, out);
  return { text: out.text, masked: out.masked };
}

async function judgeOrLocal(deps: BridgeHandlerDeps, turn: ActiveTurn, input: JudgeInput): Promise<Judged> {
  if (!turn.judge) console.error("bridge: injection_judge_missing; the local checks decide");
  else {
    try { return await turn.judge(input); } catch (e) {
      console.error(`bridge: injection_judge_threw (${e instanceof Error ? e.name : "unknown"}); the local checks decide`);
    }
  }
  try { return localOutcome({ store: deps.store, home: deps.ctx.home }, input); }
  catch (e2) {
    // fail closed: the whole result is withheld unjudged; the code says the local checks did not decide either
    console.error(`bridge: injection_local_failed (${e2 instanceof Error ? e2.name : "unknown"}); result withheld unjudged`);
    return { text: WITHHELD_UNJUDGED_TEXT, withheld: 1, withheldUnjudged: 1, framed: 0, notChecked: 0, unanswered: 1, skipped: true, masked: 0 };
  }
}

/**
 * What a judgement costs the turn (spec §7.1–7.2): a withhold → hostile; a framed passage (it may not leave, plan S8) →
 * hostile from outside, untrusted from a local read (controller ruling 1); a lost judgement (Jev down, timed out, partial) →
 * untrusted (controller ruling 7: an outage never leaves the turn clean), and hostile when outside text reached the planner
 * not checked (security final I-2).
 */
function raiseFor(turn: ActiveTurn, toolCallId: string, o: Judged): void {
  if (o.withheld - o.withheldUnjudged > 0) turn.trust?.raise("injection_withheld", toolCallId);
  if (o.withheldUnjudged > 0) turn.trust?.raise("unjudged_outside", toolCallId); // withheld, never shown (controller ruling 1)
  if (o.framed > 0) turn.trust?.raise("unjudged_local", toolCallId);              // framed only on local reads
  if (o.notChecked > 0) turn.trust?.raise("judge_lost_outside", toolCallId);      // outside, framed as not checked
  if (o.skipped || o.unanswered > 0) turn.trust?.raise("judge_timeout", toolCallId);
}

/**
 * The reader's input is digestOutput(raw, 8000) (core-worker quarantineExtract): judge exactly that. The code-built side
 * channel (`trusted_extract`, gmail's codes and links) reaches the planner AFTER the reader (core-worker ompQuarantine appends
 * it), so it is judged too, as its own text (codex #2): everything the planner will read has been judged.
 */
async function judgedRead(deps: BridgeHandlerDeps, turn: ActiveTurn, toolCallId: string, entry: RegistryEntry, output: Record<string, unknown>): Promise<Record<string, unknown>> {
  const canonical = digestOutput(output, READER_INPUT_CHAR_CAP);
  const body = await judged(deps, turn, toolCallId, entry as InjectionSource, canonical, { outside: true });
  const extract = typeof output.trusted_extract === "string" && output.trusted_extract.length > 0 ? output.trusted_extract : undefined;
  // senior re-review B3: judge the side channel with its structure visible — the codes masked by value, the links NOT, so Jev
  // sees host and route words; their token-like path segments, query values and fragment are masked (Ruling 25, W-R3-2).
  const side = extract === undefined ? undefined
    : await judged(deps, turn, `${toolCallId}:extract`, entry as InjectionSource, extract, { outside: true, paths: [], extracted: extractedCodes(extract), linkTokens: true });
  if (body === canonical && side === extract) return output;
  return { answer: body, ...(side !== undefined ? { trusted_extract: side } : {}) };
}

/** A reader failure never forwards its message: reader stderr can echo the prompt, i.e. the raw source. */
async function renderRead(deps: BridgeHandlerDeps, turn: ActiveTurn, toolCallId: string, entry: RegistryEntry, output: Record<string, unknown>): Promise<Rendered> {
  turn.trust?.raise("wall_read", toolCallId);
  rememberExtracted(turn, output);
  const judgedOutput = await judgedRead(deps, turn, toolCallId, entry, output);
  let read: ExternalReadResult;
  try { read = await turn.quarantine(entry, judgedOutput); } catch {
    return { content: QUARANTINE_FAILED_TEXT, digest: "quarantine_failed", failed: "quarantine_failed" };
  }
  const text = capResponse(renderExternalRead(read));
  // The ledger never holds read text: the rendered result may carry a code-extracted OTP or link.
  return { content: text, digest: `sha256:${sha(text)} bytes:${bytes(text)}` };
}

/** This turn's code-extracted codes and links (gmail-read's `codes=[…] links=[…]`): masked by value in every later judged text (spec §7.0 rule 5). */
const extracted = new WeakMap<ActiveTurn, Set<string>>();
function extractedFor(turn: ActiveTurn): Set<string> {
  let s = extracted.get(turn);
  if (!s) { s = new Set(); extracted.set(turn, s); }
  return s;
}
/** This turn's extracted codes and links, for the settle egress (2b-i final review A1): masked by value there as in the judge. */
export function turnExtracted(turn: ActiveTurn): readonly string[] {
  return [...extractedFor(turn)];
}
/** The codes alone of an extract (never its links): what the side channel's own judgement masks by value. */
function extractedCodes(extract: string): string[] {
  return (/codes=\[([^\]]*)\]/.exec(extract)?.[1] ?? "").split(",").map((v) => v.trim()).filter((v) => v.length >= 4);
}
function rememberExtracted(turn: ActiveTurn, output: Record<string, unknown>): void {
  const t = output.trusted_extract;
  if (typeof t !== "string") return;
  for (const key of ["codes", "links"]) {
    for (const v of (new RegExp(`${key}=\\[([^\\]]*)\\]`).exec(t)?.[1] ?? "").split(",")) if (v.trim().length >= 4) extractedFor(turn).add(v.trim());
  }
}

function failureText(r: Exclude<CapabilityResult, { status: "succeeded" }>): string {
  if (r.status === "denied" || r.status === "denied_on_revalidation") return `denied: ${r.reason}`;
  if (r.status === "requires_approval") return "requires_approval";
  if (r.status === "uncertain_outcome") return `uncertain_outcome: ${r.reconciliation_ref}`;
  return `${r.status}: ${r.error_ref}`;
}

/** The ledger reason: policy strings for denials, the status name otherwise (error_ref may hold output). */
function reasonCode(r: CapabilityResult): string {
  return r.status === "denied" || r.status === "denied_on_revalidation" ? r.reason : r.status;
}

/** path, file_path and (multi-file edit) paths[]: every one must pass; none present is missing_path. */
function gatePaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["path", "file_path"]) if (typeof input[k] === "string") out.push(input[k] as string);
  if (Array.isArray(input.paths)) for (const p of input.paths) if (typeof p === "string") out.push(p);
  return out;
}

/** Every target omp may resolve `raw` to (gate-path.ts) must pass; a form the gate does not model is refused whole. */
function pathDenial(deps: BridgeHandlerDeps, turn: ActiveTurn, raw: string, entry: FsEntry): string | null {
  const t = gateTargets(raw, deps.ctx.home, turn.cwd);
  if (!t.ok) return t.reason;
  const denied = entry === "fs_read" ? isDeniedRead : isDeniedWrite;
  return t.targets.some((abs) => denied(abs, deps.ctx)) ? "protected_path" : null;
}

/** Spec §4: does any form omp may resolve a write's path to name a file whose read masked values? Only the file itself, never its directory. */
function maskedTarget(turn: ActiveTurn, raws: string[], deps: BridgeHandlerDeps): boolean {
  if (!turn.maskedPaths?.size) return false;
  return raws.some((raw) => { const t = gateTargets(raw, deps.ctx.home, turn.cwd); return t.ok && t.targets.some((p) => turn.maskedPaths!.has(maskedKey(p))); });
}

function gateDenial(deps: BridgeHandlerDeps, turn: ActiveTurn, req: GateReq, entry: FsEntry): string | null {
  if (turn.signal.aborted) return "turn_aborted"; // as handleCall: nothing new runs once the turn is aborted
  const posture = turn.postureOk();
  if (posture) return posture;
  if (entry === "fs_write" && turn.trust?.level() === "hostile") return HOSTILE_REDIRECT_CODE; // ADR 0030's named exception (spec §7.2)
  if (entry === "fs_write" && turn.settleAsk) return SETTLE_REDIRECT_CODE;
  const raws = gatePaths(req.input ?? {});
  if (raws.length === 0) return "missing_path";
  for (const raw of raws) { const d = pathDenial(deps, turn, raw, entry); if (d) return d; }
  if (entry === "fs_write" && (maskedTarget(turn, raws, deps) || carriesMask(JSON.stringify(req.input ?? {})))) return MASKED_REDIRECT_CODE;
  const c = turn.contract;
  const d = decideCapability({ capability: entry, category: "tool", side_effect_level: entry === "fs_read" ? "none" : "local_write",
    risk_level: "low", allowed_actions: c.allowed_actions, forbidden_actions: c.forbidden_actions, approval_gates: c.approval_gates });
  if (d.decision !== "allow") return d.reason;
  if (entry === "fs_write" && !turn.budget.reserveToolCall().ok) return "budget_exhausted";
  return null;
}

/** Built-in read/edit/write, asked by the policy hook before omp runs it. fs_read is gated, not budgeted. */
function handleGate(deps: BridgeHandlerDeps, turn: ActiveTurn, req: GateReq): { decision: "allow" } | { decision: "deny"; reason: string } {
  const entry: FsEntry | undefined = Object.hasOwn(BUILTIN_CAPABILITY, req.tool) ? BUILTIN_CAPABILITY[req.tool] : undefined;
  if (!entry) throw new Error(`unknown_builtin: ${String(req.tool)}`);
  const started = Date.now();
  const reason = gateDenial(deps, turn, req, entry);
  deps.store.appendRunLedgerEvent(turn.run_id, "policy_decision", "capability_runner", {
    tool_call_id: req.toolCallId, decision: reason ? "deny" : "allow", reason: reason ?? "allowed", policy_version: POLICY_VERSION
  });
  const tool = `builtin:${req.tool}`;
  if (reason) {
    finish(deps, turn, { toolCallId: req.toolCallId, tool, capability: entry, status: "denied", content: "", started, digest: reason, reason });
    return { decision: "deny", reason: REDIRECT_TEXT[reason] ?? reason };
  }
  turn.unreported.set(req.toolCallId, entry);
  if (entry === "fs_read") retainReadTargets(deps, turn, req);
  namesFor(turn).set(req.toolCallId, tool);
  return { decision: "allow" };
}

/** Spec §4: every lexical target of an allowed read, kept so judge_read can name what it judges (and tell outside from local). */
function retainReadTargets(deps: BridgeHandlerDeps, turn: ActiveTurn, req: GateReq): void {
  const targets = gatePaths(req.input ?? {}).flatMap((raw) => { const t = gateTargets(raw, deps.ctx.home, turn.cwd); return t.ok ? t.targets : []; });
  (turn.readTargets ??= new Map()).set(req.toolCallId, targets);
}

function namesFor(turn: ActiveTurn): Map<string, string> {
  let m = builtinNames.get(turn);
  if (!m) { m = new Map(); builtinNames.set(turn, m); }
  return m;
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);

function writeBuiltinOutcome(store: RunStore, turn: ActiveTurn, toolCallId: string, entry: FsEntry, o: { ok: boolean; bytes_out: number; duration_ms: number; reason?: string },
  toolOverride?: string): void {
  const tool = toolOverride ?? namesFor(turn).get(toolCallId) ?? (entry === "fs_read" ? "builtin:read" : "builtin:write");
  namesFor(turn).delete(toolCallId);
  turn.unreported.delete(toolCallId);
  store.appendRunLedgerEvent(turn.run_id, "tool_finished", "capability_runner", {
    tool_call_id: toolCallId, status: o.ok ? "succeeded" : "failed", output_hash: "", duration_ms: o.duration_ms,
    bytes_out: o.bytes_out, tool, ...(o.reason !== undefined ? { reason: o.reason } : {})
  });
  store.appendRunLedgerEvent(turn.run_id, "loop_step", "core", {
    step: ++turn.step.n, action: tool, capability: toolOverride ? toolOverride.replace(/^builtin:/, "") : entry, ok: o.ok, result_digest: o.reason ?? `${o.bytes_out} bytes`
  });
}

/** The todo reports already written per turn (A11.4): the todo tool is ungated, so `unreported` cannot dedupe it. */
const todoReported = new WeakMap<ActiveTurn, Set<string>>();

/** The hook's tool_result for an allowed built-in: counts only, never content. A duplicate report is a no-op. */
function handleReport(deps: BridgeHandlerDeps, turn: ActiveTurn, req: ReportReq): { ok: true } {
  // read-format.ts: a succeeded read judged in an untested text shape pages once per omp version (an errored read's text is omp's message, not a file)
  const format = turn.judgePending?.get(req.toolCallId)?.format;
  if (format !== undefined && req.outcome === "succeeded") syncReadFormatDrift(deps.store, sharedOmpVersionCache(deps.cfg).lastVersion(), format, { env: deps.env });
  noteReportApplied(deps, turn, req.toolCallId, req.applied === true);
  const entry = turn.unreported.get(req.toolCallId);
  const counts = { ok: req.outcome === "succeeded", bytes_out: count(req.bytes_out), duration_ms: count(req.duration_ms) };
  if (!entry) {
    const seen = todoReported.get(turn) ?? new Set<string>();
    todoReported.set(turn, seen);
    if (req.tool === "todo" && !seen.has(req.toolCallId)) { // ungated, counts only, once per toolCallId
      seen.add(req.toolCallId);
      writeBuiltinOutcome(deps.store, turn, req.toolCallId, "fs_read", counts, "builtin:todo");
    }
    return { ok: true };
  }
  writeBuiltinOutcome(deps.store, turn, req.toolCallId, entry, counts);
  return { ok: true };
}

/** A flush without deps: `resolveDaemonTmpDir({}, "")` is a relative path no real target falls under, so every never-judged read counts as local. */
const LOCAL_ONLY: PathDeps = { env: {}, ctx: { home: "", repo: "", data: "" } };

/** Turn end: allowed-but-unreported built-ins (child died) count as failed so the breaker never undercounts. */
export function flushUnreported(store: RunStore, turn: ActiveTurn, deps: PathDeps = LOCAL_ONLY): void {
  raisePendingAtFlush(deps, turn);
  for (const [toolCallId, entry] of [...turn.unreported]) {
    writeBuiltinOutcome(store, turn, toolCallId, entry, { ok: false, bytes_out: 0, duration_ms: 0, reason: "unreported" });
  }
  turn.unreported.clear();
}
