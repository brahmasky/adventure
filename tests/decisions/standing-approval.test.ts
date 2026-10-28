import { describe, expect, it } from "vitest";
import { buildTypedTaskEvent, type Identity } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { CLEANROOM_REASONS } from "../../src/omp/bridge-handler.js";
import { PRE_SPAWN_REASONS, revokeButton, runStandingSweep, SA_PREFIX, SEALING_TTL_MS, sealVerdict, settleDeliveredReport, settleSealing, settleStandingUses, type SealInput } from "../../src/decisions/standing-approval.js";
import { RunStore } from "../../src/run/run-store.js";

// Stage 4A §7 (Decision 1-A): a sealing row grants only when every code-owned fact of the ONE sealed call is true, the run
// completed AND its terminal notice was delivered inside the 24 h TTL; delivery alone proves receipt, not success (§2: failed
// runs deliver too). Nothing ran (a pre-spawn reason with ran:false) puts the key back to candidate; anything else ends it.
// The grant re-reads its evidence (the approvals, the runs, the facts) in its own transaction, so the fixture earns its row
// through the real consume hook — a row that merely says "sealing" must never grant.
const NOW = "2026-10-28T10:00:00.000Z";
const LATER = "2026-10-29T10:00:01.000Z"; // 24 h + 1 s after NOW
const FUTURE = new Date(Date.now() + 90 * 86_400_000).toISOString(); // compared against the real clock by resolveToolApprovalForTest
const PACO: Identity = { kind: "user", id: "paco" };
const WORKER = "planner:555:w"; const FP = "fp_post";
const FACTS = { ran: true, torn_down: true, tampered: false, escaped: false, exit_code: 0, truncated: false, check_failed: false, room: "room-abc123" };
const FIN = { tool_call_id: "tc4", status: "succeeded", executor: "cleanroom", cleanroom: FACTS };
const OK: SealInput = { fin: FIN, run_state: "completed", outbox: "delivered", decision_id: "dec_1", started_at: NOW, now: NOW };
const withFacts = (over: Record<string, unknown>): SealInput => ({ ...OK, fin: { ...FIN, cleanroom: { ...FACTS, ...over } } });
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

