import { createHash } from "node:crypto";
import { resolveGateBEnabled, resolveGateBPasses, resolveGateBThreshold, verifySkill } from "../capabilities/anchor-verify.js";
import { authorDraft, withFrontmatterVersion, type AuthoredSkill } from "../capabilities/skill-author.js";
import { buildGateAQuestion, GATE_A_DISCIPLINE, parseGateAVerdict, type GateAResult } from "../capabilities/skill-router.js";
import { compileSkillAuthorContract } from "../contracts/task-contract.js";
import { redactForImprove } from "../decisions/egress.js";
import type { TickLlm } from "../improve/decide-improve.js";
import type { ImproveTickDeps, JobHooks } from "../improve/tick.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { ImprovementJobRow, JobPatch, JobState, RunStore } from "../run/run-store.js";
import { jobCollisionCard, promote, SK_PREFIX, skillButtons, TAP_STALE_DAYS } from "../skills/promote.js";
import { duplicateFrontmatterKeys, resolveSkillsEnabled, sanitizeSlug, setFrontmatterFields, type SkillStore } from "../skills/skill-store.js";
import { errorCode } from "../domain/error-code.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import { evolutionLaneSnapshot, tryStartEvolutionPipeline } from "./evolution-lane.js";

/**
 * The skill-authoring job (2b-ii §5.2): an improvement_jobs row, never a runs row. It runs on the evolution lane with a
 * no-op deliver; each of the three endings is ONE fenced transition (state running, this attempt) that also enqueues its
 * own card, so the Promise.race loser writes nothing. Gate A down-routes end `suggested` with no file; the writer is
 * one-shot over Paco's request texts only; the draft goes to `_pending` whatever the gates said; Paco promotes by tap.
 */
export { jobCollisionCard, SK_PREFIX, skillButtons };
export const JOB_OBJECTIVE_CHAR_CAP = 3_000;
export const JOB_TURN_CAP = 6;
export const JOB_QUEUED_TTL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DOWN_ROUTES: ReadonlySet<string> = new Set(["retire", "restore", "lesson", "code", "unsure"]);
export interface JobDeps {
  store: RunStore; env: NodeJS.ProcessEnv; now: string; chatId: string | null; skills: SkillStore; llm: { classify: TickLlm; compose: TickLlm; verify: TickLlm }; signal: AbortSignal;
  /** Final fix C1: the wall clock an ending is stamped with (the job runs minutes after the tick's `now`); tests inject it. */
  wallNow?: () => string;
}
interface Origin { turn_ids: string[]; run_ids: string[]; category: string; text_hashes: string[] }
const originOf = (job: ImprovementJobRow): Origin => JSON.parse(job.origin_json) as Origin;

export function startSkillJob(store: RunStore, i: { decision_id: string; proposal_id: string | null; chat_id: string | null; origin: Origin; idempotency_key: string; now: string }): string | null {
  return store.insertImprovementJob({ decision_id: i.decision_id, proposal_id: i.proposal_id, chat_id: i.chat_id, origin_json: JSON.stringify(i.origin), idempotency_key: i.idempotency_key, created_at: i.now });
}

export const jobStartedCard = (n: number, category: string): string => `🛠 Drafting a skill from ${n} requests about ${category}…`;
export const jobDraftedCard = (n: number, category: string, name: string, score: number | null): string =>
  `🛠 Skill drafted from ${n} requests about ${category}: ${name}${score === null ? " (Gate B unscored)" : ` (Gate B ${score.toFixed(2)})`}. Accept promotes it; Dismiss retires the draft.`;
