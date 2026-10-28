import { errorCode } from "../domain/error-code.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { CleanroomFacts } from "../omp/bridge-handler.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import { STANDING_STREAK, type NotificationRecord, type RunStore, type StandingApprovalRow, type ToolApprovalRow } from "../run/run-store.js";
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
export interface SealInput { fin: Record<string, unknown> | undefined; run_state: string | undefined; outbox: string | undefined; decision_id: string | undefined; started_at: string; now: string }

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
  if (Date.parse(i.now) - Date.parse(i.started_at) >= SEALING_TTL_MS) return "end"; // a late delivery never stands a command up
  if (i.fin && !sealedCall(i.fin, f)) return "end";
  if (i.run_state === undefined || UNSEALED_END.has(i.run_state)) return "end";
  if (i.run_state !== "completed") return "wait";
  if (!i.fin || i.decision_id === undefined || i.outbox === "failed_terminal") return "end"; // finished without its facts: never re-run
  return i.outbox === "delivered" ? "seal" : "wait";
}

export interface SettleOutcome { standing_id: string; verdict: SealVerdict }

/** Idempotent and total over the run's sealing rows: each transition is a store CAS on state = 'sealing', so a second call finds none. Throws on a grant card conflict (no grant without its Revoke card); both callers catch. */
export function settleSealing(store: RunStore, run_id: string, now: string = new Date().toISOString()): SettleOutcome[] {
  return store.listStandingApprovals({ state: "sealing" }).filter((r) => r.sealed_run_id === run_id).map((row) => ({ standing_id: row.standing_id, verdict: settleRow(store, row, now) }));
}

/** The reads a verdict needs; the settle and the grant's in-transaction re-read share them. */
function sealInputs(store: RunStore, row: StandingApprovalRow, now: string): SealInput {
  const run_id = row.sealed_run_id ?? "";
  const fin = store.getLedgerEvents(run_id).find((e) => e.event_type === "tool_finished" && e.payload.tool_call_id === row.sealed_tool_call_id)?.payload;
  const decision_id = store.listDecisionsForRun(run_id).filter((d) => d.entry_id === "tool.policy" && d.tool_call_id === row.sealed_tool_call_id).at(-1)?.decision_id;
  return { fin, run_state: store.findRunState(run_id), outbox: store.finalReportState(run_id), decision_id, started_at: row.sealing_started_at ?? row.updated_at, now };
}

function settleRow(store: RunStore, row: StandingApprovalRow, now: string): SealVerdict {
  const input = sealInputs(store, row, now);
  const verdict = sealVerdict(input);
  if (verdict === "seal") return grantOrEnd(store, row, now);
  if (verdict === "reset") store.resetStandingToCandidate({ standing_id: row.standing_id, now, reason: factsOf(input.fin)?.reason ?? "pre_spawn" });
  if (verdict === "end") store.endStandingApproval({ standing_id: row.standing_id, reason: "sealed_trial_failed", now });
  return verdict;
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

export function revokeButton(standing_id: string, text = "🛑 Revoke"): NotificationButton {
  const data = `${SA_PREFIX}${standing_id}:revoke`;
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("standing callback_data exceeds 64 bytes");
  return { text, data };
}

/**
 * A standing use whose own facts show a broken seal ends its grant (tampered_use; the move ends with it) and tells
 * Paco. A use with no tool_finished yet is in flight and waits; one without clean-room facts has nothing to judge. Ending wins
 * over notifying: a card conflict is an incident, never a revived grant. Idempotent: an ended row is skipped.
 */
export function settleStandingUses(store: RunStore, run_id: string, now: string = new Date().toISOString()): number {
  const events = store.getLedgerEvents(run_id); let ended = 0;
  for (const u of events.filter((e) => e.event_type === "standing_used")) {
    const fin = events.find((e) => e.event_type === "tool_finished" && e.payload.tool_call_id === u.payload.tool_call_id)?.payload;
    const row = store.getStandingApproval(String(u.payload.standing_id));
    if (!fin || !brokeSeal(fin) || row?.state !== "standing") continue;
    if (!store.endStandingApproval({ standing_id: row.standing_id, reason: "tampered_use", now })) continue;
    ended++;
    if (enqueueUrgentCard(store, { chat_id: row.chat_id, key: `standing_tampered:${row.standing_id}`, text: tamperedUseText(row.label) }) === null) {
      openAlertedIncident(store, { kind: "standing_card_failed", subject: `standing:${row.standing_id}`, detail: { card: "tampered_use" }, now });
    }
  }
  return ended;
}

/** A sealed use's facts that break the seal; a non-boolean fact counts as broken (fail closed). */
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

/** The net under the dispatcher hook: every sealing row is re-settled (the TTL ends a trial nothing else settles) and every grant's uses re-read. Expiry, schedule end and stale are not swept here yet. */
export function runStandingSweep(store: RunStore, now: string): StandingSweepResult {
  let settled = 0;
  for (const run_id of new Set(store.listStandingApprovals({ state: "sealing" }).map((r) => r.sealed_run_id ?? ""))) settled += settleQuietly(store, run_id, now);
  return { settled, ended: endTamperedUses(store, now) };
}

/** One poisoned trial (a grant card conflict) must not stop the rest of the sweep — a tamper end or an expiry behind it: its error is that run's incident. */
function settleQuietly(store: RunStore, run_id: string, now: string): number {
  try { return settleSealing(store, run_id, now).filter((o) => o.verdict !== "wait").length; }
  catch (e) { openAlertedIncident(store, { kind: "standing_settle_failed", subject: `run:${run_id}`, detail: { error: errorCode(e) }, now }); return 0; }
}

/** The net under the delivery hook: each standing row's uses (at most one per fire over 30 days) are re-read every cycle, so a missed delivery hook still ends a broken grant. */
function endTamperedUses(store: RunStore, now: string): number {
  const runs = new Set(store.listStandingApprovals({ state: "standing" }).flatMap((r) => store.listStandingUses(r.standing_id).map((u) => u.run_id)));
  let n = 0;
  for (const run_id of runs) n += settleStandingUses(store, run_id, now);
  return n;
}
