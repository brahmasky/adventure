import { errorCode } from "../domain/error-code.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { CleanroomFacts } from "../omp/bridge-handler.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import { STANDING_STALE_MS, STANDING_STREAK, type NotificationRecord, type RunStore, type StandingEndReason, type StandingApprovalRow, type ToolApprovalRow } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone, scheduleDisplayName } from "../run/schedule-spec.js";
import { enqueueUrgentCard } from "./urgent.js";

/**
 * Stage 4A (ADR 0030 §8.3, Decision 1-A): settlement of a sealed trial and the life of a standing row after it. Code reads
 * code-owned facts only — the sealed call's `tool_finished`, the run's state, its terminal notice, the consumed approvals — and
 * owns every transition; no model output is an input. The grant is immediate and automatic; Paco holds Revoke.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const SA_PREFIX = "dec:sa:";
export const STANDING_EXPIRY_MS = 30 * DAY_MS;
export const SEALING_TTL_MS = DAY_MS;
/** Slice 1's words for "the command never started"; with ran:false the trial is void, not failed (spec §6). */
export const PRE_SPAWN_REASONS: ReadonlySet<string> = new Set(["cleanroom_unavailable", "cleanroom_setup", "cleanroom_invalid", "cleanroom_tampered", "aborted", "spawn"]);
const UNSEALED_END: ReadonlySet<string> = new Set(["failed", "cancelled", "expired"]);

export type SealVerdict = "seal" | "reset" | "end" | "wait";
export interface SealInput { fin: Record<string, unknown> | undefined; run_state: string | undefined; outbox: string | undefined; decision_id: string | undefined; started_at: string | null; now: string }

/** The sealed call's facts, or null when any is missing or malformed (a missing fact is never read as true; truncated may be null = unknown). */
function factsOf(fin: Record<string, unknown> | undefined): CleanroomFacts | null {
  const c = fin?.cleanroom;
  if (typeof c !== "object" || c === null) return null;
  const f = c as Record<string, unknown>;
  if ((["ran", "torn_down", "tampered", "escaped", "check_failed"] as const).some((key) => typeof f[key] !== "boolean")) return null;
  if (f.truncated !== null && typeof f.truncated !== "boolean") return null;
  if (f.exit_code !== null && !Number.isInteger(f.exit_code)) return null;
  return f as unknown as CleanroomFacts;
}

/** §7's conjunction over the one sealed call: it ran sealed, exited 0 provably whole, left nothing behind and every check ran. */
function sealedCall(fin: Record<string, unknown>, f: CleanroomFacts | null): boolean {
  return fin.status === "succeeded" && fin.executor === "cleanroom" && f !== null && f.exit_code === 0 && f.truncated === false
    && f.ran && f.torn_down && !f.tampered && !f.escaped && !f.check_failed;
}

/** Pre-spawn first (whatever the run's fate), then the 24 h TTL (before delivery: a late report never stands a command up), then the call, the run, the notice. */
export function sealVerdict(i: SealInput): SealVerdict {
  const f = factsOf(i.fin);
  if (f && !f.ran && f.reason !== undefined && PRE_SPAWN_REASONS.has(f.reason)) return "reset";
  // a late delivery never stands a command up; a missing or garbage stamp is NaN, which no ">=" would ever catch
  const age = Date.parse(i.now) - (i.started_at === null ? Number.NaN : Date.parse(i.started_at));
  if (!Number.isFinite(age) || age >= SEALING_TTL_MS) return "end";
  if (i.fin && !sealedCall(i.fin, f)) return "end";
  if (i.run_state === undefined || UNSEALED_END.has(i.run_state)) return "end";
  if (i.run_state !== "completed") return "wait";
  if (!i.fin || i.decision_id === undefined || i.outbox === "failed_terminal") return "end"; // finished without its facts: never re-run
  return i.outbox === "delivered" ? "seal" : "wait";
}

/** A seal whose evidence re-read fails reports "end"; a trial replaced before its grant, reset or end landed reports "wait" (lost: nothing moved). */
export interface SettleOutcome { standing_id: string; verdict: SealVerdict }

/**
 * Idempotent and total over the run's sealing rows: each transition is a store CAS on state = 'sealing', so a second call finds none.
 * A row that throws (a grant card conflict: no grant without its Revoke card) is that row's own incident and reports "wait" — nothing
 * moved, so the next settle retries it — and never stops the rows after it. Only the listing itself can still throw; both callers catch.
 */
