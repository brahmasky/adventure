import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  ApprovalDecision,
  ApprovalState,
  CompiledTaskContract,
  Identity,
  RiskLevel,
  RunState,
  SideEffectLevel,
  TypedTaskEvent
} from "../domain/types.js";
import { stableHash } from "../domain/canonical.js";
import type { NotificationIntent } from "../notifications/notification-types.js";
import {
  appendLedgerEvent,
  createLedgerEvent,
  readLedgerEvents,
  type LedgerActor,
  type LedgerEvent,
  type LedgerEventType
} from "./run-ledger.js";
import { canTransitionRun } from "./state-machines.js";

type SqliteValue = string | number | bigint | null;

interface SqliteRunResult {
  changes: number;
}

interface SqliteStatement {
  get<T = Record<string, unknown>>(...values: SqliteValue[]): T | undefined;
  all<T = Record<string, unknown>>(...values: SqliteValue[]): T[];
  run(...values: SqliteValue[]): SqliteRunResult;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

export type CreateOrGetResult =
  | { status: "created"; run_id: string }
  | { status: "duplicate"; run_id: string }
  | { status: "conflict"; error: "IDEMPOTENCY_CONFLICT"; existing_run_id: string };

export interface ClaimedRun {
  run_id: string;
  contract: CompiledTaskContract;
}

export type LeaseRecovery =
  | { run_id: string; action: "requeued" }
  | { run_id: string; action: "failed" };

export interface ApprovalRequestInput {
  run_id: string;
  approval_type: "capability" | "learning";
  capability: string;
  action_fingerprint: string;
  adapter_input_hash: string;
  adapter_input_json: string;
  action_summary: string;
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  affected_resources: string[];
  requester: Identity;
  expires_at: string;
}

export interface ApprovalRequestRecord extends ApprovalRequestInput {
  approval_id: string;
  state: ApprovalState;
}

export type TriggerDedupeResult =
  | { status: "new" }
  | { status: "duplicate"; result_json: string }
  | { status: "conflict"; error: "TRIGGER_IDEMPOTENCY_CONFLICT" };

export interface ApprovalTriggerInput {
  event: TypedTaskEvent;
  decision: ApprovalDecision;
  resolved_at: string;
}

type ApprovalErrorCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_NOT_PENDING"
  | "APPROVAL_NOT_APPROVED"
  | "APPROVAL_REQUESTER_MISMATCH"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_ACTION_MISSING"
  | "APPROVAL_ACTION_MISMATCH"
  | "APPROVAL_CAPABILITY_MISMATCH"
  | "APPROVAL_INPUT_MISMATCH"
  | "APPROVAL_RUN_MISMATCH"
  | "RUN_NOT_WAITING_FOR_APPROVAL"
  | "RUN_NOT_RUNNING"
  | "TRIGGER_IDEMPOTENCY_CONFLICT";

type ApprovalFailure = { ok: false; error: { code: ApprovalErrorCode; message: string } };

type ApprovalResolutionResult =
  | { ok: true; run_id: string; status: "approval_resolved" }
  | ApprovalFailure;

type ApprovalConsumptionResult =
  | { ok: true; approval_id: string; state: "consumed" }
  | ApprovalFailure;

export interface NotificationRecord {
  notification_id: string;
  target: NotificationIntent["target"];
  target_key: string;
  intent_type: NotificationIntent["intent_type"];
  idempotency_key: string;
  state: string;
  attempt_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  provider_message_id: string | null;
  run_id: string | null;
  approval_id: string | null;
  correlation_id: string;
  payload: NotificationIntent["payload"];
  payload_hash: string;
  created_at: string;
  updated_at: string;
}

type NotificationQueueResult =
  | { status: "queued"; record: NotificationRecord }
  | { status: "duplicate"; record: NotificationRecord }
  | { status: "conflict"; error: "NOTIFICATION_IDEMPOTENCY_CONFLICT" };

interface RunRow {
  run_id: string;
  payload_hash: string;
  state: RunState;
  contract_json: string | null;
  attempt_count: number;
  created_at: string;
  worker_id: string | null;
  lease_expires_at: string | null;
}

interface ApprovalRow {
  approval_id: string;
  run_id: string;
  approval_type: "capability" | "learning";
  state: ApprovalState;
  capability: string;
  action_fingerprint: string;
  adapter_input_hash: string;
  adapter_input_json: string;
  action_summary: string;
  side_effect_level: SideEffectLevel;
  risk_level: RiskLevel;
  affected_resources_json: string;
  requester_json: string;
  expires_at: string;
  consumed_tool_call_id: string | null;
  consumed_operation_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface RunStatusRow {
  run_id: string;
  source: string;
  type: string;
  program: string | null;
  goal: string | null;
  state: RunState;
  created_at: string;
  updated_at: string;
  event_count: number;
}

export class RunStore {
  private constructor(private readonly db: SqliteDatabase) {
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  static openInMemory(): RunStore {
    return new RunStore(new DatabaseSync(":memory:"));
  }

  static open(path: string): RunStore {
    return new RunStore(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  createOrGet(event: TypedTaskEvent): CreateOrGetResult {
    const existing = this.getCreateOrGetExisting(event);
    if (existing) {
      return existing;
    }

    return this.insertRun(event);
  }

  attachContract(run_id: string, contract: CompiledTaskContract): boolean {
    const updated = this.db.prepare(`
      UPDATE runs
      SET contract_json = ?, updated_at = ?
      WHERE run_id = ? AND state = 'created'
    `).run(JSON.stringify(contract), new Date().toISOString(), run_id);

    if (updated.changes === 1) {
      this.appendRunLedgerEvent(run_id, "contract_attached", "gateway", {
        contract_hash: contract.contract_hash,
        program: this.getRunProgram(run_id) ?? "",
        budget: contract.budget,
        allowed_actions: contract.allowed_actions,
        approval_gates: contract.approval_gates
      });
    }

    return updated.changes === 1;
  }

  transition(run_id: string, expected: RunState, next: RunState, reason: string): boolean {
    const row = this.getRun(run_id);
    if (!row) {
      throw new Error(`Run not found: ${run_id}`);
    }

    if (row.state !== expected) {
      return false;
    }

    if (!canTransitionRun(expected, next)) {
      throw new Error(`Invalid run transition: ${expected} -> ${next}`);
    }

    const shouldClearLease = shouldClearLeaseOnTransition(expected, next);
    const updated = shouldClearLease
      ? this.db.prepare(`
        UPDATE runs
        SET state = ?,
            state_reason = ?,
            updated_at = ?,
            worker_id = NULL,
            lease_expires_at = NULL
        WHERE run_id = ? AND state = ?
      `).run(next, reason, new Date().toISOString(), run_id, expected)
      : this.db.prepare(`
        UPDATE runs
      SET state = ?, state_reason = ?, updated_at = ?
      WHERE run_id = ? AND state = ?
    `).run(next, reason, new Date().toISOString(), run_id, expected);

    if (updated.changes === 1 && shouldClearLease && row.worker_id) {
      this.appendRunLedgerEvent(run_id, "worker_lease_released", "core", {
        worker_id: row.worker_id,
        reason
      });
    }

    return updated.changes === 1;
  }

  getRunState(run_id: string): RunState {
    const row = this.getRun(run_id);
    if (!row) {
      throw new Error(`Run not found: ${run_id}`);
    }

    return row.state;
  }

  getRunLease(run_id: string): { worker_id: string | null; lease_expires_at: string | null } {
    const row = this.db.prepare(`
      SELECT worker_id, lease_expires_at
      FROM runs
      WHERE run_id = ?
    `).get<{ worker_id: string | null; lease_expires_at: string | null }>(run_id);
    if (!row) {
      throw new Error(`Run not found: ${run_id}`);
    }

    return row;
  }

  appendLedgerEvent(event: LedgerEvent): void {
    appendLedgerEvent(this.db, event);
  }

  getLedgerEvents(run_id?: string): LedgerEvent[] {
    return readLedgerEvents(this.db, run_id);
  }

  getRunStatus(run_id: string): RunStatusRow | undefined {
    return this.db.prepare(`
      SELECT
        runs.run_id,
        runs.source,
        runs.type,
        runs.program,
        runs.goal,
        runs.state,
        runs.created_at,
        runs.updated_at,
        COUNT(ledger_events.event_id) AS event_count
      FROM runs
      LEFT JOIN ledger_events ON ledger_events.run_id = runs.run_id
      WHERE runs.run_id = ?
      GROUP BY runs.run_id
    `).get<RunStatusRow>(run_id);
  }

  listRecentRunStatuses(limit: number): RunStatusRow[] {
    return this.db.prepare(`
      SELECT
        runs.run_id,
        runs.source,
        runs.type,
        runs.program,
        runs.goal,
        runs.state,
        runs.created_at,
        runs.updated_at,
        COUNT(ledger_events.event_id) AS event_count
      FROM runs
      LEFT JOIN ledger_events ON ledger_events.run_id = runs.run_id
      GROUP BY runs.run_id
      ORDER BY runs.updated_at DESC, runs.run_id DESC
      LIMIT ?
    `).all<RunStatusRow>(limit);
  }

  recordReportWritten(run_id: string, report_ref: string, report_hash: string, partial: boolean): void {
    this.appendRunLedgerEvent(run_id, "report_written", "core", {
      report_ref,
      report_hash,
      partial
    });
  }

  recordRunCompleted(run_id: string, report_ref: string, duration_ms: number): void {
    this.appendRunLedgerEvent(run_id, "run_completed", "core", {
      report_ref,
      budget_used: { tool_calls: 1 },
      duration_ms
    });
  }

  recordRunFailed(run_id: string, error_ref: string, recoverable: boolean): void {
    this.appendRunLedgerEvent(run_id, "run_failed", "core", {
      error_type: "worker_error",
      error_ref,
      recoverable
    });
  }

  recordEvalCompleted(eval_suite: string, passed: boolean, failed_case_ids: string[]): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: `eval:${eval_suite}`,
        event_type: "eval_completed",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload: {
          eval_suite,
          passed,
          failed_case_ids,
          report_ref: `evals/suites/${eval_suite}.json`
        }
      })
    );
  }

