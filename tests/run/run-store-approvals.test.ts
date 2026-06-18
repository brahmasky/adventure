import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent, type Identity } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

const paco: Identity = { kind: "user", id: "paco" };
const mallory: Identity = { kind: "user", id: "mallory" };

type TestSqliteStatement = {
  get: <Row>(...values: unknown[]) => Row | undefined;
  all: <Row>(...values: unknown[]) => Row[];
  run: (...values: unknown[]) => { changes: number };
};

type TestSqliteDatabase = {
  prepare: (sql: string) => TestSqliteStatement;
};

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};

function createRunningRun(store: RunStore, idempotency_key: string): string {
  const result = new Gateway(store).intake(buildTypedTaskEvent({
    source: "cli",
    type: "run",
    program: "research-brief",
    goal: "needs approval",
    requested_by: paco,
    notify: { kind: "local" },
    idempotency_key,
    source_reference: "argv"
  }));
  if (!result.ok) throw new Error("expected run");
  store.claimRun(result.run_id, "worker-approval", 30);
  return result.run_id;
}

function requestApproval(store: RunStore, run_id: string, overrides = {}) {
  return store.createApprovalRequest({
    run_id,
    approval_type: "capability",
    capability: "local_project_write",
    action_fingerprint: "fp_write_report_artifact",
    adapter_input_hash: "input_hash_write_report_artifact",
    adapter_input_json: JSON.stringify({ path: "runs/run_1/artifact.txt", content: "hello" }),
    action_summary: "Write runs/run_1/artifact.txt",
    side_effect_level: "local_write",
    risk_level: "medium",
    affected_resources: ["path:runs/run_1/artifact.txt"],
    requester: paco,
    expires_at: "2026-12-31T01:00:00.000Z",
    ...overrides
  });
}

function approveEvent(approval_id: string, overrides = {}) {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "approve",
    approval_id,
    requested_by: paco,
    notify: { kind: "local" },
    idempotency_key: `telegram:${approval_id}:approve`,
    source_reference: "telegram:update:1:message:1",
    created_at: "2026-05-28T00:00:00.000Z",
    ...overrides
  });
}

function consumeApproval(store: RunStore, approval_id: string, run_id: string, overrides = {}) {
  return store.consumeApprovedApproval({
    approval_id,
    run_id,
    requester: paco,
    capability: "local_project_write",
    adapter_input_hash: "input_hash_write_report_artifact",
    action_fingerprint: "fp_write_report_artifact",
    tool_call_id: "tool_1",
    operation_id: "op_1",
    ...overrides
  });
}

function db(store: RunStore): TestSqliteDatabase {
  return (store as unknown as { db: TestSqliteDatabase }).db;
}

function approvalState(store: RunStore, approval_id: string): string {
  const row = db(store).prepare("SELECT state FROM approvals WHERE approval_id = ?")
    .get<{ state: string }>(approval_id);
  if (!row) throw new Error("approval row missing");
  return row.state;
}

function expectTablesAndIndexes(store: RunStore): void {
  const names = db(store).prepare(`
    SELECT name FROM sqlite_master
    WHERE type IN ('table', 'index')
  `).all<{ name: string }>().map((row) => row.name);

  expect(names).toEqual(expect.arrayContaining([
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
  ]));

  const processedColumns = db(store).prepare("PRAGMA table_info(processed_triggers)")
    .all<{ name: string; notnull: number }>();
  expect(processedColumns.find((column) => column.name === "result_json")?.notnull).toBe(1);

  const notificationColumns = db(store).prepare("PRAGMA table_info(notification_outbox)")
    .all<{ name: string }>().map((column) => column.name);
  expect(notificationColumns).toEqual(expect.arrayContaining([
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
  ]));

  const outboxClaimIndex = db(store).prepare("PRAGMA index_info(notification_outbox_claim_idx)")
    .all<{ name: string }>().map((column) => column.name);
  expect(outboxClaimIndex).toEqual(["state", "next_attempt_at", "created_at"]);
}

