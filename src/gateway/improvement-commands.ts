import { createHash } from "node:crypto";
import { saveMemoryPlan, LESSON_CAPPED_HINT } from "../capabilities/memory-save.js";
import type { TypedTaskEvent } from "../domain/types.js";
import { startSkillJob } from "../core/skill-job.js";
import { errorCode } from "../domain/error-code.js";
import { computeNextRunAt, parseScheduleSpec } from "../run/schedule-spec.js";
import { promote } from "../skills/promote.js";
import type { ImprovementJobRow, ImprovementProposalRow, RunStore } from "../run/run-store.js";
import { LadderMoveRefused } from "../run/run-store.js";
import type { SkillStore } from "../skills/skill-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * Improvement taps (2b-ii §5.1, §5.2, §5.5, §5.6, §6.3). The adapter passed the sender allowlist; oncePerTrigger replays a
 * redelivered callback id. Every handled tap is one improvement_taps row; an action acts only on the state named for it,
 * on an offered subject, within TAP_STALE_DAYS; anything else answers TAP_HANDLED_TEXT and writes only the tap row.
 */
export const TAP_STALE_DAYS = 14;
export const TAP_HANDLED_TEXT = "Already handled.";
/** A transient failure (a store error mid-effect): the trigger is processed, but the text says so and a NEW tap (a new callback id) retries (codex B20). */
export const TAP_FAILED_TEXT = "That did not go through; tap it again.";
export const JOB_EXISTS_TEXT = "A job for this already exists; nothing new queued.";
const DAY_MS = 24 * 60 * 60 * 1000;
const tapped = (): GatewayIntakeResult => ({ ok: true, status: "improvement_tapped", run_id: "" });
const chatOf = (e: TypedTaskEvent): string => (e.notify.kind === "telegram" ? e.notify.chat_id : "");
interface Tap { kind: "pr" | "sk" | "lm"; id: string; action: string; callback: string }

export function handleImprovementTap(store: RunStore, skills: SkillStore, event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const m = event.metadata ?? {};
    const tap: Tap = { kind: m.kind as Tap["kind"], id: String(m.id ?? ""), action: String(m.action ?? ""), callback: String(m.telegram_callback_id ?? "") };
    let text = TAP_FAILED_TEXT;
    try {
      text = tap.kind === "pr" ? proposalTap(store, skills, tap, chatOf(event), now) : tap.kind === "sk" ? jobTap(store, skills, tap, chatOf(event), now) : moveTap(store, tap, chatOf(event), now);
    } catch (e) {
      console.error(`[improve] tap ${tap.kind}:${tap.action} failed: ${errorCode(e)}`);
    }
    try {
      const result = text === TAP_HANDLED_TEXT ? "handled" : text === TAP_FAILED_TEXT ? "failed" : text === LESSON_CAPPED_HINT ? "capped" : "applied";
      store.insertImprovementTap({ subject_kind: tap.kind === "pr" ? "proposal" : tap.kind === "sk" ? "job" : "move", subject_id: tap.id, action: tap.action, telegram_callback_id: tap.callback, result, created_at: now });
      replyTo(store, event, "improvement_tap", text);
    } catch (e) {
      console.error(`[improve] tap ${tap.kind}:${tap.action} record failed: ${errorCode(e)}`);
    }
    return tapped();
  });
}

const stale = (at: string | null, now: string): boolean => at === null || Date.parse(now) - Date.parse(at) > TAP_STALE_DAYS * DAY_MS;

/** Accept and Dismiss act within 14 days of the OFFER; Revert within 14 days of the ACCEPT (`resolved_at`; codex B21). Ruling 19: the tapping chat must be the proposal's. */
function proposalTap(store: RunStore, skills: SkillStore, tap: Tap, chat_id: string, now: string): string {
  const p = store.getImprovementProposal(tap.id);
  if (!p || p.chat_id !== chat_id) return TAP_HANDLED_TEXT;
  if (tap.action === "rev") return revertSchedule(store, p, now);
  if (stale(p.offered_at, now)) return TAP_HANDLED_TEXT;
  if (tap.action === "dis") return store.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "dismissed", now }) ? "🗑 Dismissed." : TAP_HANDLED_TEXT;
  if (p.state !== "open") return TAP_HANDLED_TEXT;
  return acceptProposal(store, p, tap, chat_id, now);
}

/** Accept: the handler runs inside the same transaction as the state change where it is a store write (§5.1). */
function acceptProposal(store: RunStore, p: ImprovementProposalRow, tap: Tap, chat_id: string, now: string): string {
  const draft = JSON.parse(p.draft_json) as Record<string, unknown>;
  const run_id = store.getDecision(p.decision_id)?.run_id ?? null;
  switch (p.target) {
    case "lesson": case "fact": return store.inTransaction(() => acceptMemory(store, p, draft, run_id, chat_id, now));
    case "schedule": return store.inTransaction(() => applySchedule(store, p, draft, now));
    case "ladder": return store.inTransaction(() => acceptLadder(store, p, draft, tap.callback, now));
    case "tool_gap": return store.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "accepted", now }) ? `Send this to start a self-write: self_write_propose focus="${String(draft.focus ?? "")}"` : TAP_HANDLED_TEXT;
    case "skill": return store.inTransaction(() => acceptSkill(store, p, draft, now));
    default: return TAP_HANDLED_TEXT;
  }
}