describe("sealVerdict (the seal conjunction, §7)", () => {
  it("all ten facts true → seal; each tool fact flipped alone → end (a test that passes with one conjunct removed fails here)", () => {
    expect(sealVerdict(OK)).toBe("seal");
    for (const over of [{ exit_code: 1 }, { exit_code: null }, { truncated: true }, { truncated: null }, { ran: false }, { torn_down: false }, { tampered: true }, { escaped: true }, { check_failed: true }]) {
      expect([over, sealVerdict(withFacts(over))]).toEqual([over, "end"]);
    }
    expect(sealVerdict({ ...OK, fin: { ...FIN, status: "failed" } })).toBe("end");
    expect(sealVerdict({ ...OK, fin: { ...FIN, executor: undefined } })).toBe("end"); // ran unsealed: never a seal
    expect(sealVerdict({ ...OK, fin: { ...FIN, cleanroom: { ...FACTS, torn_down: "yes" } } })).toBe("end"); // malformed facts are missing facts
    expect(sealVerdict({ ...OK, fin: { ...FIN, cleanroom: { ...FACTS, truncated: "no" } } })).toBe("end"); // truncation unknown is not "whole"
  });
  it("run state: completed seals; failed / cancelled / expired / missing end; still running waits, then ends at the 24 h TTL", () => {
    for (const run_state of ["failed", "cancelled", "expired", undefined]) expect(sealVerdict({ ...OK, run_state })).toBe("end");
    for (const run_state of ["running", "waiting_for_approval", "reporting", "queued"]) {
      expect(sealVerdict({ ...OK, run_state, fin: undefined })).toBe("wait");
      expect(sealVerdict({ ...OK, run_state, fin: undefined, now: LATER })).toBe("end");
    }
  });
  it("outbox: delivered seals; failed_terminal ends; queued / sending / retry_wait / none wait until the TTL", () => {
    expect(sealVerdict({ ...OK, outbox: "failed_terminal" })).toBe("end");
    for (const outbox of ["queued", "sending", "retry_wait", undefined]) {
      expect(sealVerdict({ ...OK, outbox })).toBe("wait");
      expect(sealVerdict({ ...OK, outbox, now: LATER })).toBe("end");
    }
  });
  it("the 24 h TTL is checked before delivery: delivered a second before the deadline seals; at it or after it, the trial ends", () => {
    expect(sealVerdict({ ...OK, now: at(SEALING_TTL_MS - 1_000) })).toBe("seal");
    expect(sealVerdict({ ...OK, now: at(SEALING_TTL_MS) })).toBe("end");
    expect(sealVerdict({ ...OK, now: LATER })).toBe("end");
  });
  it("a completed run whose sealed call left no facts, or no decision row, ends (never re-run, never granted with a hole in its evidence)", () => {
    expect(sealVerdict({ ...OK, fin: undefined })).toBe("end");
    expect(sealVerdict({ ...OK, decision_id: undefined })).toBe("end");
  });
  it("pre-spawn with ran:false resets to candidate whatever the run's fate or the clock; the same reason with ran:true ends", () => {
    for (const reason of PRE_SPAWN_REASONS) {
      const pre = { ...OK, fin: { ...FIN, status: "failed", cleanroom: { ...FACTS, ran: false, exit_code: null, truncated: null, reason } } };
      expect(sealVerdict({ ...pre, run_state: "failed", outbox: "delivered", now: LATER })).toBe("reset");
      expect(sealVerdict({ ...pre, fin: { ...pre.fin, cleanroom: { ...pre.fin.cleanroom, ran: true } } })).toBe("end");
    }
    expect(sealVerdict({ ...OK, fin: { ...FIN, status: "failed", cleanroom: { ...FACTS, ran: false, exit_code: null, reason: "timeout" } } })).toBe("end"); // a post-spawn word
  });
  it("every pre-spawn word is one the bridge persists (else settleSealing could never tell a void trial from a failed one)", () => {
    for (const r of PRE_SPAWN_REASONS) expect(CLEANROOM_REASONS.has(r)).toBe(true);
  });
});

