import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  CompiledTaskContract,
  RunState,
  TypedTaskEvent
} from "../domain/types.js";
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
