import { spawn, type ChildProcess } from "node:child_process";
import type { LlmAuditSink } from "../audit.js";
import type { LlmResult } from "../types.js";
import { buildChildEnv } from "../../omp/child-env.js";
import { daemonTmpRoot } from "../../run/daemon-tmp.js";
import type { OmpConfig } from "../../omp/omp-config.js";
import type { OmpCheckResult } from "../../omp/omp-version.js";
import { sharedOmpVersionCache } from "../../omp/omp-version-cache.js";
import { classifyOmpError, parseFrameLine, RETRYABLE_ERROR_KINDS, summarizeAssistantMessage, type AssistantSummary } from "../../omp/omp-frames.js";
import { familyOf, formatModelString, type ModelFamily, type ModelString } from "../../omp/model-string.js";
import { resolveModelRolesMode } from "../../omp/model-roles.js";

export interface OneShotInput {
  seat: string; chain: ModelString[]; prompt: string; files?: string[];
  correlationId: string; timeoutMs?: number; plannerFamily?: ModelFamily;
  /** The daemon's stop: aborting kills the in-flight leg's process group and ends the call (no later leg; the leg is audited error{shutdown}). */
  signal?: AbortSignal;
  /** Epoch ms bounding the whole chain: each leg's timeout is what it leaves (audited `timeout`), and no leg starts after it. */
  deadlineAt?: number;
}
export interface OneShotDeps {
  cfg: OmpConfig; audit: LlmAuditSink; versionCheck?: () => OmpCheckResult | Promise<OmpCheckResult>;
  /** Every version check's outcome, pass or refuse — the caller opens or clears its omp incidents. */
  onVersionCheck?: (check: OmpCheckResult) => void;
}

const STDOUT_CAP_BYTES = 8 * 1024 * 1024;

export function ompOneShotArgs(cfg: OmpConfig, m: ModelString, files: string[]): string[] {
  const args = ["--profile", cfg.profile, "-p", "--mode", "json", "--no-session", "--no-tools",
    "--no-extensions", "--no-skills", "--no-rules", "--model", `${m.provider}/${m.model}`];
  if (m.effort) args.push("--thinking", m.effort);
  for (const f of files) args.push(`@${f}`);
  return args;
}

interface LegOutcome { summary: AssistantSummary | null; error?: string; timedOut: boolean; latencyMs: number; aborted?: boolean }

/** After omp exits (or is killed), how long its stdout may still drain before the leg settles without it. */
export const LEG_EXIT_GRACE_MS = 500;

interface LegState { out: string; err: string; bytes: number; timedOut: boolean; settled: boolean; code: number | null | undefined }

function legOutcome(st: LegState, started: number): LegOutcome {
  const summaries = st.out.split("\n").map(parseFrameLine).filter((f) => f !== null).map(summarizeAssistantMessage).filter((s) => s !== null);
  const error = st.timedOut ? "timed out" : st.code !== 0 ? `exit ${st.code ?? "signal"}: ${st.err.slice(0, 300)}` : undefined;
  return { summary: summaries.at(-1) ?? null, ...(error ? { error } : {}), timedOut: st.timedOut, latencyMs: Date.now() - started };
}

/** SIGKILL omp's whole process group (it is the group leader): a helper that inherited stdout dies with it. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

/**
 * One leg. Settles exactly once (explicit flag): on `close`, or on `exit` plus LEG_EXIT_GRACE_MS when a helper still
 * holds stdout, or on the timeout plus the same grace after the group kill — never on a helper's lifetime (B11).
 */
function runLeg(cfg: OmpConfig, m: ModelString, input: OneShotInput): Promise<LegOutcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cfg.bin, ompOneShotArgs(cfg, m, input.files ?? []), {
      // TMPDIR: the daemon-only temp root, never planner-writable /tmp or os.tmpdir() (B13)
      env: { ...buildChildEnv(cfg.envPassthrough), TMPDIR: daemonTmpRoot() }, stdio: ["pipe", "pipe", "pipe"], detached: true
    });
    const st: LegState = { out: "", err: "", bytes: 0, timedOut: false, settled: false, code: undefined };
    let drain: ReturnType<typeof setTimeout> | undefined;
    const settle = (o?: LegOutcome) => {
      if (st.settled) return;
      st.settled = true; clearTimeout(timer); clearTimeout(drain); input.signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy(); child.stderr.destroy();
      resolve(o ?? legOutcome(st, started));
    };
    // A settled leg (an abort) arms nothing more: a kill after it could hit a reused pid.
    const settleAfterGrace = () => { if (st.settled) return; clearTimeout(drain); drain = setTimeout(() => { killGroup(child); settle(); }, LEG_EXIT_GRACE_MS); };
    const timer = setTimeout(() => { st.timedOut = true; killGroup(child); settleAfterGrace(); }, input.timeoutMs ?? cfg.oneshotTimeoutMs);
    const onAbort = () => { killGroup(child); settle({ summary: null, timedOut: false, latencyMs: Date.now() - started, aborted: true }); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => { st.bytes += d.length; if (st.bytes <= STDOUT_CAP_BYTES) st.out += d.toString("utf8"); else killGroup(child); });
    child.stderr.on("data", (d: Buffer) => { if (st.err.length < 4096) st.err += d.toString("utf8"); });
    child.stdin.on("error", () => { /* child exited before reading stdin; exit/close settles */ });
    child.on("error", (e) => settle({ summary: null, error: `spawn error: ${e.message}`, timedOut: st.timedOut, latencyMs: Date.now() - started }));
    child.on("exit", (code) => { st.code = code; settleAfterGrace(); });
    child.on("close", (code) => { if (st.code === undefined) st.code = code; settle(); });
    child.stdin.end(input.prompt);
  });
}

