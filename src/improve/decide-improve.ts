import { decide } from "../decisions/decide.js";
import { IMPROVE_ROUTE, improveJevState, jevVerdictOf, type ImproveDetail, type ImproveState, type ImproveTarget } from "../decisions/entries/improve-route.js";
import type { AnyDecideResult, AnyEntry, DecideResult, DecisionRecorder, RungOutcome, RungResult } from "../decisions/types.js";
import { askImprove } from "../jev/improve-ask.js";
import type { JevRequest, JevResult } from "../jev/jev-client.js";
import type { RunStore } from "../run/run-store.js";
import { buildPickQuestion, parsePick, PICK_DISCIPLINE } from "./pick.js";

/** A tick's model seat (telegram-daemon.ts tickLlm): `{question, system}` in, `{ok, answer}` out. */
export type TickLlm = (input: { question: string; system: string; signal?: AbortSignal }) => Promise<{ ok: true; answer: string } | { ok: false }>;
export interface ImproveDecideDeps {
  store: RunStore; env: NodeJS.ProcessEnv; client: (r: JevRequest) => Promise<JevResult>; pick: TickLlm; now: () => string;
  /** Final fix 2 (the outage latch): false runs the rule rung only — Jev answers a `latched` outage and Tiny abstains, with no call. */
  modelRungs?: boolean;
}

/** Final fix 2: the Jev skip reasons that are an outage (unreachable, rate-limited, timed out), as opposed to a deterministic failure (parse, state_too_large, posture…). */
const TRANSIENT_JEV: ReadonlySet<string> = new Set(["no_key", "fused", "auth", "rate_limited", "overloaded", "timeout", "transport", "error", "latched"]);

/** An undecided result whose Jev failure is an outage (a rung timeout has no code: it is one). A rule that threw, a parse, the disarm posture: not one. */
export function isJevOutage(r: DecideResult<ImproveTarget, ImproveDetail>): boolean {
  if (r.rung !== "fail" || r.fallbackRung !== "system_one") return false;
  return r.fallbackReason === "timeout" || (r.fallbackReason === "outage" && TRANSIENT_JEV.has(r.reason ?? ""));
}
type Result = RungResult<ImproveTarget, ImproveDetail>;

/**
 * Ruling 11: `decide()` records inside itself, but the tick's model calls must run outside its transaction and the row
 * must commit with the group's outcome rows. The capturing recorder keeps the runner's result; `flush` writes it later.
 */
export interface RecordPatch { verdict: ImproveTarget; reason: string }
export function deferredRecorder(): { recorder: DecisionRecorder; flush(real: DecisionRecorder, patch?: RecordPatch): string | null } {
  let captured: { entry: AnyEntry; r: AnyDecideResult; ctx: { run_id: string | null; tool_call_id: string | null } } | null = null;
  return {
    recorder: { record: (entry, r, ctx) => { captured = { entry, r, ctx }; return null; } },
    // ruling 6: the tick may rewrite what is RECORDED (a failed draft → nothing/no_text; a second open proposal → nothing/already_proposed); the walk is untouched
    flush: (real, patch) => (captured ? real.record(captured.entry, patch ? { ...captured.r, verdict: patch.verdict, reason: patch.reason } : captured.r, captured.ctx) : null)
  };
}

export async function decideImprove(d: ImproveDecideDeps, s: ImproveState, recorder: DecisionRecorder, run_id: string | null): Promise<DecideResult<ImproveTarget, ImproveDetail>> {
  return decide(IMPROVE_ROUTE, s, { run_id, recorder, exec: { system_one: () => jevRung(d, s), model: (_rung, _s, prior) => tinyRung(d, s, prior) } });
}

async function jevRung(d: ImproveDecideDeps, s: ImproveState): Promise<Result> {
  if (d.modelRungs === false) return { failed: "outage", reason: "latched" };
  const r = await askImprove({ state: improveJevState(s), client: d.client, store: d.store });
  if ("failed" in r) return { failed: r.failed, ...(r.reason ? { reason: r.reason } : {}) };
  return jevVerdictOf(r.answer, s);
}

/** Below the bar: one word among Jev's top two; the row keeps Jev's top p (§4.3). No top two (an inapplicable top, a Jev failure): abstain. */
async function tinyRung(d: ImproveDecideDeps, s: ImproveState, prior: readonly RungOutcome<ImproveTarget, ImproveDetail>[]): Promise<Result> {
  const jev = prior.find((o) => o.kind === "system_one")?.result;
  const detail = jev && "abstain" in jev ? jev.detail : undefined;
  if (!detail?.top2 || d.modelRungs === false) return { abstain: true };
  const r = await d.pick({ question: buildPickQuestion(improveJevState(s), detail.top2), system: PICK_DISCIPLINE });
  // ruling 18 / spec §4.3: a failed call or a word that is not one of the two ABSTAINS (never a decision_fallback count); the seat's audit row holds the failure
  if (!r.ok) return { abstain: true, reason: "below_bar" };
  const picked = parsePick(r.answer, detail.top2);
  if (!picked) return { abstain: true, reason: "below_bar" };
  return { verdict: picked, reason: "tiny_pick", ...(detail.p !== undefined ? { p: detail.p } : {}), detail: { ...detail, pick: picked } };
}
