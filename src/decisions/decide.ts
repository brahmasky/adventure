import type {
  AnyDecideResult, AnyEntry, ArmedMode, DecideCtx, DecideResult, Entry, FallbackReason, JevRung, ModelRung, PacoRung, RuleRung, RungAnswer,
  RungKind, RungOutcome, RungResult
} from "./types.js";

/**
 * The runner (spec §5.1). Walks the ladder, applies the monotone rule, then records — in that order, so a ledger failure
 * can never change a decision. A thrown rule, a timeout or a missing executor is an abstention that names why.
 */
interface Walk<V, D> {
  outcomes: RungOutcome<V, D>[]; floor: V | undefined; floorRung: RungKind | undefined; fallback: FallbackReason | null; fallbackCode: string | null;
  fallbackRung: RungKind | null; shadowed: boolean;
}
type Decided<V, D> = { rung: RungKind; answer: RungAnswer<V, D> } | null;
const newWalk = <V, D>(): Walk<V, D> => ({ outcomes: [], floor: undefined, floorRung: undefined, fallback: null, fallbackCode: null, fallbackRung: null, shadowed: false });
/** The one error-message helper for src/decisions/ (the recorder imports it from here). */
export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function decideSync<S, V extends string, D = never>(entry: Entry<S, V, D>, s: S, ctx: DecideCtx<S, V, D>): DecideResult<V, D> {
  const clock = ctx.clock ?? Date.now;
  const started = clock();
  const w = newWalk<V, D>();
  // Checked up front, not on reaching the rung: a rule answering early must not hide a ladder decideSync can never run whole.
  const nonRule = entry.ladder.find((r) => r.kind !== "rule");
  if (nonRule) throw new Error(`decideSync: ${entry.id} has a ${nonRule.kind} rung; use decide`);
  for (const rung of entry.ladder) {
    if (rung.kind !== "rule") continue;
    const mode = modeOf(entry, rung.kind, ctx);
    if (mode === "off") { w.outcomes.push({ kind: rung.kind, name: rung.name, mode, result: null }); continue; }
    const answer = apply(entry, w, rung.kind, rung.name, mode, safeRule(entry.id, rung, s, ctx));
    if (answer) return record(entry, finish(entry, w, { rung: "rule", answer }, clock() - started), ctx);
  }
  return record(entry, finish(entry, w, null, clock() - started), ctx);
}

export async function decide<S, V extends string, D = never>(entry: Entry<S, V, D>, s: S, ctx: DecideCtx<S, V, D>): Promise<DecideResult<V, D>> {
  const clock = ctx.clock ?? Date.now;
  const started = clock();
  const w = newWalk<V, D>();
  for (const rung of entry.ladder) {
    const mode = modeOf(entry, rung.kind, ctx);
    if (mode === "off") { w.outcomes.push({ kind: rung.kind, name: rung.name, mode, result: null }); continue; }
    const raw = rung.kind === "rule" ? safeRule(entry.id, rung, s, ctx) : await runAsync(entry.id, rung, s, [...w.outcomes], ctx);
    const answer = apply(entry, w, rung.kind, rung.name, mode, raw);
    if (answer) return record(entry, finish(entry, w, { rung: rung.kind, answer }, clock() - started), ctx);
  }
  return record(entry, finish(entry, w, null, clock() - started), ctx);
}

/** A locked entry never reads ctx.armed (spec §4.1); otherwise ctx.armed (the front door's configured shadow) overrides the entry's arming. */
function modeOf<S, V extends string, D>(entry: Entry<S, V, D>, kind: RungKind, ctx: DecideCtx<S, V, D>): ArmedMode {
  if (entry.locked) return entry.armed[kind] ?? "on";
  return ctx.armed?.[kind] ?? entry.armed[kind] ?? "on";
}

function safeRule<S, V extends string, D>(id: string, rung: RuleRung<S, V, D>, s: S, ctx: DecideCtx<S, V, D>): RungResult<V, D> {
  try {
    const out = rung.decide(s);
    return typeof out === "string" ? { verdict: out } : out;
  } catch (e) {
    (ctx.log ?? console.error)(`decisions: ${id} rung ${rung.name} threw: ${message(e)}`);
    return { failed: "threw" };
  }
}

type AsyncRung = JevRung | ModelRung | PacoRung;
function executorFor<S, V, D>(rung: AsyncRung, ctx: DecideCtx<S, V, D>): ((s: S, prior: readonly RungOutcome<V, D>[]) => Promise<RungResult<V, D>>) | undefined {
  const x = ctx.exec;
  if (rung.kind === "system_one") return x?.system_one ? (s, p) => x.system_one!(rung, s, p) : undefined;
  if (rung.kind === "model") return x?.model ? (s, p) => x.model!(rung, s, p) : undefined;
  return x?.paco ? (s, p) => x.paco!(rung, s, p) : undefined;
}

