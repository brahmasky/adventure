import { createHash } from "node:crypto";
import { CapabilityRunner, type CapabilityExecutionInput, type CapabilityResult } from "../capabilities/capability-runner.js";
import { decideCapability } from "../policy/capability-policy.js";
import type { BudgetLedger } from "../budget/budget-ledger.js";
import type { CompiledTaskContract, Identity } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { BridgeRequest } from "./bridge-protocol.js";
import { BUILTIN_CAPABILITY, capabilityFor, type RegistryEntry } from "./capability-map.js";
import { classifyCommand } from "./command-matcher.js";
import { gateTargets } from "./gate-path.js";
import { renderExternalRead, UNTRUSTED_READ_ENTRIES, type ExternalReadResult } from "./external-read.js";
import type { OmpConfig } from "./omp-config.js";
import { isDeniedRead, isDeniedWrite, type PathContext } from "./protected-paths.js";
import { isToolArmed } from "./tool-arming.js";
import { createToolApprovalSink, toolApprovalWaiters } from "./tool-approval-sink.js";
import { validateInput, type ToolDeclaration } from "./tool-decls.js";

type FsEntry = "fs_read" | "fs_write";

export interface ActiveTurn {
  run_id: string; worker_id: string; chat_id: string; requester: Identity; contract: CompiledTaskContract;
  budget: BudgetLedger; registry: ToolRegistry; signal: AbortSignal; cwd: string; step: { n: number };
  cache: Map<string, Promise<unknown>>; unreported: Map<string, FsEntry>;
  quarantine: (tool: string, output: Record<string, unknown>) => Promise<ExternalReadResult>;
  setAwaitingApproval: (on: boolean) => void; postureOk: () => string | null;
  /** Per-turn call queue: at most one call (and so one approval) in flight per turn. */
  serial?: Promise<unknown>;
}

export interface BridgeHandlerDeps {
  store: RunStore; cfg: OmpConfig; ctx: PathContext; decls: ToolDeclaration[]; env: NodeJS.ProcessEnv;
  /** The Telegram turn contract's allowed_actions: the manifest is fixed before any turn exists. */
  turnEnvelopeActions: string[];
  activeTurn: () => ActiveTurn | null;
}

export interface CallResult { content: string; isError: boolean }