export function settleSealing(store: RunStore, run_id: string, now: string = new Date().toISOString()): SettleOutcome[] {
  return store.listStandingApprovals({ state: "sealing" }).filter((r) => r.sealed_run_id === run_id).map((row) => {
    try { return { standing_id: row.standing_id, verdict: settleRow(store, row, now) }; }
    catch (e) { rowSettleFailed(store, row.standing_id, e, now); return { standing_id: row.standing_id, verdict: "wait" as const }; }
  });
}

function rowSettleFailed(store: RunStore, standing_id: string, e: unknown, now: string): void {
  try { openAlertedIncident(store, { kind: "standing_settle_failed", subject: `standing:${standing_id}`, detail: { error: errorCode(e) }, now }); }
  catch (inner) { console.error(`[standing] settle incident not recorded: ${errorCode(inner)}`); }
}

/** The reads a verdict needs; the settle and the grant's in-transaction re-read share them. */
function sealInputs(store: RunStore, row: StandingApprovalRow, now: string): SealInput {
  const run_id = row.sealed_run_id ?? "";
  const fin = store.getLedgerEvents(run_id).find((e) => e.event_type === "tool_finished" && e.payload.tool_call_id === row.sealed_tool_call_id)?.payload;
  const decision_id = store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "tool.policy" && d.tool_call_id === row.sealed_tool_call_id).at(-1)?.decision_id;
  return { fin, run_state: store.findRunState(run_id), outbox: store.finalReportState(run_id), decision_id, started_at: row.sealing_started_at, now }; // no fallback: a row without its start has no TTL to keep
}

function settleRow(store: RunStore, row: StandingApprovalRow, now: string): SealVerdict {
  const input = sealInputs(store, row, now);
  const verdict = sealVerdict(input);
  if (verdict === "seal") return grantOrEnd(store, row, now);
  // both CAS on the trial read here: a row that became another trial meanwhile is lost, and its newer trial waits
  const trial = { sealing_approval_id: row.sealing_approval_id, sealed_run_id: row.sealed_run_id, sealed_tool_call_id: row.sealed_tool_call_id };
  const moved = verdict === "reset" ? store.resetStandingToCandidate({ standing_id: row.standing_id, now, reason: factsOf(input.fin)?.reason ?? "pre_spawn", trial })
    : verdict === "end" ? store.endStandingApproval({ standing_id: row.standing_id, reason: "sealed_trial_failed", now, trial }) : true;
  return moved ? verdict : "wait";
}

/**
 * Runs only on a seal verdict, so a trial that failed its facts has already ended for that reason. A gap in the evidence ends the
 * trial and names the gap; a row that became another trial meanwhile is "lost" — nothing settled here, the newer trial waits.
 */
function grantOrEnd(store: RunStore, observed: StandingApprovalRow, now: string): SealVerdict {
  const g = grantStanding(store, observed, now);
  if (g.status === "lost") return "wait";
  if (g.status === "granted") return "seal";
  openAlertedIncident(store, { kind: "standing_evidence_failed", subject: `standing:${observed.standing_id}`, detail: { missing: g.missing }, now });
  return "end";
}

type GrantOutcome = { status: "granted" } | { status: "lost" } | { status: "evidence_missing"; missing: string };
/** The same trial: a reset and a newer fourth approval between the settle's read and the grant make the row another trial. */
const sameTrial = (a: StandingApprovalRow, b: StandingApprovalRow): boolean =>
  a.sealing_approval_id === b.sealing_approval_id && a.sealed_run_id === b.sealed_run_id && a.sealed_tool_call_id === b.sealed_tool_call_id;

/**
 * The evidence re-read, the grant and its card in one transaction. The row is re-read HERE and every evidence, card and
 * transition field comes from that read: an older trial's evidence must neither grant nor end a newer trial. A card that cannot
 * be queued rolls the grant back (no grant without its Revoke card); a gap ends this trial inside the same transaction.
 */
