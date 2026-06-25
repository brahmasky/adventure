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
import {
  computeBreaches,
  computeHeadroom,
  GLOBAL_BUDGET_WINDOW_HOURS,
  type GlobalBudgetBreach,
  type GlobalBudgetCaps,
  type GlobalBudgetHeadroom,
  type GlobalBudgetKind
} from "../budget/global-budget-ledger.js";
import type { NotificationButton, NotificationIntent } from "../notifications/notification-types.js";
import {
  appendLedgerEvent,
  createLedgerEvent,
  readLedgerEvents,
  type LedgerActor,
  type LedgerEvent,
  type LedgerEventType
} from "./run-ledger.js";
import { canTransitionRun } from "./state-machines.js";
import type { LlmUsage } from "./llm-usage.js";

/** The LLM-call roles recorded by {@link RunStore.recordLlmCall} (spec §"Real telemetry"). */
export type LlmCallRole = "writer" | "reviewer" | "classify" | "frame" | "answer";

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

export type TelegramRateLimitReason = "command_window" | "active_runs" | "pending_approvals";

export type TelegramRateLimitResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: "TELEGRAM_RATE_LIMITED"; message: string; reason: TelegramRateLimitReason };
    };

export interface TelegramRateLimitInput {
  actor_id: string;
  chat_id: string;
  command: string;
  now: string;
}

export interface TelegramCommandAuditInput {
  actor_id: string;
  chat_id: string;
  command: string;
  source_reference: string;
  decision: "accepted" | "denied";
  reason_code?: string;
  occurred_at: string;
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

export type ChatTurnRole = "user" | "assistant";

export interface ChatTurnRow {
  turn_id: string;
  chat_id: string;
  run_id: string;
  role: ChatTurnRole;
  text: string;
  intent: string | null;
  created_at: string;
}

export interface LessonBlockRow {
  scope: string;
  block: string;
  char_cap: number;
  updated_at: string;
}

export interface PollHeartbeat {
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  updated_at: string | null;
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

  /**
   * Append one turn to a chat's short-term thread (ADR 0010). Store-all; reads take
   * the last N (see getRecentChatTurns). `intent` is the classifier's verdict for an
   * assistant reply (null for user turns).
   */
  recordChatTurn(input: {
    chat_id: string;
    run_id: string;
    role: ChatTurnRole;
    text: string;
    intent?: string;
    created_at?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO chat_turns (turn_id, chat_id, run_id, role, text, intent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `turn_${randomUUID()}`,
      input.chat_id,
      input.run_id,
      input.role,
      input.text,
      input.intent ?? null,
      input.created_at ?? new Date().toISOString()
    );
  }

  /**
   * The last `limit` turns for a chat, returned in chronological order (oldest →
   * newest) so they read as a transcript when folded into a prompt. An optional
   * `sinceIso` bounds the window to a recent session (turns at/after that time),
   * so a follow-up after a long gap starts a fresh thread.
   */
  getRecentChatTurns(chat_id: string, limit: number, sinceIso?: string): ChatTurnRow[] {
    const rows = sinceIso
      ? this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at
          FROM chat_turns
          WHERE chat_id = ? AND created_at >= ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, sinceIso, limit)
      : this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at
          FROM chat_turns
          WHERE chat_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, limit);
    return rows.reverse();
  }

  /**
   * The raw lesson block for a scope, or undefined if absent/empty (ADR 0010). The
   * composer reads this to fold a scope's durable preferences into a system prompt.
   */
  readLessonBlock(scope: string): string | undefined {
    const row = this.db.prepare(`
      SELECT block FROM lesson_blocks WHERE scope = ?
    `).get<{ block: string }>(scope);
    const text = row?.block?.trim();
    return text && text.length > 0 ? text : undefined;
  }