export const APPROVAL_DENIED_TEXT = "Paco denied this action. It did not run. Do not retry it; tell him what you were trying to do.";
export const APPROVAL_EXPIRED_TEXT = "The approval request got no answer in time. The action did not run.";
export const QUARANTINE_FAILED_TEXT = "The reader could not process this source, so none of it is shown. Try another source.";
export const READ_TOOL_FAILED_TEXT = "The read tool failed; its error text is withheld (it may carry source bytes). Status:";
export const TURN_ABORTED_TEXT = "The turn was aborted; this call did not run.";
export const POLICY_VERSION = "omp-1";
export const RESPONSE_CAP = 32 * 1024;
const CARD_DETAIL_CAP = 300;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
export const TRUNCATION_NOTE = "\n…[truncated at 32 KiB]";
/** Cap in UTF-8 bytes, cut on a character boundary (never inside a multi-byte sequence). */
function cap(s: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= RESPONSE_CAP) return s;
  let end = RESPONSE_CAP;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}${TRUNCATION_NOTE}`;
}
type CallReq = Extract<BridgeRequest, { kind: "call" }>;
type GateReq = Extract<BridgeRequest, { kind: "gate" }>;
type ReportReq = Extract<BridgeRequest, { kind: "report" }>;

/** Built-in name per allowed gate (edit and write share fs_write); read back by report/flush. */
const builtinNames = new WeakMap<ActiveTurn, Map<string, string>>();

const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Shape check on the decoded wire value; a malformed request is never memoised. */
function wellFormed(req: BridgeRequest): boolean {
  const r = req as unknown as Record<string, unknown>;
  if (r.kind === "call") return nonEmpty(r.toolCallId) && typeof r.tool === "string" && isObject(r.input);
  if (r.kind === "gate") return nonEmpty(r.toolCallId) && typeof r.tool === "string" && isObject(r.input);
  if (r.kind === "report") return typeof r.toolCallId === "string";
  return true;
}

export function createBridgeHandler(deps: BridgeHandlerDeps): (req: BridgeRequest) => Promise<unknown> {
  return async (req) => {
    if (!wellFormed(req)) throw new Error("bad_request");
    if (req.kind === "manifest") return manifestFor(deps);
    const turn = deps.activeTurn();
    if (!turn) throw new Error("no_active_turn");
    if (req.kind === "call") return memo(turn, `call:${req.toolCallId}`, () => serialise(turn, () => handleCall(deps, turn, req)));
    if (req.kind === "gate") return memo(turn, `gate:${req.toolCallId}`, async () => handleGate(deps, turn, req));
    if (req.kind === "report") return handleReport(deps, turn, req);
    throw new Error("unknown request kind");
  };
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

function refuse(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, capability: string, reason: string, text: string, started: number): CallResult {
  finish(deps, turn, { toolCallId: req.toolCallId, tool: req.tool, capability, status: "denied", content: text, started, digest: reason, reason });
  return { content: text, isError: true };
}

async function handleCall(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq): Promise<CallResult> {
  const started = Date.now();
  const decl = deps.decls.find((d) => d.name === req.tool);
  const entry = capabilityFor(req.tool, req.input ?? {});
  if (!decl || !entry) throw new Error(`unknown_tool: ${String(req.tool)}`);
  if (turn.signal.aborted) return refuse(deps, turn, req, entry, "turn_aborted", TURN_ABORTED_TEXT, started);
  const posture = turn.postureOk();
  if (posture) return refuse(deps, turn, req, entry, posture, posture, started);
  if (!isToolArmed(req.tool, deps.env)) return refuse(deps, turn, req, entry, "not_armed", `${req.tool} is not armed`, started);
  const errors = validateInput(decl.parameters, req.input);
  if (errors.length > 0) return { content: errors.join("; "), isError: true };
  const executed = await executeWithApproval(deps, turn, req, entry);
  if ("refusal" in executed) return refuse(deps, turn, req, entry, executed.refusal.reason, executed.refusal.text, started);
  const r = executed.result;
  const rendered = await render(turn, entry, r);
  const status = rendered.failed ? "failed" : statusOf(r);
  const reason = rendered.failed ?? (status === "succeeded" ? undefined : reasonCode(r));
  finish(deps, turn, { toolCallId: req.toolCallId, tool: req.tool, capability: entry, status, content: rendered.content, started,
    digest: rendered.digest, bytesIn: bytes(JSON.stringify(req.input)), ...(reason !== undefined ? { reason } : {}) });
  return { content: rendered.content, isError: status !== "succeeded" };
}

function statusOf(r: CapabilityResult): "succeeded" | "failed" | "denied" {
  if (r.status === "succeeded") return "succeeded";
  return r.status === "denied" || r.status === "denied_on_revalidation" ? "denied" : "failed";
}

type Executed = { result: CapabilityResult } | { refusal: { reason: string; text: string } };

/** First execute; on requires_approval wait in-turn, then re-execute on the reserved budget unit. */
async function executeWithApproval(deps: BridgeHandlerDeps, turn: ActiveTurn, req: CallReq, entry: RegistryEntry): Promise<Executed> {
  const command = req.tool === "bash" && typeof req.input.command === "string" ? req.input.command : undefined;
  const sink = createToolApprovalSink({ store: deps.store, worker_id: turn.worker_id, tool_call_id: req.toolCallId,
    approvalTimeoutMs: deps.cfg.approvalTimeoutMs, ...(command !== undefined ? { card_detail: command.slice(0, CARD_DETAIL_CAP) } : {}) });
  const runner = new CapabilityRunner(turn.registry, sink);
  const base: CapabilityExecutionInput = { run_id: turn.run_id, requester: turn.requester, contract: turn.contract, capability: entry,
    input: req.input, budget: turn.budget, signal: turn.signal, tool_call_id: req.toolCallId, action_summary: summaryFor(req.tool, command) };
  const first = await runner.execute(base);
  if (first.status !== "requires_approval") return { result: first };
  const outcome = await awaitApproval(turn, first.approval_id, deps.cfg.approvalTimeoutMs);
  if (outcome === "approved") return { result: await runner.execute({ ...base, approved_approval_id: first.approval_id, budget_reserved: true }) };
  if (outcome !== "denied") deps.store.expireToolApproval(first.approval_id, new Date().toISOString());
  return { refusal: outcome === "denied" ? { reason: "denied_by_paco", text: APPROVAL_DENIED_TEXT } : { reason: `approval_${outcome}`, text: APPROVAL_EXPIRED_TEXT } };
}

/** The card's action line and the ledger's action_summary: the matcher label, never the command text. */
function summaryFor(tool: string, command: string | undefined): string {
  if (command === undefined) return tool;
  const c = classifyCommand(command);
  return c.kind === "plain" ? tool : c.label;
}

async function awaitApproval(turn: ActiveTurn, approval_id: string, timeoutMs: number) {
  turn.setAwaitingApproval(true);
  try { return await toolApprovalWaiters.wait(approval_id, timeoutMs, turn.signal); } finally { turn.setAwaitingApproval(false); }
}

interface Rendered { content: string; digest: string; failed?: string }

/** Read tools cross the wall ALWAYS (D3); bash is raw (D12); a ledger digest carries counts and hashes only. */
async function render(turn: ActiveTurn, entry: RegistryEntry, r: CapabilityResult): Promise<Rendered> {
  const isRead = UNTRUSTED_READ_ENTRIES.has(entry);
  if (r.status !== "succeeded") return { content: isRead ? `${READ_TOOL_FAILED_TEXT} ${r.status}` : cap(failureText(r)), digest: r.status };
  if (isRead) return renderRead(turn, entry, r.output);
  if (entry === "shell" || entry === "shell_external" || entry === "shell_destructive") {
    const out = typeof r.output.output === "string" ? r.output.output : "";
    const code = String(r.output.exit_code ?? "none");
    return { content: `${cap(out)}\n[exit ${code}]`, digest: `exit ${code}, ${bytes(out)} bytes` };
  }
  const json = JSON.stringify(r.output);
  return { content: cap(json), digest: `${bytes(json)} bytes` };
}

/** A reader failure never forwards its message: reader stderr can echo the prompt, i.e. the raw source. */
async function renderRead(turn: ActiveTurn, entry: RegistryEntry, output: Record<string, unknown>): Promise<Rendered> {
  let read: ExternalReadResult;
  try { read = await turn.quarantine(entry, output); } catch {
    return { content: QUARANTINE_FAILED_TEXT, digest: "quarantine_failed", failed: "quarantine_failed" };
  }
  const text = cap(renderExternalRead(read));
  // The ledger never holds read text: the rendered result may carry a code-extracted OTP or link.
  return { content: text, digest: `sha256:${sha(text)} bytes:${bytes(text)}` };
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

function gateDenial(deps: BridgeHandlerDeps, turn: ActiveTurn, req: GateReq, entry: FsEntry): string | null {
  const posture = turn.postureOk();
  if (posture) return posture;
  const raws = gatePaths(req.input ?? {});
  if (raws.length === 0) return "missing_path";
  for (const raw of raws) { const d = pathDenial(deps, turn, raw, entry); if (d) return d; }
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
    return { decision: "deny", reason };
  }
  turn.unreported.set(req.toolCallId, entry);
  namesFor(turn).set(req.toolCallId, tool);
  return { decision: "allow" };
}

function namesFor(turn: ActiveTurn): Map<string, string> {
  let m = builtinNames.get(turn);
  if (!m) { m = new Map(); builtinNames.set(turn, m); }
  return m;
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);

function writeBuiltinOutcome(store: RunStore, turn: ActiveTurn, toolCallId: string, entry: FsEntry, o: { ok: boolean; bytes_out: number; duration_ms: number; reason?: string }): void {
  const tool = namesFor(turn).get(toolCallId) ?? (entry === "fs_read" ? "builtin:read" : "builtin:write");
  namesFor(turn).delete(toolCallId);
  turn.unreported.delete(toolCallId);
  store.appendRunLedgerEvent(turn.run_id, "tool_finished", "capability_runner", {
    tool_call_id: toolCallId, status: o.ok ? "succeeded" : "failed", output_hash: "", duration_ms: o.duration_ms,
    bytes_out: o.bytes_out, tool, ...(o.reason !== undefined ? { reason: o.reason } : {})
  });
  store.appendRunLedgerEvent(turn.run_id, "loop_step", "core", {
    step: ++turn.step.n, action: tool, capability: entry, ok: o.ok, result_digest: o.reason ?? `${o.bytes_out} bytes`
  });
}

/** The hook's tool_result for an allowed built-in: counts only, never content. A duplicate report is a no-op. */
function handleReport(deps: BridgeHandlerDeps, turn: ActiveTurn, req: ReportReq): { ok: true } {
  const entry = turn.unreported.get(req.toolCallId);
  if (!entry) return { ok: true };
  writeBuiltinOutcome(deps.store, turn, req.toolCallId, entry,
    { ok: req.outcome === "succeeded", bytes_out: count(req.bytes_out), duration_ms: count(req.duration_ms) });
  return { ok: true };
}

/** Turn end: allowed-but-unreported built-ins (child died) count as failed so the breaker never undercounts. */
export function flushUnreported(store: RunStore, turn: ActiveTurn): void {
  for (const [toolCallId, entry] of [...turn.unreported]) {
    writeBuiltinOutcome(store, turn, toolCallId, entry, { ok: false, bytes_out: 0, duration_ms: 0, reason: "unreported" });
  }
  turn.unreported.clear();
}