export const jobSuggestedCard = (n: number, verdict: string): string => `🛠 ${n} similar requests, but Gate A says this is a ${verdict}, not a skill. Nothing was written.`;
export const jobFailedCard = (code: string): string => `🛠 Skill drafting failed (${code}). Nothing was written.`;
export const jobGateAUnavailableCard = (n: number): string => `🛠 ${n} similar requests, but the skill check (Gate A) could not run (gate_a_unavailable). Nothing was written.`;
export const jobExpiredCard = (name: string): string => `🛠 The drafted skill ${name} was not reviewed within ${TAP_STALE_DAYS} days; the draft is retired.`;
export const jobPromoteFailedCard = (name: string): string => `🛠 Promoting the skill ${name} failed ${PROMOTE_RETRY_MAX} times (promote_failed). The draft stays under _pending until the sweep retires it.`;
export const PROMOTE_RETRY_MAX = 3;

/** The card goes out from the fenced transition, keyed by job, attempt and state: a redelivered event never sends it twice (§5.2, codex round 4). */
function enqueueJobCard(store: RunStore, chatId: string | null, job_id: string, attempt: number, state: JobState, text: string, buttons?: NotificationButton[]): void {
  if (!chatId) return;
  store.enqueueNotification({ target: { kind: "telegram", chat_id: chatId }, intent_type: "progress", idempotency_key: `improve_job:${job_id}:${attempt}:${state}`, correlation_id: `improve_job:${job_id}`,
    payload: { text, ...(buttons ? { buttons } : {}) } });
}

/** One fenced ending: the transition and its card commit together; a loser (zero rows) enqueues nothing. */
function endJob(d: Pick<JobDeps, "store" | "chatId" | "wallNow">, job: ImprovementJobRow, attempt: number, to: JobState, patch: JobPatch, text: string, buttons?: NotificationButton[]): boolean {
  const now = d.wallNow?.() ?? new Date().toISOString(); // final fix C1: the instant of the ending, not the tick's start
  return d.store.inTransaction(() => {
    if (!d.store.transitionJob({ job_id: job.job_id, from: ["running"], to, now, attempt, patch })) return false;
    enqueueJobCard(d.store, job.chat_id ?? d.chatId, job.job_id, attempt, to, text, buttons); // the job's own chat (ruling 19; codex round 2)
    if (buttons) d.store.markJobsOffered([job.job_id], now);
    return true;
  });
}

/** §5.2: Paco's request texts of the cluster, newest kept, ≤ 6 turns and ≤ 3 000 characters; never a reply or tool text. */
function objectiveOf(store: RunStore, origin: Origin): string {
  const texts = origin.turn_ids.map((id) => store.getChatTurnById(id)).filter((t) => t?.role === "user").map((t) => redactForImprove(store, t!.text)).slice(-JOB_TURN_CAP);
  let out: string[] = []; let chars = 0;
  for (const t of [...texts].reverse()) { if (chars + t.length > JOB_OBJECTIVE_CHAR_CAP) break; out = [t, ...out]; chars += t.length; }
  return out.join("\n\n");
}

/** A lane callback must never throw (an unobserved rejection kills the daemon): a failed ending leaves the row running for the boot sweep. */
function safeEnd(...args: Parameters<typeof endJob>): void {
  try { endJob(...args); } catch (e) { console.error(`[skill-job] end failed: ${errorCode(e)}`); }
}