  /** All lesson blocks (for `/lessons` with no scope), newest-updated first. */
  listLessonBlocks(): LessonBlockRow[] {
    return this.db.prepare(`
      SELECT scope, block, char_cap, updated_at
      FROM lesson_blocks
      ORDER BY updated_at DESC, scope ASC
    `).all<LessonBlockRow>();
  }

  /**
   * Append `- <lesson>` to the scope's block (upsert). If the resulting block
   * exceeds char_cap, the injected async `rewrite` consolidates it (dedupe into the
   * strongest rules); a hard truncate to char_cap is the backstop if rewrite still
   * overruns or throws. Silent — the distill caller decides whether to notify.
   */
  async appendLessonToBlock(
    scope: string,
    lesson: string,
    now: string,
    rewrite?: (text: string) => Promise<string>
  ): Promise<void> {
    const trimmed = lesson.trim();
    if (trimmed.length === 0) return;

    const existing = this.db.prepare(`
      SELECT block, char_cap FROM lesson_blocks WHERE scope = ?
    `).get<{ block: string; char_cap: number }>(scope);
    const charCap = existing?.char_cap ?? DEFAULT_LESSON_CHAR_CAP;
    const prior = existing?.block?.trim() ?? "";
    let block = prior.length > 0 ? `${prior}\n- ${trimmed}` : `- ${trimmed}`;

    if (block.length > charCap && rewrite) {
      try {
        const rewritten = (await rewrite(block)).trim();
        if (rewritten.length > 0) block = rewritten;
      } catch {
        // Keep the appended block; the truncate backstop below bounds it.
      }
    }
    if (block.length > charCap) {
      block = block.slice(0, charCap);
    }

    this.db.prepare(`
      INSERT INTO lesson_blocks (scope, block, char_cap, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET block = excluded.block, updated_at = excluded.updated_at
    `).run(scope, block, charCap, now);
  }

  /** Clear a scope's lesson block (the `/forget` control command). */
  forgetScope(scope: string): void {
    this.db.prepare(`DELETE FROM lesson_blocks WHERE scope = ?`).run(scope);
  }

