import { randomUUID } from "node:crypto";

export type LedgerActor =
  | "gateway"
  | "core"
  | "capability_runner"
  | "trigger_adapter"
  | "notification_outbox"
  | "system";

export type LedgerEventType =
  | "trigger_received"
  | "idempotency_conflict"
  | "schedule_fired"
  | "schedule_skipped_duplicate"
  | "run_created"
  | "contract_attached"
  | "worker_lease_acquired"
  | "worker_lease_released"
  | "worker_lease_expired"
  | "context_selected"
  | "budget_zone_changed"
  | "capability_requested"
  | "policy_decision"
  | "tool_started"
  | "tool_finished"
  | "approval_requested"
  | "approval_resolved"
  | "notification_queued"
  | "notification_delivered"
  | "notification_failed"
  | "report_written"
  | "lesson_proposed"
  | "reconciliation_required"
  | "eval_completed"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_expired"
  | "global_budget_fuse"
  | "web_search_performed"
  | "http_fetch_performed"
  | "self_write_published"
  | "self_write_blocked"
  | "self_write_failed"
  | "external_work_published"
  | "external_work_failed"
  | "llm_call"
  | "loop_started"
  | "loop_step"
  | "loop_halted"
  | "lesson_decay_tick"
  | "lesson_consolidate_tick"
  | "episodic_distill_pass"
  | "episodic_consolidate_tick"
  | "wiki_page_saved"
  | "wiki_decay_tick"
  | "db_backup_completed"
  | "db_backup_failed"
  | "bounty_scan_completed"
  | "project_created"
  | "project_state_changed"
  | "incident_opened"
  | "incident_resolved"
  | "google_api_call_completed";

export interface LedgerEvent {
  event_id: string;
  run_id?: string;
  correlation_id: string;
  event_type: LedgerEventType;
  occurred_at: string;
  actor: LedgerActor;
  sequence: number;
  payload: Record<string, unknown>;
}

interface LedgerStatement {
  all<T = Record<string, unknown>>(...values: Array<string | number | null>): T[];
  run(...values: Array<string | number | null>): { changes: number };
}

export interface LedgerDatabase {
  prepare(sql: string): LedgerStatement;
}