describe("RunStore approval storage", () => {
  let store: RunStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("creates one pending approval per run/action fingerprint and parks the run without a lease", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:create");

    const first = requestApproval(store, run_id);
    const duplicate = requestApproval(store, run_id);

    expect(first).toMatchObject({
      run_id,
      state: "pending",
      action_fingerprint: "fp_write_report_artifact"
    });
    expect(duplicate.approval_id).toBe(first.approval_id);
    expect(store.getRunState(run_id)).toBe("waiting_for_approval");
    expect(store.getRunLease(run_id)).toEqual({ worker_id: null, lease_expires_at: null });
  });

  it("refuses to create approvals unless the run can park from running", () => {
    const localStore = RunStore.openInMemory();
    store = localStore;
    const result = new Gateway(localStore).intake(buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program: "research-brief",
      goal: "approval must park",
      requested_by: paco,
      notify: { kind: "local" },
      idempotency_key: "approval:not-running",
      source_reference: "argv"
    }));
    if (!result.ok) throw new Error("expected run");

    expect(() => requestApproval(localStore, result.run_id)).toThrow("Run is not running");
    expect(db(localStore).prepare("SELECT COUNT(*) AS count FROM approvals")
      .get<{ count: number }>()?.count).toBe(0);
    expect(db(localStore).prepare("SELECT COUNT(*) AS count FROM notification_outbox")
      .get<{ count: number }>()?.count).toBe(0);
  });

  it("rejects approval resolution from the wrong requester", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:wrong-requester");
    const approval = requestApproval(store, run_id);

    expect(store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: mallory,
      resolved_at: "2026-05-28T00:00:00.000Z"
    })).toEqual({
      ok: false,
      error: { code: "APPROVAL_REQUESTER_MISMATCH", message: "Approval requester does not match" }
    });
  });

  it("rejects expired pending approvals", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:expired");
    const approval = requestApproval(store, run_id, { expires_at: "2026-01-01T00:00:00.000Z" });

    expect(store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:00.000Z"
    })).toEqual({
      ok: false,
      error: { code: "APPROVAL_EXPIRED", message: "Approval has expired" }
    });
  });

  it("rejects missing stored action fingerprints", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:missing-action");
    const approval = requestApproval(store, run_id, { action_fingerprint: "" });

    expect(store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:00.000Z"
    })).toEqual({
      ok: false,
      error: { code: "APPROVAL_ACTION_MISSING", message: "Approval action fingerprint is missing" }
    });
  });

  it("rejects approval when the run is no longer waiting for approval", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:not-waiting");
    const approval = requestApproval(store, run_id);
    store.transition(run_id, "waiting_for_approval", "queued", "manual resume");
    store.claimRun(run_id, "worker-approval", 30);

    expect(store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:00.000Z"
    })).toEqual({
      ok: false,
      error: { code: "RUN_NOT_WAITING_FOR_APPROVAL", message: "Run is not waiting for approval" }
    });
  });

  it("approves and denies pending approvals", () => {
    store = RunStore.openInMemory();
    const approvedRun = createRunningRun(store, "approval:approve");
    const deniedRun = createRunningRun(store, "approval:deny");
    const approval = requestApproval(store, approvedRun);
    const denial = requestApproval(store, deniedRun, { action_fingerprint: "fp_deny" });

    expect(store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:00.000Z"
    })).toEqual({ ok: true, run_id: approvedRun, status: "approval_resolved" });
    expect(store.getRunState(approvedRun)).toBe("queued");

    expect(store.resolveApproval({
      approval_id: denial.approval_id,
      decision: "denied",
      requester: paco,
      resolved_at: "2026-05-28T00:00:01.000Z"
    })).toEqual({ ok: true, run_id: deniedRun, status: "approval_resolved" });
    expect(store.getRunState(deniedRun)).toBe("cancelled");
  });

  it("rejects replay and non-pending approvals", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:replay");
    const approval = requestApproval(store, run_id);
    store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:00.000Z"
    });

    expect(store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:01.000Z"
    })).toEqual({
      ok: false,
      error: { code: "APPROVAL_NOT_PENDING", message: "Approval is not pending" }
    });
  });

  it("processes approval triggers with dedupe and conflict handling", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:trigger");
    const approval = requestApproval(store, run_id);
    const event = approveEvent(approval.approval_id);

    const processed = store.processApprovalTrigger({
      event,
      decision: "approved",
      resolved_at: "2026-05-28T00:00:00.000Z"
    });
    const replay = store.processApprovalTrigger({
      event,
      decision: "approved",
      resolved_at: "2026-05-28T00:00:00.000Z"
    });
    const conflict = store.processApprovalTrigger({
      event: approveEvent(approval.approval_id, { payload: { drift: true } }),
      decision: "approved",
      resolved_at: "2026-05-28T00:00:00.000Z"
    });

    expect(processed).toEqual({ ok: true, run_id, status: "approval_resolved" });
    expect(replay).toEqual(processed);
    expect(conflict).toEqual({
      ok: false,
      error: { code: "TRIGGER_IDEMPOTENCY_CONFLICT", message: "Trigger idempotency key conflicts with a different payload" }
    });
  });

  it("consumes approved approvals once and binds tool call evidence", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:consume");
    const approval = requestApproval(store, run_id);
    store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:00.000Z"
    });
    store.claimRun(run_id, "worker-approval", 30);

    expect(consumeApproval(store, approval.approval_id, run_id)).toEqual({
      ok: true,
      approval_id: approval.approval_id,
      state: "consumed"
    });
    expect(approvalState(store, approval.approval_id)).toBe("consumed");
    expect(consumeApproval(store, approval.approval_id, run_id)).toEqual({
      ok: false,
      error: { code: "APPROVAL_NOT_APPROVED", message: "Approval is not approved" }
    });
  });

  it("rejects consume drift for wrong run, requester, capability, adapter input hash, action fingerprint, and run state", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:consume-drift");
    const other_run_id = createRunningRun(store, "approval:consume-drift-other");
    const cases = [
      {
        overrides: { run_id: other_run_id },
        error: { code: "APPROVAL_RUN_MISMATCH", message: "Approval run does not match" }
      },
      {
        overrides: { requester: mallory },
        error: { code: "APPROVAL_REQUESTER_MISMATCH", message: "Approval requester does not match" }
      },
      {
        overrides: { capability: "network_write" },
        error: { code: "APPROVAL_CAPABILITY_MISMATCH", message: "Approval capability does not match" }
      },
      {
        overrides: { adapter_input_hash: "wrong_hash" },
        error: { code: "APPROVAL_INPUT_MISMATCH", message: "Approval adapter input hash does not match" }
      },
      {
        overrides: { action_fingerprint: "wrong_fp" },
        error: { code: "APPROVAL_ACTION_MISMATCH", message: "Approval action fingerprint does not match" }
      }
    ];

    for (const [index, testCase] of cases.entries()) {
      const approval = requestApproval(store, run_id, { action_fingerprint: `fp_consume_${index}` });
      store.resolveApproval({
        approval_id: approval.approval_id,
        decision: "approved",
        requester: paco,
        resolved_at: "2026-05-28T00:00:00.000Z"
      });
      store.claimRun(run_id, "worker-approval", 30);

      expect(consumeApproval(store, approval.approval_id, run_id, testCase.overrides)).toEqual({
        ok: false,
        error: testCase.error
      });
      store.transition(run_id, "running", "waiting_for_approval", "next approval");
      store.transition(run_id, "waiting_for_approval", "queued", "continue approval checks");
      store.claimRun(run_id, "worker-approval", 30);
    }

    const approval = requestApproval(store, run_id, { action_fingerprint: "fp_consume_state" });
    store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:00.000Z"
    });

    expect(consumeApproval(store, approval.approval_id, run_id)).toEqual({
      ok: false,
      error: { code: "RUN_NOT_RUNNING", message: "Run is not running" }
    });
  });

  it("expires pending approvals, cancels waiting runs, and rejects late approval", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:expire-pending");
    const approval = requestApproval(store, run_id, { expires_at: "2026-05-28T00:00:00.000Z" });

    expect(store.expirePendingApprovals("2026-05-28T00:00:01.000Z")).toEqual([
      { approval_id: approval.approval_id, run_id }
    ]);
    expect(store.getRunState(run_id)).toBe("cancelled");
    expect(store.resolveApproval({
      approval_id: approval.approval_id,
      decision: "approved",
      requester: paco,
      resolved_at: "2026-05-28T00:00:02.000Z"
    })).toEqual({
      ok: false,
      error: { code: "APPROVAL_NOT_PENDING", message: "Approval is not pending" }
    });
  });

  it("dedupes processed triggers and records skipped telegram updates once", () => {
    const localStore = RunStore.openInMemory();
    store = localStore;
    const event = approveEvent("appr_trigger_dedupe");

    expect(localStore.beginTriggerProcessing(event)).toEqual({ status: "new" });
    expect(db(localStore).prepare("SELECT COUNT(*) AS count FROM processed_triggers")
      .get<{ count: number }>()?.count).toBe(0);
    localStore.recordTriggerProcessed(event, { ok: true });
    expect(localStore.beginTriggerProcessing(event)).toEqual({
      status: "duplicate",
      result_json: JSON.stringify({ ok: true })
    });
    expect(localStore.beginTriggerProcessing(approveEvent("appr_trigger_dedupe", { payload: { drift: true } })))
      .toEqual({ status: "conflict", error: "TRIGGER_IDEMPOTENCY_CONFLICT" });
    expect(() => localStore.recordTriggerProcessed(event, undefined))
      .toThrow("Processed trigger result must serialize to JSON");
    expect(() => localStore.recordTriggerProcessed(approveEvent("appr_trigger_dedupe", { payload: { drift: true } }), { ok: false }))
      .toThrow("TRIGGER_IDEMPOTENCY_CONFLICT");

    localStore.recordSkippedTelegramUpdate({
      update_id: 123,
      reason_code: "unauthorized",
      reason_message: "not allowlisted",
      skipped_at: "2026-05-28T00:00:00.000Z"
    });
    localStore.recordSkippedTelegramUpdate({
      update_id: 123,
      reason_code: "changed",
      reason_message: "ignored duplicate",
      skipped_at: "2026-05-28T00:00:01.000Z"
    });

    expect(db(localStore).prepare("SELECT reason_code FROM skipped_telegram_updates WHERE update_id = 123")
      .get<{ reason_code: string }>()).toEqual({ reason_code: "unauthorized" });
  });

  it("returns notification records and rejects idempotency conflicts", () => {
    store = RunStore.openInMemory();
    const run_id = createRunningRun(store, "approval:notification-record");
    const intent = {
      target: { kind: "local" } as const,
      intent_type: "progress" as const,
      idempotency_key: `${run_id}:progress:test`,
      run_id,
      correlation_id: run_id,
      payload: { text: "queued" }
    };

    const queued = store.enqueueNotification(intent);
    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") throw new Error("expected queued notification");
    expect(queued.record).toMatchObject({
      notification_id: expect.stringMatching(/^notif_/),
      run_id,
      state: "queued",
      attempt_count: 0,
      target: { kind: "local" },
      payload: { text: "queued" }
    });

    expect(store.enqueueNotification(intent)).toEqual({
      status: "duplicate",
      record: queued.record
    });
    expect(store.enqueueNotification({ ...intent, payload: { text: "changed" } })).toEqual({
      status: "conflict",
      error: "NOTIFICATION_IDEMPOTENCY_CONFLICT"
    });
  });

  it("migrates a Milestone-1 database without losing existing rows and skips repeat migration", () => {
    const dir = join(tmpdir(), `houge-run-store-${process.pid}-${Date.now()}`);
    const path = join(dir, "runs.sqlite");
    mkdirSync(dir, { recursive: true });
    const sqlite = new DatabaseSync(path);
    sqlite.exec(`
      CREATE TABLE runs (
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
      );
      CREATE TABLE ledger_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT,
        correlation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      INSERT INTO runs (
        run_id, source, type, program, goal, requested_by_json, notify_json,
        idempotency_key, source_reference, payload_hash, event_json, state,
        attempt_count, created_at, updated_at
      ) VALUES (
        'run_m1', 'cli', 'run', 'research-brief', 'legacy',
        '{"kind":"user","id":"paco"}', '{"kind":"local"}', 'legacy:key',
        'argv', 'hash', '{}', 'completed', 1,
        '2026-05-25T00:00:00.000Z', '2026-05-25T00:00:00.000Z'
      );
      INSERT INTO ledger_events (
        event_id, run_id, correlation_id, event_type, occurred_at, actor, sequence, payload_json
      ) VALUES (
        'evt_m1', 'run_m1', 'run_m1', 'run_completed',
        '2026-05-25T00:00:01.000Z', 'core', 1,
        '{"report_ref":"runs/run_m1/report.md","budget_used":{"tool_calls":1},"duration_ms":1}'
      );
    `);
    sqlite.close();

    try {
      store = RunStore.open(path);
      expect(store.getRunStatus("run_m1")?.state).toBe("completed");
      expect(store.getLedgerEvents("run_m1")).toHaveLength(1);
      expectTablesAndIndexes(store);
      expect(db(store).prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get<{ count: number }>()?.count).toBe(3);
      store.close();

      store = RunStore.open(path);
      expect(db(store).prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get<{ count: number }>()?.count).toBe(3);
      expect(store.getRunStatus("run_m1")?.state).toBe("completed");
    } finally {
      store?.close();
      store = undefined;
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when an existing milestone-2 table is missing required columns", () => {
    const dir = join(tmpdir(), `houge-run-store-drift-${process.pid}-${Date.now()}`);
    const path = join(dir, "runs.sqlite");
    mkdirSync(dir, { recursive: true });
    const sqlite = new DatabaseSync(path);
    sqlite.exec(`
      CREATE TABLE runs (
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
      );
      CREATE TABLE ledger_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT,
        correlation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at)
      VALUES ('2026-05-28-milestone-2-telegram-approvals', '2026-05-28T00:00:00.000Z');
      CREATE TABLE processed_triggers (
        source TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY(source, idempotency_key)
      );
    `);
    sqlite.close();

    try {
      expect(() => RunStore.open(path)).toThrow("Milestone 2 migration invalid processed_triggers");
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