function grantStanding(store: RunStore, observed: StandingApprovalRow, now: string): GrantOutcome {
  const expires_at = new Date(Date.parse(now) + STANDING_EXPIRY_MS).toISOString();
  return store.inTransaction((): GrantOutcome => {
    const row = store.getStandingApproval(observed.standing_id);
    if (!row || row.state !== "sealing" || !sameTrial(row, observed)) return { status: "lost" };
    const proof = grantEvidence(store, row, now);
    if ("missing" in proof) { store.endStandingApproval({ standing_id: row.standing_id, reason: "sealed_trial_failed", now }); return { status: "evidence_missing", missing: proof.missing }; }
    const move_id = store.markStandingGranted({ standing_id: row.standing_id, evidence: proof.evidence, expires_at, now, facts: { ...proof.facts } });
    if (move_id === null) return { status: "lost" };
    const text = grantCardText({ label: row.label, schedule: scheduleDisplayName(store.getScheduledTask(row.schedule_id)?.goal ?? ""),
      expires_local: formatInstantInZone(expires_at, resolveDisplayZone(process.env)).slice(0, 10) });
    const notification_id = enqueueUrgentCard(store, { chat_id: row.chat_id, key: `standing_grant:${row.standing_id}`, text, buttons: [revokeButton(row.standing_id)] });
    if (notification_id === null) throw new Error(`standing grant card conflict: ${row.standing_id}`); // no grant without its Revoke card
    store.setStandingGrantNotification(row.standing_id, notification_id, now);
    return { status: "granted" };
  });
}

/** The whole evidence, re-read inside the grant's transaction (a row that merely says "sealing" never grants), in §4.3 order (approval/decision ids, then execution ids). */
function grantEvidence(store: RunStore, row: StandingApprovalRow, now: string): { evidence: string[]; facts: CleanroomFacts } | { missing: string } {
  const { sealed_run_id: run_id, sealed_tool_call_id: tc, sealing_approval_id: fourth } = row;
  if (!run_id || !tc || !fourth) return { missing: "sealing_fields" };
  const credited = creditedApprovals(store, row, run_id);
  if (typeof credited === "string") return { missing: credited };
  const a4 = store.getToolApproval(fourth);
  if (!a4 || a4.state !== "consumed" || a4.run_id !== run_id || a4.tool_call_id !== tc || !keyedApproval(store, a4, row)) return { missing: "sealing_approval" };
  const input = sealInputs(store, row, now); const facts = factsOf(input.fin);
  if (sealVerdict(input) !== "seal" || facts === null || input.decision_id === undefined) return { missing: "seal_facts" };
  return { evidence: [...credited, fourth, input.decision_id, run_id, tc], facts };
}

/** Three consumed approvals of this key, one per distinct scheduled run in credited_runs_json order, none on the sealed run. */
function creditedApprovals(store: RunStore, row: StandingApprovalRow, sealed_run_id: string): string[] | string {
  const ids = (JSON.parse(row.approval_ids_json) as string[]).slice(0, STANDING_STREAK);
  const runs = JSON.parse(row.credited_runs_json) as string[];
  if (ids.length !== STANDING_STREAK || runs.length !== STANDING_STREAK || new Set(runs).size !== STANDING_STREAK || runs.includes(sealed_run_id)) return "credited_runs";
  for (const [n, id] of ids.entries()) {
    const a = store.getToolApproval(id);
    if (!a || a.state !== "consumed" || a.run_id !== runs[n] || !keyedApproval(store, a, row)) return `approval:${id}`;
  }
  return ids;
}

/** The approval's action is the key's, and its run is a run of the key's schedule notifying the key's chat (the consume hook's key rule). */
function keyedApproval(store: RunStore, a: ToolApprovalRow, row: StandingApprovalRow): boolean {
  const run = store.getRunForWorker(a.run_id);
  return a.capability === row.capability && a.action_fingerprint === row.action_fingerprint && run?.source === "schedule" && run.requested_by.kind === "schedule"
    && run.requested_by.id === row.schedule_id && run.notify.kind === "telegram" && run.notify.chat_id === row.chat_id;
}

/** Spec §8: the conditions the grant stands on, in Paco's words; "no background processes" is stated as a condition, not a guarantee. */
export function grantCardText(i: { label: string; schedule: string; expires_local: string }): string {
  return [`🪜 **Standing approval** — I'll stop asking for **${i.label}** on "${i.schedule}".`,
    "You approved this exact command on three runs; the fourth ran sealed, exited 0, and its report reached you.",
    "From the next run, on this schedule only, it runs without a card:",
    "• in an empty folder with a fresh home, TCP egress only",
    "• with no background processes left behind (a condition, not a guarantee)",
    "• one run per fire; one byte changed asks again",
    `• until ${i.expires_local} (30 days)`,
    "Revoke stops it from the next run."].join("\n");
}