let k = 0;
function scheduledRun(s: RunStore, schedule_id: string): string {
  const r = new Gateway(s).intake(buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "post", requested_by: { kind: "schedule", id: schedule_id },
    notify: { kind: "telegram", chat_id: "555" }, idempotency_key: `schedule:${schedule_id}:${++k}`, source_reference: `scheduled_tasks.${schedule_id}` }));
  if (!r.ok) throw new Error(JSON.stringify(r));
  s.claimRun(r.run_id, WORKER, 86_400 * 400); // the consume CAS checks the lease against the fixed NOW
  return r.run_id;
}
/** One approval Paco tapped and the runner consumed, through the real hooks (the consume credits the streak or seals the trial). */
function consumed(s: RunStore, run_id: string, tool_call_id: string, standing_trial?: { standing_id: string }): string {
  const a = s.createToolApproval({ run_id, worker_id: WORKER, tool_call_id, capability: "shell_external", input_hash: "ih", action_fingerprint: FP, requester: PACO, summary: "HTTP write",
    side_effect_level: "external_write", expires_at: FUTURE });
  s.resolveToolApprovalForTest(a.approval_id, "approved");
  const c = s.consumeToolApproval({ approval_id: a.approval_id, run_id, worker_id: WORKER, capability: "shell_external", action_fingerprint: FP, requester: PACO, now: NOW, ...(standing_trial ? { standing_trial } : {}) });
  if (!c.ok) throw new Error(c.code);
  return a.approval_id;
}
/** Three credited runs, then the fourth run's consume with the trial selector (row sealing on call tc4), then that run's facts, decision, end and notice as the case needs. */
function sealed(s: RunStore, o: { facts?: Record<string, unknown> | null; run?: "completed" | "failed" | "running"; outbox?: "delivered" | "queued" | "failed_terminal" | null; decision?: boolean } = {}) {
  const schedule_id = s.addScheduledTask({ chat_id: "555", goal: "Alishan check-in", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z", now: NOW }).schedule_id;
  const credited = ["tc1", "tc2", "tc3"].map((tc) => consumed(s, scheduledRun(s, schedule_id), tc));
  const cand = s.standingFor({ schedule_id, chat_id: "555", action_fingerprint: FP });
  if (cand?.state !== "candidate") throw new Error(`fixture: ${cand?.state ?? "no row"}`);
  const run_id = scheduledRun(s, schedule_id);
  const a4 = consumed(s, run_id, "tc4", { standing_id: cand.standing_id });
  const row = s.getStandingApproval(cand.standing_id)!;
  if (row.state !== "sealing") throw new Error(`fixture: ${row.state}`);
  if (o.facts !== null) s.appendRunLedgerEvent(run_id, "tool_finished", "capability_runner", { tool_call_id: "tc4", status: "succeeded", output_hash: "h", duration_ms: 1, bytes_out: 3, tool: "bash",
    executor: "cleanroom", cleanroom: { ...FACTS, ...(o.facts ?? {}) } });
  const decision_id = o.decision === false ? undefined : s.insertDecision({ entry_id: "tool.policy", entry_version: 3, run_id, tool_call_id: "tc4", stage: "pre_tool", rung: "rule", verdict: "requires_approval",
    p: null, reason_code: "gated_side_effect", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0 });
  if ((o.run ?? "completed") === "completed") s.finishRun({ run_id, expected_worker_id: WORKER, next: "completed", report_ref: "r.md", duration_ms: 1, tool_calls: 1 });
  if (o.run === "failed") s.finishRun({ run_id, expected_worker_id: WORKER, next: "failed", error_type: "planner_exit", error_ref: "x" });
  if (o.outbox !== null) {
    if (o.run === "failed") s.enqueueFailureNotification(run_id, "I hit an error on that one: x"); else s.enqueueFinalReportNotification(run_id, { text: "200", report_path: "r.md" });
    // the oldest queued row is an approval card, not this run's notice: claim until the run's own final_report comes up
    let n = s.claimNextNotification("t", 30)!;
    while (n.idempotency_key !== `${run_id}:final_report`) n = s.claimNextNotification("t", 30)!;
    if ((o.outbox ?? "delivered") === "delivered") s.markNotificationDelivered(n.notification_id, "tg:1");
    if (o.outbox === "failed_terminal") s.markNotificationFailed(n.notification_id, "boom", false, NOW, 1);
    if (o.outbox === "queued") s.markNotificationFailed(n.notification_id, "boom", true, NOW, 5); // retry_wait: not delivered yet
  }
  return { row, run_id, schedule_id, decision_id, credited, a4, runs: JSON.parse(row.credited_runs_json) as string[] };
}
const events = (s: RunStore, type: string) => s.getLedgerEvents().filter((e) => e.event_type === type).map((e) => e.payload);
const raw = (s: RunStore) => (s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
const moves = (s: RunStore) => s.listLadderMovesCreatedSince("2000-01-01T00:00:00.000Z");

describe("settleSealing (Decision 1-A: the grant is immediate)", () => {
  it("a sealed run grants at once: row standing for 30 d, an auto move on tool.policy with the evidence in §4.3 order, both ledger facts, an urgent card with Revoke", () => {
    const s = RunStore.openInMemory(); const { row, run_id, decision_id, credited, a4 } = sealed(s);
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "seal" }]);
    const after = s.getStandingApproval(row.standing_id)!;
    expect(after).toMatchObject({ state: "standing", expires_at: "2026-11-27T10:00:00.000Z" });
    expect(s.getLadderMove(after.move_id!)).toMatchObject({ entry_id: "tool.policy", scope: row.standing_id, from_rung: "paco", to_rung: "rule", granted_by: "auto", granted_via: "approval.standing", state: "active", revocable: 1 });
    expect(JSON.parse(s.getLadderMove(after.move_id!)!.evidence_json)).toEqual([...credited, a4, decision_id, run_id, "tc4"]); // decision/approval ids first, execution ids after
    expect(events(s, "standing_sealed")).toEqual([expect.objectContaining({ standing_id: row.standing_id, run_id, tool_call_id: "tc4", exit_code: 0, torn_down: true, room: "room-abc123" })]);
    expect(events(s, "standing_granted")).toEqual([{ standing_id: row.standing_id, move_id: after.move_id }]);
    const card = s.getNotification(after.grant_notification_id!)!;
    expect(card).toMatchObject({ idempotency_key: `urgent:standing_grant:${row.standing_id}`, target: { kind: "telegram", chat_id: "555" } });
    expect(String(card.payload.text)).toMatch(/one byte changed asks again/i);
    expect(card.payload.buttons).toEqual([revokeButton(row.standing_id)]);
    expect(Buffer.byteLength(revokeButton(row.standing_id).data)).toBeLessThanOrEqual(64);
  });
  it("is idempotent: a second settle (the sweep after the dispatcher) finds no sealing row and changes nothing", () => {
    const s = RunStore.openInMemory(); const { run_id } = sealed(s);
    settleSealing(s, run_id, NOW);
    expect(settleSealing(s, run_id, NOW)).toEqual([]);
    expect(moves(s)).toHaveLength(1);
    expect(events(s, "standing_granted")).toHaveLength(1);
  });
  it("the grant re-reads its evidence: each gap ends the row sealed_trial_failed, names itself in standing_evidence_failed, and never grants", () => {
    // one case per guard, each asserting the gap it names: a case that still ends with that guard removed would name another gap
    type F = ReturnType<typeof sealed>;
    const sql = (s: RunStore, q: string, ...a: unknown[]) => { raw(s).prepare(q).run(...a); };
    const cases: Array<[string, (s: RunStore, f: F) => void, (f: F) => string]> = [
      ["a credited approval no longer consumed", (s, f) => sql(s, `UPDATE tool_approvals SET state = 'expired' WHERE approval_id = ?`, f.credited[0]), (f) => `approval:${f.credited[0]}`],
      ["two credits naming one run", (s, f) => sql(s, `UPDATE tool_approvals SET run_id = ? WHERE approval_id = ?`, f.runs[0], f.credited[1]), (f) => `approval:${f.credited[1]}`],
      ["fabricated credited ids", (s, f) => sql(s, `UPDATE standing_approvals SET approval_ids_json = ? WHERE standing_id = ?`, JSON.stringify(["a1", "a2", "a3", f.a4]), f.row.standing_id), () => "approval:a1"],
      ["a credited approval keyed to a foreign schedule", (s, f) => sql(s, `UPDATE runs SET requested_by_json = '{"kind":"schedule","id":"sch_foreign"}' WHERE run_id = ?`, f.runs[0]), (f) => `approval:${f.credited[0]}`],
      ["duplicate credited runs", (s, f) => sql(s, `UPDATE standing_approvals SET credited_runs_json = ? WHERE standing_id = ?`, JSON.stringify([f.runs[0], f.runs[0], f.runs[2]]), f.row.standing_id), () => "credited_runs"],
      ["the sealed run inside the credited list", (s, f) => sql(s, `UPDATE standing_approvals SET credited_runs_json = ? WHERE standing_id = ?`, JSON.stringify([f.runs[0], f.runs[1], f.run_id]), f.row.standing_id), () => "credited_runs"],
      ["the fourth approval on another run", (s, f) => sql(s, `UPDATE tool_approvals SET run_id = ? WHERE approval_id = ?`, f.runs[0], f.a4), () => "sealing_approval"],
      ["the fourth approval on another tool call", (s, f) => sql(s, `UPDATE tool_approvals SET tool_call_id = 'tc_other' WHERE approval_id = ?`, f.a4), () => "sealing_approval"],
      ["the fourth approval not consumed", (s, f) => sql(s, `UPDATE tool_approvals SET state = 'approved' WHERE approval_id = ?`, f.a4), () => "sealing_approval"],
      ["the row lost its sealing approval id", (s, f) => sql(s, `UPDATE standing_approvals SET sealing_approval_id = NULL WHERE standing_id = ?`, f.row.standing_id), () => "sealing_fields"]
    ];
    for (const [name, mutate, missing] of cases) {
      const s = RunStore.openInMemory(); const f = sealed(s); mutate(s, f);
      expect([name, settleSealing(s, f.run_id, NOW)]).toEqual([name, [{ standing_id: f.row.standing_id, verdict: "end" }]]);
      expect([name, s.getStandingApproval(f.row.standing_id)?.ended_reason, s.getStandingApproval(f.row.standing_id)?.move_id]).toEqual([name, "sealed_trial_failed", null]);
      const inc = s.findOpenIncident(s.incidentFingerprint("standing_evidence_failed", `standing:${f.row.standing_id}`));
      expect([name, inc ? (JSON.parse(inc.detail_json) as { missing?: string }).missing : "no incident"]).toEqual([name, missing(f)]);
      expect([name, moves(s).length, events(s, "standing_granted").length]).toEqual([name, 0, 0]);
    }
  });
  it("a trial that changed between the settle's read and the grant is lost: the older trial's evidence neither grants nor ends the newer one", () => {
    // interleaved: between settleSealing's read and grantStanding's transaction the trial is reset and a newer fourth approval seals it again
    const s = RunStore.openInMemory(); const f = sealed(s);
    const racy = Object.create(s) as RunStore; let newer = "";
    racy.inTransaction = <T,>(fn: () => T): T => {
      if (newer === "") {
        s.resetStandingToCandidate({ standing_id: f.row.standing_id, now: NOW, reason: "race" });
        newer = scheduledRun(s, f.schedule_id); consumed(s, newer, "tc4b", { standing_id: f.row.standing_id });
      }
      return RunStore.prototype.inTransaction.call(racy, fn) as T;
    };
    expect(settleSealing(racy, f.run_id, NOW)).toEqual([{ standing_id: f.row.standing_id, verdict: "wait" }]);
    expect(s.getStandingApproval(f.row.standing_id)).toMatchObject({ state: "sealing", sealed_run_id: newer, sealed_tool_call_id: "tc4b", move_id: null });
    expect(moves(s)).toEqual([]);
    expect(s.findOpenIncident(s.incidentFingerprint("standing_evidence_failed", `standing:${f.row.standing_id}`))).toBeUndefined();
    expect(settleSealing(s, newer, NOW)).toEqual([{ standing_id: f.row.standing_id, verdict: "wait" }]); // the newer trial has no facts of its own yet
  });
  it("a grant whose Revoke card cannot be queued does not commit: the row stays sealing with no move, no event, no card id", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s);
    s.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: `urgent:standing_grant:${row.standing_id}`, correlation_id: "x", payload: { text: "another payload" } });
    expect(() => settleSealing(s, run_id, NOW)).toThrow(/grant card/);
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "sealing", move_id: null, grant_notification_id: null });
    expect(moves(s)).toEqual([]); expect(events(s, "standing_granted")).toEqual([]); expect(events(s, "standing_sealed")).toEqual([]);
  });
  it("a report settled at the 24 h deadline ends the trial, never grants", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s);
    expect(settleSealing(s, run_id, at(SEALING_TTL_MS))).toEqual([{ standing_id: row.standing_id, verdict: "end" }]);
    expect(moves(s)).toEqual([]);
  });
  it("a failed run whose failure notice was delivered ends the row (the shared final_report key is not a success signal)", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s, { run: "failed" });
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "end" }]);
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "sealed_trial_failed", move_id: null });
    expect(moves(s)).toEqual([]);
  });
  it("a void trial (cleanroom_unavailable, ran:false) goes back to candidate with the three credited approvals; the spent fourth is dropped", () => {
    const s = RunStore.openInMemory(); const { row, run_id, credited } = sealed(s, { facts: { ran: false, exit_code: null, truncated: null, reason: "cleanroom_unavailable" } });
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "reset" }]);
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "candidate", approval_ids_json: JSON.stringify(credited), sealing_approval_id: null, sealed_run_id: null, sealed_tool_call_id: null, sealing_started_at: null });
    expect(events(s, "standing_streak").at(-1)).toMatchObject({ standing_id: row.standing_id, streak: 3, reset: "cleanroom_unavailable" });
  });
  it("a report still in retry waits; past the TTL the sweep ends it; a missing decision row ends it", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s, { outbox: "queued" });
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "wait" }]);
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("sealing");
    expect(runStandingSweep(s, LATER)).toMatchObject({ settled: 1 });
    expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "sealed_trial_failed" });
    const s2 = RunStore.openInMemory(); const nd = sealed(s2, { decision: false });
    expect(settleSealing(s2, nd.run_id, NOW)).toEqual([{ standing_id: nd.row.standing_id, verdict: "end" }]);
  });
  it("tool_finished of ANOTHER call in the run is not the sealed call's facts", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s, { facts: null });
    s.appendRunLedgerEvent(run_id, "tool_finished", "capability_runner", { ...FIN, tool_call_id: "tc_other", output_hash: "h", duration_ms: 1, bytes_out: 1 });
    expect(settleSealing(s, run_id, NOW)).toEqual([{ standing_id: row.standing_id, verdict: "end" }]);
  });
});