/** Ruling 14: the state change and the queued job commit together; the tick starts it. reconcileAccepted is the net for an older crash. */
function acceptSkill(store: RunStore, p: ImprovementProposalRow, draft: Record<string, unknown>, now: string): string {
  const origin = draft.origin as { turn_ids: string[]; category: string } | undefined;
  if (!origin || !store.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "accepted", now })) return TAP_HANDLED_TEXT;
  const texts = origin.turn_ids.map((id) => store.getChatTurnById(id)?.text ?? "");
  const job_id = startSkillJob(store, { decision_id: p.decision_id, proposal_id: p.proposal_id, chat_id: p.chat_id, now, idempotency_key: `${origin.category}:${origin.turn_ids[0]}`,
    origin: { turn_ids: origin.turn_ids, run_ids: origin.turn_ids.map((id) => store.getChatTurnById(id)?.run_id ?? ""), category: origin.category, text_hashes: texts.map((t) => createHash("sha256").update(t).digest("hex").slice(0, 16)) } });
  if (job_id === null) { // a job for this cluster already exists (idempotency key): say so, never "Queued" without a job
    store.transitionProposal({ proposal_id: p.proposal_id, from: ["accepted"], to: "dismissed", now, result_json: JSON.stringify({ reason: "job_exists" }) });
    return JOB_EXISTS_TEXT;
  }
  return "✅ Queued: the skill will be drafted at the next tick.";
}

function acceptMemory(store: RunStore, p: ImprovementProposalRow, draft: Record<string, unknown>, run_id: string | null, chat_id: string, now: string): string {
  if (!run_id) return TAP_HANDLED_TEXT;
  const plan = p.target === "lesson" ? { lesson: draft as { scope: string; text: string; avoid?: string } } : { fact: draft as { text: string; evidence: { line: number; quote: string }; source_turn_ids: string[] } };
  const saved = saveMemoryPlan(store, plan, { run_id, chat_id, source: "improve", now });
  if (saved.lesson && "capped" in saved.lesson) return LESSON_CAPPED_HINT;
  const result = saved.lesson ? { change_id: saved.lesson.change_id, lesson_id: saved.lesson.id } : saved.fact ? { change_id: saved.fact.change_id, fact_id: saved.fact.id } : null;
  if (!result || !store.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "accepted", now, result_json: JSON.stringify(result) })) throw new Error("accept_lost");
  return saved.lesson ? `📒 Lesson #${(saved.lesson as { id: number }).id} saved. Undo is on tonight's digest line.` : `🧠 Fact #${saved.fact!.id} saved. Undo is on tonight's digest line.`;
}

interface ScheduleDraft { schedule_id: string; before: { spec_json: string; tz: string; next_run_at: string }; after: { spec_json: string; tz: string; next_run_at: string }; hour_from: number; hour_to: number }

/** §5.5: apply `after` only while the row still equals `before` (Paco edited it meanwhile → handled, state expired). */
function applySchedule(store: RunStore, p: ImprovementProposalRow, draft: Record<string, unknown>, now: string): string {
  const d = draft as unknown as ScheduleDraft;
  const row = store.getScheduledTask(d.schedule_id);
  if (!row || row.spec_json !== d.before.spec_json || row.tz !== d.before.tz) { store.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "expired", now }); return TAP_HANDLED_TEXT; }
  const next = nextRunAt(d.after.spec_json, d.after.tz, now); // recomputed at tap time: the drafted value is up to 14 days old
  if (!next || !store.updateScheduledTask({ schedule_id: d.schedule_id, spec_json: d.after.spec_json, tz: d.after.tz, next_run_at: next, now })) return TAP_HANDLED_TEXT;
  if (!store.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "accepted", now })) throw new Error("accept_lost");
  return `⏰ Moved to ${String(d.hour_to).padStart(2, "0")}:00. Revert is on tonight's digest line.`;
}

function nextRunAt(spec_json: string, tz: string, now: string): string | null {
  try {
    const spec = parseScheduleSpec(JSON.parse(spec_json));
    return spec ? computeNextRunAt(spec, tz, now) : null;
  } catch {
    return null;
  }
}