export async function runQueuedJobs(d: JobDeps, budget: number): Promise<number> {
  if (!resolveSkillsEnabled(d.env)) return 0; // final fix C5: /disarm turns skills off; queued jobs wait, no seat call, no file
  let started = 0;
  for (const job of d.store.listJobsByState(["queued"])) {
    if (started >= budget || d.signal.aborted || evolutionLaneSnapshot().busy) break; // busy: no transition, no started_at, no card; the next tick retries
    let origin: Origin;
    try { origin = originOf(job); } catch (e) { console.error(`[skill-job] bad origin: ${errorCode(e)}`); continue; }
    const attempt = job.attempt + 1;
    const moved = d.store.inTransaction(() => {
      if (!d.store.transitionJob({ job_id: job.job_id, from: ["queued"], to: "running", now: d.now, bumpAttempt: true })) return false;
      enqueueJobCard(d.store, job.chat_id ?? d.chatId, job.job_id, attempt, "running", jobStartedCard(origin.turn_ids.length, origin.category)); // before the body: a synchronous ending shows after it
      return true;
    });
    if (!moved) continue;
    const capMs = compileSkillAuthorContract(objectiveOf(d.store, origin).slice(0, 200)).budget.time_minutes * 60_000;
    const ok = tryStartEvolutionPipeline({ current: { run_id: job.job_id, tool: "skill_author", started_at: d.now }, capMs,
      run: async () => { await authorPendingSkill(d, { ...job, state: "running", attempt }, attempt); return { text: "" }; },
      onTimeout: () => { safeEnd(d, job, attempt, "failed", { result_code: "timeout" }, jobFailedCard("timeout")); return { text: "" }; },
      onError: () => { safeEnd(d, job, attempt, "failed", { result_code: "error" }, jobFailedCard("error")); console.error(`[improve] job ${job.job_id} threw (detail withheld: it may carry model text)`); return { text: "" }; },
      deliver: () => {} });
    if (!ok) { d.store.transitionJob({ job_id: job.job_id, from: ["running"], to: "queued", now: d.now, attempt, patch: { result_code: "lane_busy" } }); break; }
    started += 1;
  }
  return started;
}

/** The job body on the lane: Gate A, the writer, Gate B, the pending write, then its fenced ending. Every exit is one ending. */
export async function authorPendingSkill(d: JobDeps, job: ImprovementJobRow, attempt: number): Promise<void> {
  const origin = originOf(job);
  const objective = objectiveOf(d.store, origin);
  const n = origin.turn_ids.length;
  if (objective.trim().length === 0) { endJob(d, job, attempt, "failed", { result_code: "no_text" }, jobFailedCard("no_text")); return; }
  const gateA = await gateAOf(d, objective);
  // final fix C2: a failed classify call is not a verdict; the job fails so nothing claims Gate A said "not a skill"
  if (gateA === null) { endJob(d, job, attempt, "failed", { result_code: "gate_a_unavailable" }, jobGateAUnavailableCard(n)); return; }
  if (DOWN_ROUTES.has(gateA.verdict)) { endJob(d, job, attempt, "suggested", { gate_a: gateA.verdict }, jobSuggestedCard(n, gateA.verdict)); return; }
  const fed = fedFileOf(d.skills, objective);
  const parsed = await authorDraft(objective, fed, async (q, system) => { const r = await d.llm.compose({ question: q, system }); return r.ok ? r.answer : undefined; });
  if (!parsed) { endJob(d, job, attempt, "failed", { result_code: "author_failed" }, jobFailedCard("author_failed")); return; }
  const score = await gateBOf(d, parsed);
  // ruling 20: slugged scope and name on the row (the writer's raw "Ask" would never match the file), the draft stamped with the job id,
  // and a pending path another job holds takes the first free -N suffix so two jobs never overwrite each other's draft (codex B19)
  const scope = sanitizeSlug(parsed.scope);
  // final fix B1/B2: a repeated frontmatter key (a forged name/origin the parser would read) or a `_` scope/name (the store's own dirs) is refused
  if (!draftShapeOk(parsed.file, scope, sanitizeSlug(parsed.name))) { endJob(d, job, attempt, "failed", { result_code: "author_failed" }, jobFailedCard("author_failed")); return; }
  const name = freePendingName(d.skills, scope, sanitizeSlug(parsed.name), job.job_id);
  const stamped = setFrontmatterFields(withFrontmatterVersion(parsed.file, 1), { name, origin: `improve_job:${job.job_id}`, ...(score === null ? {} : { score, last_verified: d.now.slice(0, 10) }) });
  if (d.store.getImprovementJob(job.job_id)?.state !== "running") return; // the fence moved (a timeout won): write no file (§5.2)
  const written = d.skills.writePending(scope, name, stamped);
  if (!written.ok) { endJob(d, job, attempt, "failed", { result_code: "write_failed" }, jobFailedCard("write_failed")); return; }
  endJob(d, job, attempt, "pending_review", { gate_a: "skill", pending_scope: scope, pending_name: name }, jobDraftedCard(n, origin.category, name, score), skillButtons(job.job_id, "review"));
}

