/**
 * omp contract probe (spec §4): checks the omp surface Houge depends on (catalog, start refusal, RPC session, pin
 * refusal, effort, new_session, one tiny prompt) so a quiet contract change in an omp upgrade is caught instead of
 * silently breaking fallback, attribution or session reset. Outcomes are fixed codes chosen here: omp's own text
 * (stderr, error detail, the model's reply) is classified at most and never stored, logged or returned. A fail pages;
 * it never blocks or downgrades a spawn (D2).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOmpCatalogResult, type CatalogRead } from "./model-catalog.js";
import { formatModelString, type ModelString, type OmpEffort } from "./model-string.js";
import type { OmpConfig } from "./omp-config.js";
import { classifyOmpError, frameErrorText, type OmpFrame } from "./omp-frames.js";
import { PlannerRpcError, PlannerSession, type PlannerSessionOptions } from "./planner-session.js";
import { isModelRefusal, writeHougeConfigFile } from "./planner-supervisor.js";
import type { PathContext } from "./protected-paths.js";
import { writeSeatbeltProfiles } from "./seatbelt.js";

export type ProbeCheckName = "catalog" | "start_refusal" | "session_open" | "pin_refusal" | "effort" | "new_session" | "prompt";
export type ProbeCheckOutcome = "pass" | `fail:${string}` | `inconclusive:${string}` | "skipped";
export interface ProbeResult {
  version: string; result: "pass" | "fail" | "inconclusive"; model: string | null;
  checks: Record<ProbeCheckName, ProbeCheckOutcome>;
  usage: { input_tokens: number; output_tokens: number } | null;
  started_at: string; finished_at: string;
}
/** The slice of PlannerSession the probe drives (tests inject a fake). */
export interface ProbeSessionLike {
  start(): Promise<{ resumed: boolean; sessionId: string }>;
  setModel(m: ModelString): Promise<void>;
  setThinkingLevel(level: OmpEffort): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  prompt(text: string): Promise<void>;
  onFrame(cb: (f: OmpFrame) => void): void;
  stop(): Promise<void>;
}
/** The one fixed selector: deliberately not a model, so omp must refuse it at start and at set_model. */
export const PROBE_BOGUS_MODEL: ModelString = { provider: "houge-probe", model: "no-such-model" };
export interface ProbeInput {
  cfg: OmpConfig; ctx: PathContext; version: string; model: ModelString | null; signal?: AbortSignal;
  session?: (o: PlannerSessionOptions) => ProbeSessionLike;
  catalog?: () => Promise<CatalogRead>;
  prepare?: (ctx: PathContext) => { configFile: string; plannerProfile: string };
  now?: () => string;
  timeouts?: { startMs?: number; commandMs?: number; frameMs?: number; promptMs?: number };
}

const SYSTEM_PROMPT = "You are a connectivity probe for Houge. Answer in as few words as possible.";
const PROBE_PROMPT = "Reply with exactly OK.";
const START_INCONCLUSIVE = /^exited:(model_missing|quota|auth|transport)$/;
const TIMED_OUT = Symbol("timed_out");
const ABORTED = Symbol("aborted");
const CHECK_NAMES: readonly ProbeCheckName[] = ["catalog", "start_refusal", "session_open", "pin_refusal", "effort", "new_session", "prompt"];

interface Timeouts { startMs: number; commandMs: number; frameMs: number; promptMs: number }
type FrameHub = Set<(f: OmpFrame) => void>;
interface Live { s: ProbeSessionLike; hub: FrameHub }
interface Run {
  input: ProbeInput; t: Timeouts;
  open: (m: ModelString) => Live; aborted: Promise<typeof ABORTED>; isAborted: () => boolean;
  catalog: CatalogRead | null; usage: ProbeResult["usage"];
}