  claimNext(worker_id: string, lease_ttl_seconds: number): ClaimedRun | null {
    const row = this.db.prepare(`
      SELECT run_id, state, contract_json, attempt_count, created_at, worker_id, lease_expires_at
      FROM runs
      WHERE state = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get<RunRow>();

    if (!row) {
      return null;
    }

    return this.claimQueuedRow(row, worker_id, lease_ttl_seconds);
  }

  claimRun(run_id: string, worker_id: string, lease_ttl_seconds: number): ClaimedRun | null {
    const row = this.db.prepare(`
      SELECT run_id, state, contract_json, attempt_count, created_at, worker_id, lease_expires_at
      FROM runs
      WHERE run_id = ? AND state = 'queued'
    `).get<RunRow>(run_id);

    if (!row) {
      return null;
    }

    return this.claimQueuedRow(row, worker_id, lease_ttl_seconds);
  }

  private claimQueuedRow(
    row: RunRow,
    worker_id: string,
    lease_ttl_seconds: number
  ): ClaimedRun | null {
    if (!row.contract_json) {
      throw new Error(`Queued run missing contract: ${row.run_id}`);
    }

    const lease_expires_at = new Date(Date.now() + lease_ttl_seconds * 1000).toISOString();
    const updated = this.db.prepare(`
      UPDATE runs
      SET state = 'running',
          worker_id = ?,
          lease_expires_at = ?,
          attempt_count = attempt_count + 1,
          updated_at = ?
      WHERE run_id = ? AND state = 'queued'
    `).run(worker_id, lease_expires_at, new Date().toISOString(), row.run_id);

    if (updated.changes !== 1) {
      return null;
    }

    this.appendRunLedgerEvent(row.run_id, "worker_lease_acquired", "core", {
      worker_id,
      lease_expires_at,
      attempt_count: row.attempt_count + 1
    });

    return { run_id: row.run_id, contract: JSON.parse(row.contract_json) as CompiledTaskContract };
  }

  heartbeat(run_id: string, worker_id: string, lease_ttl_seconds: number): boolean {
    const lease_expires_at = this.addSeconds(new Date().toISOString(), lease_ttl_seconds);
    const updated = this.db.prepare(`
      UPDATE runs
      SET lease_expires_at = ?, updated_at = ?
      WHERE run_id = ? AND worker_id = ? AND state = 'running'
    `).run(lease_expires_at, new Date().toISOString(), run_id, worker_id);

    return updated.changes === 1;
  }

  recoverExpiredLeases(now: string, max_attempts: number): LeaseRecovery[] {
    const rows = this.db.prepare(`
      SELECT run_id, state, contract_json, attempt_count, created_at, worker_id, lease_expires_at
      FROM runs
      WHERE state = 'running' AND lease_expires_at <= ?
      ORDER BY lease_expires_at ASC
    `).all<RunRow>(now);

    return rows.flatMap((row) => {
      const nextState: RunState = row.attempt_count < max_attempts ? "queued" : "failed";
      const action: LeaseRecovery["action"] = nextState === "queued" ? "requeued" : "failed";
      const updated = this.db.prepare(`
        UPDATE runs
        SET state = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE run_id = ? AND state = 'running'
      `).run(nextState, new Date().toISOString(), row.run_id);

      if (updated.changes === 1) {
        this.appendRunLedgerEvent(row.run_id, "worker_lease_expired", "system", {
          worker_id: row.worker_id ?? "",
          lease_expires_at: row.lease_expires_at ?? now,
          active_tool_call_id: null,
          recovery_action: action
        });
      }

      return updated.changes === 1 ? [{ run_id: row.run_id, action }] : [];
    });
  }

  beginTriggerProcessing(event: TypedTaskEvent): TriggerDedupeResult {
    const existing = this.getProcessedTrigger(event);
    if (existing) {
      if (existing.payload_hash !== event.payload_hash) {
        return { status: "conflict", error: "TRIGGER_IDEMPOTENCY_CONFLICT" };
      }

      return { status: "duplicate", result_json: existing.result_json };
    }

    return { status: "new" };
  }

  recordTriggerProcessed(event: TypedTaskEvent, result: unknown): void {
    const result_json = serializeProcessedTriggerResult(result);
    const recorded = this.db.prepare(`
      INSERT INTO processed_triggers (source, idempotency_key, payload_hash, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, idempotency_key) DO UPDATE SET result_json = excluded.result_json
      WHERE processed_triggers.payload_hash = excluded.payload_hash
    `).run(event.source, event.idempotency_key, event.payload_hash, result_json, event.created_at);
    if (recorded.changes !== 1) {
      throw new Error("TRIGGER_IDEMPOTENCY_CONFLICT");
    }
  }

  recordSkippedTelegramUpdate(input: {
    update_id: number;
    reason_code: string;
    reason_message: string;
    skipped_at: string;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO skipped_telegram_updates (
        update_id,
        reason_code,
        reason_message,
        skipped_at
      ) VALUES (?, ?, ?, ?)
    `).run(input.update_id, input.reason_code, input.reason_message, input.skipped_at);
  }