async function runAsync<S, V, D>(id: string, rung: AsyncRung, s: S, prior: readonly RungOutcome<V, D>[], ctx: DecideCtx<S, V, D>): Promise<RungResult<V, D>> {
  const exec = executorFor(rung, ctx);
  if (!exec) return { failed: "outage", reason: "no_executor" };
  const timeoutMs = rung.kind === "paco" ? undefined : rung.timeoutMs;
  try {
    return await withTimeout(exec(s, prior), timeoutMs);
  } catch (e) {
    (ctx.log ?? console.error)(`decisions: ${id} rung ${rung.name} threw: ${message(e)}`);
    return { failed: "threw" };
  }
}

function withTimeout<V, D>(p: Promise<RungResult<V, D>>, ms: number | undefined): Promise<RungResult<V, D>> {
  if (ms === undefined) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<RungResult<V, D>>((resolve) => { timer = setTimeout(() => resolve({ failed: "timeout" }), ms); });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/** Records the outcome in the walk; returns the answer only when it applies (not shadow, not a failure, not an abstention). */
function apply<S, V extends string, D>(entry: Entry<S, V, D>, w: Walk<V, D>, kind: RungKind, name: string, mode: ArmedMode, raw: RungResult<V, D>): RungAnswer<V, D> | null {
  const result = checked(entry, raw);
  w.outcomes.push({ kind, name, mode, result });
  if (mode === "shadow") { w.shadowed = true; return null; }
  if ("failed" in result) {
    if (w.fallback === null) { w.fallback = result.failed; w.fallbackCode = result.reason ?? null; w.fallbackRung = kind; }
    return null;
  }
  if ("abstain" in result) {
    if (entry.monotone && result.floor !== undefined) {
      const next = cautious(entry, w.floor, result.floor);
      if (next !== w.floor) w.floorRung = kind; // the rung that set the floor (senior re-review S2)
      w.floor = next;
    }
    return null;
  }
  return result;
}

/** A verdict (or floor) outside the entry's closed set is a parse failure, never an answer. */
function checked<S, V extends string, D>(entry: Entry<S, V, D>, r: RungResult<V, D>): RungResult<V, D> {
  if ("verdict" in r && !entry.verdicts.includes(r.verdict)) return { failed: "parse" };
  if ("abstain" in r && r.floor !== undefined && !entry.verdicts.includes(r.floor)) return { failed: "parse" };
  return r;
}

function cautious<S, V extends string, D>(entry: Entry<S, V, D>, a: V | undefined, b: V): V {
  if (a === undefined || !entry.monotone) return b;
  const order = entry.monotone.order;
  return order.indexOf(b) >= order.indexOf(a) ? b : a;
}

function finish<S, V extends string, D>(entry: Entry<S, V, D>, w: Walk<V, D>, d: Decided<V, D>, elapsed: number): DecideResult<V, D> {
  const base = { fallbackReason: w.fallback, fallbackRung: w.fallbackRung, armedMode: w.shadowed ? ("shadow" as const) : ("on" as const), decisionId: null,
    walk: w.outcomes, latencyMs: Math.max(0, Math.round(elapsed)) };
  if (d === null) {
    const verdict = entry.monotone ? cautious(entry, w.floor, entry.fail) : entry.fail;
    return { ...base, verdict, rung: "fail", reason: w.fallbackCode };
  }
  const verdict = entry.monotone ? cautious(entry, w.floor, d.answer.verdict) : d.answer.verdict;
  // ruling 17: the floor held against a looser judge — the verdict is the floor's, so the row names the rung that set it
  if (verdict !== d.answer.verdict) return { ...base, verdict, rung: w.floorRung ?? "rule", reason: "floor_held" };
  return { ...base, verdict, rung: d.rung, reason: d.answer.reason ?? null, ...(d.answer.p !== undefined ? { p: d.answer.p } : {}),
    ...(d.answer.detail !== undefined ? { detail: d.answer.detail } : {}) };
}

function record<S, V extends string, D>(entry: Entry<S, V, D>, r: DecideResult<V, D>, ctx: DecideCtx<S, V, D>): DecideResult<V, D> {
  let decisionId: string | null = null;
  try {
    decisionId = ctx.recorder.record(entry as unknown as AnyEntry, r as unknown as AnyDecideResult, { run_id: ctx.run_id, tool_call_id: ctx.tool_call_id ?? null });
  } catch (e) {
    (ctx.log ?? console.error)(`decisions: ${entry.id} record threw past the recorder: ${message(e)}`);
  }
  return { ...r, decisionId };
}