const requiredPayloadFields = {
  trigger_received: ["source", "source_reference", "requester", "idempotency_key", "payload_hash"],
  idempotency_conflict: [
    "source",
    "idempotency_key",
    "existing_run_id",
    "stored_payload_hash",
    "incoming_payload_hash",
    "resolution"
  ],
  schedule_fired: ["schedule_id", "scheduled_time", "command_hash"],
  schedule_skipped_duplicate: [
    "schedule_id",
    "scheduled_time",
    "idempotency_key",
    "existing_run_id"
  ],
  run_created: ["source", "idempotency_key", "program", "goal_hash", "requester"],
  contract_attached: ["contract_hash", "program", "budget", "allowed_actions", "approval_gates"],
  worker_lease_acquired: ["worker_id", "lease_expires_at", "attempt_count"],
  worker_lease_released: ["worker_id", "reason"],
  worker_lease_expired: [
    "worker_id",
    "lease_expires_at",
    "active_tool_call_id",
    "recovery_action"
  ],
  context_selected: [
    "context_pack_id",
    "included_artifact_ids",
    "excluded_relevant_artifact_ids",
    "token_estimate"
  ],
  budget_zone_changed: ["previous_zone", "next_zone", "remaining_budget", "reason"],
  capability_requested: [
    "tool_call_id",
    "capability",
    "input_hash",
    "side_effect_level",
    "risk_level"
  ],
  policy_decision: ["tool_call_id", "decision", "reason", "policy_version"],
  tool_started: ["tool_call_id", "operation_id", "adapter_name", "input_hash", "timeout_ms"],
  tool_finished: ["tool_call_id", "status", "output_hash", "duration_ms", "bytes_out"],
  approval_requested: [
    "approval_id",
    "action_fingerprint",
    "action_summary",
    "side_effect_level",
    "expires_at"
  ],
  approval_resolved: ["approval_id", "decision", "requester", "resolved_at"],
  notification_queued: ["notification_id", "target", "intent_type", "idempotency_key"],
  notification_delivered: ["notification_id", "target", "adapter", "delivered_at"],
  notification_failed: ["notification_id", "target", "adapter", "error_ref", "retryable"],
  report_written: ["report_ref", "report_hash", "partial"],
  lesson_proposed: ["lesson_id", "source_run_id", "provenance", "target_artifact_type"],
  reconciliation_required: ["tool_call_id", "operation_id", "reason", "reconciliation_ref"],
  eval_completed: ["eval_suite", "passed", "failed_case_ids", "report_ref"],
  run_completed: ["report_ref", "budget_used", "duration_ms"],
  run_failed: ["error_type", "error_ref", "recoverable"],
  run_cancelled: ["reason", "requester", "report_ref"],
  run_expired: ["reason", "expired_at", "report_ref"],
  global_budget_fuse: ["breaches", "window_hours"],
  web_search_performed: ["query", "provider", "source_urls"],
  // Provenance audit for the loop's direct URL read (Phase 3.6 step ③) — parity with
  // web_search_performed; bytes rides as optional metadata.
  http_fetch_performed: ["url", "status"],
  // Phase 3 self-write audit trail (spec § Notification, surfacing + tracking). Each is the
  // structured signal for an outcome — the future read-only dashboard's data source.
  self_write_published: ["branch", "summary", "verdict", "gate_results"],
  self_write_blocked: ["attempted_paths", "context"],
  self_write_failed: ["reason", "last_output"],
  // Money-Work Phase P1 external-work audit trail (ADR 0023). Each is the structured signal
  // for an outcome — the local artifact's ledger record. patch_ref is the runs/<id>/patch.diff
  // path; NON-NEGOTIABLE: counts/metadata + the repo url ONLY — never the repo's code or diff.
  external_work_published: ["repo_url", "task", "patch_ref", "gate"],
  external_work_failed: ["repo_url", "task", "reason"],
  // Phase 3.1 real LLM telemetry (spec §"Real telemetry", backlog #3). Token usage captured at
  // the source for every LLM call. role ∈ writer|reviewer|classify|frame|answer. cached_input_tokens,
  // cost_usd, latency_ms are optional. NON-NEGOTIABLE: counts/metadata ONLY — never prompt/diff/response.
  llm_call: ["provider", "model", "role", "input_tokens", "output_tokens"],
  // Inner-loop observation hooks (ADR 0013, step ⓪·1). `loop_started.applied_artifacts`
  // is the attribution seed (which lesson/skill scope blocks were injected); `loop_step`
  // records each composed step (result_digest is the truncated transcript entry — never
  // full payloads); `loop_halted.reason` ∈ final|clarify|step_cap|denial|parse_cap|
  // clarify_cap|failed. `loop_step` also carries an OPTIONAL `reader_applied:true` when the
  // step's output passed through the Dual-LLM quarantined reader (ADR 0014) — not required.
  loop_started: ["manifest", "hint", "applied_artifacts"],
  loop_step: ["step", "action", "capability", "ok", "result_digest"],
  loop_halted: ["reason", "steps"],
  // ⓪·3 S2 (ADR 0012 §1/§3): the daily reuse-value decay+prune pass — one summary per tick.
  lesson_decay_tick: ["lessons_decayed", "pruned_ids"],
  // Lesson-consolidation design (2026-07-23): one summary per daily preserve-all lesson-merge
  // tick that did work. `merges` is id-only ([{new_id, superseded_ids}]) — traceable for undo,
  // but no lesson text (the bodies-out-of-the-ledger invariant holds).
  lesson_consolidate_tick: ["scopes_processed", "clusters_merged", "lessons_superseded", "merges"],
  // Phase M B2: one summary per executed episodic fast-path distill pass (run-less).
  episodic_distill_pass: ["facts_added", "superseded", "dropped", "turns_read"],
  // Phase M B4: one summary per daily episodic consolidate tick that did work (run-less).
  episodic_consolidate_tick: ["facts_decayed", "pruned_ids", "clusters_merged", "promoted_ids"],
  // Phase W (ADR 0020): one event per wiki page save (add/refine/unchanged); confidence
  // is null on an UNVERIFIED save; superseded_id rides as optional metadata on refine.
  wiki_page_saved: ["verb", "id", "topic_slug", "source_count", "confidence", "contradiction_count"],
  // Phase W W2: the daily wiki reuse-value decay+prune pass — one summary per executed tick.
  wiki_decay_tick: ["pages_decayed", "pruned_ids"],
  // Backlog #3 (ADR 0021): the periodic WAL-safe VACUUM INTO snapshot — one event per
  // landed snapshot; a failed attempt records the reason and the latch stays put (retry).
  db_backup_completed: ["path", "bytes", "kept_count", "duration_ms"],
  db_backup_failed: ["reason"],
  // Money-Work P2 (spec 2026-07-18): bounty intake + durable project state. Counts and
  // deterministic identifiers ONLY — never venue-derived free text (titles/labels stay
  // out of the ledger; the sanitized table lives in the turn transcript, not here).
  bounty_scan_completed: ["venue_count", "candidates", "scam_suspects", "new_sightings"],
  project_created: ["project_id", "source_url"],
  project_state_changed: ["project_id", "from", "to"],
  // Introspection slice A (ADR 0024): ids + counts only — the incident detail lives in the
  // incidents row, not the ledger.
  incident_opened: ["incident_id", "kind", "subject"],
  incident_resolved: ["incident_id", "kind", "subject", "open_minutes"],
  // ADR 0025: Google API surface (gmail_read / google_api). Counts and deterministic
  // identifiers ONLY — never mail content or API response text.
  google_api_call_completed: ["service", "op", "count", "extracted_codes", "extracted_links"]
} as const satisfies Record<LedgerEventType, readonly string[]>;