export function tamperedUseText(label: string): string {
  return `🛑 **Standing approval ended** — a standing run of **${label}** reported a broken seal (tampered, escaped, a failed check or a room left behind). From the next run it asks for a tap again.`;
}

export function unverifiedUseText(label: string): string {
  return `🛑 **Standing approval ended** — a standing run of **${label}** finished without the sealed room's report, so nothing shows the seal held. From the next run it asks for a tap again.`;
}

export function revokeButton(standing_id: string, text = "🛑 Revoke"): NotificationButton {
  const data = `${SA_PREFIX}${standing_id}:revoke`;
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("standing callback_data exceeds 64 bytes");
  return { text, data };
}

/**
 * A standing use ends its grant (the move ends with it) and Paco gets an urgent card when its own facts show a broken seal
 * (tampered_use), or when its run ended and no well-formed clean-room facts prove the seal held (unverified_use: a crash before
 * tool_finished, or a fact the ledger cannot read). A use with no facts on a run still in flight waits. Ending wins over notifying:
 * a card conflict is an incident, never a revived grant. Idempotent: an ended row is skipped.
 */
export function settleStandingUses(store: RunStore, run_id: string, now: string = new Date().toISOString()): number {
  const events = store.getLedgerEvents(run_id); let ended = 0;
  for (const u of events.filter((e) => e.event_type === "standing_used")) {
    const fin = events.find((e) => e.event_type === "tool_finished" && e.payload.tool_call_id === u.payload.tool_call_id)?.payload;
    const row = store.getStandingApproval(String(u.payload.standing_id));
    const reason = row?.state === "standing" ? useEndReason(fin, store.findRunState(run_id)) : null;
    if (!row || !reason || !store.endStandingApproval({ standing_id: row.standing_id, reason, now })) continue;
    ended++;
    const card = reason === "tampered_use" ? { key: "standing_tampered", text: tamperedUseText(row.label) } : { key: "standing_unverified", text: unverifiedUseText(row.label) };
    if (enqueueUrgentCard(store, { chat_id: row.chat_id, key: `${card.key}:${row.standing_id}`, text: card.text }) === null) {
      openAlertedIncident(store, { kind: "standing_card_failed", subject: `standing:${row.standing_id}`, detail: { card: reason }, now });
    }
  }
  return ended;
}

/** Runs that will never write the use's facts; a run the store no longer knows counts too (nothing can arrive), so it fails closed. */
const USE_RUN_ENDED: ReadonlySet<string | undefined> = new Set(["completed", "failed", "cancelled", "expired", undefined]);

function useEndReason(fin: Record<string, unknown> | undefined, run_state: string | undefined): "tampered_use" | "unverified_use" | null {
  if (fin && brokeSeal(fin)) return "tampered_use";
  if ((!fin || factsOf(fin) === null) && USE_RUN_ENDED.has(run_state)) return "unverified_use";
  return null;
}

/** A use's facts that break the seal; a non-boolean fact counts as broken (fail closed). Absent facts are useEndReason's to judge. */
function brokeSeal(fin: Record<string, unknown>): boolean {
  const c = fin.cleanroom;
  if (typeof c !== "object" || c === null) return false;
  const f = c as Record<string, unknown>;
  return f.tampered !== false || f.escaped !== false || f.check_failed !== false || (f.ran === true && f.torn_down !== true);
}

/** The dispatcher's onDelivered: a run's own terminal notice settles its sealed trial and its standing uses. Never throws: an error is an incident, never a reclassified delivery. */
export function settleDeliveredReport(store: RunStore, record: Pick<NotificationRecord, "intent_type" | "idempotency_key" | "run_id">, env: NodeJS.ProcessEnv = process.env,
  now: string = new Date().toISOString()): void {
  if (record.intent_type !== "final_report" || record.run_id === null || record.idempotency_key !== `${record.run_id}:final_report`) return;
  // two settlements, two catches: a failed trial settle (a grant card conflict, say) must not skip the standing-use check, nor the reverse
  const run_id = record.run_id;
  try { settleSealing(store, run_id, now); } catch (e) { settleFailed(store, `run:${run_id}`, e, env); }
  try { settleStandingUses(store, run_id, now); } catch (e) { settleFailed(store, `uses:${run_id}`, e, env); }
}