function legFailure(o: LegOutcome): string | null {
  if (o.timedOut) return "timed out";
  if (o.summary?.stopReason === "error" || o.summary?.errorMessage) return o.summary.errorMessage ?? "error";
  if (o.error) return o.error;
  if (!o.summary || o.summary.text.trim().length === 0) return "produced no answer";
  return null;
}

/** The leg's input under the chain's deadline: its timeout is what the deadline leaves; null once nothing is left. */
function legUnderDeadline(input: OneShotInput, cfg: OmpConfig): OneShotInput | null {
  if (input.deadlineAt === undefined) return input;
  const left = input.deadlineAt - Date.now();
  return left <= 0 ? null : { ...input, timeoutMs: Math.min(input.timeoutMs ?? cfg.oneshotTimeoutMs, left) };
}

/**
 * omp cannot hear audio: it inlines Ogg bytes as TEXT and the model invents a transcript (ruling 2,
 * live probe 2026-09-30). Code-owned refusal at the chokepoint — voice belongs to the agy-cli leg.
 */
export const OMP_AUDIO_REFUSED = "omp one-shot refuses audio (voice runs on the agy-cli leg)";
const AUDIO_FILE = /\.(opus|ogg|oga|mp3|wav|m4a|aac|flac|amr|weba)$/i;

/** A call the daemon's stop cut short: not a model failure (its leg, if one ran, is audited error{shutdown}). */
const ABORTED: LlmResult = { ok: false, provider: "omp", error: "aborted: the daemon is stopping", aborted: true };

/**
 * D10 as a skip rule (spec 2026-10-06 §8), resolved mode only. A reader call that knows the planner's family runs its
 * candidates of another family first, then the rest, each group in list order. When every candidate shares the family
 * the order stands, and every leg is flagged family_collapse below, as before. `HOUGE_MODEL_ROLES=static` (read per
 * call) keeps the list order exactly, as before stage A (spec §4.3).
 */
function readerOrder(input: OneShotInput): ModelString[] {
  if (input.seat !== "reader" || input.plannerFamily === undefined) return input.chain;
  if (resolveModelRolesMode(process.env) === "static") return input.chain;
  const cross = input.chain.filter((m) => familyOf(m) !== input.plannerFamily);
  return [...cross, ...input.chain.filter((m) => familyOf(m) === input.plannerFamily)];
}

export async function spawnOneShot(input: OneShotInput, deps: OneShotDeps): Promise<LlmResult> {
  if ((input.files ?? []).some((f) => AUDIO_FILE.test(f))) return { ok: false, provider: "omp", error: OMP_AUDIO_REFUSED };
  if (input.signal?.aborted) return ABORTED;
  const version = await (deps.versionCheck ?? (() => sharedOmpVersionCache(deps.cfg).current()))(); // one exec per omp binary (spec §3); never blocks the loop
  deps.onVersionCheck?.(version);
  // No leg ran, so no audit row: the structured check rides out for the caller's incident (ruling 6).
  if (!version.ok) return { ok: false, provider: "omp", error: version.reason, unavailable: true, omp_check: version };
  const errors: string[] = [];
  for (const [i, m] of readerOrder(input).entries()) {
    if (input.signal?.aborted) return ABORTED;
    const leg = legUnderDeadline(input, deps.cfg);
    if (leg === null) { errors.push(`${formatModelString(m)}: deadline`); break; } // never ran, so never audited
    const o = await runLeg(deps.cfg, m, leg);
    const family = familyOf(m);
    const base = {
      provider: m.provider, role: "", latency_ms: o.latencyMs, family, leg_index: i,
      attempt_group: input.correlationId, request_key: `${input.correlationId}:${i}`,
      ...(input.plannerFamily !== undefined && input.plannerFamily === family ? { family_collapse: true } : {})
    };
    if (o.aborted) {
      // The leg ran, so it is audited — as error{shutdown}, the one kind the llm_leg_failing sweep ignores.
      deps.audit.record({ ...base, outcome: "error", model: m.model, error_kind: "shutdown" });
      return ABORTED;
    }
    const failure = legFailure(o);
    if (failure === null && o.summary) {
      deps.audit.record({ ...base, outcome: "ok", model: o.summary.model ?? m.model,
        ...(o.summary.usage ? { usage: o.summary.usage } : {}),
        ...(o.summary.credentialId !== undefined ? { credential_id: o.summary.credentialId } : {}),
        ...(o.summary.ttftMs !== undefined ? { ttft_ms: o.summary.ttftMs } : {}) });
      return { ok: true, provider: m.provider, model: o.summary.model ?? m.model, answer: o.summary.text,
        ...(o.summary.usage ? { usage: o.summary.usage } : {}) };
    }
    const kind = o.timedOut ? "timeout" : classifyOmpError(failure ?? "");
    deps.audit.record({ ...base, outcome: "error", model: m.model, error_kind: kind });
    errors.push(`${formatModelString(m)}: ${kind}`);
    if (!RETRYABLE_ERROR_KINDS.has(kind)) break; // a refusal or an unknown failure is final for the call (spec §8)
  }
  return { ok: false, provider: "omp", error: `all ${input.seat} legs failed — ${errors.join("; ")}` };
}