  createApprovalRequest(input: ApprovalRequestInput): ApprovalRequestRecord {
    const approval_id = `appr_${randomUUID()}`;
    const created_at = new Date().toISOString();
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const existing = this.findPendingApproval(input.run_id, input.action_fingerprint);
      if (existing) {
        this.db.exec("COMMIT");
        activeTransaction = false;
        return this.approvalRecordFromRow(existing);
      }

      if (this.getRunState(input.run_id) !== "running") {
        throw new Error("Run is not running");
      }

      this.db.prepare(`
        INSERT INTO approvals (
          approval_id,
          run_id,
          approval_type,
          state,
          capability,
          action_fingerprint,
          adapter_input_hash,
          adapter_input_json,
          action_summary,
          side_effect_level,
          risk_level,
          affected_resources_json,
          requester_json,
          expires_at,
          created_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        approval_id,
        input.run_id,
        input.approval_type,
        input.capability,
        input.action_fingerprint,
        input.adapter_input_hash,
        input.adapter_input_json,
        input.action_summary,
        input.side_effect_level,
        input.risk_level,
        JSON.stringify(input.affected_resources),
        JSON.stringify(input.requester),
        input.expires_at,
        created_at
      );

      this.appendRunLedgerEvent(input.run_id, "approval_requested", "capability_runner", {
        approval_id,
        action_fingerprint: input.action_fingerprint,
        action_summary: input.action_summary,
        side_effect_level: input.side_effect_level,
        expires_at: input.expires_at
      });

      this.assertNotificationQueued(this.enqueueNotification({
        target: this.getRunNotifyTarget(input.run_id),
        intent_type: "approval_prompt",
        idempotency_key: `approval:${approval_id}:prompt`,
        run_id: input.run_id,
        approval_id,
        correlation_id: input.run_id,
        payload: { text: input.action_summary, action_summary: input.action_summary }
      }));

      if (!this.transition(input.run_id, "running", "waiting_for_approval", "approval required")) {
        throw new Error("Run is not running");
      }

      this.db.exec("COMMIT");
      activeTransaction = false;

      return {
        ...input,
        approval_id,
        state: "pending"
      };
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  resolveApproval(input: {
    approval_id: string;
    decision: ApprovalDecision;
    requester: Identity;
    resolved_at: string;
  }): ApprovalResolutionResult {
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const result = this.resolveApprovalWithinTransaction(input);
      this.db.exec("COMMIT");
      activeTransaction = false;
      return result;
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  processApprovalTrigger(input: ApprovalTriggerInput): ApprovalResolutionResult {
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const dedupe = this.beginTriggerProcessingWithinTransaction(input.event);
      if (dedupe.status === "duplicate") {
        this.db.exec("COMMIT");
        activeTransaction = false;
        return JSON.parse(dedupe.result_json) as ApprovalResolutionResult;
      }
      if (dedupe.status === "conflict") {
        this.db.exec("COMMIT");
        activeTransaction = false;
        return {
          ok: false,
          error: {
            code: "TRIGGER_IDEMPOTENCY_CONFLICT",
            message: "Trigger idempotency key conflicts with a different payload"
          }
        };
      }

      const result = this.resolveApprovalWithinTransaction({
        approval_id: input.event.approval_id ?? "",
        decision: input.decision,
        requester: input.event.requested_by,
        resolved_at: input.resolved_at
      });

      if (result.ok) {
        const approval_id = input.event.approval_id ?? "";
        this.appendRunLedgerEvent(result.run_id, "approval_resolved", "gateway", {
          approval_id,
          decision: input.decision,
          requester: input.event.requested_by,
          resolved_at: input.resolved_at
        });
        this.assertNotificationQueued(this.enqueueNotification({
          target: input.event.notify,
          intent_type: "approval_resolved",
          idempotency_key: `approval:${approval_id}:resolved`,
          run_id: result.run_id,
          approval_id,
          correlation_id: input.event.idempotency_key,
          payload: { text: `Approval ${input.decision}`, decision: input.decision }
        }));
      }

      this.recordTriggerProcessedWithinTransaction(input.event, result);
      this.db.exec("COMMIT");
      activeTransaction = false;
      return result;
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  expirePendingApprovals(now: string): Array<{ approval_id: string; run_id: string }> {
    const rows = this.db.prepare(`
      SELECT *
      FROM approvals
      WHERE state = 'pending' AND expires_at <= ?
      ORDER BY expires_at ASC, approval_id ASC
    `).all<ApprovalRow>(now);
    const expired: Array<{ approval_id: string; run_id: string }> = [];
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      for (const row of rows) {
        const updated = this.db.prepare(`
          UPDATE approvals
          SET state = 'expired', resolved_at = ?
          WHERE approval_id = ? AND state = 'pending'
        `).run(now, row.approval_id);
        if (updated.changes !== 1) {
          continue;
        }

        const run = this.getRun(row.run_id);
        if (run?.state === "waiting_for_approval") {
          this.db.prepare(`
            UPDATE runs
            SET state = 'cancelled', state_reason = ?, updated_at = ?
            WHERE run_id = ? AND state = 'waiting_for_approval'
          `).run("approval expired", now, row.run_id);
          this.appendRunLedgerEvent(row.run_id, "run_cancelled", "system", {
            reason: "approval expired",
            requester: JSON.parse(row.requester_json) as Identity,
            report_ref: null
          });
        }

        this.appendRunLedgerEvent(row.run_id, "approval_resolved", "system", {
          approval_id: row.approval_id,
          decision: "expired",
          requester: JSON.parse(row.requester_json) as Identity,
          resolved_at: now
        });
        this.assertNotificationQueued(this.enqueueNotification({
          target: this.getRunNotifyTarget(row.run_id),
          intent_type: "approval_resolved",
          idempotency_key: `approval:${row.approval_id}:expired`,
          run_id: row.run_id,
          approval_id: row.approval_id,
          correlation_id: row.run_id,
          payload: { text: "Approval expired", decision: "expired" }
        }));
        expired.push({ approval_id: row.approval_id, run_id: row.run_id });
      }

      this.db.exec("COMMIT");
      activeTransaction = false;
      return expired;
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  enqueueNotification(intent: NotificationIntent): NotificationQueueResult {
    const target_key = this.notificationTargetKey(intent.target);
    const payload_hash = stableHash(intent.payload);
    const existing = this.db.prepare(`
      SELECT notification_id, payload_hash, run_id, approval_id, correlation_id
      FROM notification_outbox
      WHERE target_key = ? AND idempotency_key = ?
    `).get<{
      notification_id: string;
      payload_hash: string;
      run_id: string | null;
      approval_id: string | null;
      correlation_id: string;
    }>(target_key, intent.idempotency_key);

    if (existing) {
      const same = existing.payload_hash === payload_hash &&
        (existing.run_id ?? undefined) === intent.run_id &&
        (existing.approval_id ?? undefined) === intent.approval_id &&
        existing.correlation_id === intent.correlation_id;
      return same
        ? { status: "duplicate", record: this.getNotificationRecord(existing.notification_id) }
        : { status: "conflict", error: "NOTIFICATION_IDEMPOTENCY_CONFLICT" };
    }

    const notification_id = `notif_${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notification_outbox (
        notification_id,
        target_json,
        target_key,
        intent_type,
        idempotency_key,
        state,
        attempt_count,
        next_attempt_at,
        lease_owner,
        lease_expires_at,
        provider_message_id,
        run_id,
        approval_id,
        correlation_id,
        payload_json,
        payload_hash,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      notification_id,
      JSON.stringify(intent.target),
      target_key,
      intent.intent_type,
      intent.idempotency_key,
      now,
      intent.run_id ?? null,
      intent.approval_id ?? null,
      intent.correlation_id,
      JSON.stringify(intent.payload),
      payload_hash,
      now,
      now
    );

    if (intent.run_id) {
      this.appendRunLedgerEvent(intent.run_id, "notification_queued", "notification_outbox", {
        notification_id,
        target: intent.target,
        intent_type: intent.intent_type,
        idempotency_key: intent.idempotency_key
      });
    }

    return { status: "queued", record: this.getNotificationRecord(notification_id) };
  }

  getNotification(notification_id: string): NotificationRecord | undefined {
    const row = this.db.prepare(`
      SELECT notification_id
      FROM notification_outbox
      WHERE notification_id = ?
    `).get<{ notification_id: string }>(notification_id);
    return row ? this.getNotificationRecord(row.notification_id) : undefined;
  }

  countNotificationsByIdempotencyKey(idempotency_key: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM notification_outbox
      WHERE idempotency_key = ?
    `).get<{ count: number }>(idempotency_key);
    return row?.count ?? 0;
  }

  claimNextNotification(lease_owner: string, lease_ttl_seconds: number): NotificationRecord | null {
    const now = new Date().toISOString();
    const lease_expires_at = this.addSeconds(now, lease_ttl_seconds);
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const updated = this.db.prepare(`
        UPDATE notification_outbox
        SET state = 'sending',
            lease_owner = ?,
            lease_expires_at = ?,
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE notification_id = (
          SELECT notification_id
          FROM notification_outbox
          WHERE state = 'queued' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT 1
        )
      `).run(lease_owner, lease_expires_at, now, now);

      if (updated.changes !== 1) {
        this.db.exec("COMMIT");
        activeTransaction = false;
        return null;
      }

      const claimed = this.db.prepare(`
        SELECT notification_id
        FROM notification_outbox
        WHERE lease_owner = ? AND state = 'sending'
        ORDER BY updated_at DESC, notification_id DESC
        LIMIT 1
      `).get<{ notification_id: string }>(lease_owner);

      this.db.exec("COMMIT");
      activeTransaction = false;
      return claimed ? this.getNotificationRecord(claimed.notification_id) : null;
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  markNotificationDelivered(notification_id: string, provider_message_id: string): void {
    const now = new Date().toISOString();
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const record = this.getNotificationRecord(notification_id);
      const updated = this.db.prepare(`
        UPDATE notification_outbox
        SET state = 'delivered',
            provider_message_id = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE notification_id = ? AND state = 'sending'
      `).run(provider_message_id, now, notification_id);
      if (updated.changes !== 1) {
        throw new Error(`Notification not in sending state: ${notification_id}`);
      }

      this.appendNotificationLedgerEvent(record, "notification_delivered", {
        notification_id,
        target: record.target,
        adapter: record.target.kind,
        delivered_at: now,
        provider_message_id,
        run_id: record.run_id,
        approval_id: record.approval_id,
        correlation_id: record.correlation_id
      });

      this.db.exec("COMMIT");
      activeTransaction = false;
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  markNotificationFailed(
    notification_id: string,
    error_ref: string,
    retryable: boolean,
    now: string,
    max_attempts: number
  ): void {
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const record = this.getNotificationRecord(notification_id);
      const willRetry = retryable && record.attempt_count < max_attempts;
      const nextState = willRetry ? "retry_wait" : "failed_terminal";
      const next_attempt_at = willRetry ? now : record.next_attempt_at;

      const updated = this.db.prepare(`
        UPDATE notification_outbox
        SET state = ?,
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE notification_id = ? AND state = 'sending'
      `).run(nextState, next_attempt_at, now, notification_id);
      if (updated.changes !== 1) {
        throw new Error(`Notification not in sending state: ${notification_id}`);
      }

      this.appendNotificationLedgerEvent(record, "notification_failed", {
        notification_id,
        target: record.target,
        adapter: record.target.kind,
        error_ref,
        retryable: willRetry,
        run_id: record.run_id,
        approval_id: record.approval_id,
        correlation_id: record.correlation_id
      });

      this.db.exec("COMMIT");
      activeTransaction = false;
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  requeueRetryWaitNotifications(now: string): string[] {
    const rows = this.db.prepare(`
      SELECT notification_id
      FROM notification_outbox
      WHERE state = 'retry_wait' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC, created_at ASC
    `).all<{ notification_id: string }>(now);

    const requeued: string[] = [];
    for (const row of rows) {
      const updated = this.db.prepare(`
        UPDATE notification_outbox
        SET state = 'queued',
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE notification_id = ? AND state = 'retry_wait'
      `).run(now, now, row.notification_id);
      if (updated.changes === 1) {
        requeued.push(row.notification_id);
      }
    }

    return requeued;
  }

  recoverStaleSendingNotifications(now: string): string[] {
    const rows = this.db.prepare(`
      SELECT notification_id
      FROM notification_outbox
      WHERE state = 'sending'
        AND lease_expires_at IS NOT NULL
        AND (lease_expires_at <= ? OR lease_expires_at <= updated_at)
      ORDER BY lease_expires_at ASC, created_at ASC
    `).all<{ notification_id: string }>(now);

    const recovered: string[] = [];
    for (const row of rows) {
      const updated = this.db.prepare(`
        UPDATE notification_outbox
        SET state = 'queued',
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE notification_id = ? AND state = 'sending'
      `).run(now, now, row.notification_id);
      if (updated.changes === 1) {
        recovered.push(row.notification_id);
      }
    }

    return recovered;
  }

  consumeApprovedApproval(input: {
    approval_id: string;
    run_id: string;
    requester: Identity;
    capability: string;
    adapter_input_hash: string;
    action_fingerprint: string;
    tool_call_id: string;
    operation_id: string;
  }): ApprovalConsumptionResult {
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const row = this.getApprovalRow(input.approval_id);
      if (!row) {
        const result = approvalFailure("APPROVAL_NOT_FOUND");
        this.db.exec("COMMIT");
        activeTransaction = false;
        return result;
      }
      if (row.state !== "approved") {
        const result = approvalFailure("APPROVAL_NOT_APPROVED");
        this.db.exec("COMMIT");
        activeTransaction = false;
        return result;
      }
      if (!sameIdentity(JSON.parse(row.requester_json) as Identity, input.requester)) {
        const result = approvalFailure("APPROVAL_REQUESTER_MISMATCH");
        this.db.exec("COMMIT");
        activeTransaction = false;
        return result;
      }
      if (row.run_id !== input.run_id) {
        const result = approvalFailure("APPROVAL_RUN_MISMATCH");
        this.db.exec("COMMIT");
        activeTransaction = false;
        return result;
      }
      if (this.getRunState(row.run_id) !== "running") {
        const result = approvalFailure("RUN_NOT_RUNNING");
        this.db.exec("COMMIT");
        activeTransaction = false;
        return result;
      }
      if (row.capability !== input.capability) {
        const result = approvalFailure("APPROVAL_CAPABILITY_MISMATCH");
        this.db.exec("COMMIT");
        activeTransaction = false;
        return result;
      }
      if (row.adapter_input_hash !== input.adapter_input_hash) {
        const result = approvalFailure("APPROVAL_INPUT_MISMATCH");
        this.db.exec("COMMIT");
        activeTransaction = false;
        return result;
      }
      if (row.action_fingerprint !== input.action_fingerprint) {
        const result = approvalFailure("APPROVAL_ACTION_MISMATCH");
        this.db.exec("COMMIT");
        activeTransaction = false;
        return result;
      }

      this.db.prepare(`
        UPDATE approvals
        SET state = 'consumed',
            consumed_tool_call_id = ?,
            consumed_operation_id = ?
        WHERE approval_id = ? AND state = 'approved'
      `).run(input.tool_call_id, input.operation_id, input.approval_id);

      this.db.exec("COMMIT");
      activeTransaction = false;
      return {
        ok: true,
        approval_id: row.approval_id,
        state: "consumed"
      };
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  getApprovalForRun(run_id: string, state: ApprovalState): ApprovalRequestRecord | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM approvals
      WHERE run_id = ? AND state = ?
      ORDER BY created_at DESC, approval_id DESC
    `).get<ApprovalRow>(run_id, state);
    return row ? this.approvalRecordFromRow(row) : undefined;
  }

  getRunRequester(run_id: string): Identity {
    const row = this.db.prepare(`
      SELECT requested_by_json
      FROM runs
      WHERE run_id = ?
    `).get<{ requested_by_json: string }>(run_id);
    if (!row) {
      throw new Error(`Run not found: ${run_id}`);
    }

    return JSON.parse(row.requested_by_json) as Identity;
  }

  getRunMetadata(run_id: string): Record<string, unknown> {
    const row = this.db.prepare(`
      SELECT event_json
      FROM runs
      WHERE run_id = ?
    `).get<{ event_json: string }>(run_id);
    if (!row) {
      throw new Error(`Run not found: ${run_id}`);
    }

    const event = JSON.parse(row.event_json) as TypedTaskEvent;
    return event.metadata ?? {};
  }

  getApprovedActionForRun(run_id: string): {
    approval_id: string;
    capability: string;
    adapter_input_json: string;
    adapter_input_hash: string;
    action_fingerprint: string;
    requester: Identity;
  } | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM approvals
      WHERE run_id = ? AND state = 'approved'
      ORDER BY created_at DESC, approval_id DESC
    `).get<ApprovalRow>(run_id);
    if (!row) {
      return undefined;
    }

    return {
      approval_id: row.approval_id,
      capability: row.capability,
      adapter_input_json: row.adapter_input_json,
      adapter_input_hash: row.adapter_input_hash,
      action_fingerprint: row.action_fingerprint,
      requester: JSON.parse(row.requester_json) as Identity
    };
  }

  private getCreateOrGetExisting(event: TypedTaskEvent): CreateOrGetResult | null {
    const existing = this.db.prepare(`
      SELECT run_id, payload_hash
      FROM runs
      WHERE source = ? AND idempotency_key = ?
    `).get<{ run_id: string; payload_hash: string }>(event.source, event.idempotency_key);

    if (existing) {
      if (existing.payload_hash !== event.payload_hash) {
        this.appendRunLedgerEvent(existing.run_id, "idempotency_conflict", "gateway", {
          source: event.source,
          idempotency_key: event.idempotency_key,
          existing_run_id: existing.run_id,
          stored_payload_hash: existing.payload_hash,
          incoming_payload_hash: event.payload_hash,
          resolution: "rejected"
        });

        return {
          status: "conflict",
          error: "IDEMPOTENCY_CONFLICT",
          existing_run_id: existing.run_id
        };
      }

      return { status: "duplicate", run_id: existing.run_id };
    }

    return null;
  }

  private insertRun(event: TypedTaskEvent): CreateOrGetResult {
    const run_id = `run_${randomUUID()}`;
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      try {
        this.insertRunRow(run_id, event);
      } catch (error) {
        const race = isUniqueConstraintError(error) ? this.getCreateOrGetExisting(event) : null;
        if (race) {
          this.db.exec("COMMIT");
          activeTransaction = false;
          return race;
        }

        throw error;
      }

      this.appendRunLedgerEvent(run_id, "run_created", "gateway", {
        source: event.source,
        idempotency_key: event.idempotency_key,
        program: event.program ?? "",
        goal_hash: event.payload_hash,
        requester: event.requested_by
      });

      this.db.exec("COMMIT");
      activeTransaction = false;
      return { status: "created", run_id };
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private insertRunRow(run_id: string, event: TypedTaskEvent): void {
    this.db.prepare(`
      INSERT INTO runs (
        run_id,
        source,
        type,
        program,
        goal,
        requested_by_json,
        notify_json,
        idempotency_key,
        source_reference,
        payload_hash,
        event_json,
        state,
        attempt_count,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      run_id,
      event.source,
      event.type,
      event.program ?? null,
      event.goal ?? null,
      JSON.stringify(event.requested_by),
      JSON.stringify(event.notify),
      event.idempotency_key,
      event.source_reference,
      event.payload_hash,
      JSON.stringify(event),
      "created",
      event.created_at,
      event.created_at
    );
  }