const draftShapeOk = (file: string, scope: string, name: string): boolean =>
  duplicateFrontmatterKeys(file).length === 0 && scope.length > 0 && name.length > 0 && !scope.startsWith("_") && !name.startsWith("_");

/** `<name>` when free or already this job's; else the first `<name>-N` (N ≥ 2) no other job's draft holds. */
function freePendingName(skills: SkillStore, scope: string, name: string, job_id: string): string {
  const owner = (n: string): string | undefined => skills.listPending().find((m) => m.scope === scope && m.name === n)?.origin;
  if (!skills.pendingExists(scope, name) || owner(name) === `improve_job:${job_id}`) return name;
  for (let k = 2; k < 100; k += 1) { const c = `${name}-${k}`; if (!skills.pendingExists(scope, c) || owner(c) === `improve_job:${job_id}`) return c; }
  return `${name}-${job_id.slice(4, 12)}`;
}

async function gateAOf(d: JobDeps, objective: string): Promise<GateAResult | null> {
  const r = await d.llm.classify({ question: buildGateAQuestion(objective), system: GATE_A_DISCIPLINE });
  return r.ok ? parseGateAVerdict(r.answer) : null;
}

/** Step 0 of authorAndWriteSkill: the ONE active skill the objective names, fed to the writer (its text is in-house, codex D11). */
function fedFileOf(skills: SkillStore, objective: string): string | undefined {
  const lowered = objective.toLowerCase();
  const mentioned = skills.list().filter((m) => new RegExp(`(^|[^a-z0-9_-])${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_-]|$)`).test(lowered));
  return mentioned.length === 1 ? skills.readRawSkill(mentioned[0]!.scope, mentioned[0]!.name) ?? undefined : undefined;
}

/** Gate B through the tick's verify seat; null when disabled or unscored (the draft is still parked; the card says unscored). */
async function gateBOf(d: JobDeps, skill: AuthoredSkill): Promise<number | null> {
  if (!resolveGateBEnabled(d.env)) return null;
  const r = await verifySkill({ when: skill.meta.when, body: skill.body }, { passes: resolveGateBPasses(d.env), threshold: resolveGateBThreshold(d.env) },
    async (system, question) => { const a = await d.llm.verify({ question, system }); return a.ok ? a.answer : undefined; });
  return r.unscored ? null : r.score;
}

/** At boot: the lane is in-memory, so every running job is failed daemon_restart with its card (§5.2). */
export function reconcileJobsAtBoot(store: RunStore, skills: SkillStore, chatId: string | null, now: string): number {
  let n = 0;
  for (const job of store.listJobsByState(["running"])) {
    const ok = store.inTransaction(() => {
      if (!store.transitionJob({ job_id: job.job_id, from: ["running"], to: "failed", now, attempt: job.attempt, patch: { result_code: "daemon_restart" } })) return false;
      enqueueJobCard(store, job.chat_id ?? chatId, job.job_id, job.attempt, "failed", jobFailedCard("daemon_restart"));
      return true;
    });
    if (ok) n += 1;
  }
  sweepOrphans(store, skills, now);
  return n;
}

type ReconcileDeps = Pick<JobDeps, "store" | "skills" | "now" | "chatId"> & { env?: NodeJS.ProcessEnv };

/** Tick-time reconcile: stale queued jobs fail lane_busy; unreviewed offers expire; promoting jobs retry (promote, shared with the tap); orphaned pending files retire. */
export function reconcileJobs(d: ReconcileDeps): void {
  const cut = new Date(Date.parse(d.now) - JOB_QUEUED_TTL_DAYS * DAY_MS).toISOString();
  for (const job of d.store.listJobsByState(["queued"])) {
    if (job.created_at >= cut) continue;
    d.store.inTransaction(() => {
      if (d.store.transitionJob({ job_id: job.job_id, from: ["queued"], to: "failed", now: d.now, patch: { result_code: "lane_busy" } })) enqueueJobCard(d.store, job.chat_id ?? d.chatId, job.job_id, job.attempt, "failed", jobFailedCard("lane_busy"));
    });
  }
  expireOffers(d);
  for (const job of d.store.listJobsByState(["promoting"])) retryPromote(d, job);
  sweepOrphans(d.store, d.skills, d.now);
}