function settleFailed(store: RunStore, subject: string, e: unknown, env: NodeJS.ProcessEnv): void {
  try { openAlertedIncident(store, { kind: "standing_settle_failed", subject, detail: { error: errorCode(e) }, env }); }
  catch (inner) { console.error(`[standing] settle incident not recorded: ${errorCode(inner)}`); }
}

export interface StandingSweepResult { settled: number; ended: number }

/** The net under the dispatcher hook: every sealing row is re-settled (the TTL ends a trial nothing else settles), every grant's uses re-read, and lapsed or stale rows ended. */
export function runStandingSweep(store: RunStore, now: string): StandingSweepResult {
  let settled = 0;
  for (const run_id of new Set(store.listStandingApprovals({ state: "sealing" }).map((r) => r.sealed_run_id ?? ""))) settled += settleQuietly(store, run_id, now);
  return { settled, ended: endTamperedUses(store, now) + endLapsed(store, now) + endStale(store, now) };
}

/** A grant past expires_at, or whose schedule can never fire again (disabled or gone). A 'failed' schedule keeps it: the use CAS already refuses it and an update re-enables. */
function endLapsed(store: RunStore, now: string): number {
  let n = 0;
  for (const r of store.listStandingApprovals({ state: "standing" })) {
    const schedule = store.getScheduledTask(r.schedule_id);
    const reason: StandingEndReason | null = r.expires_at === null || r.expires_at <= now ? "expired" : !schedule || schedule.state === "disabled" ? "schedule_ended" : null;
    if (reason && store.endStandingApproval({ standing_id: r.standing_id, reason, now })) n++;
  }
  return n;
}

/** A streak or candidate with no new credit for 30 days (spec Decision 4). A sealing row is settled, never staled. */
function endStale(store: RunStore, now: string): number {
  const cutoff = new Date(Date.parse(now) - STANDING_STALE_MS).toISOString();
  let n = 0;
  for (const state of ["streak", "candidate"] as const) {
    for (const r of store.listStandingApprovals({ state })) if (r.updated_at <= cutoff && store.endStandingApproval({ standing_id: r.standing_id, reason: "stale", now })) n++;
  }
  return n;
}

export function standingRevokedText(label: string): string {
  return `🛑 Revoked. ${label} on this schedule asks for a tap again from the next run.`;
}

/** `/schedule`'s "常驻批准": this chat's grants, `#N label · schedule · 到期 date`, one Revoke per row; empty when there are none. */
export function standingScheduleSection(store: RunStore, chat_id: string, env: NodeJS.ProcessEnv = process.env): { text: string; button_rows: NotificationButton[][] } {
  const rows = store.listStandingApprovals({ state: "standing", chat_id });
  if (rows.length === 0) return { text: "", button_rows: [] };
  const tz = resolveDisplayZone(env);
  const lines = rows.map((r, k) => `#${k + 1} ${r.label} · ${scheduleDisplayName(store.getScheduledTask(r.schedule_id)?.goal ?? "")} · 到期 ${r.expires_at ? formatInstantInZone(r.expires_at, tz).slice(0, 10) : "?"}`);
  return { text: `\n\n**常驻批准**\n${lines.join("\n")}`, button_rows: rows.map((r, k) => [revokeButton(r.standing_id, `🛑 Revoke #${k + 1}`)]) };
}

/** One poisoned trial (a grant card conflict) must not stop the rest of the sweep — a tamper end or an expiry behind it: its error is that run's incident. */
function settleQuietly(store: RunStore, run_id: string, now: string): number {
  try { return settleSealing(store, run_id, now).filter((o) => o.verdict !== "wait").length; }
  catch (e) { openAlertedIncident(store, { kind: "standing_settle_failed", subject: `run:${run_id}`, detail: { error: errorCode(e) }, now }); return 0; }
}

/** The net under the delivery hook: each standing row's uses (at most one per fire over 30 days) are re-read every cycle, so a missed delivery hook still ends a broken or unverified grant. */
function endTamperedUses(store: RunStore, now: string): number {
  const runs = new Set(store.listStandingApprovals({ state: "standing" }).flatMap((r) => store.listStandingUses(r.standing_id).map((u) => u.run_id)));
  let n = 0;
  for (const run_id of runs) n += settleStandingUses(store, run_id, now);
  return n;
}