/** A granted row on an enabled schedule, one real use through the store CAS, then that call's facts (null: still in flight). */
function used(s: RunStore, facts: Record<string, unknown> | null) {
  const schedule_id = s.addScheduledTask({ chat_id: "555", goal: "post", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2027-01-01T00:00:00.000Z", now: NOW }).schedule_id;
  const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "x", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true });
  const row = s.insertStandingApprovalForTest({ schedule_id, chat_id: "555", action_fingerprint: FP, state: "standing", move_id, expires_at: FUTURE });
  const run_id = scheduledRun(s, schedule_id);
  const u = s.standingUse({ standing_id: row.standing_id, action_fingerprint: FP, run_id, tool_call_id: "tc5", now: NOW });
  if (!u.ok) throw new Error(u.code);
  if (facts !== null) s.appendRunLedgerEvent(run_id, "tool_finished", "capability_runner", { tool_call_id: "tc5", status: "succeeded", output_hash: "h", duration_ms: 1, bytes_out: 3, tool: "bash",
    executor: "cleanroom", cleanroom: { ...FACTS, ...facts } });
  return { row, run_id, move_id };
}

describe("settleStandingUses (a broken seal on a standing use ends the grant)", () => {
  it("tampered, escaped, a failed check, or a room left behind each end the grant tampered_use with its move, and Paco gets an urgent card", () => {
    for (const over of [{ tampered: true }, { escaped: true }, { check_failed: true }, { torn_down: false }]) {
      const s = RunStore.openInMemory(); const { row, run_id, move_id } = used(s, over);
      expect([over, settleStandingUses(s, run_id, NOW)]).toEqual([over, 1]);
      expect(s.getStandingApproval(row.standing_id)).toMatchObject({ state: "ended", ended_reason: "tampered_use" });
      expect(s.getLadderMove(move_id)?.state).toBe("ended");
      expect(s.claimNextNotification("t", 30)).toMatchObject({ idempotency_key: `urgent:standing_tampered:${row.standing_id}`, target: { kind: "telegram", chat_id: "555" } });
    }
  });
  it("a clean use, or one still in flight (no tool_finished yet), leaves the grant standing; a second settle of a broken one changes nothing", () => {
    const s = RunStore.openInMemory(); const clean = used(s, {});
    expect(settleStandingUses(s, clean.run_id, NOW)).toBe(0);
    expect(s.getStandingApproval(clean.row.standing_id)?.state).toBe("standing");
    const s2 = RunStore.openInMemory(); const flight = used(s2, null);
    expect(settleStandingUses(s2, flight.run_id, NOW)).toBe(0);
    const s3 = RunStore.openInMemory(); const bad = used(s3, { tampered: true });
    settleStandingUses(s3, bad.run_id, NOW);
    expect(settleStandingUses(s3, bad.run_id, NOW)).toBe(0);
    expect(events(s3, "standing_ended")).toHaveLength(1);
  });
  it("the sweep re-reads every standing row's uses, so a broken use ends its grant even when no delivery hook ran", () => {
    const s = RunStore.openInMemory(); const { row } = used(s, { escaped: true });
    expect(runStandingSweep(s, NOW)).toMatchObject({ ended: 1 });
    expect(s.getStandingApproval(row.standing_id)?.ended_reason).toBe("tampered_use");
  });
});