export function createLedgerEvent(
  input: Omit<LedgerEvent, "event_id" | "occurred_at">
): LedgerEvent {
  return {
    ...input,
    event_id: `evt_${randomUUID()}`,
    occurred_at: new Date().toISOString()
  };
}

export function validateLedgerEvent(
  event: LedgerEvent
): { ok: true } | { ok: false; error: string } {
  for (const field of requiredPayloadFields[event.event_type]) {
    if (event.payload[field] === undefined) {
      return {
        ok: false,
        error: `${event.event_type} missing required payload field: ${field}`
      };
    }
  }

  return { ok: true };
}

export function appendLedgerEvent(db: LedgerDatabase, event: LedgerEvent): void {
  const validation = validateLedgerEvent(event);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  db.prepare(`
    INSERT INTO ledger_events (
      event_id,
      run_id,
      correlation_id,
      event_type,
      occurred_at,
      actor,
      sequence,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id,
    event.run_id ?? null,
    event.correlation_id,
    event.event_type,
    event.occurred_at,
    event.actor,
    event.sequence,
    JSON.stringify(event.payload)
  );
}

export function readLedgerEvents(db: LedgerDatabase, run_id?: string): LedgerEvent[] {
  const sql = run_id
    ? `
      SELECT event_id, run_id, correlation_id, event_type, occurred_at, actor, sequence, payload_json
      FROM ledger_events
      WHERE run_id = ?
      ORDER BY sequence ASC, occurred_at ASC, event_id ASC
    `
    : `
      SELECT event_id, run_id, correlation_id, event_type, occurred_at, actor, sequence, payload_json
      FROM ledger_events
      ORDER BY sequence ASC, occurred_at ASC, event_id ASC
    `;
  const rows = run_id
    ? db.prepare(sql).all<LedgerEventRow>(run_id)
    : db.prepare(sql).all<LedgerEventRow>();

  return rows.map((row) => {
    const event: LedgerEvent = {
      event_id: row.event_id,
      correlation_id: row.correlation_id,
      event_type: row.event_type as LedgerEventType,
      occurred_at: row.occurred_at,
      actor: row.actor as LedgerActor,
      sequence: row.sequence,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>
    };
    if (row.run_id !== null) {
      event.run_id = row.run_id;
    }
    return event;
  });
}

interface LedgerEventRow {
  event_id: string;
  run_id: string | null;
  correlation_id: string;
  event_type: string;
  occurred_at: string;
  actor: string;
  sequence: number;
  payload_json: string;
}