  /**
   * Correlate a delivered notification's provider_message_id (e.g. `telegram:<id>`)
   * back to its originating run_id — the feedback path uses the reply-hint to find
   * the prior answer's run and thus its chat turn + scope.
   */
  getRunIdByProviderMessageId(provider_message_id: string): string | undefined {
    const row = this.db.prepare(`
      SELECT run_id
      FROM notification_outbox
      WHERE provider_message_id = ? AND run_id IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<{ run_id: string | null }>(provider_message_id);
    return row?.run_id ?? undefined;
  }

  /**
   * The assistant chat turn produced by a given run (the feedback reply-hint path
   * correlates a replied-to message → its run → that run's answer + intent → scope).
   */
  getAssistantChatTurnForRun(run_id: string): ChatTurnRow | undefined {
    return this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at
      FROM chat_turns
      WHERE run_id = ? AND role = 'assistant'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get<ChatTurnRow>(run_id);
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

  /**
   * Phase 3 self-write audit (spec § Notification, surfacing + tracking). Three outcomes, each a
   * structured run-store event (audit trail + future dashboard source); the Telegram notification
   * rides the turn's async reply, not these events.
   */
  recordSelfWritePublished(
    run_id: string,
    payload: {
      branch: string;
      summary: string;
      verdict: Record<string, unknown>;
      gate_results: Record<string, unknown>;
      /** Phase 3.1 (W3): compact per-role token usage stamp (counts/metadata ONLY — no bodies). Optional. */
      usage_summary?: Record<string, unknown>;
    }
  ): void {
    this.appendRunLedgerEvent(run_id, "self_write_published", "core", payload);
  }

  recordSelfWriteBlocked(
    run_id: string,
    payload: { attempted_paths: Array<Record<string, unknown>>; context: string }
  ): void {
    this.appendRunLedgerEvent(run_id, "self_write_blocked", "core", payload);
  }

  recordSelfWriteFailed(run_id: string, payload: { reason: string; last_output: string }): void {
    this.appendRunLedgerEvent(run_id, "self_write_failed", "core", payload);
  }

  /**
   * Phase 3.1 real LLM telemetry (spec §"Real telemetry", backlog #3). Emits one `llm_call`
   * ledger event with token usage captured at the source — the structured replacement for
   * hand-grepping logs (and the future per-role dashboard's data source).
   *
   * NON-NEGOTIABLE: records ONLY counts/metadata. The prompt, diff, and response bodies are
   * NEVER passed here and NEVER stored — only `provider`, `model`, `role`, token counts, an
   * optional cost, and an optional latency.
   */
  recordLlmCall(
    run_id: string,
    info: { provider: string; model: string; role: LlmCallRole; usage: LlmUsage; latency_ms?: number }
  ): void {
    const payload: Record<string, unknown> = {
      provider: info.provider,
      model: info.model,
      role: info.role,
      input_tokens: info.usage.input_tokens,
      output_tokens: info.usage.output_tokens,
      cached_input_tokens: info.usage.cached_input_tokens
    };
    if (info.usage.cost_usd !== undefined) payload.cost_usd = info.usage.cost_usd;
    if (info.latency_ms !== undefined) payload.latency_ms = info.latency_ms;
    this.appendRunLedgerEvent(run_id, "llm_call", "capability_runner", payload);
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

  checkTelegramRateLimit(input: TelegramRateLimitInput): TelegramRateLimitResult {
    const windowStart = this.addSeconds(input.now, -TELEGRAM_COMMAND_WINDOW_SECONDS);
    const windowRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM telegram_command_audit
      WHERE actor_id = ?
        AND chat_id = ?
        AND decision = 'accepted'
        AND occurred_at > ?
    `).get<{ count: number }>(input.actor_id, input.chat_id, windowStart);
    if ((windowRow?.count ?? 0) >= TELEGRAM_MAX_COMMANDS_PER_WINDOW) {
      return telegramRateLimited("command_window");
    }

    const activeRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM runs
      WHERE state IN ('queued', 'running', 'waiting_for_approval')
        AND type = 'run'
        AND json_extract(requested_by_json, '$.id') = ?
    `).get<{ count: number }>(input.actor_id);
    if ((activeRow?.count ?? 0) >= TELEGRAM_MAX_ACTIVE_RUNS) {
      return telegramRateLimited("active_runs");
    }

    const pendingRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM approvals
      WHERE state = 'pending'
        AND json_extract(requester_json, '$.id') = ?
    `).get<{ count: number }>(input.actor_id);
    if ((pendingRow?.count ?? 0) >= TELEGRAM_MAX_PENDING_APPROVALS) {
      return telegramRateLimited("pending_approvals");
    }