function revertSchedule(store: RunStore, p: ImprovementProposalRow, now: string): string {
  if (p.target !== "schedule" || p.state !== "accepted" || !p.resolved_at || Date.parse(now) - Date.parse(p.resolved_at) > TAP_STALE_DAYS * DAY_MS) return TAP_HANDLED_TEXT;
  const d = JSON.parse(p.draft_json) as ScheduleDraft;
  return store.inTransaction(() => {
    const row = store.getScheduledTask(d.schedule_id);
    if (!row || row.spec_json !== d.after.spec_json || row.tz !== d.after.tz) return TAP_HANDLED_TEXT;
    const next = nextRunAt(d.before.spec_json, d.before.tz, now);
    if (!next || !store.updateScheduledTask({ schedule_id: d.schedule_id, spec_json: d.before.spec_json, tz: d.before.tz, next_run_at: next, now })) return TAP_HANDLED_TEXT;
    return store.transitionProposal({ proposal_id: p.proposal_id, from: ["accepted"], to: "reverted", now }) ? "↩️ Reverted to the previous time." : TAP_HANDLED_TEXT;
  });
}

/** R6: a paco move with the callback id; the store refuses locked entries (never proposed, defended anyway). */
function acceptLadder(store: RunStore, p: ImprovementProposalRow, draft: Record<string, unknown>, callback: string, now: string): string {
  const entry_id = String(draft.entry_id ?? ""); const move = String(draft.move ?? "");
  try {
    const move_id = store.insertLadderMove({ entry_id, scope: p.scope, from_rung: "system_one", to_rung: move === "retire_judge" ? "model" : "system_one", evidence: [p.proposal_id], granted_by: "paco",
      granted_via: "improve.route", paco_callback_id: callback, revocable: true, created_at: now });
    if (!store.transitionProposal({ proposal_id: p.proposal_id, from: ["open"], to: "accepted", now, result_json: JSON.stringify({ move_id }) })) throw new Error("accept_lost");
    return `🪜 Recorded: ${move} on ${entry_id}. Nothing changes until a human edit; Revoke is on tonight's digest line.`;
  } catch (e) {
    if (e instanceof LadderMoveRefused) return TAP_HANDLED_TEXT;
    throw e;
  }
}

/** §5.2 job flow: Accept on pending_review → promoting(refuse); collision → the collision card; replace/keep on collision → promoting(mode); dismiss on either retires the draft. */
function jobTap(store: RunStore, skills: SkillStore, tap: Tap, chat_id: string, now: string): string {
  const job = store.getImprovementJob(tap.id);
  if (!job || job.chat_id !== chat_id || !job.pending_scope || !job.pending_name || stale(job.offered_at, now)) return TAP_HANDLED_TEXT; // ruling 19: chat-bound
  if (tap.action === "dismiss") return dismissJob(store, skills, job, now);
  const mode = tap.action === "accept" && job.state === "pending_review" ? "refuse" : tap.action === "replace" && job.state === "collision" ? "replace" : tap.action === "keep" && job.state === "collision" ? "keep_both" : null;
  if (!mode || !store.transitionJob({ job_id: job.job_id, from: [job.state], to: "promoting", now, patch: { promote_mode: mode } })) return TAP_HANDLED_TEXT;
  return promote(store, skills, { ...job, state: "promoting", promote_mode: mode }, chat_id, now);
}

export const DISMISS_FILE_DEFERRED_TEXT = "🗑 Dismissed. The draft file could not be moved now; it is retired at the next tick.";

/** Final fix B4: the fenced transition first, then the file; a failed move leaves the file for the sweep (a dismissed job's stamped draft). */
function dismissJob(store: RunStore, skills: SkillStore, job: ImprovementJobRow, now: string): string {
  if (job.state !== "pending_review" && job.state !== "collision") return TAP_HANDLED_TEXT;
  if (!store.transitionJob({ job_id: job.job_id, from: [job.state], to: "dismissed", now })) return TAP_HANDLED_TEXT;
  const r = skills.dismissPending(job.pending_scope!, job.pending_name!, now.slice(0, 10));
  if (r.ok || r.error === "not_found") return "🗑 Draft retired.";
  console.error(`[improve] dismiss file move failed: ${r.error}`);
  return DISMISS_FILE_DEFERRED_TEXT;
}

/** Ruling 19: a move's chat is its proposal's (`evidence_json[0]` is the proposal id, Task 13 acceptLadder). */
function moveTap(store: RunStore, tap: Tap, chat_id: string, now: string): string {
  const m = store.getLadderMove(tap.id);
  if (!m || Date.parse(now) - Date.parse(m.created_at) > TAP_STALE_DAYS * DAY_MS) return TAP_HANDLED_TEXT;
  const proposal_id = (JSON.parse(m.evidence_json) as string[])[0];
  if (!proposal_id || store.getImprovementProposal(proposal_id)?.chat_id !== chat_id) return TAP_HANDLED_TEXT;
  return store.endLadderMove(tap.id, now) ? `🪜 Revoked the move on ${m.entry_id}.` : TAP_HANDLED_TEXT;
}