describe("settleDeliveredReport (the dispatcher's hook)", () => {
  it("settles only a run's own final_report; another intent or a foreign key never settles", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = sealed(s);
    settleDeliveredReport(s, { intent_type: "progress", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW);
    settleDeliveredReport(s, { intent_type: "final_report", idempotency_key: "urgent:x", run_id }, {}, NOW);
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("sealing");
    settleDeliveredReport(s, { intent_type: "final_report", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW); // NOW: inside the trial's 24 h
    expect(s.getStandingApproval(row.standing_id)?.state).toBe("standing");
  });
  it("a settlement error (a broken store, or a grant card conflict) opens standing_settle_failed and never throws into the dispatcher", () => {
    const s = RunStore.openInMemory(); const { run_id } = sealed(s);
    const broken = Object.create(s) as RunStore;
    (broken as { listStandingApprovals: unknown }).listStandingApprovals = () => { throw new Error("disk I/O error"); };
    expect(() => settleDeliveredReport(broken, { intent_type: "final_report", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW)).not.toThrow();
    expect(s.findOpenIncident(s.incidentFingerprint("standing_settle_failed", `run:${run_id}`))).toBeDefined();
    const c = RunStore.openInMemory(); const f = sealed(c);
    c.enqueueNotification({ target: { kind: "telegram", chat_id: "555" }, intent_type: "progress", idempotency_key: `urgent:standing_grant:${f.row.standing_id}`, correlation_id: "x", payload: { text: "another payload" } });
    expect(() => settleDeliveredReport(c, { intent_type: "final_report", idempotency_key: `${f.run_id}:final_report`, run_id: f.run_id }, {}, NOW)).not.toThrow();
    expect(c.findOpenIncident(c.incidentFingerprint("standing_settle_failed", `run:${f.run_id}`))).toBeDefined();
    expect(c.getStandingApproval(f.row.standing_id)?.state).toBe("sealing");
  });
  it("the delivery hook, not only the sweep, ends a tampered standing use when the run's report is delivered", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = used(s, { tampered: true });
    settleDeliveredReport(s, { intent_type: "final_report", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW);
    expect(s.getStandingApproval(row.standing_id)?.ended_reason).toBe("tampered_use");
  });
  it("a failed trial settle never skips the standing-use check: each failure is its own incident", () => {
    const s = RunStore.openInMemory(); const { row, run_id } = used(s, { escaped: true });
    const broken = Object.create(s) as RunStore;
    (broken as { listStandingApprovals: unknown }).listStandingApprovals = () => { throw new Error("disk I/O error"); }; // settleSealing fails; settleStandingUses never lists
    settleDeliveredReport(broken, { intent_type: "final_report", idempotency_key: `${run_id}:final_report`, run_id }, {}, NOW);
    expect(s.getStandingApproval(row.standing_id)?.ended_reason).toBe("tampered_use");
    expect(s.findOpenIncident(s.incidentFingerprint("standing_settle_failed", `run:${run_id}`))).toBeDefined();
  });
});

describe("revokeButton", () => {
  it("carries dec:sa:<standing_id>:revoke", () => {
    expect(revokeButton("sa_0f8fad5b-d9cb-469f-a165-70867728950e")).toEqual({ text: "🛑 Revoke", data: `${SA_PREFIX}sa_0f8fad5b-d9cb-469f-a165-70867728950e:revoke` });
  });
});