/** Race `p` against a timer that is always cleared (no timer outlives the wait). */
async function bounded<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((r) => { t = setTimeout(() => r(TIMED_OUT), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

/** A probe step: its value, TIMED_OUT, or ABORTED (the stop signal ends the wait at once). */
const step = <T>(r: Run, p: Promise<T>, ms: number) => bounded(Promise.race([p, r.aborted]), ms);

const errCode = (e: unknown): string => (e instanceof PlannerRpcError ? e.code : "");
const isTimeoutErr = (e: unknown): boolean => errCode(e).startsWith("timeout:");

/** Wait for the first frame matching `pred`; subscribe BEFORE the command (omp emits frames before its reply). */
function waitFrame(hub: FrameHub, pred: (f: OmpFrame) => boolean): { seen: Promise<OmpFrame>; cancel: () => void } {
  let cb: (f: OmpFrame) => void = () => undefined;
  const seen = new Promise<OmpFrame>((resolve) => { cb = (f) => { if (pred(f)) { hub.delete(cb); resolve(f); } }; hub.add(cb); });
  return { seen, cancel: () => hub.delete(cb) };
}

function checkCatalogRead(c: CatalogRead): ProbeCheckOutcome {
  if (c.kind === "ok") return c.models.length > 0 ? "pass" : "fail:unparsed";
  return c.kind === "unparsed" ? "fail:unparsed" : "inconclusive:catalog_unavailable";
}

async function checkCatalog(r: Run, read: () => Promise<CatalogRead>): Promise<ProbeCheckOutcome> {
  const c = await Promise.race([read(), r.aborted]);
  if (c === ABORTED) return "skipped";
  r.catalog = c;
  return checkCatalogRead(c);
}

async function checkStartRefusal(r: Run): Promise<ProbeCheckOutcome> {
  const { s } = r.open(PROBE_BOGUS_MODEL);
  try {
    const v = await step(r, s.start().then(() => "started" as const, (e: unknown) => ({ code: errCode(e) })), r.t.startMs);
    if (v === ABORTED) return "skipped";
    if (v === TIMED_OUT) return "inconclusive:timeout";
    if (v === "started") return "fail:started";
    return v.code === "exited:model_missing" ? "pass" : "fail:unclassified";
  } finally { await s.stop().catch(() => {}); }
}

async function checkSessionOpen(r: Run, s: ProbeSessionLike): Promise<ProbeCheckOutcome> {
  const v = await step(r, s.start().then((ok) => ({ ok }), (e: unknown) => ({ code: errCode(e) })), r.t.startMs);
  if (v === ABORTED) return "skipped";
  if (v === TIMED_OUT) return "inconclusive:timeout";
  if ("code" in v) {
    const m = START_INCONCLUSIVE.exec(v.code);
    return m ? `inconclusive:start_${m[1]}` : "fail:start";
  }
  const o = v.ok as { resumed?: unknown; sessionId?: unknown } | null | undefined;
  return typeof o?.resumed === "boolean" && typeof o.sessionId === "string" && o.sessionId.length > 0 ? "pass" : "fail:shape";
}

async function checkPinRefusal(r: Run, s: ProbeSessionLike): Promise<ProbeCheckOutcome> {
  const v = await step(r, s.setModel(PROBE_BOGUS_MODEL).then(() => "accepted" as const, (e: unknown) => ({ e })), r.t.commandMs);
  if (v === ABORTED) return "skipped";
  if (v === TIMED_OUT) return "inconclusive:timeout";
  if (v === "accepted") return "fail:accepted";
  if (isModelRefusal(v.e)) return "pass";
  return isTimeoutErr(v.e) ? "inconclusive:timeout" : "fail:unclassified";
}

/** The first catalogued level of `model` other than its effort (check 5 moves there and back). */
function altEffort(r: Run, model: ModelString): OmpEffort | null {
  if (!model.effort || r.catalog?.kind !== "ok") return null;
  const entry = r.catalog.models.find((m) => m.provider === model.provider && m.id === model.model);
  return entry?.thinking?.find((l) => l !== model.effort) ?? null;
}

/** One `set_thinking_level`, passing only when its `thinking_level_changed` frame shows `level`. */
async function setLevelSeen(r: Run, live: Live, level: OmpEffort): Promise<ProbeCheckOutcome> {
  const w = waitFrame(live.hub, (f) => f.type === "thinking_level_changed" && f.thinkingLevel === level);
  try {
    const sent = await step(r, live.s.setThinkingLevel(level).then(() => null, (e: unknown) => ({ e })), r.t.commandMs);
    if (sent === ABORTED) return "skipped";
    if (sent === TIMED_OUT) return "inconclusive:timeout";
    if (sent !== null) return isTimeoutErr(sent.e) ? "inconclusive:timeout" : "fail:rejected";
    const seen = await step(r, w.seen, r.t.frameMs);
    if (seen === ABORTED) return "skipped";
    return seen === TIMED_OUT ? "fail:no_frame" : "pass";
  } finally { w.cancel(); }
}

async function checkEffort(r: Run, live: Live, model: ModelString): Promise<ProbeCheckOutcome> {
  const alt = altEffort(r, model);
  if (!alt || !model.effort) return "skipped";
  const there = await setLevelSeen(r, live, alt);
  return there === "pass" ? setLevelSeen(r, live, model.effort) : there;
}

async function checkNewSession(r: Run, s: ProbeSessionLike): Promise<ProbeCheckOutcome> {
  const v = await step(r, s.newSession().then(() => null, (e: unknown) => ({ e })), r.t.commandMs);
  if (v === ABORTED) return "skipped";
  if (v === TIMED_OUT) return "inconclusive:timeout";
  if (v === null) return "pass";
  return isTimeoutErr(v.e) ? "inconclusive:timeout" : "fail:shape";
}

/** Check 7's shape rule over the raw frame (summarizeAssistantMessage would turn bad usage into zeros). */
export function validateAssistantEnd(frame: OmpFrame): { input_tokens: number; output_tokens: number } | null {
  const m = frame.message as Record<string, unknown> | undefined;
  if (typeof m !== "object" || m === null || m.role !== "assistant") return null;
  if (typeof m.provider !== "string" || typeof m.model !== "string" || typeof m.stopReason !== "string") return null;
  const u = m.usage as Record<string, unknown> | undefined;
  if (typeof u !== "object" || u === null) return null;
  const { input, output } = u;
  if (typeof input !== "number" || !Number.isFinite(input) || typeof output !== "number" || !Number.isFinite(output)) return null;
  const content = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
  const text = content.filter((c) => c?.type === "text").map((c) => (typeof c.text === "string" ? c.text : "")).join("");
  return text.trim().length > 0 ? { input_tokens: input, output_tokens: output } : null;
}

const isAssistantEnd = (f: OmpFrame) => f.type === "message_end" && (f.message as { role?: unknown } | undefined)?.role === "assistant";
const isProviderErrorFrame = (f: OmpFrame) => f.type === "error" || (f.type === "prompt_result" && f.status === "error");
const providerKind = (text: string): ProbeCheckOutcome => `inconclusive:provider_${classifyOmpError(text)}`;

/** The settled prompt: the frame that ended it (agent_end or a provider error) and the last assistant message_end. */
function judgePrompt(r: Run, end: OmpFrame, last: OmpFrame | undefined): ProbeCheckOutcome {
  if (isProviderErrorFrame(end)) return providerKind(frameErrorText(end));
  if (!last) return "fail:shape";
  const m = last.message as Record<string, unknown>;
  if (m.stopReason === "error" || typeof m.errorMessage === "string") return providerKind(typeof m.errorMessage === "string" ? m.errorMessage : "");
  const usage = validateAssistantEnd(last);
  if (!usage) return "fail:shape";
  r.usage = usage;
  return "pass";
}

/** Kinds that say nothing about a provider: a refusal classified as one of these is omp rejecting the command itself. */
const NON_PROVIDER_KINDS: ReadonlySet<string> = new Set(["other", "parse"]);

/** A refused `prompt` command: a provider-like condition in its detail is not drift; an unclassified refusal is. */
function promptRefused(e: unknown): ProbeCheckOutcome {
  if (isTimeoutErr(e)) return "inconclusive:timeout";
  if (errCode(e) !== "command_failed:prompt") return "fail:rejected";
  const kind = classifyOmpError((e as PlannerRpcError).detail ?? "");
  return NON_PROVIDER_KINDS.has(kind) ? "fail:rejected" : `inconclusive:provider_${kind}`;
}

async function checkPrompt(r: Run, live: Live): Promise<ProbeCheckOutcome> {
  let last: OmpFrame | undefined;
  const w = waitFrame(live.hub, (f) => {
    if (isAssistantEnd(f)) last = f;
    return f.type === "agent_end" || isProviderErrorFrame(f);
  });
  try {
    const sent = live.s.prompt(PROBE_PROMPT).then(() => new Promise<never>(() => {}), (e: unknown) => ({ e }));
    const v = await step(r, Promise.race([w.seen, sent]), r.t.promptMs);
    if (v === ABORTED) return "skipped";
    if (v === TIMED_OUT) return "inconclusive:timeout";
    if ("e" in v) return promptRefused(v.e);
    return judgePrompt(r, v, last);
  } finally { w.cancel(); }
}

/** Checks 3–7 on one child started on the probe model; 4–7 run only when 3 passed. */
async function runModelChecks(r: Run, model: ModelString, checks: Record<ProbeCheckName, ProbeCheckOutcome>): Promise<void> {
  const live = r.open(model);
  try {
    checks.session_open = await guarded(r, () => checkSessionOpen(r, live.s));
    if (checks.session_open !== "pass") return;
    checks.pin_refusal = await guarded(r, () => checkPinRefusal(r, live.s));
    checks.effort = await guarded(r, () => checkEffort(r, live, model));
    checks.new_session = await guarded(r, () => checkNewSession(r, live.s));
    checks.prompt = await guarded(r, () => checkPrompt(r, live));
    if (checks.prompt !== "pass") r.usage = null; // usage only from a validated reply
  } finally { await live.s.stop().catch(() => {}); }
}

/** A check cut by the stop signal, or started after it, is `skipped`. */
async function guarded(r: Run, fn: () => Promise<ProbeCheckOutcome>): Promise<ProbeCheckOutcome> {
  if (r.isAborted()) return "skipped";
  const out = await fn();
  return r.isAborted() ? "skipped" : out;
}

async function runChecks(r: Run): Promise<Record<ProbeCheckName, ProbeCheckOutcome>> {
  const checks = Object.fromEntries(CHECK_NAMES.map((n) => [n, "skipped"])) as Record<ProbeCheckName, ProbeCheckOutcome>;
  const read = r.input.catalog ?? (() => readOmpCatalogResult(r.input.cfg));
  checks.catalog = await guarded(r, () => checkCatalog(r, read));
  checks.start_refusal = await guarded(r, () => checkStartRefusal(r));
  if (!r.input.model) { if (!r.isAborted()) checks.session_open = "inconclusive:no_model"; return checks; }
  await runModelChecks(r, r.input.model, checks);
  return checks;
}

function overall(checks: Record<ProbeCheckName, ProbeCheckOutcome>): ProbeResult["result"] {
  const v = Object.values(checks);
  if (v.some((c) => c.startsWith("fail:"))) return "fail";
  return v.some((c) => c.startsWith("inconclusive:")) ? "inconclusive" : "pass";
}

function defaultPrepare(ctx: PathContext): { configFile: string; plannerProfile: string } {
  writeSeatbeltProfiles(ctx);
  return { configFile: writeHougeConfigFile(ctx), plannerProfile: join(ctx.data, "omp", "planner.sb") };
}

/** Abort wiring: the stop signal stops the live child at once and settles `aborted`. */
function abortWatch(signal: AbortSignal | undefined, liveChild: () => ProbeSessionLike | undefined) {
  let fire: () => void = () => undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => { fire = () => { void liveChild()?.stop().catch(() => {}); resolve(ABORTED); }; });
  if (signal?.aborted) fire(); else signal?.addEventListener("abort", fire, { once: true });
  return { aborted, isAborted: () => signal?.aborted === true, detach: () => signal?.removeEventListener("abort", fire) };
}

/** Run the seven checks in throwaway dirs under `<data>/omp`, removed afterwards; every child is stopped. */
export async function runOmpContractProbe(input: ProbeInput): Promise<ProbeResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const started_at = now();
  const t: Timeouts = { startMs: 30_000, commandMs: 15_000, frameMs: 5_000, promptMs: 60_000, ...input.timeouts };
  const id = randomUUID();
  const cwd = join(input.ctx.data, "omp", "workspace", `probe-${id}`);
  const sessionDir = join(input.ctx.data, "omp", "sessions", `probe-${id}`);
  let current: ProbeSessionLike | undefined;
  const watch = abortWatch(input.signal, () => current);
  try {
    for (const d of [cwd, sessionDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const systemPromptFile = join(cwd, "probe-system.md");
    writeFileSync(systemPromptFile, SYSTEM_PROMPT, { mode: 0o600 });
    const prep = (input.prepare ?? defaultPrepare)(input.ctx);
    const base = { cfg: input.cfg, sessionDir, cwd, systemPromptFile, extensions: [], bridgeSock: "", bridgeToken: "", ...prep,
      tools: "none" as const, quietRpcErrors: true, sendTimeoutMs: t.commandMs };
    const open = (model: ModelString): Live => {
      const s = (input.session ?? ((o) => new PlannerSession(o)))({ ...base, model });
      const hub: FrameHub = new Set();
      s.onFrame((f) => { for (const cb of [...hub]) cb(f); });
      current = s;
      if (watch.isAborted()) void s.stop().catch(() => {});
      return { s, hub };
    };
    const r: Run = { input, t, open, aborted: watch.aborted, isAborted: watch.isAborted, catalog: null, usage: null };
    const checks = await runChecks(r);
    return { version: input.version, result: overall(checks), model: input.model ? formatModelString(input.model) : null,
      checks, usage: r.usage, started_at, finished_at: now() };
  } finally {
    watch.detach();
    for (const d of [cwd, sessionDir]) rmSync(d, { recursive: true, force: true });
  }
}