  private getRun(run_id: string): RunRow | undefined {
    return this.db.prepare(`
      SELECT run_id, payload_hash, state, contract_json, attempt_count, created_at, worker_id, lease_expires_at
      FROM runs
      WHERE run_id = ?
    `).get<RunRow>(run_id);
  }

  private getRunProgram(run_id: string): string | null {
    const row = this.db.prepare(`
      SELECT program
      FROM runs
      WHERE run_id = ?
    `).get<{ program: string | null }>(run_id);

    return row?.program ?? null;
  }

  private getRunNotifyTarget(run_id: string): NotificationIntent["target"] {
    const row = this.db.prepare(`
      SELECT notify_json
      FROM runs
      WHERE run_id = ?
    `).get<{ notify_json: string }>(run_id);
    if (!row) {
      throw new Error(`Run not found: ${run_id}`);
    }

    return JSON.parse(row.notify_json) as NotificationIntent["target"];
  }

  private findPendingApproval(run_id: string, action_fingerprint: string): ApprovalRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM approvals
      WHERE run_id = ? AND action_fingerprint = ? AND state = 'pending'
    `).get<ApprovalRow>(run_id, action_fingerprint);
  }

  private getApprovalRow(approval_id: string): ApprovalRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM approvals
      WHERE approval_id = ?
    `).get<ApprovalRow>(approval_id);
  }

  private approvalRecordFromRow(row: ApprovalRow): ApprovalRequestRecord {
    return {
      approval_id: row.approval_id,
      run_id: row.run_id,
      approval_type: row.approval_type,
      state: row.state,
      capability: row.capability,
      action_fingerprint: row.action_fingerprint,
      adapter_input_hash: row.adapter_input_hash,
      adapter_input_json: row.adapter_input_json,
      action_summary: row.action_summary,
      side_effect_level: row.side_effect_level,
      risk_level: row.risk_level,
      affected_resources: JSON.parse(row.affected_resources_json) as string[],
      requester: JSON.parse(row.requester_json) as Identity,
      expires_at: row.expires_at
    };
  }

  private resolveApprovalWithinTransaction(input: {
    approval_id: string;
    decision: ApprovalDecision;
    requester: Identity;
    resolved_at: string;
  }): ApprovalResolutionResult {
    const row = this.getApprovalRow(input.approval_id);
    if (!row) return approvalFailure("APPROVAL_NOT_FOUND");
    if (!sameIdentity(JSON.parse(row.requester_json) as Identity, input.requester)) {
      return approvalFailure("APPROVAL_REQUESTER_MISMATCH");
    }
    if (row.state === "pending" && row.expires_at <= input.resolved_at) {
      return approvalFailure("APPROVAL_EXPIRED");
    }
    if (row.state !== "pending") return approvalFailure("APPROVAL_NOT_PENDING");
    if (!row.action_fingerprint) return approvalFailure("APPROVAL_ACTION_MISSING");
    if (this.getRunState(row.run_id) !== "waiting_for_approval") {
      return approvalFailure("RUN_NOT_WAITING_FOR_APPROVAL");
    }

    const nextRunState: RunState = input.decision === "approved" ? "queued" : "cancelled";
    this.db.prepare(`
      UPDATE approvals
      SET state = ?, resolved_at = ?
      WHERE approval_id = ? AND state = 'pending'
    `).run(input.decision, input.resolved_at, input.approval_id);
    this.db.prepare(`
      UPDATE runs
      SET state = ?, state_reason = ?, updated_at = ?, worker_id = NULL, lease_expires_at = NULL
      WHERE run_id = ? AND state = 'waiting_for_approval'
    `).run(nextRunState, `approval ${input.decision}`, input.resolved_at, row.run_id);

    return {
      ok: true,
      run_id: row.run_id,
      status: "approval_resolved"
    };
  }

  private assertNotificationQueued(result: NotificationQueueResult): void {
    if (result.status === "conflict") {
      throw new Error(result.error);
    }
  }

  private getNotificationRecord(notification_id: string): NotificationRecord {
    const row = this.db.prepare(`
      SELECT *
      FROM notification_outbox
      WHERE notification_id = ?
    `).get<{
      notification_id: string;
      target_json: string;
      target_key: string;
      intent_type: NotificationIntent["intent_type"];
      idempotency_key: string;
      state: string;
      attempt_count: number;
      next_attempt_at: string;
      lease_owner: string | null;
      lease_expires_at: string | null;
      provider_message_id: string | null;
      run_id: string | null;
      approval_id: string | null;
      correlation_id: string;
      payload_json: string;
      payload_hash: string;
      created_at: string;
      updated_at: string;
    }>(notification_id);
    if (!row) {
      throw new Error(`Notification not found: ${notification_id}`);
    }

    return {
      notification_id: row.notification_id,
      target: JSON.parse(row.target_json) as NotificationIntent["target"],
      target_key: row.target_key,
      intent_type: row.intent_type,
      idempotency_key: row.idempotency_key,
      state: row.state,
      attempt_count: row.attempt_count,
      next_attempt_at: row.next_attempt_at,
      lease_owner: row.lease_owner,
      lease_expires_at: row.lease_expires_at,
      provider_message_id: row.provider_message_id,
      run_id: row.run_id,
      approval_id: row.approval_id,
      correlation_id: row.correlation_id,
      payload: JSON.parse(row.payload_json) as NotificationIntent["payload"],
      payload_hash: row.payload_hash,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private getProcessedTrigger(event: TypedTaskEvent): {
    payload_hash: string;
    result_json: string;
  } | undefined {
    return this.db.prepare(`
      SELECT payload_hash, result_json
      FROM processed_triggers
      WHERE source = ? AND idempotency_key = ?
    `).get<{ payload_hash: string; result_json: string }>(
      event.source,
      event.idempotency_key
    );
  }

  private beginTriggerProcessingWithinTransaction(event: TypedTaskEvent): TriggerDedupeResult {
    const existing = this.getProcessedTrigger(event);
    if (existing) {
      if (existing.payload_hash !== event.payload_hash) {
        return { status: "conflict", error: "TRIGGER_IDEMPOTENCY_CONFLICT" };
      }

      return { status: "duplicate", result_json: existing.result_json };
    }

    return { status: "new" };
  }

  private recordTriggerProcessedWithinTransaction(event: TypedTaskEvent, result: unknown): void {
    const result_json = serializeProcessedTriggerResult(result);
    const recorded = this.db.prepare(`
      INSERT INTO processed_triggers (source, idempotency_key, payload_hash, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, idempotency_key) DO UPDATE SET result_json = excluded.result_json
      WHERE processed_triggers.payload_hash = excluded.payload_hash
    `).run(event.source, event.idempotency_key, event.payload_hash, result_json, event.created_at);
    if (recorded.changes !== 1) {
      throw new Error("TRIGGER_IDEMPOTENCY_CONFLICT");
    }
  }

  private notificationTargetKey(target: NotificationIntent["target"]): string {
    return target.kind === "local" ? "local" : `telegram:${target.chat_id}`;
  }

  private appendNotificationLedgerEvent(
    record: NotificationRecord,
    event_type: LedgerEventType,
    payload: Record<string, unknown>
  ): void {
    const event: Parameters<typeof createLedgerEvent>[0] = {
      correlation_id: record.correlation_id,
      event_type,
      actor: "notification_outbox",
      sequence: this.nextLedgerSequence(record.run_id ?? undefined),
      payload
    };
    if (record.run_id) {
      event.run_id = record.run_id;
    }
    this.appendLedgerEvent(createLedgerEvent(event));
  }

  private appendRunLedgerEvent(
    run_id: string,
    event_type: LedgerEventType,
    actor: LedgerActor,
    payload: Record<string, unknown>
  ): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        run_id,
        correlation_id: run_id,
        event_type,
        actor,
        sequence: this.nextLedgerSequence(run_id),
        payload
      })
    );
  }

  private nextLedgerSequence(run_id?: string): number {
    const row = run_id
      ? this.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM ledger_events
        WHERE run_id = ?
      `).get<{ sequence: number }>(run_id)
      : this.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM ledger_events
      `).get<{ sequence: number }>();

    return row?.sequence ?? 1;
  }

  private addSeconds(base: string, seconds: number): string {
    return new Date(new Date(base).getTime() + seconds * 1000).toISOString();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        program TEXT,
        goal TEXT,
        requested_by_json TEXT NOT NULL,
        notify_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        source_reference TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        event_json TEXT NOT NULL,
        contract_json TEXT,
        state TEXT NOT NULL,
        state_reason TEXT,
        worker_id TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, idempotency_key)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT,
        correlation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    this.applyMilestone2Migration();
    this.validateMilestone2Schema();
  }

  private applyMilestone2Migration(): void {
    const version = "2026-05-28-milestone-2-telegram-approvals";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `);

      const applied = this.db.prepare(`
        SELECT version
        FROM schema_migrations
        WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS processed_triggers (
          source TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(source, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS approvals (
          approval_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          approval_type TEXT NOT NULL,
          state TEXT NOT NULL,
          capability TEXT NOT NULL,
          action_fingerprint TEXT NOT NULL,
          adapter_input_hash TEXT NOT NULL,
          adapter_input_json TEXT NOT NULL,
          action_summary TEXT NOT NULL,
          side_effect_level TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          affected_resources_json TEXT NOT NULL,
          requester_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_tool_call_id TEXT,
          consumed_operation_id TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_action
          ON approvals(run_id, action_fingerprint)
          WHERE state = 'pending';

        CREATE INDEX IF NOT EXISTS ledger_events_run_sequence_idx
          ON ledger_events(run_id, sequence);

        CREATE INDEX IF NOT EXISTS runs_created_at_idx
          ON runs(created_at);

        CREATE INDEX IF NOT EXISTS runs_updated_at_idx
          ON runs(updated_at);

        CREATE INDEX IF NOT EXISTS approvals_run_state_idx
          ON approvals(run_id, state);

        CREATE TABLE IF NOT EXISTS notification_outbox (
          notification_id TEXT PRIMARY KEY,
          target_json TEXT NOT NULL,
          target_key TEXT NOT NULL,
          intent_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          state TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TEXT,
          provider_message_id TEXT,
          run_id TEXT,
          approval_id TEXT,
          correlation_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(target_key, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS notification_outbox_claim_idx
          ON notification_outbox(state, next_attempt_at, created_at);

        CREATE TABLE IF NOT EXISTS trigger_offsets (
          source TEXT PRIMARY KEY,
          offset INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS skipped_telegram_updates (
          update_id INTEGER PRIMARY KEY,
          reason_code TEXT NOT NULL,
          reason_message TEXT NOT NULL,
          skipped_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS telegram_command_audit (
          audit_id TEXT PRIMARY KEY,
          actor_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          command TEXT NOT NULL,
          source_reference TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason_code TEXT,
          occurred_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS telegram_command_audit_actor_chat_time_idx
          ON telegram_command_audit(actor_id, chat_id, occurred_at);

        CREATE INDEX IF NOT EXISTS telegram_command_audit_decision_time_idx
          ON telegram_command_audit(decision, occurred_at);
      `);

      this.repairMilestone2SchemaDrift();

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at)
          VALUES (?, ?)
        `).run(version, new Date().toISOString());
      }

      this.db.exec("COMMIT");
      activeTransaction = false;
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private validateMilestone2Schema(): void {
    const required = [
      "schema_migrations",
      "processed_triggers",
      "approvals",
      "approvals_one_pending_action",
      "ledger_events_run_sequence_idx",
      "runs_created_at_idx",
      "runs_updated_at_idx",
      "approvals_run_state_idx",
      "notification_outbox",
      "notification_outbox_claim_idx",
      "trigger_offsets",
      "skipped_telegram_updates",
      "telegram_command_audit",
      "telegram_command_audit_actor_chat_time_idx",
      "telegram_command_audit_decision_time_idx"
    ];
    const rows = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'index')
    `).all<{ name: string }>();
    const names = new Set(rows.map((row) => row.name));
    const missing = required.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`Milestone 2 migration missing objects: ${missing.join(", ")}`);
    }
    this.validateMilestone2Columns();
  }

  private repairMilestone2SchemaDrift(): void {
    const processed = this.tableColumns("processed_triggers");
    if (processed.get("result_json")?.notnull !== 1) {
      this.rebuildProcessedTriggers();
    }

    const outboxColumns = this.tableColumns("notification_outbox");
    const expectedOutboxColumns = [
      "notification_id",
      "target_json",
      "target_key",
      "intent_type",
      "idempotency_key",
      "state",
      "attempt_count",
      "next_attempt_at",
      "lease_owner",
      "lease_expires_at",
      "provider_message_id",
      "run_id",
      "approval_id",
      "correlation_id",
      "payload_json",
      "payload_hash",
      "created_at",
      "updated_at"
    ];
    const missing = expectedOutboxColumns.some((column) => !outboxColumns.has(column));
    if (missing || this.indexColumns("notification_outbox_claim_idx").join(",") !== "state,next_attempt_at,created_at") {
      this.rebuildNotificationOutbox(outboxColumns);
    }
  }

  private rebuildProcessedTriggers(): void {
    this.db.exec(`
      ALTER TABLE processed_triggers RENAME TO processed_triggers_old;
      CREATE TABLE processed_triggers (
        source TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(source, idempotency_key)
      );
      INSERT INTO processed_triggers (source, idempotency_key, payload_hash, result_json, created_at)
      SELECT source, idempotency_key, payload_hash, result_json, created_at
      FROM processed_triggers_old
      WHERE result_json IS NOT NULL;
      DROP TABLE processed_triggers_old;
    `);
  }

  private rebuildNotificationOutbox(columns: Map<string, { notnull: number }>): void {
    const value = (name: string, fallback: string): string => columns.has(name) ? name : fallback;
    const state = columns.has("state")
      ? "CASE state WHEN 'pending' THEN 'queued' ELSE state END"
      : "'queued'";
    this.db.exec(`
      DROP INDEX IF EXISTS notification_outbox_claim_idx;
      ALTER TABLE notification_outbox RENAME TO notification_outbox_old;
      CREATE TABLE notification_outbox (
        notification_id TEXT PRIMARY KEY,
        target_json TEXT NOT NULL,
        target_key TEXT NOT NULL,
        intent_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        provider_message_id TEXT,
        run_id TEXT,
        approval_id TEXT,
        correlation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(target_key, idempotency_key)
      );
      INSERT INTO notification_outbox (
        notification_id, target_json, target_key, intent_type, idempotency_key,
        state, attempt_count, next_attempt_at, lease_owner, lease_expires_at,
        provider_message_id, run_id, approval_id, correlation_id, payload_json,
        payload_hash, created_at, updated_at
      )
      SELECT
        ${value("notification_id", "'notif_migrated_' || hex(randomblob(16))")},
        ${value("target_json", "'{\"kind\":\"local\"}'")},
        ${value("target_key", "'local'")},
        ${value("intent_type", "'progress'")},
        ${value("idempotency_key", "'migrated:' || hex(randomblob(16))")},
        ${state},
        ${value("attempt_count", "0")},
        ${value("next_attempt_at", value("created_at", "datetime('now')"))},
        ${value("lease_owner", value("claimed_by", "NULL"))},
        ${value("lease_expires_at", value("claim_expires_at", "NULL"))},
        ${value("provider_message_id", "NULL")},
        ${value("run_id", "NULL")},
        ${value("approval_id", "NULL")},
        ${value("correlation_id", value("run_id", "'migration'"))},
        ${value("payload_json", "'{\"text\":\"migrated notification\"}'")},
        ${value("payload_hash", "'migration'")},
        ${value("created_at", "datetime('now')")},
        ${value("updated_at", value("created_at", "datetime('now')"))}
      FROM notification_outbox_old;
      DROP TABLE notification_outbox_old;
      CREATE INDEX notification_outbox_claim_idx
        ON notification_outbox(state, next_attempt_at, created_at);
    `);
  }

  private validateMilestone2Columns(): void {
    this.requireColumns("processed_triggers", [
      ["source", true],
      ["idempotency_key", true],
      ["payload_hash", true],
      ["result_json", true],
      ["created_at", true]
    ]);
    this.requireColumns("approvals", [
      ["approval_id", false],
      ["run_id", true],
      ["approval_type", true],
      ["state", true],
      ["capability", true],
      ["action_fingerprint", true],
      ["adapter_input_hash", true],
      ["adapter_input_json", true],
      ["action_summary", true],
      ["side_effect_level", true],
      ["risk_level", true],
      ["affected_resources_json", true],
      ["requester_json", true],
      ["expires_at", true],
      ["consumed_tool_call_id", false],
      ["consumed_operation_id", false],
      ["created_at", true],
      ["resolved_at", false]
    ]);
    this.requireColumns("notification_outbox", [
      ["notification_id", false],
      ["target_json", true],
      ["target_key", true],
      ["intent_type", true],
      ["idempotency_key", true],
      ["state", true],
      ["attempt_count", true],
      ["next_attempt_at", true],
      ["lease_owner", false],
      ["lease_expires_at", false],
      ["provider_message_id", false],
      ["run_id", false],
      ["approval_id", false],
      ["correlation_id", true],
      ["payload_json", true],
      ["payload_hash", true],
      ["created_at", true],
      ["updated_at", true]
    ]);
    this.requireColumns("trigger_offsets", [
      ["source", false],
      ["offset", true],
      ["updated_at", true]
    ]);
    this.requireColumns("skipped_telegram_updates", [
      ["update_id", false],
      ["reason_code", true],
      ["reason_message", true],
      ["skipped_at", true]
    ]);
    this.requireColumns("telegram_command_audit", [
      ["audit_id", false],
      ["actor_id", true],
      ["chat_id", true],
      ["command", true],
      ["source_reference", true],
      ["decision", true],
      ["reason_code", false],
      ["occurred_at", true]
    ]);

    const outboxIndex = this.indexColumns("notification_outbox_claim_idx").join(",");
    if (outboxIndex !== "state,next_attempt_at,created_at") {
      throw new Error("Milestone 2 migration invalid notification_outbox_claim_idx");
    }
  }

  private requireColumns(table: string, expected: Array<[string, boolean]>): void {
    const columns = this.tableColumns(table);
    for (const [name, notnull] of expected) {
      const column = columns.get(name);
      if (!column) {
        throw new Error(`Milestone 2 migration invalid ${table}.${name}`);
      }
      if (notnull && column.notnull !== 1) {
        throw new Error(`Milestone 2 migration invalid ${table}.${name}`);
      }
    }
  }

  private tableColumns(table: string): Map<string, { notnull: number }> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string; notnull: number }>();
    return new Map(rows.map((row) => [row.name, { notnull: row.notnull }]));
  }

  private indexColumns(index: string): string[] {
    return this.db.prepare(`PRAGMA index_info(${index})`)
      .all<{ name: string }>()
      .map((row) => row.name);
  }
}

function isTerminalRunState(state: RunState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "expired";
}

function shouldClearLeaseOnTransition(expected: RunState, next: RunState): boolean {
  return (
    isTerminalRunState(next) ||
    (expected === "running" &&
      (next === "waiting_for_approval" || next === "reconciliation_required"))
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return error.message.includes("UNIQUE constraint failed");
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function serializeProcessedTriggerResult(result: unknown): string {
  const result_json = JSON.stringify(result);
  if (result_json === undefined) {
    throw new Error("Processed trigger result must serialize to JSON");
  }

  return result_json;
}

function approvalFailure(code: ApprovalErrorCode): ApprovalFailure {
  const messages: Record<ApprovalErrorCode, string> = {
    APPROVAL_NOT_FOUND: "Approval not found",
    APPROVAL_NOT_PENDING: "Approval is not pending",
    APPROVAL_NOT_APPROVED: "Approval is not approved",
    APPROVAL_REQUESTER_MISMATCH: "Approval requester does not match",
    APPROVAL_EXPIRED: "Approval has expired",
    APPROVAL_ACTION_MISSING: "Approval action fingerprint is missing",
    APPROVAL_ACTION_MISMATCH: "Approval action fingerprint does not match",
    APPROVAL_CAPABILITY_MISMATCH: "Approval capability does not match",
    APPROVAL_INPUT_MISMATCH: "Approval adapter input hash does not match",
    APPROVAL_RUN_MISMATCH: "Approval run does not match",
    RUN_NOT_WAITING_FOR_APPROVAL: "Run is not waiting for approval",
    RUN_NOT_RUNNING: "Run is not running",
    TRIGGER_IDEMPOTENCY_CONFLICT: "Trigger idempotency key conflicts with a different payload"
  };

  return { ok: false, error: { code, message: messages[code] } };
}