/** Final fix C3: a drafted skill (or a collision) Paco has not tapped within TAP_STALE_DAYS expires with one card; its draft retires (the sweep retries a failed move). */
function expireOffers(d: ReconcileDeps): void {
  const cut = new Date(Date.parse(d.now) - TAP_STALE_DAYS * DAY_MS).toISOString();
  for (const job of d.store.listJobsByState(["pending_review", "collision"])) {
    if ((job.offered_at ?? job.finished_at ?? job.created_at) >= cut) continue;
    const ended = d.store.inTransaction(() => {
      if (!d.store.transitionJob({ job_id: job.job_id, from: [job.state], to: "expired", now: d.now, patch: { result_code: "offer_expired" } })) return false;
      enqueueJobCard(d.store, job.chat_id ?? d.chatId, job.job_id, job.attempt, "expired", jobExpiredCard(job.pending_name ?? "draft"));
      return true;
    });
    if (!ended || !job.pending_scope || !job.pending_name) continue;
    const r = d.skills.dismissPending(job.pending_scope, job.pending_name, d.now.slice(0, 10));
    if (!r.ok && r.error !== "not_found") console.error(`[skill-job] expired draft not moved: ${r.error}`);
  }
}

/** Final fix C3: a retry that ends the job sends its card (the tap's reply is gone); a throw counts toward PROMOTE_RETRY_MAX, then promote_failed with a card. */
function retryPromote(d: ReconcileDeps, job: ImprovementJobRow): void {
  // final fix 3: at most one retry per local date (resumed segments of one tick never burn PROMOTE_RETRY_MAX in minutes)
  if (retryOf(job.result_code).date === localDateOf(d)) return;
  let text: string;
  try { text = promote(d.store, d.skills, job, d.chatId, d.now); } catch (e) {
    console.error(`[skill-job] promote retry failed: ${errorCode(e)}`);
    try { promoteRetryFailed(d, job); } catch (e2) { console.error(`[skill-job] promote retry not recorded: ${errorCode(e2)}`); }
    return;
  }
  const after = d.store.getImprovementJob(job.job_id)?.state;
  if (after === "promoted" || after === "failed") enqueueJobCard(d.store, job.chat_id ?? d.chatId, job.job_id, job.attempt, after, text);
}

/** `promote_retry:<n>:<local date of that retry>` on the row's result_code: the count and the day it last ran (no new column). */
function retryOf(code: string | null): { n: number; date: string | null } {
  const m = /^promote_retry:(\d+)(?::(\d{4}-\d{2}-\d{2}))?$/.exec(code ?? "");
  return m ? { n: Number(m[1]), date: m[2] ?? null } : { n: 0, date: null };
}
const localDateOf = (d: ReconcileDeps): string => formatInstantInZone(d.now, resolveDisplayZone(d.env ?? process.env)).slice(0, 10);

function promoteRetryFailed(d: ReconcileDeps, job: ImprovementJobRow): void {
  const n = retryOf(job.result_code).n + 1;
  d.store.inTransaction(() => {
    if (n < PROMOTE_RETRY_MAX) { d.store.transitionJob({ job_id: job.job_id, from: ["promoting"], to: "promoting", now: d.now, patch: { result_code: `promote_retry:${n}:${localDateOf(d)}` } }); return; }
    if (d.store.transitionJob({ job_id: job.job_id, from: ["promoting"], to: "failed", now: d.now, patch: { result_code: "promote_failed" } }))
      enqueueJobCard(d.store, job.chat_id ?? d.chatId, job.job_id, job.attempt, "failed", jobPromoteFailedCard(job.pending_name ?? "draft"));
  });
}