    return { ok: true };
  }

  recordTelegramCommandAudit(input: TelegramCommandAuditInput): void {
    this.db.prepare(`
      INSERT INTO telegram_command_audit (
        audit_id,
        actor_id,
        chat_id,
        command,
        source_reference,
        decision,
        reason_code,
        occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `tca_${randomUUID()}`,
      input.actor_id,
      input.chat_id,
      input.command,
      input.source_reference,
      input.decision,
      input.reason_code ?? null,
      input.occurred_at
    );
  }

  // --- Global (cross-run) autonomy budget ---------------------------------

  private globalBudgetUsageCounts(now: string): Record<GlobalBudgetKind, number> {
    const windowStart = this.addSeconds(now, -GLOBAL_BUDGET_WINDOW_HOURS * 3600);

    const runs = this.db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS count
      FROM global_budget_events
      WHERE kind = 'run' AND occurred_at > ?
    `).get<{ count: number }>(windowStart);

    // tool_calls and gated_attempts are DERIVED from the authoritative ledger,
    // so they need no separate recording path.
    const toolCalls = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM ledger_events
      WHERE event_type = 'tool_finished' AND occurred_at > ?
    `).get<{ count: number }>(windowStart);

    const gated = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM ledger_events
      WHERE event_type = 'approval_requested' AND occurred_at > ?
    `).get<{ count: number }>(windowStart);

    return {
      runs: runs?.count ?? 0,
      tool_calls: toolCalls?.count ?? 0,
      gated_attempts: gated?.count ?? 0
    };
  }

  /** Is admitting a new run within every global cap right now? */
  checkGlobalBudget(
    caps: GlobalBudgetCaps,
    now: string
  ): { ok: true } | { ok: false; breaches: GlobalBudgetBreach[] } {
    const breaches = computeBreaches(this.globalBudgetUsageCounts(now), caps);
    return breaches.length === 0 ? { ok: true } : { ok: false, breaches };
  }

  /** Per-cap headroom for the `/status` overview. */
  globalBudgetUsage(caps: GlobalBudgetCaps, now: string): GlobalBudgetHeadroom[] {
    return computeHeadroom(this.globalBudgetUsageCounts(now), caps);
  }

  /** Record one admitted run against the rolling-window run counter. */
  recordGlobalBudgetRun(input: { now: string; run_id?: string; correlation_id?: string }): void {
    this.db.prepare(`
      INSERT INTO global_budget_events (event_id, kind, quantity, occurred_at, run_id, correlation_id)
      VALUES (?, 'run', 1, ?, ?, ?)
    `).run(
      `gbe_${randomUUID()}`,
      input.now,
      input.run_id ?? null,
      input.correlation_id ?? null
    );
  }

  /** Append an unscoped `global_budget_fuse` ledger event (audit for every refusal). */
  recordGlobalBudgetFuse(input: {
    breaches: GlobalBudgetBreach[];
    correlation_id: string;
    now: string;
  }): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: input.correlation_id,
        event_type: "global_budget_fuse",
        actor: "gateway",
        sequence: this.nextLedgerSequence(),
        payload: {
          reason: "global_budget_fuse",
          breaches: input.breaches,
          window_hours: GLOBAL_BUDGET_WINDOW_HOURS
        }
      })
    );
  }

  /**
   * Single-row latch so exactly ONE alert fires per fuse episode. Returns
   * `armed: true` only on the 0→1 transition (the first breach of the episode);
   * subsequent breaches return `armed: false`.
   */
  armGlobalFuseIfNeeded(now: string): { armed: boolean; since: string } {
    const row = this.db.prepare(`
      SELECT fused, since FROM global_budget_fuse_state WHERE id = 1
    `).get<{ fused: number; since: string | null }>();

    if (row && row.fused === 1 && row.since) {
      return { armed: false, since: row.since };
    }

    this.db.prepare(`
      UPDATE global_budget_fuse_state SET fused = 1, since = ? WHERE id = 1
    `).run(now);
    return { armed: true, since: now };
  }

  /** Re-arm the breaker once admissions are back under cap. */
  disarmGlobalFuse(): void {
    this.db.prepare(`
      UPDATE global_budget_fuse_state SET fused = 0, since = NULL WHERE id = 1 AND fused = 1
    `).run();
  }

  /** Run counts grouped by state within the rolling window (for `/status`). */
  runCountsByStateSince(now: string): Record<string, number> {
    const windowStart = this.addSeconds(now, -GLOBAL_BUDGET_WINDOW_HOURS * 3600);
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS count
      FROM runs
      WHERE created_at > ?
      GROUP BY state
    `).all<{ state: string; count: number }>(windowStart);
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.state] = row.count;
    return counts;
  }

  /** Most recent failed run's reason, or null (for `/status`). */
  lastRunError(): string | null {
    const row = this.db.prepare(`
      SELECT state_reason
      FROM runs
      WHERE state = 'failed'
      ORDER BY updated_at DESC, run_id DESC
      LIMIT 1
    `).get<{ state_reason: string | null }>();
    return row?.state_reason ?? null;
  }

  // --- Daemon poll heartbeat ----------------------------------------------

  /**
   * Record one daemon poll cycle. On success advances `last_success_at`; on
   * failure records `last_error` + `last_error_at`. The single row lets an
   * unattended operator confirm via /status that the daemon is alive.
   */
  recordPollHeartbeat(input: { now: string; ok: boolean; error?: string }): void {
    if (input.ok) {
      this.db.prepare(`
        UPDATE daemon_heartbeat SET last_success_at = ?, updated_at = ? WHERE id = 1
      `).run(input.now, input.now);
    } else {
      this.db.prepare(`
        UPDATE daemon_heartbeat
        SET last_error = ?, last_error_at = ?, updated_at = ?
        WHERE id = 1
      `).run(input.error ?? "unknown error", input.now, input.now);
    }
  }

  /** The daemon heartbeat, or null if the daemon has never recorded a cycle. */
  getPollHeartbeat(): PollHeartbeat | null {
    const row = this.db.prepare(`
      SELECT last_success_at, last_error, last_error_at, updated_at
      FROM daemon_heartbeat WHERE id = 1
    `).get<PollHeartbeat>();
    if (!row || row.updated_at === null) return null;
    return row;
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
        payload: {
          text: buildApprovalPromptText(approval_id, input),
          action_summary: input.action_summary
        }
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

  getOffset(source: string): number {
    const row = this.db.prepare(`
      SELECT offset
      FROM trigger_offsets
      WHERE source = ?
    `).get<{ offset: number }>(source);
    return row?.offset ?? 0;
  }

  setOffset(source: string, offset: number): void {
    this.db.prepare(`
      INSERT INTO trigger_offsets (source, offset, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at
    `).run(source, offset, new Date().toISOString());
  }

  /**
   * Enqueue the terminal `final_report` notification for a completed run,
   * delivered to the run's original notify target. Idempotent on
   * `${run_id}:final_report`.
   */
  enqueueFinalReportNotification(
    run_id: string,
    input: { text: string; report_path: string; buttons?: NotificationButton[] }
  ): NotificationQueueResult {
    return this.enqueueNotification({
      target: this.getRunNotifyTarget(run_id),
      intent_type: "final_report",
      idempotency_key: `${run_id}:final_report`,
      run_id,
      correlation_id: run_id,
      payload: {
        // The user-facing message IS the answer/report body (no server path).
        // Bounded to a Telegram-safe length; report_path stays for audit only.
        text: truncateForChat(input.text),
        report_path: input.report_path,
        // Phase 3.3: inline buttons (the self-write merge controls) ride only when supplied;
        // every other final report omits them and stays byte-identical to before.
        ...(input.buttons ? { buttons: input.buttons } : {})
      }
    });
  }

  /**
   * Mark expired approval-prompt notifications (queued/retry_wait/sending) as
   * `failed_terminal`, then expire the linked pending approvals so the waiting
   * runs also resolve. Used by the poll runner before dispatch.
   */
  expireUndeliveredApprovalPrompts(now: string): void {
    const rows = this.db.prepare(`
      SELECT notification_id
      FROM notification_outbox
      WHERE intent_type = 'approval_prompt'
        AND state IN ('queued', 'retry_wait', 'sending')
        AND approval_id IN (
          SELECT approval_id FROM approvals WHERE state = 'pending' AND expires_at <= ?
        )
    `).all<{ notification_id: string }>(now);

    for (const row of rows) {
      this.db.prepare(`
        UPDATE notification_outbox
        SET state = 'failed_terminal',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE notification_id = ?
      `).run(now, row.notification_id);
    }

    this.expirePendingApprovals(now);
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

  getRunNotifyTarget(run_id: string): NotificationIntent["target"] {
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
    this.applyGuardrailsMigration();
    this.applyDaemonMigration();
    this.applyChatTurnsMigration();
    this.applyLessonBlocksMigration();
  }

  /**
   * Long-term procedural lessons (ADR 0010): one char-capped, edit-in-place block
   * per scope. Distinct from chat_turns (short-term) — these are durable preferences
   * the composer folds into future runs. Consolidated by an LLM rewrite at the cap.
   */
  private applyLessonBlocksMigration(): void {
    const version = "2026-06-19-lesson-blocks";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lesson_blocks (
          scope TEXT PRIMARY KEY,
          block TEXT NOT NULL DEFAULT '',
          char_cap INTEGER NOT NULL DEFAULT 1200,
          updated_at TEXT NOT NULL
        );
      `);

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
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

  /**
   * Short-term per-chat conversation memory (ADR 0010): a rolling thread of user
   * and assistant turns so a `turn` run can interpret a follow-up in context. This
   * is distinct from long-term lessons — bounded, store-all/read-last-N.
   */
  private applyChatTurnsMigration(): void {
    const version = "2026-06-19-chat-turns";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chat_turns (
          turn_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          intent TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS chat_turns_chat_time_idx
          ON chat_turns(chat_id, created_at);
      `);

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
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

  private applyDaemonMigration(): void {
    const version = "2026-06-18-daemon-heartbeat";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS daemon_heartbeat (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_success_at TEXT,
          last_error TEXT,
          last_error_at TEXT,
          updated_at TEXT
        );

        INSERT OR IGNORE INTO daemon_heartbeat (id) VALUES (1);
      `);

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
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

  private applyGuardrailsMigration(): void {
    const version = "2026-06-18-autonomy-guardrails";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS global_budget_events (
          event_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          quantity INTEGER NOT NULL,
          occurred_at TEXT NOT NULL,
          run_id TEXT,
          correlation_id TEXT
        );

        CREATE INDEX IF NOT EXISTS global_budget_events_kind_time_idx
          ON global_budget_events(kind, occurred_at);

        CREATE TABLE IF NOT EXISTS global_budget_fuse_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          fused INTEGER NOT NULL DEFAULT 0,
          since TEXT
        );

        INSERT OR IGNORE INTO global_budget_fuse_state (id, fused, since)
          VALUES (1, 0, NULL);
      `);

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
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

const DEFAULT_LESSON_CHAR_CAP = 1200;
const TELEGRAM_COMMAND_WINDOW_SECONDS = 60;
const TELEGRAM_MAX_COMMANDS_PER_WINDOW = 5;
const TELEGRAM_MAX_ACTIVE_RUNS = 3;
const TELEGRAM_MAX_PENDING_APPROVALS = 5;

// Telegram caps a message at 4096 chars; leave headroom for the truncation note.
const CHAT_TEXT_MAX = 3900;

function truncateForChat(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= CHAT_TEXT_MAX) return trimmed;
  return `${trimmed.slice(0, CHAT_TEXT_MAX)}\n\n… (truncated)`;
}

function buildApprovalPromptText(approval_id: string, input: ApprovalRequestInput): string {
  return [
    `Approval required: ${approval_id}`,
    `Action: ${input.action_summary}`,
    `Side effect: ${input.side_effect_level}`,
    `Risk: ${input.risk_level}`,
    `Affected resources: ${input.affected_resources.join(", ")}`,
    `Action fingerprint: ${input.action_fingerprint}`,
    `Adapter input hash: ${input.adapter_input_hash}`,
    `Requester: ${input.requester.kind}:${input.requester.id}`,
    `Expires: ${input.expires_at}`,
    "Expected run state: waiting_for_approval",
    "Consequence if approved: the exact fingerprinted action may execute once after policy revalidation.",
    "Consequence if denied or expired: the run is cancelled and reports the blocked action.",
    `Reply /approve ${approval_id} to continue or /deny ${approval_id} to stop.`
  ].join("\n");
}

function telegramRateLimited(reason: TelegramRateLimitReason): TelegramRateLimitResult {
  return {
    ok: false,
    error: {
      code: "TELEGRAM_RATE_LIMITED",
      message: "Telegram command rate limit exceeded",
      reason
    }
  };
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
