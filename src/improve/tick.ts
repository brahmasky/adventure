import { createHash } from "node:crypto";
import { errorCode } from "../domain/error-code.js";
import { redactForImprove } from "../decisions/egress.js";
import type { ImproveState, ImproveTarget } from "../decisions/entries/improve-route.js";
import { resolveDigestAt } from "../decisions/digest.js";
import { OutcomeRejected, outcomeValueOf } from "../decisions/outcomes.js";
import { storeRecorder } from "../decisions/record.js";
import type { DecideResult } from "../decisions/types.js";
import type { JevRequest, JevResult } from "../jev/jev-client.js";
import type { ProposalTarget, RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { resolveSkillsEnabled, type SkillStore } from "../skills/skill-store.js";
import { computeAbandonment } from "./abandonment.js";
import { decideImprove, deferredRecorder, type RecordPatch, type TickLlm } from "./decide-improve.js";
import { buildImproveState, groupSignals, RECURRENCE_WINDOW_DAYS, type SignalGroup } from "./groups.js";
import { DRAFT_SEAT_FAILED, draftFor, PROPOSAL_TTL_DAYS, type Draft } from "./proposals.js";
import { computeRecurrence, recordRecurrenceSignals, resolveRecurrenceGate, type Embedder, type RecurrenceCluster } from "./recurrence.js";
import { scheduleHints } from "./schedule-shift.js";

/**
 * The daily improvement tick (2b-ii §3). Once per local date at the digest's time (also when the digest is off): mirror the
 * day's outcomes into the inbox, compute recurrence and abandonment, group the unconsumed rows, decide each group with model
 * calls OUTSIDE any transaction, then commit one transaction per group. Deferred groups stay unconsumed (durable retry); a
 * crash resumes from the `running` latch; the stop signal is checked between model calls; `improve_tick` events bracket it.
 */
export const IMPROVE_GROUPS_PER_TICK = 40;
export const IMPROVE_JOBS_PER_DAY = 3;
export const IMPROVE_INBOX_BATCH = 500;
export const IMPROVE_STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface JobHooks {
  reconcile(d: ImproveTickDeps): void;
  reconcileAccepted(d: ImproveTickDeps): void;
  enqueueFromRecurrence(store: RunStore, i: { decision_id: string; proposal_id: null; chat_id: string | null; origin: { turn_ids: string[]; run_ids: string[]; category: string; text_hashes: string[] }; idempotency_key: string; now: string }): string | null;
  runQueued(d: ImproveTickDeps, budget: number): Promise<number>;
}
export interface ImproveTickDeps {
  store: RunStore; env: NodeJS.ProcessEnv; now: string; signal: AbortSignal; chatId: string | null;
  client: (r: JevRequest) => Promise<JevResult>;
  llm: { pick: TickLlm; distill: TickLlm; classify: TickLlm; compose: TickLlm; verify: TickLlm };
  embed: Embedder; embedModel: string; skills: SkillStore; jobs?: JobHooks;
  /** Tests only: overrides IMPROVE_TICK_BUDGET_MS, and the wall clock the budget is measured on (a flake-free budget test). */
  budgetMs?: number;
  clock?: () => number;
  /** The instant a job's ending is stamped with (final fix C1). Unset in the daemon (the wall clock); the live gate passes its shifted clock. */
  wallNow?: () => string;
}
export const IMPROVE_TICK_BUDGET_MS = 120_000;
export interface TickCounts { mirrored: number; recurrence: number; abandoned: number; groups: number; decided: number; proposals: number; jobs_queued: number; jobs_started: number; deferred: number; deferred_outage: number; stale: number; already_proposed: number; no_draft: number; record_failed: number; embed_unavailable: number }
export type ImproveTickResult = { ran: false } | { ran: true; result: "done" | "stopped" | "failed"; counts: TickCounts };
const zero = (): TickCounts => ({ mirrored: 0, recurrence: 0, abandoned: 0, groups: 0, decided: 0, proposals: 0, jobs_queued: 0, jobs_started: 0, deferred: 0, deferred_outage: 0, stale: 0, already_proposed: 0, no_draft: 0, record_failed: 0, embed_unavailable: 0 });

/** Due once per local date at or after HOUGE_DECISION_DIGEST_AT (the default 21:00 when it is `off`): the date, or null. */
export function improveTickDue(store: RunStore, env: NodeJS.ProcessEnv, now: string): string | null {
  const [date, time] = formatInstantInZone(now, resolveDisplayZone(env)).split(" ") as [string, string];
  if (time < resolveDigestAt(env)) return null;
  const t = store.getImproveTick(date);
  return t === undefined || t.result === "running" || t.result === "stopped" ? date : null;
}

export async function runImproveTick(d: ImproveTickDeps): Promise<ImproveTickResult> {
  const date = improveTickDue(d.store, d.env, d.now);
  if (!date || d.store.beginImproveTick(date, d.now) === "done") return { ran: false };
  d.store.recordMemoryEvent("improve_tick", { phase: "start", local_date: date }, "improve");
  const counts = zero();
  let result: "done" | "stopped" | "failed" = "done";
  try {
    result = await tickBody(d, counts);
  } catch (e) {
    result = "failed";
    console.error(`[improve] tick failed: ${errorCode(e)}`);
  }
  d.store.finishImproveTick(date, result, { ...counts }, d.now);
  d.store.recordMemoryEvent("improve_tick", { phase: "end", local_date: date, result, counts: { ...counts } }, "improve");
  return { ran: true, result, counts };
}

/** Phase 1: housekeeping and the producers. `stopped` when the daemon is stopping. */
async function producePhase(d: ImproveTickDeps, c: TickCounts): Promise<{ clusters: Map<string, RecurrenceCluster>; stopped: boolean }> {
  d.store.expireProposals(new Date(Date.parse(d.now) - PROPOSAL_TTL_DAYS * DAY_MS).toISOString(), d.now);
  d.jobs?.reconcile(d);
  d.jobs?.reconcileAccepted(d);
  c.mirrored = d.store.mirrorOutcomesIntoInbox().copied;
  const rec = await computeRecurrence({ store: d.store, env: d.env, now: d.now, embed: d.embed, embedModel: d.embedModel, signal: d.signal });
  if (d.signal.aborted) return { clusters: rec.clusters, stopped: true };
  c.embed_unavailable = rec.embedUnavailable;
  c.recurrence = recordRecurrenceSignals(d.store, rec.clusters, d.now);
  if (rec.embedUnavailable === 0) c.abandoned = await computeAbandonment({ store: d.store, now: d.now, gate: resolveRecurrenceGate(d.env), embed: d.embed, embedModel: d.embedModel, signal: d.signal });
  return { clusters: rec.clusters, stopped: d.signal.aborted };
}

async function tickBody(d: ImproveTickDeps, c: TickCounts): Promise<"done" | "stopped"> {
  const clock = d.clock ?? Date.now;
  const started = clock();
  const { clusters, stopped } = await producePhase(d, c);
  if (stopped) return "stopped";
  const tz = resolveDisplayZone(d.env);
  const staleBefore = new Date(Date.parse(d.now) - IMPROVE_STALE_DAYS * DAY_MS).toISOString();
  const groups = groupSignals(d.store.listUnconsumedSignals(IMPROVE_INBOX_BATCH), (id) => d.store.getJevVerdictForRun(id), clusters, staleBefore);
  c.groups = groups.length;
  const hints = scheduleHints(d.store, d.now, tz);
  const since14 = d.store.listImproveSignalsSince(new Date(Date.parse(d.now) - RECURRENCE_WINDOW_DAYS * DAY_MS).toISOString());
  const dayAgo = new Date(Date.parse(d.now) - DAY_MS).toISOString();
  let queueLeft = IMPROVE_JOBS_PER_DAY - d.store.countJobsCreatedSince(dayAgo);
  for (const g of groups) {
    // ruling 17: between groups only — a decided group always commits; the stop or the budget ends the call, the latch resumes next cycle
    if (d.signal.aborted || clock() - started > (d.budgetMs ?? IMPROVE_TICK_BUDGET_MS)) return "stopped";
    if (c.decided >= IMPROVE_GROUPS_PER_TICK) { c.deferred += 1; continue; }
    // final fix D5: with the embedder down no cluster exists today, so a waiting recurrence row is deferred, not consumed stale
    if (g.signal === "recurrence" && c.embed_unavailable > 0 && g.rows.every((x) => x.created_at >= staleBefore)) { c.deferred_outage += 1; continue; }
    const s = buildImproveState(g, { store: d.store, env: d.env, now: d.now, skills: d.skills, redact: (t) => redactForImprove(d.store, t), scheduleHints: hints, since14, recurrenceGate: resolveRecurrenceGate(d.env) });
    // §3.5: a cluster beyond the day's 3 gets no row (ruling 5); final fix C5: so does every cluster while /disarm has skills off
    if (willStartJob(s) && (queueLeft <= 0 || !resolveSkillsEnabled(d.env))) { c.deferred += 1; continue; }
    let outcome: GroupOutcome;
    try {
      outcome = await runGroup(d, g, s, { tz, hints }, c);
    } catch (e) {   // one group's failure (the commit rolled back whole) never costs the next group its turn; its rows stay unconsumed
      console.error(`[improve] group failed: ${errorCode(e)}`);
      c.record_failed += 1;
      continue;
    }
    if (outcome === "record_failed") { c.record_failed += 1; continue; }   // rows stay unconsumed: tomorrow's tick reads them again
    if (outcome === "deferred") { c.deferred += 1; continue; }
    if (outcome === "deferred_outage") { c.deferred_outage += 1; continue; }   // final fix D1: an outage never consumes; the stale rule bounds it
    if (outcome === "queued") queueLeft -= 1;
    if (s.stale) c.stale += 1;
    c.decided += 1;
  }
  if (d.jobs) c.jobs_started = await d.jobs.runQueued(d, Math.max(0, IMPROVE_JOBS_PER_DAY - d.store.countJobsStartedSince(dayAgo))); // ruling 14: starts are budgeted apart from queueing
  return "done";
}

type GroupOutcome = "queued" | "committed" | "record_failed" | "deferred" | "deferred_outage";

/**
 * One group's model calls, outside any transaction, then its commit. Final fix D1: a Jev failure (any fallbackReason) or a
 * failed distill seat call writes nothing and consumes nothing. D2/D3: the duplicate check (an open proposal, or one Paco
 * dismissed or that expired within PROPOSAL_TTL_DAYS) runs before the draft, so a duplicate costs no distill call.
 */
async function runGroup(d: ImproveTickDeps, g: SignalGroup, s: ImproveState, x: { tz: string; hints: ReturnType<typeof scheduleHints> }, c: TickCounts): Promise<GroupOutcome> {
  const rec2 = deferredRecorder();
  const r = await decideImprove({ store: d.store, env: d.env, client: d.client, pick: d.llm.pick, now: () => d.now }, s, rec2.recorder, g.newest.about_run_id ?? g.newest.run_id);
  if (r.fallbackReason !== null) return "deferred_outage";
  const wantsDraft = r.verdict !== "nothing" && !(r.rung === "rule" && r.verdict === "skill");
  const duplicate = wantsDraft && NEEDS_DRAFT.has(r.verdict) && d.store.proposalBlocks(r.verdict as ProposalTarget, s.scope, ttlSince(d.now));
  const draft = wantsDraft && !duplicate ? await draftFor(r.verdict, g, s, { store: d.store, env: d.env, now: d.now, tz: x.tz, distill: d.llm.distill, redact: (t) => redactForImprove(d.store, t), scheduleHints: x.hints }) : null;
  if (draft === DRAFT_SEAT_FAILED) return "deferred_outage";
  return commitGroup(d, g, s, r, { draft, duplicate }, rec2.flush, c);
}
const ttlSince = (now: string): string => new Date(Date.parse(now) - PROPOSAL_TTL_DAYS * DAY_MS).toISOString();
/** A rule-rung skill/recurrence row starts a job (ruling 1): the state predicts it so the day's budget can defer before any call. */
const willStartJob = (s: ImproveState): boolean => s.recurrence !== null && !s.alreadyAuthored && !s.skillExists && !(s.category !== null && ["lookup", "research"].includes(s.category)) && !s.stale;
/** Targets that need a draft to be a proposal; `knowledge` is recorded only (R5) and a rule-rung `skill` is the job. */
const NEEDS_DRAFT: ReadonlySet<string> = new Set(["lesson", "fact", "skill", "schedule", "tool_gap", "ladder"]);

/**
 * §3.1's commit boundary: the decision row (through the real recorder, patched when the proposal is not written — ruling 6),
 * one outcome row per inbox row (the stored text back through its check: outcomeValueOf), the proposal or the queued job,
 * and consumed_at — one transaction. A recorder that returns null (its write failed) consumes nothing: the rows are read
 * again tomorrow.
 */
function commitGroup(d: ImproveTickDeps, g: SignalGroup, s: ImproveState, r: DecideResult<ImproveTarget, unknown>, pre: { draft: Draft | null; duplicate: boolean },
  flush: (real: ReturnType<typeof storeRecorder>, patch?: RecordPatch) => string | null, c: TickCounts): GroupOutcome {
  // final fix C5: the backstop of the pre-check — a rule-rung job while skills are disarmed writes nothing and consumes nothing
  if (r.rung === "rule" && r.verdict === "skill" && !resolveSkillsEnabled(d.env)) return "deferred";
  return d.store.inTransaction(() => {
    const job = r.rung === "rule" && r.verdict === "skill" && s.recurrence !== null && d.jobs !== undefined;
    const wantsProposal = !job && NEEDS_DRAFT.has(r.verdict);
    const draft = pre.draft;
    const duplicate = wantsProposal && (pre.duplicate || (draft !== null && d.store.proposalBlocks(draft.target, s.scope, ttlSince(d.now))));
    const patch: RecordPatch | undefined = duplicate ? { verdict: "nothing", reason: "already_proposed" } : wantsProposal && draft === null ? { verdict: "nothing", reason: "no_text" } : undefined;
    const decision_id = flush(storeRecorder(d.store, { env: d.env, now: () => d.now }), patch);
    if (!decision_id) return "record_failed";
    for (const row of g.rows) {
      try { d.store.insertDecisionOutcome({ decision_id, signal: row.signal, value: outcomeValueOf(row.signal, row.value), source: "code", created_at: d.now }); }
      catch (e) { if (!(e instanceof OutcomeRejected)) throw e; console.error(`[improve] outcome row refused: ${row.signal}`); }
    }
    let queued = false;
    if (job) {
      const origin = { turn_ids: s.recurrence!.turnIds, run_ids: g.rows.map((x) => x.about_run_id).filter((x): x is string => x !== null), category: s.category ?? "other", text_hashes: textHashes(g) };
      queued = d.jobs!.enqueueFromRecurrence(d.store, { decision_id, proposal_id: null, chat_id: g.newest.chat_id ?? d.chatId, origin, idempotency_key: s.recurrence!.idempotencyKey, now: d.now }) !== null;
      if (queued) c.jobs_queued += 1;
    } else if (patch?.reason === "already_proposed") c.already_proposed += 1;
    else if (patch?.reason === "no_text") c.no_draft += 1;
    else if (draft) { d.store.insertImprovementProposal({ decision_id, target: draft.target, scope: s.scope, chat_id: g.newest.chat_id ?? d.chatId, draft_json: draft.draft_json, evidence: draft.evidence, created_at: d.now }); c.proposals += 1; }
    d.store.consumeSignals(g.rows.map((x) => x.signal_id), d.now);
    return queued ? "queued" : "committed";
  });
}

/** sha256 of each cluster text (the job re-reads the texts from chat_turns; the hashes tell a changed row). */
function textHashes(g: SignalGroup): string[] {
  return (g.recurrence?.texts ?? []).map((t) => createHash("sha256").update(t).digest("hex").slice(0, 16));
}