/**
 * Final fix B3: a `_pending` draft is retired only when it is STAMPED `origin: improve_job:<id>`, that job row exists, the job
 * has ended without owning a draft (dismissed, expired, failed), and the job's recorded pending path is this file (or the job
 * recorded none: a crash between the write and the ending). Unstamped drafts (the commanded path's parking lot, ruling 20), a
 * stamp no job row matches, and a stamp of a PROMOTED job (a commanded refine of that skill, parked with the origin line the
 * writer copied) are never touched; neither is a file a live job (running, pending_review, collision, promoting) holds.
 */
const SWEEPABLE: ReadonlySet<JobState> = new Set(["dismissed", "expired", "failed"]);
function sweepOrphans(store: RunStore, skills: SkillStore, now: string): void {
  const held = new Set(store.listJobsByState(["running", "pending_review", "collision", "promoting"]).map((j) => `${j.pending_scope}/${j.pending_name}`));
  for (const m of skills.listPending()) {
    const job = m.origin?.startsWith("improve_job:") ? store.getImprovementJob(m.origin.slice("improve_job:".length)) : undefined;
    if (!job || !SWEEPABLE.has(job.state) || held.has(`${m.scope}/${m.name}`)) continue;
    if (job.pending_scope !== null && `${job.pending_scope}/${job.pending_name}` !== `${m.scope}/${m.name}`) continue;
    const r = skills.dismissPending(m.scope, m.name, now.slice(0, 10));
    if (!r.ok) console.error(`[skill-job] sweep failed: ${r.error}`);
  }
}

/** §5.1: an accepted skill proposal with no job (a crash between the state change and the insert) gets its queued job, idempotent on the proposal. */
export function reconcileAccepted(d: Pick<JobDeps, "store" | "now">): void {
  const withJob = new Set(d.store.listJobsByState(["queued", "running", "pending_review", "suggested", "collision", "promoting", "promoted", "dismissed", "failed", "expired"]).map((j) => j.proposal_id));
  for (const p of d.store.listProposalsResolvedSince(new Date(Date.parse(d.now) - 30 * DAY_MS).toISOString())) {
    if (p.target !== "skill" || p.state !== "accepted" || withJob.has(p.proposal_id)) continue;
    let draft: { origin: { turn_ids: string[]; category: string } };
    try { draft = JSON.parse(p.draft_json) as typeof draft; if (!Array.isArray(draft.origin.turn_ids)) continue; } catch (e) { console.error(`[skill-job] bad proposal draft: ${errorCode(e)}`); continue; }
    const texts = draft.origin.turn_ids.map((id) => d.store.getChatTurnById(id)?.text ?? "");
    startSkillJob(d.store, { decision_id: p.decision_id, proposal_id: p.proposal_id, chat_id: p.chat_id, now: d.now, idempotency_key: `${draft.origin.category}:${draft.origin.turn_ids[0]}`,
      origin: { turn_ids: draft.origin.turn_ids, run_ids: draft.origin.turn_ids.map((id) => d.store.getChatTurnById(id)?.run_id ?? ""), category: draft.origin.category,
        text_hashes: texts.map((t) => createHash("sha256").update(t).digest("hex").slice(0, 16)) } });
  }
}

/** The tick's hooks (Task 10 JobHooks), bound to the tick's deps. */
export const skillJobHooks: JobHooks = {
  reconcile: (d) => reconcileJobs(jobDeps(d)),
  reconcileAccepted: (d) => reconcileAccepted(jobDeps(d)),
  enqueueFromRecurrence: (store, i) => startSkillJob(store, i),
  runQueued: (d, budget) => runQueuedJobs(jobDeps(d), budget)
};
const jobDeps = (d: ImproveTickDeps): JobDeps => ({ store: d.store, env: d.env, now: d.now, chatId: d.chatId, skills: d.skills, llm: { classify: d.llm.classify, compose: d.llm.compose, verify: d.llm.verify }, signal: d.signal, ...(d.wallNow ? { wallNow: d.wallNow } : {}) });
