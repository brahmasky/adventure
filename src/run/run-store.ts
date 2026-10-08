import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  ApprovalDecision,
  ApprovalState,
  CompiledTaskContract,
  Identity,
  ProjectState,
  RiskLevel,
  RunState,
  ScheduleState,
  SideEffectLevel,
  TypedTaskEvent
} from "../domain/types.js";
import { stableHash } from "../domain/canonical.js";
import { flattenLessonText, OMP_LESSON_SCOPES, UNTHEMED } from "./lesson-themes.js";
import { LESSON_AVOID_MAX_CHARS, LESSON_MAX_CHARS } from "../capabilities/distill.js";
import {
  computeBreaches,
  computeHeadroom,
  GLOBAL_BUDGET_WINDOW_HOURS,
  type GlobalBudgetBreach,
  type GlobalBudgetCaps,
  type GlobalBudgetHeadroom,
  type GlobalBudgetKind
} from "../budget/global-budget-ledger.js";
import { NOTIFICATION_MAX_ATTEMPTS, type NotificationButton, type NotificationIntent } from "../notifications/notification-types.js";
import {
  appendLedgerEvent,
  createLedgerEvent,
  readLedgerEvents,
  readLedgerEventsByCorrelation,
  type LedgerActor,
  type LedgerEvent,
  type LedgerEventType
} from "./run-ledger.js";
import { canTransitionProject, canTransitionRun } from "./state-machines.js";
import type { LlmAttempt, LlmAuditSink } from "../llm/audit.js";
import { computeCostUsd, METERED_PROVIDERS } from "../llm/metered-pricing.js";
import { blobToFloat32, cosineSimilarity, float32ToBlob } from "../llm/embeddings.js";
import { resolveWikiDecayDays } from "../capabilities/wiki.js";
import type { TriageShadowStats } from "../jev/triage-report.js";
import type { SkipReason } from "../jev/decide.js";
import type { Category } from "../jev/questions/tree.js";
import type { Effort, Lane, RouteReason, TurnRole } from "../jev/tree-policy.js";
import type { MediaIngestedPayload } from "../media/media-config.js";

/**
 * The `role` recorded on every `llm_attempt` row (via `llmAuditSink`'s scope): chain calls, spawn
 * seats, and the daemon-tick purposes. The pre-slice-2 `llm_call` writer is gone; its history
 * stays readable through the usage readers' UNION.
 */
export type LlmCallRole =
  | "writer"
  | "reviewer"
  | "classify"
  | "frame"
  | "answer"
  | "compose"
  | "reader"
  | "distill"
  | "consolidate"
  | "extract"
  | "judge"
  | "chair"
  | "verify"
  | "attribution"
  | "classify_replay"
  | "classify_replay_llm"
  | "classify_shadow"
  | "media_transcribe"
  // Jev decision points (ADR 0029): one role per point so the per-point rate is readable in llm_attempt
  | "triage";

/** Where an audited attempt belongs: a run, or a run-less correlation (`tick:*`, `cli:*`, `rating:*`). */
export type LlmAuditScope =
  | { run_id: string; role: LlmCallRole }
  | { correlation_id: string; role: LlmCallRole };

type SqliteValue = string | number | bigint | Uint8Array | null;

interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
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

export type PlannerFailure =
  | "planner_exit"
  | "lease_lost"
  | "lease_expired"
  | "killed"
  | "no_planner_leg"
  | "model_error"
  | "turn_timeout"
  | "frame_idle"
  | "merged_parent_failed"
  | "media_failed";

export type FinishRunInput =
  | {
      run_id: string;
      expected_worker_id: string;
      next: "completed";
      report_ref: string;
      duration_ms: number;
      tool_calls: number;
    }
  | {
      run_id: string;
      expected_worker_id: string;
      next: "failed";
      error_type: PlannerFailure;
      error_ref: string;
    };

export interface ToolApprovalInput {
  run_id: string;
  worker_id: string;
  tool_call_id: string;
  capability: string;
  input_hash: string;
  action_fingerprint: string;
  requester: Identity;
  summary: string;
  side_effect_level: SideEffectLevel;
  expires_at: string;
  /** Approval-card text only (e.g. the bash command, capped by the caller). Never stored, never in the ledger. */
  card_detail?: string;
}

export interface ToolApprovalRow extends ToolApprovalInput {
  approval_id: string;
  state: "pending" | "approved" | "denied" | "expired" | "consumed";
  created_at: string;
  resolved_at: string | null;
}

interface ToolApprovalDbRow {
  approval_id: string;
  run_id: string;
  worker_id: string;
  tool_call_id: string;
  capability: string;
  input_hash: string;
  action_fingerprint: string;
  requester_json: string;
  summary: string;
  side_effect_level: SideEffectLevel;
  state: ToolApprovalRow["state"];
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
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

/** One chat's planner-session bookkeeping (memory A1 §6): the lesson set its omp session was started on. */
export interface PlannerSessionState {
  chat_id: string;
  /** The lesson set the chat's live transcript was started on: committed at the first dispatch after a reset ("" before any). */
  lesson_fingerprint: string;
  /**
   * A reset whose new transcript has not been prompted yet. omp treats a transcript with no turns as empty, so a respawn
   * before the first dispatch resumes the OLD one: only promotePlannerSession (at dispatch) commits it.
   */
  pending_fingerprint: string | null;
  /** 1 after a reset until a dispatch claims the seed (claimSessionSeed). */
  seed_pending: number;
  updated_at: string;
}

export interface ChatTurnRow {
  turn_id: string;
  chat_id: string;
  run_id: string;
  role: ChatTurnRole;
  text: string;
  intent: string | null;
  created_at: string;
  /** The stored turn this message quoted (a Telegram reply resolved by resolveQuotedTurn, spec §2.2.1); null otherwise. */
  quoted_turn_id: string | null;
}

/** A Telegram quote resolved to the stored turn it replies to (spec §2.2.1), or why it could not be. */
export type QuoteResolution =
  | { ok: true; role: "houge" | "user"; turn: ChatTurnRow }
  | { ok: false; reason: "no_mapping" | "ambiguous" | "not_final" };

/** One historical user turn eligible for Jev replay (Jev spec 2026-09-25). */
export interface ReplayTurnRow {
  turn_id: string;
  chat_id: string;
  run_id: string;
  text: string;
  created_at: string;
  recorded_intent: string;
  /** When the classifier ran: its first `classify` llm_attempt, else the run's first ledger event. */
  anchor: string | null;
  anchor_kind: "classify" | "run_start" | null;
}

export type LessonStatus = "active" | "superseded" | "pruned";
export type LessonSource = "user_feedback" | "loop" | "migration" | "consolidation" | "lane";

/**
 * One durable lesson (⓪·3 S1, ADR 0012 §2/§3): a per-lesson row with eval metadata
 * (applied/corrected counts, reuse_value, rating_history) and a bidirectional supersede
 * chain. Rows are NEVER deleted — 'superseded' and 'pruned' are reversible states.
 */
export interface LessonRow {
  id: number;
  scope: string;
  text: string;
  avoid: string | null;
  status: LessonStatus;
  supersedes: number | null;
  superseded_by: number | null;
  applied_count: number;
  corrected_count: number;
  reuse_value: number;
  /** JSON array of rating entries (written by the S2 signal path). */
  rating_history: string;
  created_at: string;
  last_used: string | null;
  source: LessonSource;
  /** Closed-list theme (memory A1 §5; src/run/lesson-themes.ts), 'unthemed' by default. */
  theme: string;
}

/** The reconcile verdict {@link RunStore.saveReconciledLesson} applies (structurally matches capabilities/reconcile.ts). */
export type LessonReconcileVerdict =
  | { verdict: "ADD" }
  | { verdict: "DROP" }
  | { verdict: "SUPERSEDE"; id: number }
  | { verdict: "UPDATE"; id: number; text?: string };

export type LessonWriteVerb = "add" | "supersede" | "update" | "drop";

export interface LessonSaveResult {
  /** `capped`: nothing saved — the text or AVOID would exceed its cap (memory A1 §2). */
  verb: LessonWriteVerb | "capped";
  /** The new active row's id (absent on drop and capped). */
  id?: number;
  supersededId?: number;
  /** The lesson a capped UPDATE/SUPERSEDE left untouched. */
  cappedTargetId?: number;
  /** The text actually stored (the merged text on update; the candidate's on drop). */
  lesson: string;
  /** Rows pruned by the per-scope cap (lowest reuse_value first; never the new row). */
  prunedIds: number[];
  /**
   * ⓪·3 S2b layer-routing (iii): true when this SUPERSEDE hit a lesson that was already
   * superseded recently or repeatedly corrected — the memory layer looks ineffective, so
   * the digest should steer the model toward the code layer.
   */
  escalate?: boolean;
}

/**
 * One entry in a lesson's `rating_history` JSON (⓪·3 S2): a session rating that touched
 * the lesson ({rating, at}) or a low-rating attribution flag ({at, flag:"culprit", reason}).
 */
export interface RatingHistoryEntry {
  rating?: number;
  at: string;
  flag?: string;
  reason?: string;
}

/** Tolerant parse of a lesson's rating_history JSON — garbage degrades to []. */
export function parseRatingHistory(json: string): RatingHistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RatingHistoryEntry => typeof entry === "object" && entry !== null
    );
  } catch {
    return [];
  }
}

/** The single pending rating ask per chat (⓪·3 S2a). `asked_at` survives consume/expiry
 * (the row is deactivated, never deleted) so the ask cooldown stays durable. */
export interface PendingRating {
  chat_id: string;
  asked_at: string;
  window_start: string;
  active: boolean;
}

export type EpisodicFactStatus = "active" | "superseded" | "pruned";

/**
 * One episodic fact (Phase M B1, ADR 0005 §3/§4): an atomic, pronoun-resolved,
 * time-grounded assertion distilled from a chat, with provenance back to the source
 * turns and the same eval metadata + bidirectional supersede chain as lessons. Rows
 * are NEVER deleted — a superseding fact sets the old row's `valid_until` (bi-temporal
 * invalidation), so "true until X" stays answerable.
 */
export interface EpisodicFactRow {
  id: number;
  fact: string;
  /** JSON array of participant names. */
  participants: string;
  chat_id: string | null;
  /** JSON array of chat_turns turn_ids (provenance — summaries point back to source). */
  source_turn_ids: string;
  /** What time the fact is ABOUT (may differ from when it was learned). */
  occurred_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  salience: number;
  status: EpisodicFactStatus;
  supersedes: number | null;
  superseded_by: number | null;
  applied_count: number;
  corrected_count: number;
  reuse_value: number;
  /** JSON array of rating entries (same shape as lessons; written by later signal wiring). */
  rating_history: string;
  /** Float32Array bytes (see llm/embeddings.ts converters); null = not embedded (backfillable). */
  embedding: Uint8Array | null;
  embedding_model: string | null;
  created_at: string;
  last_used: string | null;
  /** 1 = stable biography/identity, folded into the always-known core band (default 0). */
  is_core: number;
}

/**
 * One scheduled task (B10b, ADR 0017). ROW-level `state` is enabled|disabled|failed
 * (the vestigial ScheduleState's durable subset — fired/enqueued/skipped_duplicate are
 * PER-FIRE ledger events, not row states). Rows are never deleted: cancel flips state
 * to 'disabled'; three consecutive fire failures flip it to 'failed'.
 */
/** An open/resolved behavioral incident (introspection slice A, ADR 0024). Never deleted. */
export interface IncidentRow {
  incident_id: string;
  /** Invariant family — the `kind` half of the fingerprint. */
  kind: string;
  /** Stable id of the offending thing (schedule_id / run_id / notification_id / "daemon"). */
  subject: string;
  /** `${kind}:${subject}` — deterministic, so the same violation always dedupes. */
  fingerprint: string;
  state: "open" | "resolved";
  /** Counts and ids ONLY — never user text (same redaction rule as ledger payloads). */
  detail_json: string;
  seen_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRow {
  schedule_id: string;
  chat_id: string;
  /** The turn text a fire replays (sanitized at creation — schedule-spec.ts). */
  goal: string;
  /** JSON ScheduleSpec (schedule-spec.ts; parse tolerantly — a corrupt row must not throw). */
  spec_json: string;
  /** IANA zone the spec's wall-clock times are stated in. */
  tz: string;
  state: ScheduleState;
  /** UTC ISO of the next fire (the tick's due query + the fire's idempotency key). */
  next_run_at: string;
  last_fired_at: string | null;
  consecutive_failures: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One pursued bounty (P2, spec 2026-07-18 §4). A row exists ONLY once Paco decides to
 * pursue (listing ≠ project). Rows are never deleted — `dropped` is a state. All text
 * columns hold sanitizer-passed values (the capability validates before the store).
 */
export interface ProjectRow {
  project_id: string;
  /** v1: always "bounty". */
  kind: string;
  /** Grammar-validated GitHub issue URL — UNIQUE (duplicate track = idempotent return). */
  source_url: string;
  title: string | null;
  /** Whole USD, as CLAIMED by the venue — never verified, never money accounting. */
  amount_usd: number | null;
  state: ProjectState;
  state_reason: string | null;
  /** Valid JSON ≤ 4 KB (capability-enforced). */
  notes_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Scan memory (P2): one row per bounty issue URL ever seen — dedupe, NEW-in-window
 * deltas, and the durable record of the last substantive judgment. Non-downgrading:
 * an `unverified` scan never overwrites a substantive verdict/score.
 */
export interface BountySightingRow {
  issue_url: string;
  first_seen_at: string;
  last_seen_at: string;
  last_score: number | null;
  last_verdict: string | null;
  times_seen: number;
}

export type IdeaStatus = "seen" | "tracked" | "shortlisted" | "picked" | "killed" | "archived";

/** One contributing item inside an idea card's sources map — always slimmer-sourced values. */
export interface IdeaSourceItem {
  /** Namespaced radar item id (`<sourceKey>:<native>`), slimmer-validated. */
  id: string;
  /** Slimmer-validated https URL (the LLM never emits a URL that gets stored). */
  url: string;
  title: string;
}

/**
 * One idea card (Idea Radar R1, spec 2026-07-24 §2). `slug` is a filename/identity key
 * ONLY — dedupe is the extract-LLM's match-or-new verdict, never slug equality. Rows are
 * never deleted: `archived`/`killed` are states; momentum = distinct_items ×
 * distinct_sources (computed, the /radar ordering).
 */
export interface IdeaRow {
  id: number;
  slug: string;
  title: string;
  summary: string;
  status: IdeaStatus;
  sources: Record<string, IdeaSourceItem[]>;
  distinct_items: number;
  distinct_sources: number;
  /** Null in R1; the R2 judge panel writes it. */
  scores_json: string | null;
  first_seen: string;
  last_seen: string;
  archived_at: string | null;
  momentum: number;
}

/** Per-card, per-source contributing-item cap (spec §2) — overflow drops oldest-first. */
export const IDEA_CARD_ITEMS_PER_SOURCE_CAP = 20;

/** Bound every per-source list (insert path) — the touch path re-caps after its union. */
function capIdeaSources(sources: Record<string, IdeaSourceItem[]>): Record<string, IdeaSourceItem[]> {
  const capped: Record<string, IdeaSourceItem[]> = {};
  for (const [key, items] of Object.entries(sources)) {
    if (items.length === 0) continue;
    capped[key] = items.slice(-IDEA_CARD_ITEMS_PER_SOURCE_CAP);
  }
  return capped;
}

/** The card's distinct counts, always recomputed from the sources map (never caller-trusted). */
function countIdeaSources(sources: Record<string, IdeaSourceItem[]>): {
  distinct_items: number;
  distinct_sources: number;
} {
  let distinct_items = 0;
  let distinct_sources = 0;
  for (const items of Object.values(sources)) {
    if (items.length === 0) continue;
    distinct_items += items.length;
    distinct_sources += 1;
  }
  return { distinct_items, distinct_sources };
}

/** Raw ideas row (sources_json still serialized) as selected by listActiveIdeas. */
interface IdeaRawRow {
  id: number;
  slug: string;
  title: string;
  summary: string;
  status: IdeaStatus;
  sources_json: string;
  distinct_items: number;
  distinct_sources: number;
  scores_json: string | null;
  first_seen: string;
  last_seen: string;
  archived_at: string | null;
  momentum: number;
}

function parseIdeaRow(row: IdeaRawRow): IdeaRow {
  const { sources_json, ...rest } = row;
  return { ...rest, sources: JSON.parse(sources_json) as Record<string, IdeaSourceItem[]> };
}

/**
 * The ONLY status transitions {@link RunStore.setIdeaStatus} will write (Idea Radar R2,
 * spec 2026-07-25 §8): the panel shortlists seen/tracked cards and reverts un-re-shortlisted
 * ones to tracked; the operator pick flips shortlisted↔picked. Everything else —
 * same-status, archived/killed source, seen→picked leaps — is refused in code, never thrown.
 */
const IDEA_STATUS_TRANSITIONS: ReadonlyArray<readonly [IdeaStatus, IdeaStatus]> = [
  ["seen", "shortlisted"],
  ["tracked", "shortlisted"],
  ["shortlisted", "tracked"],
  ["shortlisted", "picked"],
  ["picked", "shortlisted"]
];

/** One frozen shortlist entry inside a snapshot's cards_json (Idea Radar R2, spec §4 apply). */
export interface ShortlistCard {
  rank: number;
  idea_id: number;
  slug: string;
  title: string;
  mean_score: number;
  chair_rationale: string | null;
}

/**
 * One weekly shortlist snapshot (Idea Radar R2, spec §4/§5). Frozen history: `/idea pick <n>`
 * resolves ranks against the LATEST snapshot's cards, never the live board — board drift after
 * the panel cannot misresolve a pick. `picked_idea_id` is display bookkeeping; the pick truth
 * is the global `status='picked'` singleton on the ideas table.
 */
export interface ShortlistRow {
  id: number;
  created_at: string;
  week_key: string;
  cards: ShortlistCard[];
  picked_idea_id: number | null;
}

/** The candidate {@link RunStore.saveReconciledFact} stores (all metadata rides ADD/SUPERSEDE/UPDATE). */
export interface EpisodicFactCandidate {
  chat_id: string;
  fact: string;
  participants?: string[];
  source_turn_ids?: string[];
  occurred_at?: string;
  salience?: number;
  embedding?: Float32Array | null;
  embedding_model?: string;
  /** Stable biography/identity — folds into the always-known core band (default false). */
  is_core?: boolean;
}

export interface EpisodicFactSaveResult {
  verb: LessonWriteVerb;
  /** The new active row's id (absent on drop). */
  id?: number;
  supersededId?: number;
  /** The fact text actually stored (the merged text on update; the candidate's on drop). */
  fact: string;
  /** Rows pruned by the per-chat cap (lowest reuse_value first; never the new row). */
  prunedIds: number[];
}

/** Per-chat fast-path distill progress (Phase M B2): which turns have been distilled. */
export interface EpisodicDistillWatermark {
  chat_id: string;
  last_turn_created_at: string | null;
  last_distilled_at: string | null;
}

/**
 * One wiki page (Phase W, ADR 0020): a durable per-topic knowledge page synthesized from
 * external-read digests and cross-source verified. Pages are GLOBAL (no chat_id —
 * knowledge isn't per-conversation) and NEVER deleted: a refine inserts a NEW row and
 * links the prior via bidirectional supersede pointers; overflow prunes reversibly.
 */
export interface WikiPageRow {
  id: number;
  topic_slug: string;
  title: string;
  summary: string;
  /** JSON array of key-fact strings (sanitized/capped at parse time). */
  key_facts: string;
  body_md: string;
  /** JSON array of source URLs (deduped host+path at save time). */
  sources: string;
  /** JSON array of {claim,a,b} contradictions — both sides verbatim, never averaged. */
  contradictions: string;
  /** Mean verifier confidence in [0,1]; NULL = saved UNVERIFIED (all passes failed). */
  confidence: number | null;
  verified_passes: number;
  last_verified: string | null;
  status: string;
  supersedes: number | null;
  superseded_by: number | null;
  applied_count: number;
  corrected_count: number;
  reuse_value: number;
  /** JSON array of rating entries (same shape as lessons; written by W2 signal wiring). */
  rating_history: string;
  /** Float32Array bytes of embed(title+"\n"+summary); null = not embedded (backfillable). */
  embedding: Uint8Array | null;
  embedding_model: string | null;
  created_at: string;
  last_used: string | null;
}

/** The candidate {@link RunStore.saveReconciledWikiPage} stores. */
export interface WikiPageCandidate {
  topic_slug: string;
  title: string;
  summary?: string;
  key_facts?: string[];
  body_md?: string;
  sources?: string[];
  contradictions?: Array<{ claim: string; a: string; b: string }>;
  confidence?: number | null;
  verified_passes?: number;
  last_verified?: string | null;
  embedding?: Float32Array | null;
  embedding_model?: string;
  /** Refine-only: the synthesis judged the digests add nothing — touch, don't insert. */
  unchanged?: boolean;
  /** Refine-only: the prior page was contradicted — it pays corrected_count/reuse. */
  priorContradicted?: boolean;
}

export type WikiWriteVerb = "add" | "refine" | "unchanged";

export interface WikiPageSaveResult {
  verb: WikiWriteVerb;
  /** The active row's id (the prior row's on "unchanged"). */
  id: number;
  supersededId?: number;
  /** Rows pruned by the global cap (lowest reuse_value first; never the new row). */
  prunedIds: number[];
}

/** One captured session rating (⓪·3 S2a): 0–3 + optional comment + the applied set. */
export interface SessionRating {
  id: number;
  chat_id: string;
  rating: number;
  comment: string | null;
  asked_at: string;
  captured_at: string;
  /** JSON array of the lesson ids applied during the rated window. */
  applied_lesson_ids: string;
}

/** Rating snapshot for `/status` (⓪·3 S2c). */
export interface RatingStatus {
  /** asked_at of a still-answerable pending ask, else null. */
  pending_since: string | null;
  last_rating: number | null;
  last_rating_at: string | null;
}

export interface PollHeartbeat {
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  updated_at: string | null;
}

/** A green self-write merge recorded just before the restart (⓪·2c U2, ADR 0012 D4 stage 1). */
export interface ReloadMarker {
  sha: string;
  subject: string;
  branch: string;
  merged_at: string;
}

/** One daemon boot (houge_status, 2026-10-02): when, why, and which code it booted on. Code-owned values only. */
export interface DaemonBootInput {
  boot_id: string;
  started_at: string;
  pid: number;
  /** self_write_reload | kickstart | revive_after_kill | crash_recovery | restart | unknown */
  reason: string;
  reload_sha: string | null;
  reload_subject: string | null;
  reload_branch: string | null;
  reload_merged_at: string | null;
  head_sha: string | null;
  head_subject: string | null;
  head_committed_at: string | null;
  /** The newest first-parent commit touching a build input (houge-status BUILD_INPUTS); null when unknown. */
  build_input_committed_at?: string | null;
  dist_built_at: string | null;
  /** At boot the newest src .ts was newer than the newest dist .js. */
  src_newer_than_dist?: boolean;
}

export interface DaemonBoot extends DaemonBootInput {
  build_input_committed_at: string | null;
  src_newer_than_dist: boolean;
  /** Set when the daemon loop exited cleanly; null on the live boot and on one that crashed. */
  stopped_at: string | null;
}

/** The newest green self-write merge; `pending` = its reload marker is not consumed yet (not live until restart). */
export interface SelfWriteMergeRecord {
  branch: string;
  sha: string;
  merged_at: string;
  pending: boolean;
}

/** Boot rows kept (one per daemon start). */
export const DAEMON_BOOTS_KEPT = 50;

/** Self-service memory correction (2026-10-02): which store a memory_correct / /forget_memory change touched. */
export type MemoryKind = "fact" | "wiki";

/** One reversible memory change (memory_changes row): the ids it flipped, never any text. */
export interface MemoryChange {
  change_id: string;
  kind: MemoryKind;
  action: "retire" | "correct";
  old_ids: number[];
  /** The correction's new fact (correct only). */
  new_id: number | null;
  /** The turn that made it; null for Paco's own /forget_memory. */
  run_id: string | null;
  chat_id: string;
  created_at: string;
  undone_at: string | null;
}

export type MemoryUndoResult =
  | { status: "undone"; change: MemoryChange; restored: number[]; retired: number | null }
  | { status: "already_undone" | "changed_since"; change: MemoryChange }
  | { status: "not_found" };

export type JevDecisionStatus = "answered" | "skipped";
export type JevDecisionOutcome = "act" | "ask" | "fallback" | "shadow";

/** One Jev decision row (ADR 0029 §3.4): ids, enums and numbers only, never message text. */
export interface JevDecisionRow {
  decision_id: string; run_id: string | null; point: string; question_id: string | null; criteria_hash: string | null;
  model_reported: string | null; state_hash: string | null; lang: string; answers_json: string | null; confidence: number | null; top_prob: number | null;
  margin: number | null; threshold_version: string | null; threshold_used: string | null; decision: JevDecisionOutcome | null;
  outcome_source: "llm_label" | "paco_correction" | "observed_action" | "none"; outcome_value: string | null; latency_ms: number | null;
  input_tokens: number | null; status: JevDecisionStatus; skip_reason: string | null; created_at: string;
  /** Answered rows only: when live cut the thread (claim) and built the state; null on skipped and pre-2026-10-06 rows. */
  thread_cut_at: string | null; state_built_at: string | null;
}

/** One decision point call (spec §6): what the tree routed, what saved, what the handler did, and Paco's correction. Never text. */
export interface JevVerdictInsert { run_id: string; category: Category | null; breadth: number | null; reasoning: number | null;
  actions: number | null; sets_rule: number | null; rule_scope: "ask" | "research" | null; lane: Lane; role: TurnRole;
  effort: Effort | null; cascade: VerdictCascade; save_outcome: "saved" | "not_durable" | "capped" | "none";
  route_outcome: "act" | "fallback"; reason: RouteReason; skip_reason: SkipReason | null; quoted_turn_id: string | null; created_at?: string }
/** "tiny": the cascade call ran (plan Decision 14; Tiny role), whatever it returned — `reason` says cascade / cascade_failed. */
export type VerdictCascade = "tiny" | null;
export type VerdictCorrection = "ask_anyway" | "think_harder" | "escalation" | "low_rating";
export interface JevVerdictRow {
  verdict_id: string; run_id: string; category: Category | null; breadth: number | null; reasoning: number | null; actions: number | null;
  sets_rule: number | null; rule_scope: "ask" | "research" | null; lane: Lane; role: TurnRole; effort: Effort | null; model: string | null;
  cascade: VerdictCascade; save_outcome: JevVerdictInsert["save_outcome"]; route_outcome: "act" | "fallback" | "pin_failed";
  /** 'pending' | 'lane_reply' | 'fallthrough:<reason>' | 'planner_done' | 'planner_failed' */
  handler_outcome: string; reason: RouteReason; skip_reason: string | null; fast_used_tool: number; paco_correction: VerdictCorrection | null;
  quoted_turn_id: string | null; created_at: string; updated_at: string;
}
type JevVerdictPatch = Partial<{ handler_outcome: string; model: string | null; route_outcome: "pin_failed"; fast_used_tool: boolean; paco_correction: VerdictCorrection }>;
/** The only columns an update may set: a fixed list, so the SET clause never takes a name from input. */
const VERDICT_PATCH_COLUMNS = ["handler_outcome", "model", "route_outcome", "fast_used_tool", "paco_correction"] as const;

/** One undoable memory-lane save (ADR 0029 §5.6): the new lesson, the one it superseded, the cap victims it pruned. */
export interface LessonChange {
  change_id: string; run_id: string | null; chat_id: string; new_id: number; superseded_id: number | null; pruned_ids: number[];
  created_at: string; undone_at: string | null;
}

export type LessonUndoResult =
  | { status: "undone"; change: LessonChange; restored: number[]; skipped: number[] }
  | { status: "already_undone" | "changed_since"; change: LessonChange }
  | { status: "not_found" };

/** The two memory tables a change may flip; never interpolated from input. */
const MEMORY_TABLE: Readonly<Record<MemoryKind, "episodic_facts" | "wiki_pages">> = { fact: "episodic_facts", wiki: "wiki_pages" };

/** Whether a lesson text or avoid is over its size cap (memory A1 §2). */
function overLessonCap(text: string, avoid: string | undefined): boolean {
  return text.length > LESSON_MAX_CHARS || (avoid?.length ?? 0) > LESSON_AVOID_MAX_CHARS;
}

/** Exactly one stored turn resolves a quote; none is no mapping, several is ambiguous (spec §2.2.1). */
function oneTurn(turns: ChatTurnRow[], role: "houge" | "user"): QuoteResolution {
  const [turn] = turns;
  if (!turn) return { ok: false, reason: "no_mapping" };
  return turns.length === 1 ? { ok: true, role, turn } : { ok: false, reason: "ambiguous" };
}

export class RunStore {
  /**
   * Secrets-firewall redactor (ADR 0015): masks known secret VALUES at RunStore's own write seams —
   * the ledger append (covers every ledger writer), the three chat-notification enqueues, and the
   * approval prompt. Direct sendMessage paths outside RunStore (rating, self-write action handler,
   * daemon status) are NOT routed through here; they carry only constants/sha/non-secret text.
   * Identity (no-op) unless the firewall injected a real redactor at boot — so when the firewall is
   * OFF every store write is byte-identical.
   */
  private readonly redact: (s: string) => string;
  private readonly redactionEnabled: boolean;

  private constructor(private readonly db: SqliteDatabase, redact?: (s: string) => string) {
    this.redact = redact ?? ((s) => s);
    this.redactionEnabled = redact !== undefined;
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  static openInMemory(options: { redact?: (s: string) => string } = {}): RunStore {
    return new RunStore(new DatabaseSync(":memory:"), options.redact);
  }

  static open(path: string, options: { redact?: (s: string) => string } = {}): RunStore {
    return new RunStore(new DatabaseSync(path), options.redact);
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
    // The SINGLE ledger redaction seam (ADR 0015): every ledger writer routes through here, so a
    // secret value in ANY free-text payload field is masked once, at the append boundary. No-op
    // (fast path) when the firewall is OFF.
    appendLedgerEvent(this.db, this.redactionEnabled ? this.redactLedgerEvent(event) : event);
  }

  /** Deep-mask secret values in an event's payload strings (used only when the firewall is armed). */
  private redactLedgerEvent(event: LedgerEvent): LedgerEvent {
    return { ...event, payload: this.redactValue(event.payload) as Record<string, unknown> };
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactValue(v);
      return out;
    }
    return value;
  }

  getLedgerEvents(run_id?: string): LedgerEvent[] {
    return readLedgerEvents(this.db, run_id);
  }

  getLedgerEventsByCorrelation(correlation_id: string): LedgerEvent[] {
    return readLedgerEventsByCorrelation(this.db, correlation_id);
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
    /** The turn this message quoted (spec §2.2.1), so the replay rebuilds the same state. */
    quoted_turn_id?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO chat_turns (turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `turn_${randomUUID()}`,
      input.chat_id,
      input.run_id,
      input.role,
      input.text,
      input.intent ?? null,
      input.created_at ?? new Date().toISOString(),
      input.quoted_turn_id ?? null
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
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
          FROM chat_turns
          WHERE chat_id = ? AND created_at >= ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, sinceIso, limit)
      : this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
          FROM chat_turns
          WHERE chat_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, limit);
    return rows.reverse();
  }

  /**
   * The thread as it stood at `beforeIso` (exclusive), for Jev replay. `chat_turns.created_at` is
   * COMPLETION time — both rows of a turn are written after the loop — so the target run's own rows
   * are excluded explicitly, and a run that completed after the anchor is naturally left out.
   */
  getChatTurnsBefore(chat_id: string, limit: number, sinceIso: string, beforeIso: string, excludeRunId: string): ChatTurnRow[] {
    return this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
      FROM chat_turns
      WHERE chat_id = ? AND created_at >= ? AND created_at < ? AND run_id <> ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all<ChatTurnRow>(chat_id, sinceIso, beforeIso, excludeRunId, limit).reverse();
  }

  /**
   * User turns whose run produced a classified assistant reply, oldest first (Jev replay).
   * `recorded_intent` is picked as the EARLIEST qualifying assistant row of the run (correlated
   * subquery, not a JOIN) so a run with more than one qualifying assistant row still yields exactly
   * one row per user turn — a JOIN would double-count the turn and inflate the GO/STOP denominator
   * (review finding, fix round 1).
   */
  listReplayTurns(opts: { sinceIso?: string; limit?: number }): ReplayTurnRow[] {
    const earliestAssistantIntent = `(
      SELECT a.intent FROM chat_turns a
      WHERE a.run_id = u.run_id AND a.role = 'assistant'
        AND a.intent IS NOT NULL AND a.intent <> 'evolution_report'
      ORDER BY a.rowid ASC LIMIT 1
    )`;
    const rows = this.db.prepare(`
      SELECT u.turn_id, u.chat_id, u.run_id, u.text, u.created_at,
        ${earliestAssistantIntent} AS recorded_intent,
        (SELECT MIN(e.occurred_at) FROM ledger_events e
          WHERE e.run_id = u.run_id AND e.event_type = 'llm_attempt'
            AND json_extract(e.payload_json, '$.role') = 'classify') AS classify_at,
        (SELECT MIN(e.occurred_at) FROM ledger_events e WHERE e.run_id = u.run_id) AS run_start
      FROM chat_turns u
      WHERE u.role = 'user' AND u.created_at >= ?
        AND ${earliestAssistantIntent} IS NOT NULL
      ORDER BY u.created_at ASC, u.rowid ASC
      LIMIT ?
    `).all<Omit<ReplayTurnRow, "anchor" | "anchor_kind"> & { classify_at: string | null; run_start: string | null }>(
      opts.sinceIso ?? "", opts.limit ?? -1
    );
    return rows.map(({ classify_at, run_start, ...row }) => ({
      ...row,
      anchor: classify_at ?? run_start,
      anchor_kind: classify_at ? "classify" : run_start ? "run_start" : null
    }));
  }

  /** Distinct `loop_step.capability` values for a run — the replay's observed-action proxy. */
  runLoopCapabilities(run_id: string): string[] {
    return this.db.prepare(`
      SELECT DISTINCT json_extract(payload_json, '$.capability') AS capability
      FROM ledger_events WHERE run_id = ? AND event_type = 'loop_step'
    `).all<{ capability: string | null }>(run_id)
      .map((r) => r.capability)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
  }

  /** A run's trigger source (`telegram` | `schedule` | `cli` | `event`) — undefined if the run does not exist. */
  runSource(run_id: string): string | undefined {
    return this.db.prepare(`SELECT source FROM runs WHERE run_id = ?`).get<{ source: string }>(run_id)?.source;
  }

  /** A run's state — undefined if the run does not exist (unlike {@link getRunState}, which throws). */
  findRunState(run_id: string): RunState | undefined {
    return this.db.prepare(`SELECT state FROM runs WHERE run_id = ?`).get<{ state: RunState }>(run_id)?.state;
  }

  /**
   * When a run was active in its chat: its first chat turn anywhere, to the later of its last chat turn and
   * its last loop_step. Never `runs.updated_at`, which lease recovery stamps minutes after a crashed turn.
   * Undefined when the run has no chat turn.
   */
  runActivitySpan(run_id: string): { from: string; to: string } | undefined {
    const row = this.db.prepare(`
      SELECT MIN(created_at) AS first_turn, MAX(created_at) AS last_turn,
        (SELECT MAX(occurred_at) FROM ledger_events WHERE run_id = ? AND event_type = 'loop_step') AS last_step
      FROM chat_turns WHERE run_id = ?
    `).get<{ first_turn: string | null; last_turn: string | null; last_step: string | null }>(run_id, run_id);
    if (!row?.first_turn || !row.last_turn) return undefined;
    return { from: row.first_turn, to: row.last_step && row.last_step > row.last_turn ? row.last_step : row.last_turn };
  }


  /**
   * The lane 1 live shadow as the §5.9 step 4 bar reads it: `triage` rows with decision `shadow` since `sinceIso`, each
   * joined to its run's planner `loop_step` capabilities. A "pure verdict" is `lane = memory ∧ complete = pure` (the
   * row's argmax choices — a superset of pure-at-bar, so the count errs toward NO-GO). `days` = distinct UTC days with a
   * shadow row (occurred_at is ISO UTC), so a parked daemon's silent weeks do not count toward the 14. Only turns whose
   * `lane` shadow decision row reported `model` count: calibration keys on the reported model, so an alias move must not
   * let the old model's shadow stand as the new model's evidence.
   */
  triageShadowStats(sinceIso: string, model: string): TriageShadowStats {
    const rows = this.db.prepare(`
      SELECT e.run_id, e.occurred_at, json_extract(e.payload_json, '$.lane') AS lane,
        json_extract(e.payload_json, '$.complete') AS complete, r.state AS run_state
      FROM ledger_events e LEFT JOIN runs r ON r.run_id = e.run_id
      WHERE e.event_type = 'triage' AND json_extract(e.payload_json, '$.decision') = 'shadow' AND e.occurred_at >= ?
        AND EXISTS (SELECT 1 FROM jev_decisions d WHERE d.run_id = e.run_id AND d.point = 'triage' AND d.question_id = 'lane'
          AND d.decision = 'shadow' AND d.model_reported = ?)
      ORDER BY e.occurred_at ASC, e.sequence ASC
    `).all<{ run_id: string; occurred_at: string; lane: string | null; complete: string | null; run_state: string | null }>(sinceIso, model);
    const stats: TriageShadowStats = { model, days: 0, matched_lesson_write: 0, pure_on_tool_turns: 0, pure_on_no_tool_turns: 0 };
    for (const r of rows) {
      const caps = this.runLoopCapabilities(r.run_id);
      // "matched" = a triage row AND a completed planner run (§5.9 step 4): a failed run's lesson_write saved nothing.
      if (r.run_state === "completed" && caps.includes("lesson_write")) stats.matched_lesson_write += 1;
      if (r.lane !== "memory" || r.complete !== "pure") continue;
      if (caps.some((c) => c !== "lesson_write")) stats.pure_on_tool_turns += 1;
      else if (caps.length === 0) stats.pure_on_no_tool_turns += 1;
    }
    stats.days = new Set(rows.map((r) => r.occurred_at.slice(0, 10))).size; // distinct UTC days with a shadow row
    stats.live_state_rows = this.db.prepare(`
      SELECT run_id, state_hash FROM jev_decisions
      WHERE point = 'triage' AND question_id = 'lane' AND decision = 'shadow' AND state_hash IS NOT NULL AND created_at >= ? AND model_reported = ?
      ORDER BY created_at ASC, rowid ASC
    `).all<{ run_id: string | null; state_hash: string }>(sinceIso, model).map((r) => ({ run_id: r.run_id ?? "", state_hash: r.state_hash }));
    return stats;
  }



  /**
   * The OLDEST `limit` turns strictly after `afterIso` (or from the beginning), in
   * chronological order. The episodic distill pass reads with this so a burst longer
   * than one window is caught up oldest-first across successive passes — a newest-first
   * read would advance the watermark past turns it never distilled, silently losing
   * durable facts stated early in a long session (verifier finding, Phase M).
   */
  getChatTurnsAfter(chat_id: string, afterIso: string | undefined, limit: number): ChatTurnRow[] {
    return afterIso
      ? this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
          FROM chat_turns
          WHERE chat_id = ? AND created_at > ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, afterIso, limit)
      : this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
          FROM chat_turns
          WHERE chat_id = ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, limit);
  }

  /**
   * The scope's lessons COMPOSED at read time (⓪·3 S1): active rows only, most valuable
   * first (reuse_value desc; ties in reading order — oldest first, matching the legacy
   * block), row-capped per scope and char-capped like the old block, each rendered
   * `- <text>` with an `AVOID: …` suffix line when set. Returns undefined when the
   * scope has no active lessons (the composer omits the section).
   */
  readLessonBlock(scope: string): string | undefined {
    const rows = this.getActiveLessons(scope, resolveLessonCapPerScope(process.env));
    if (rows.length === 0) return undefined;
    const bullets: string[] = [];
    let length = 0;
    for (const row of rows) {
      const bullet = row.avoid ? `- ${row.text}\n  AVOID: ${row.avoid}` : `- ${row.text}`;
      if (bullets.length > 0 && length + 1 + bullet.length > DEFAULT_LESSON_CHAR_CAP) break;
      bullets.push(bullet);
      length += (bullets.length > 1 ? 1 : 0) + bullet.length;
    }
    return bullets.join("\n");
  }

  /**
   * The scope's ACTIVE lessons, most valuable first (reuse_value desc). Equal values
   * tie in READING order (created asc, id asc, ⓪·3f P3) — migrated equal-value lessons
   * render in the same order the legacy block listed them, not reversed.
   */
  getActiveLessons(scope: string, cap?: number): LessonRow[] {
    const limit = cap ?? -1; // SQLite: LIMIT -1 = unbounded
    return this.db.prepare(`
      SELECT ${LESSON_COLUMNS} FROM lessons
      WHERE scope = ? AND status = 'active'
      ORDER BY reuse_value DESC, created_at ASC, id ASC
      LIMIT ?
    `).all<LessonRow>(scope, limit);
  }

  /** All ACTIVE lessons (for `/lessons`), grouped by scope in render order. */
  listLessons(scope?: string): LessonRow[] {
    return scope
      ? this.getActiveLessons(scope)
      : this.db.prepare(`
          SELECT ${LESSON_COLUMNS} FROM lessons
          WHERE status = 'active'
          ORDER BY scope ASC, reuse_value DESC, created_at ASC, id ASC
        `).all<LessonRow>();
  }

  getLesson(id: number): LessonRow | undefined {
    return this.db.prepare(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE id = ?`).get<LessonRow>(id);
  }

  /** Insert one active lesson row; returns its id. `theme` defaults to the column default ('unthemed'). */
  addLesson(input: {
    scope: string;
    text: string;
    avoid?: string;
    theme?: string;
    source: LessonSource;
    created_at?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO lessons (scope, text, avoid, created_at, source, theme)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.scope,
      flattenLessonText(input.text),
      (input.avoid !== undefined ? flattenLessonText(input.avoid) : "") || null,
      input.created_at ?? new Date().toISOString(),
      input.source,
      input.theme ?? UNTHEMED
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Link a supersede pair BIDIRECTIONALLY (ADR 0012 §2): the old row becomes
   * 'superseded' pointing forward, the new row points back. NEVER deletes.
   */
  supersedeLesson(oldId: number, newId: number): void {
    this.db.prepare(`
      UPDATE lessons SET status = 'superseded', superseded_by = ? WHERE id = ?
    `).run(newId, oldId);
    this.db.prepare(`UPDATE lessons SET supersedes = ? WHERE id = ?`).run(oldId, newId);
  }

  /** Rewrite a lesson's text in place (trivial merges only — supersede is the audited path). */
  updateLessonText(id: number, text: string): void {
    this.db.prepare(`UPDATE lessons SET text = ? WHERE id = ?`).run(flattenLessonText(text), id);
  }

  /** Undo a supersede of this lesson (memory A1 migration --revert): active again, no successor. */
  reactivateLesson(id: number): boolean {
    return this.db.prepare(`
      UPDATE lessons SET status = 'active', superseded_by = NULL WHERE id = ? AND status = 'superseded'
    `).run(id).changes === 1;
  }

  /** Attribution (S1→S2 hookup): these lessons were applied to a turn's prompt. */
  touchApplied(ids: number[], now: string = new Date().toISOString()): void {
    const stmt = this.db.prepare(`
      UPDATE lessons SET applied_count = applied_count + 1, last_used = ? WHERE id = ?
    `);
    for (const id of ids) stmt.run(now, id);
  }

  /**
   * Final-review B4: active lessons the omp render cap skipped this turn. Only last_used moves (never applied_count, never
   * credit): decay must not prune a lesson that the cap alone kept out of the prompt.
   */
  touchLessonsSeen(ids: number[], now: string = new Date().toISOString()): void {
    const stmt = this.db.prepare(`UPDATE lessons SET last_used = ? WHERE id = ? AND status = 'active'`);
    for (const id of ids) stmt.run(now, id);
  }

  /** A correction landed against this lesson (the S2 signal path acts on the pattern). */
  recordCorrection(id: number): void {
    this.db.prepare(`UPDATE lessons SET corrected_count = corrected_count + 1 WHERE id = ?`).run(id);
  }

  /** Prune one lesson (the `/forget <id>` control command) — reversible, never deleted. */
  forgetLesson(id: number): boolean {
    return this.db.prepare(`
      UPDATE lessons SET status = 'pruned' WHERE id = ? AND status = 'active'
    `).run(id).changes === 1;
  }

  /** Prune a scope's active lessons (the `/forget <scope>` control command) — reversible. */
  forgetScope(scope: string): void {
    this.db.prepare(`UPDATE lessons SET status = 'pruned' WHERE scope = ? AND status = 'active'`).run(scope);
  }

  /**
   * The full supersede chain a lesson belongs to, oldest → newest (walk `supersedes`
   * back to the root, then `superseded_by` forward). Includes non-active rows.
   */
  lessonLineage(id: number): LessonRow[] {
    let row = this.getLesson(id);
    if (!row) return [];
    const seen = new Set<number>([row.id]);
    while (row.supersedes !== null) {
      const prior = this.getLesson(row.supersedes);
      if (!prior || seen.has(prior.id)) break;
      seen.add(prior.id);
      row = prior;
    }
    const chain: LessonRow[] = [row];
    const walked = new Set<number>([row.id]);
    while (row.superseded_by !== null) {
      const next = this.getLesson(row.superseded_by);
      if (!next || walked.has(next.id)) break;
      walked.add(next.id);
      chain.push(next);
      row = next;
    }
    return chain;
  }

  /**
   * The member ids an N→1 merge folded into a new row: every lesson whose `superseded_by`
   * names `new_id`. Unlike the scalar `supersedes` pointer (which, after {@link RunStore.applyLessonMerge},
   * names only the LAST member), this recovers ALL merged members for undo/inspect.
   */
  lessonsSupersededBy(new_id: number): number[] {
    return this.db
      .prepare(`SELECT id FROM lessons WHERE superseded_by = ? ORDER BY id`)
      .all<{ id: number }>(new_id)
      .map((r) => r.id);
  }

  /**
   * Apply a reconcile verdict (⓪·3 S1b, ADR 0012 §2; memory A1 §2/§5). ADD inserts; SUPERSEDE/UPDATE insert a NEW row
   * linked to the prior (never an in-place rewrite, never a delete); DROP writes nothing. A target that is missing,
   * inactive or in another scope degrades to ADD (⓪·3f P1) — except across the omp scopes (ask ↔ research, rendered as
   * one set): there the new row takes the TARGET's scope, ledgered `lesson_cross_scope` (final-review B2). An UPDATE
   * whose target has another KNOWN theme is not merged: the candidate is saved as an ADD under its own theme; onto an
   * `unthemed` target it merges and takes the candidate's theme (B3). A result whose text is over LESSON_MAX_CHARS or whose AVOID
   * is over LESSON_AVOID_MAX_CHARS is not saved (`capped`; the prior stays), except an UPDATE whose MERGE is over while the
   * candidate fits: the candidate is saved alone as an ADD in its own scope, the target untouched and never pruned for it
   * (`lesson_update_overflow`, ADR 0005 amendment 2026-10-06). An UPDATE inherits the target's
   * reuse_value, applied_count and theme. Overflow beyond the per-scope cap prunes the lowest reuse_value rows.
   */
  saveReconciledLesson(
    candidate: { scope: string; text: string; avoid?: string; theme?: string },
    verdict: LessonReconcileVerdict,
    source: LessonSource,
    now: string,
    cap: number = resolveLessonCapPerScope(process.env),
    repeatDays: number = resolveLessonRepeatDays(process.env)
  ): LessonSaveResult {
    const text = candidate.text.trim();
    if (verdict.verdict === "DROP") return { verb: "drop", lesson: text, prunedIds: [] };
    const target = verdict.verdict === "ADD" ? undefined : this.reconcileTarget(verdict.id, candidate.scope);
    const known = candidate.theme !== undefined && candidate.theme !== UNTHEMED ? candidate.theme : undefined;
    // Spec §5: only a candidate with a KNOWN theme other than the target's KNOWN theme is refused a merge.
    if (target && verdict.verdict === "UPDATE" && known !== undefined && target.theme !== UNTHEMED && known !== target.theme) {
      return this.saveAsAdd({ ...candidate, text, theme: known }, target.id, source, now, cap, { event: "lesson_cross_theme" });
    }
    const update = verdict.verdict === "UPDATE" && target !== undefined;
    const theme = update && target.theme !== UNTHEMED ? target.theme : known ?? UNTHEMED;
    const scope = target?.scope ?? candidate.scope;
    const merged = update && verdict.text?.trim() ? verdict.text.trim() : text;
    // UPDATE supplements: the revised row inherits the prior AVOID unless the candidate brings one.
    const avoid = candidate.avoid?.trim() || (update && target.avoid ? target.avoid : undefined);
    if (update && overLessonCap(merged, avoid) && !overLessonCap(text, candidate.avoid?.trim())) {
      // The merge outgrew the cap but the new rule fits: save it alone (ADR 0005 amendment 2026-10-06). The target keeps
      // what it said; a near-duplicate is the accepted cost of never losing an instruction.
      return this.saveAsAdd({ ...candidate, text, theme }, target.id, source, now, cap, { event: "lesson_update_overflow", merged_chars: merged.length });
    }
    const capped = this.lessonOverCap(merged, avoid, verdict.verdict, target?.id ?? null);
    if (capped) return capped;
    const id = this.addLesson({ scope, text: merged, ...(avoid ? { avoid } : {}), theme, source, created_at: now });
    if (target) this.supersedeLesson(target.id, id);
    if (target && target.scope !== candidate.scope) this.recordMemoryEvent("lesson_cross_scope", { verdict: verdict.verdict, target_id: target.id });
    if (update) this.inheritLessonStanding(target, id);
    const escalate = verdict.verdict === "SUPERSEDE" && target ? this.payForSupersede(target, id, now, repeatDays) : false;
    const prunedIds = this.pruneScopeOverflow(scope, cap, [id]);
    const verb: LessonWriteVerb = !target ? "add" : update ? "update" : "supersede";
    return { verb, id, ...(target ? { supersededId: target.id } : {}), lesson: merged, prunedIds, ...(escalate ? { escalate: true } : {}) };
  }

  /** An active target in the candidate's scope, or in the other omp scope (B2); otherwise none (the verdict becomes ADD). */
  private reconcileTarget(id: number, scope: string): LessonRow | undefined {
    const prior = this.getLesson(id);
    if (prior?.status !== "active") return undefined;
    const omp = (OMP_LESSON_SCOPES as readonly string[]);
    return prior.scope === scope || (omp.includes(prior.scope) && omp.includes(scope)) ? prior : undefined;
  }

  /** Spec §2: a write over either cap is refused, ledgered, and reported as `capped` (the prior row is untouched). */
  private lessonOverCap(
    text: string, avoid: string | undefined, verdict: LessonReconcileVerdict["verdict"], target_id: number | null
  ): LessonSaveResult | undefined {
    const avoidChars = avoid?.length ?? 0;
    if (!overLessonCap(text, avoid)) return undefined;
    this.recordMemoryEvent("lesson_write_capped", { verdict, target_id, chars: text.length, avoid_chars: avoidChars });
    return { verb: "capped", lesson: text, prunedIds: [], ...(target_id !== null ? { cappedTargetId: target_id } : {}) };
  }

  /**
   * The candidate lands as its own lesson and the target stays: a cross-theme UPDATE (spec §5: merging is same-theme
   * only) or a merge that outgrew the cap (`lesson_update_overflow`).
   */
  private saveAsAdd(
    candidate: { scope: string; text: string; avoid?: string; theme: string },
    targetId: number,
    source: LessonSource,
    now: string,
    cap: number,
    why: { event: "lesson_cross_theme" } | { event: "lesson_update_overflow"; merged_chars: number }
  ): LessonSaveResult {
    const avoid = candidate.avoid?.trim() || undefined;
    const capped = this.lessonOverCap(candidate.text, avoid, "ADD", null);
    if (capped) return capped;
    const id = this.addLesson({ scope: candidate.scope, text: candidate.text, ...(avoid ? { avoid } : {}), theme: candidate.theme, source, created_at: now });
    const { event, ...extra } = why;
    this.recordMemoryEvent(event, { candidate: id, target: targetId, ...extra });
    // The overflow ADD promised the target stays: it is never the row the scope cap prunes to make room.
    const keep = why.event === "lesson_update_overflow" ? [id, targetId] : [id];
    return { verb: "add", id, lesson: candidate.text, prunedIds: this.pruneScopeOverflow(candidate.scope, cap, keep) };
  }

  /** Spec §2: an UPDATE keeps the target's earned standing (a rewrite must not drop in rank). */
  private inheritLessonStanding(target: LessonRow, id: number): void {
    this.db.prepare(`UPDATE lessons SET reuse_value = ?, applied_count = ? WHERE id = ?`)
      .run(target.reuse_value, target.applied_count, id);
  }

  /**
   * ⓪·3 S2b: a SUPERSEDE is a correction against the target (reuse −0.5). A recent supersede already in the chain,
   * or a target corrected repeatedly, marks the memory layer ineffective → escalate (layer-routing iii).
   */
  private payForSupersede(target: LessonRow, id: number, now: string, repeatDays: number): boolean {
    this.recordCorrection(target.id);
    this.db.prepare(`UPDATE lessons SET reuse_value = reuse_value - 0.5 WHERE id = ?`).run(target.id);
    const cutoff = new Date(Date.parse(now) - repeatDays * 86_400_000).toISOString();
    const repeatInLineage = this.lessonLineage(target.id).some(
      (row) => row.id !== id && row.supersedes !== null && row.created_at >= cutoff
    );
    return repeatInLineage || target.corrected_count + 1 >= 2;
  }

  /** Prune (reversibly) the lowest-value active rows over the scope cap, sparing `keepId`. */
  private pruneScopeOverflow(scope: string, cap: number, keepIds: readonly number[]): number[] {
    if (cap <= 0) return [];
    const keep = new Set(keepIds);
    const active = this.db.prepare(`
      SELECT id FROM lessons
      WHERE scope = ? AND status = 'active'
      ORDER BY reuse_value ASC, COALESCE(last_used, created_at) ASC, id ASC
    `).all<{ id: number }>(scope);
    const others = active.filter((r) => !keep.has(r.id));
    const kept = active.length - others.length;
    const toPrune = others.slice(0, Math.max(0, others.length + kept - cap)).map((r) => r.id);
    for (const id of toPrune) {
      this.db.prepare(`UPDATE lessons SET status = 'pruned' WHERE id = ?`).run(id);
    }
    return toPrune;
  }

  /**
   * A Telegram quote resolved to the stored turn it replies to (spec §2.2.1), code only; Telegram's own copy of the
   * quoted text is never read. Houge's reply: this chat's outbox row whose provider id is `telegram:<id>` → that run's
   * one assistant turn. Paco's message: the run born from `telegram:update:*:message:<id>` in this chat → its one user
   * turn. Telegram message ids are per chat, so every lookup is scoped to `chat_id`.
   */
  resolveQuotedTurn(chat_id: string, reply_to_message_id: number): QuoteResolution {
    if (!Number.isSafeInteger(reply_to_message_id) || reply_to_message_id <= 0) return { ok: false, reason: "no_mapping" };
    const sent = this.db.prepare(`
      SELECT run_id, intent_type, idempotency_key FROM notification_outbox
      WHERE provider_message_id = ? AND target_key = ? AND run_id IS NOT NULL
    `).all<{ run_id: string; intent_type: string; idempotency_key: string }>(`telegram:${reply_to_message_id}`, `telegram:${chat_id}`);
    return sent.length > 0 ? this.quotedHougeTurn(chat_id, sent) : this.quotedUserTurn(chat_id, reply_to_message_id);
  }

  /**
   * Only a run's `final_report` maps to its answer, and never an evolution report (queued as `final_report` too, under
   * `<run>:evolution_report:<tool>`). The run must hold exactly one assistant turn outside `evolution_report` (`IS NOT`
   * keeps a NULL-intent reply); none or several is unresolved, never a guess.
   */
  private quotedHougeTurn(chat_id: string, sent: Array<{ run_id: string; intent_type: string; idempotency_key: string }>): QuoteResolution {
    const runs = [...new Set(sent.filter((r) => r.intent_type === "final_report" && !r.idempotency_key.includes(":evolution_report:")).map((r) => r.run_id))];
    const [run] = runs;
    if (run === undefined) return { ok: false, reason: "not_final" };
    if (runs.length > 1) return { ok: false, reason: "ambiguous" };
    const turns = this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
      FROM chat_turns
      WHERE run_id = ? AND chat_id = ? AND role = 'assistant' AND intent IS NOT 'evolution_report'
      ORDER BY created_at ASC, rowid ASC
      LIMIT 2
    `).all<ChatTurnRow>(run, chat_id);
    return oneTurn(turns, "houge");
  }

  /** LIKE anchors both ends: `…:message:12` never matches `…:message:123` (the id is digits, never a wildcard). */
  private quotedUserTurn(chat_id: string, messageId: number): QuoteResolution {
    const runs = this.db.prepare(`
      SELECT run_id FROM runs
      WHERE source = 'telegram' AND source_reference LIKE ?
        AND json_extract(notify_json, '$.kind') = 'telegram' AND json_extract(notify_json, '$.chat_id') = ?
    `).all<{ run_id: string }>(`telegram:update:%:message:${messageId}`, chat_id);
    const [run] = runs;
    if (run === undefined) return { ok: false, reason: "no_mapping" };
    if (runs.length > 1) return { ok: false, reason: "ambiguous" };
    const turns = this.db.prepare(`
      SELECT turn_id, chat_id, run_id, role, text, intent, created_at, quoted_turn_id
      FROM chat_turns
      WHERE run_id = ? AND chat_id = ? AND role = 'user'
      ORDER BY created_at ASC, rowid ASC
      LIMIT 2
    `).all<ChatTurnRow>(run.run_id, chat_id);
    return oneTurn(turns, "user");
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

  recordRunCompleted(
    run_id: string,
    report_ref: string,
    duration_ms: number,
    /** ACTUAL capability calls when the caller tracked a shared ledger (default: the single-call legacy stamp). */
    budget_used: { tool_calls: number } = { tool_calls: 1 }
  ): void {
    this.appendRunLedgerEvent(run_id, "run_completed", "core", {
      report_ref,
      budget_used,
      duration_ms
    });
  }

  recordRunFailed(
    run_id: string,
    error_ref: string,
    recoverable: boolean,
    error_type: string = "worker_error"
  ): void {
    this.appendRunLedgerEvent(run_id, "run_failed", "core", {
      error_type,
      error_ref,
      recoverable
    });
  }

  /**
   * Atomic, owner-checked terminal write for a detached planner turn (spec §7.1): the state
   * flip and the terminal ledger event commit together, and only the current lease owner wins —
   * a stale supervisor whose run was reclaimed gets `false` and writes nothing.
   */
  finishRun(input: FinishRunInput): boolean {
    let active = false;
    this.db.exec("BEGIN IMMEDIATE");
    active = true;
    try {
      const updated = this.db.prepare(`
        UPDATE runs SET state = ?, state_reason = COALESCE(?, state_reason), worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE run_id = ? AND worker_id = ? AND state = 'running'
      `).run(input.next, input.next === "failed" ? input.error_type : null, new Date().toISOString(), input.run_id, input.expected_worker_id);
      if (updated.changes === 1) {
        if (input.next === "completed") {
          this.appendRunLedgerEvent(input.run_id, "run_completed", "core", {
            report_ref: input.report_ref,
            budget_used: { tool_calls: input.tool_calls },
            duration_ms: input.duration_ms
          });
        } else {
          this.appendRunLedgerEvent(input.run_id, "run_failed", "core", {
            error_type: input.error_type,
            error_ref: input.error_ref,
            recoverable: false
          });
        }
      } else {
        console.warn(`[run-store] terminal_lost run=${input.run_id} owner=${input.expected_worker_id}`);
      }
      this.db.exec("COMMIT");
      active = false;
      return updated.changes === 1;
    } catch (error) {
      if (active) this.db.exec("ROLLBACK");
      throw error;
    }
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
      /** At most 200 code points (the focus summary); the full focus never lands in the ledger. */
      summary: string;
      /** The full focus's length in code points (the summary's unit). */
      focus_chars: number;
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
    payload: { attempted_paths: Array<Record<string, unknown>>; context: string; focus_chars: number }
  ): void {
    this.appendRunLedgerEvent(run_id, "self_write_blocked", "core", payload);
  }

  recordSelfWriteFailed(run_id: string, payload: { reason: string; last_output: string }): void {
    this.appendRunLedgerEvent(run_id, "self_write_failed", "core", payload);
  }

  /**
   * Money-Work Phase P1 external-work audit (ADR 0023). Two outcomes, each a structured
   * run-store event (audit trail + future dashboard source). The Telegram notification rides
   * the evolution lane's completion notification, not these events. Records the repo url +
   * task + local patch ref ONLY — never the external repo's code or diff.
   */
  recordExternalWorkPublished(
    run_id: string,
    payload: { repo_url: string; task: string; patch_ref: string; gate: string }
  ): void {
    this.appendRunLedgerEvent(run_id, "external_work_published", "core", payload);
  }

  recordExternalWorkFailed(
    run_id: string,
    payload: { repo_url: string; task: string; reason: string }
  ): void {
    this.appendRunLedgerEvent(run_id, "external_work_failed", "core", payload);
  }

  /**
   * Inner-loop observation hooks (ADR 0013, step ⓪·1) — read-only audit trail.
   * `loop_started.applied_artifacts` is the attribution seed (which lesson/skill scope
   * blocks were injected); `loop_step` records each step's action/capability + the
   * truncated result digest (never full payloads); `loop_halted` records why.
   */
  recordLoopStarted(
    run_id: string,
    payload: { manifest: string[]; hint: string; applied_artifacts: Record<string, unknown>; retrieval?: Record<string, unknown> }
  ): void {
    this.appendRunLedgerEvent(run_id, "loop_started", "core", payload);
  }

  recordLoopStep(
    run_id: string,
    payload: {
      step: number;
      action: string;
      capability: string;
      ok: boolean;
      result_digest: string;
      // Dual-LLM audit (ADR 0014): true when this step's raw output was routed through the
      // quarantined reader. OPTIONAL — absent on every non-quarantined step and when Dual-LLM
      // is OFF, so the required loop_step schema is unchanged.
      reader_applied?: boolean;
    }
  ): void {
    this.appendRunLedgerEvent(run_id, "loop_step", "core", payload);
  }

  recordLoopHalted(run_id: string, payload: { reason: string; steps: number }): void {
    this.appendRunLedgerEvent(run_id, "loop_halted", "core", payload);
  }


  /** Multimodal ingest (spec 2026-09-29): one `media_ingested` row per media turn. */
  recordMediaIngested(run_id: string, payload: MediaIngestedPayload): void {
    this.appendRunLedgerEvent(run_id, "media_ingested", "core", { ...payload });
  }

  /**
   * The audit chokepoint's ledger sink (spec 2026-09-04 §"Slice 2"; review 2026-09-06 W1).
   * One `llm_attempt` row per call — run-scoped (`appendRunLedgerEvent`) or run-less
   * (`appendLedgerEvent` under a `tick:*` / `cli:*` / `rating:*` correlation id, the
   * `recordEvalCompleted` precedent). The scoped ROLE overrides whatever the chain passed: the
   * chain does not know a call's purpose.
   *
   * Pricing happens HERE, the one seam every path shares (ADR 0019): only a METERED provider
   * gets a `cost_usd`; a flat-rate leg's self-reported list price is a phantom and is stripped.
   * Cost reads `output_tokens` alone — `thinking_tokens` is informational and already inside it.
   * Best-effort by contract: a failed write logs a warning and never fails the caller.
   *
   * Cross-process (the daemon plus a `cli:*` writer on the same file) can mint the same global
   * `sequence`; `event_id` is the primary key so both rows land and readers tie-break on
   * `occurred_at, event_id` — benign, the `recordEvalCompleted` precedent; not worth serializing
   * every LLM call behind `BEGIN IMMEDIATE`.
   */
  llmAuditSink(scope: LlmAuditScope): LlmAuditSink {
    return {
      record: (attempt: LlmAttempt): void => {
        try {
          const payload: Record<string, unknown> = {
            provider: attempt.provider,
            role: scope.role,
            outcome: attempt.outcome
          };
          if (attempt.outcome === "ok" && attempt.model === undefined) {
            console.warn(
              `[llm-audit] ok attempt from ${attempt.provider} carries no model — recording "unknown"`
            );
            payload.model = "unknown";
          } else if (attempt.model !== undefined) {
            payload.model = attempt.model;
          }
          if (attempt.latency_ms !== undefined) payload.latency_ms = attempt.latency_ms;
          if (attempt.error_kind !== undefined) payload.error_kind = attempt.error_kind;
          if (attempt.attempt_group !== undefined) payload.attempt_group = attempt.attempt_group;
          if (attempt.leg_index !== undefined) payload.leg_index = attempt.leg_index;
          if (attempt.usage) {
            const { cost_usd: selfReported, ...usage } = attempt.usage;
            payload.input_tokens = usage.input_tokens;
            payload.output_tokens = usage.output_tokens;
            payload.cached_input_tokens = usage.cached_input_tokens;
            if (usage.thinking_tokens !== undefined) payload.thinking_tokens = usage.thinking_tokens;
            if (METERED_PROVIDERS.has(attempt.provider)) {
              // `null` = unknown metered model (warned once inside computeCostUsd); fall back to
              // the provider's own figure if it reported one, else leave the row unpriced.
              const cost =
                computeCostUsd(attempt.provider, String(payload.model ?? ""), usage, process.env) ??
                selfReported;
              if (cost !== undefined) payload.cost_usd = cost;
            }
          }
          if (attempt.credential_id !== undefined) payload.credential_id = attempt.credential_id;
          if (attempt.ttft_ms !== undefined) payload.ttft_ms = attempt.ttft_ms;
          if (attempt.family !== undefined) payload.family = attempt.family;
          if (attempt.family_collapse) payload.family_collapse = true;
          if (attempt.request_key !== undefined) payload.request_key = attempt.request_key;
          if ("run_id" in scope) {
            this.appendRunLedgerEvent(scope.run_id, "llm_attempt", "capability_runner", payload);
          } else {
            this.appendLedgerEvent(
              createLedgerEvent({
                correlation_id: scope.correlation_id,
                event_type: "llm_attempt",
                actor: "capability_runner",
                sequence: this.nextLedgerSequence(),
                payload
              })
            );
          }
          if (attempt.family_collapse) this.appendWallCollapse(scope, attempt, payload);
        } catch (error) {
          // A repeated request_key is the dedupe contract (unique index): a silent no-op.
          if (isUniqueConstraintError(error)) return;
          console.warn(
            `[llm-audit] failed to record ${scope.role} attempt (non-fatal): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    };
  }

  private appendWallCollapse(
    scope: LlmAuditScope,
    attempt: LlmAttempt,
    payload: Record<string, unknown>
  ): void {
    const collapse = {
      request_key: attempt.request_key ?? "",
      family: attempt.family ?? "",
      provider: attempt.provider,
      model: String(payload.model ?? "")
    };
    if ("run_id" in scope) {
      this.appendRunLedgerEvent(scope.run_id, "wall_collapse", "capability_runner", collapse);
      return;
    }
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: scope.correlation_id,
        event_type: "wall_collapse",
        actor: "capability_runner",
        sequence: this.nextLedgerSequence(),
        payload: collapse
      })
    );
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
      // A planner turn may already have produced side effects: fail it, never requeue (spec §7.2).
      if ((row.worker_id ?? "").startsWith("planner:")) {
        return this.failExpiredPlannerRow(row) ? [{ run_id: row.run_id, action: "failed" as const }] : [];
      }
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

  /**
   * Only planner-owned expired leases (B1: the daemon runs this at boot and on a timer). An inline executeRun
   * claims 30 s and never heartbeats, so a generic recovery would requeue a run that is still executing.
   */
  recoverExpiredPlannerLeases(now: string): Array<{ run_id: string; worker_id: string }> {
    const rows = this.db.prepare(`
      SELECT run_id, state, contract_json, attempt_count, created_at, worker_id, lease_expires_at
      FROM runs
      WHERE state = 'running' AND lease_expires_at <= ? AND worker_id LIKE 'planner:%'
      ORDER BY created_at ASC, run_id ASC
    `).all<RunRow>(now);
    return rows.flatMap((row) => (this.failExpiredPlannerRow(row) ? [{ run_id: row.run_id, worker_id: row.worker_id ?? "" }] : []));
  }

  /** Fail one expired planner run, keyed on the observed owner and expiry (one transaction per row). */
  private failExpiredPlannerRow(row: RunRow): boolean {
    const failed = this.db.prepare(`
      UPDATE runs SET state = 'failed', state_reason = 'lease_expired', worker_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE run_id = ? AND state = 'running' AND worker_id = ? AND lease_expires_at = ?
    `).run(new Date().toISOString(), row.run_id, row.worker_id, row.lease_expires_at);
    if (failed.changes !== 1) return false;
    this.appendRunLedgerEvent(row.run_id, "run_failed", "system", { error_type: "lease_expired", error_ref: row.worker_id ?? "", recoverable: false });
    return true;
  }

  /** Turn runs still queued from before `before` (a boot): nothing will ever dispatch them (B1). */
  listQueuedTurnRunsBefore(before: string): string[] {
    return this.db.prepare(`
      SELECT run_id FROM runs WHERE state = 'queued' AND type = 'turn' AND created_at < ? ORDER BY created_at ASC, run_id ASC
    `).all<{ run_id: string }>(before).map((r) => r.run_id);
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

  // --- Metered-API $ ceiling (ADR 0019) -----------------------------------

  /**
   * Metered spend, DERIVED from `llm_attempt` rows with `outcome = 'ok'`, unioned with the
   * pre-2026-09-06 `llm_call` history (never rewritten; its `gemini-api` output figures
   * undercount ~5×, see the ADR 0019 amendment) — `cost_usd` is populated at the recording
   * seam via src/llm/metered-pricing.ts, no second bookkeeping:
   *   - `daily_usd`   — rolling 24h window (same precedent as the count caps),
   *   - `monthly_usd` — the calendar month (UTC) containing `now` (how the bill arrives).
   * Events without a `cost_usd` (flat-rate legs, unknown metered models) contribute 0.
   */
  meteredSpendUsd(now: string): { daily_usd: number; monthly_usd: number } {
    const windowStart = this.addSeconds(now, -GLOBAL_BUDGET_WINDOW_HOURS * 3600);
    const daily = this.db.prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(payload_json, '$.cost_usd') AS REAL)), 0) AS spend
      FROM ledger_events
      WHERE (
        event_type = 'llm_call'
        OR (event_type = 'llm_attempt' AND json_extract(payload_json, '$.outcome') = 'ok')
      )
        AND json_extract(payload_json, '$.cost_usd') IS NOT NULL
        AND occurred_at > ?
    `).get<{ spend: number }>(windowStart);
    // UTC calendar-month bounds, computed in JS — never `strftime('%Y-%m', occurred_at) =
    // strftime('%Y-%m', ?)` (codex review, Task 12 fix 4): that equality can't be bound by the
    // `ledger_events_type_time_idx` (event_type, occurred_at) index, so every tick's
    // `checkMeteredCeiling` scanned all history of the type instead of one month's worth. A
    // `>= start AND < end` range on the same column IS sargable.
    const nowDate = new Date(now);
    const monthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)).toISOString();
    const monthEnd = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1)).toISOString();
    const monthly = this.db.prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(payload_json, '$.cost_usd') AS REAL)), 0) AS spend
      FROM ledger_events
      WHERE (
        event_type = 'llm_call'
        OR (event_type = 'llm_attempt' AND json_extract(payload_json, '$.outcome') = 'ok')
      )
        AND json_extract(payload_json, '$.cost_usd') IS NOT NULL
        AND occurred_at >= ? AND occurred_at < ?
    `).get<{ spend: number }>(monthStart, monthEnd);
    return { daily_usd: daily?.spend ?? 0, monthly_usd: monthly?.spend ?? 0 };
  }

  /**
   * Per-model token/cost breakdown, DERIVED from `llm_attempt` rows with `outcome = 'ok'`,
   * unioned with the pre-2026-09-06 `llm_call` history (never rewritten; its `gemini-api`
   * output figures undercount ~5×, see the ADR 0019 amendment) — the same source as
   * {@link meteredSpendUsd} — powers `houge usage`. Groups by provider+model, summing calls,
   * input/output tokens, and cost_usd (unpriced events contribute 0 to cost). An optional
   * `sinceIso` scopes to calls strictly after that instant; omitted → all time. Pure read.
   */
  usageByModel(sinceIso?: string): Array<{
    provider: string;
    model: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }> {
    return this.db.prepare(`
      SELECT
        json_extract(payload_json, '$.provider') AS provider,
        json_extract(payload_json, '$.model') AS model,
        COUNT(*) AS calls,
        COALESCE(SUM(CAST(json_extract(payload_json, '$.input_tokens') AS INTEGER)), 0) AS input_tokens,
        COALESCE(SUM(CAST(json_extract(payload_json, '$.output_tokens') AS INTEGER)), 0) AS output_tokens,
        COALESCE(SUM(CAST(json_extract(payload_json, '$.cost_usd') AS REAL)), 0) AS cost_usd
      FROM ledger_events
      WHERE (
        event_type = 'llm_call'
        OR (event_type = 'llm_attempt' AND json_extract(payload_json, '$.outcome') = 'ok')
      )
        AND (? IS NULL OR occurred_at > ?)
      GROUP BY provider, model
      ORDER BY cost_usd DESC, calls DESC
    `).all<{
      provider: string;
      model: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>(sinceIso ?? null, sinceIso ?? null);
  }

  /**
   * Single-row latch so exactly ONE alert fires per metered-fuse episode (the twin of
   * {@link armGlobalFuseIfNeeded}). `armed: true` only on the 0→1 transition.
   */
  armMeteredFuseIfNeeded(now: string): { armed: boolean; since: string } {
    const row = this.db.prepare(`
      SELECT fused, since FROM metered_fuse_state WHERE id = 1
    `).get<{ fused: number; since: string | null }>();

    if (row && row.fused === 1 && row.since) {
      return { armed: false, since: row.since };
    }

    this.db.prepare(`
      UPDATE metered_fuse_state SET fused = 1, since = ? WHERE id = 1
    `).run(now);
    return { armed: true, since: now };
  }

  /** Disarm once spend falls back under both ceilings (the window rolled) — a future episode alerts again. */
  disarmMeteredFuse(): void {
    this.db.prepare(`
      UPDATE metered_fuse_state SET fused = 0, since = NULL WHERE id = 1 AND fused = 1
    `).run();
  }

  /**
   * Cheap latch read consulted by the chain builder on EVERY LLM call (enforcement is
   * latch-driven — the sums above run once per poll tick, not per call). DEFENSIVE:
   * any error reads as "not breached" — the ceiling is a cost net, not a security gate,
   * and a broken latch must never take the answer path down with it.
   */
  meteredFuseLatched(): boolean {
    try {
      const row = this.db.prepare(`
        SELECT fused FROM metered_fuse_state WHERE id = 1
      `).get<{ fused: number }>();
      return row?.fused === 1;
    } catch {
      return false;
    }
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

  /**
   * Most recent failed run's reason WITHIN the /status ACTIVITY window, or null.
   * Scoped to the same window as runCountsByStateSince — an undated all-time error
   * under a "24h" header reads as fresh (operator confusion, 2026-07-27: a July-5
   * tool timeout looked like a live fault three weeks later).
   */
  lastRunError(now: string): string | null {
    const windowStart = this.addSeconds(now, -GLOBAL_BUDGET_WINDOW_HOURS * 3600);
    const row = this.db.prepare(`
      SELECT state_reason
      FROM runs
      WHERE state = 'failed' AND updated_at > ?
      ORDER BY updated_at DESC, run_id DESC
      LIMIT 1
    `).get<{ state_reason: string | null }>(windowStart);
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

  // --- Self-write reload marker (⓪·2c U2 / ADR 0012 D4 stage 1) -------------

  /**
   * Durably record a green self-write merge JUST BEFORE the restart, so the rebooted
   * daemon can confirm the reload. Single-row (like daemon_heartbeat): a newer merge
   * overwrites an unconsumed marker.
   */
  writeReloadMarker(input: { sha: string; subject: string; branch: string; merged_at?: string }): void {
    this.db.prepare(`
      INSERT INTO reload_marker (id, sha, subject, branch, merged_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sha = excluded.sha,
        subject = excluded.subject,
        branch = excluded.branch,
        merged_at = excluded.merged_at
    `).run(input.sha, input.subject, input.branch, input.merged_at ?? new Date().toISOString());
  }

  /**
   * Read AND delete the reload marker atomically (exactly-once: the boot confirmation
   * fires on the first startup after a merge, then stays silent). Null when none.
   */
  consumeReloadMarker(): ReloadMarker | null {
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const row = this.db.prepare(`
        SELECT sha, subject, branch, merged_at FROM reload_marker WHERE id = 1
      `).get<ReloadMarker>();
      if (row) {
        this.db.prepare(`DELETE FROM reload_marker WHERE id = 1`).run();
      }
      this.db.exec("COMMIT");
      activeTransaction = false;
      return row ?? null;
    } catch (error) {
      if (activeTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  // --- Daemon boot record (houge_status, 2026-10-02) ------------------------

  /** Record this daemon boot and keep only the newest {@link DAEMON_BOOTS_KEPT}. */
  recordDaemonBoot(b: DaemonBootInput): void {
    this.db.prepare(`
      INSERT INTO daemon_boots (boot_id, started_at, pid, reason, reload_sha, reload_subject, reload_branch, reload_merged_at,
        head_sha, head_subject, head_committed_at, build_input_committed_at, dist_built_at, src_newer_than_dist)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(b.boot_id, b.started_at, b.pid, b.reason, b.reload_sha, b.reload_subject, b.reload_branch, b.reload_merged_at,
      b.head_sha, b.head_subject, b.head_committed_at, b.build_input_committed_at ?? null, b.dist_built_at, b.src_newer_than_dist ? 1 : 0);
    this.db.prepare(`
      DELETE FROM daemon_boots WHERE seq NOT IN (SELECT seq FROM daemon_boots ORDER BY seq DESC LIMIT ?)
    `).run(DAEMON_BOOTS_KEPT);
    this.db.prepare(`DELETE FROM boot_chat_notes WHERE boot_id NOT IN (SELECT boot_id FROM daemon_boots)`).run();
  }

  /** Whether this boot's restart note already went to the chat (a peek: the claim happens at dispatch). */
  hasRestartNote(boot_id: string, chat_id: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM boot_chat_notes WHERE boot_id = ? AND chat_id = ?`).get<{ hit: number }>(boot_id, chat_id) !== undefined;
  }

  /** The restart note goes to a chat once per boot: true only for the first claim of (boot, chat). */
  claimRestartNote(boot_id: string, chat_id: string, now: string = new Date().toISOString()): boolean {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO boot_chat_notes (boot_id, chat_id, noted_at) VALUES (?, ?, ?)
    `).run(boot_id, chat_id, now);
    return r.changes === 1;
  }

  getPlannerSessionState(chat_id: string): PlannerSessionState | undefined {
    return this.db.prepare(`
      SELECT chat_id, lesson_fingerprint, pending_fingerprint, seed_pending, updated_at FROM planner_session_state WHERE chat_id = ?
    `).get<PlannerSessionState>(chat_id);
  }

  /** A fresh omp session was started for this lesson set: store it as PENDING, mark the seed pending, ledger the reset. */
  recordPlannerSessionReset(chat_id: string, lesson_fingerprint: string, now: string): void {
    this.inTransaction(() => {
      this.db.prepare(`
        INSERT INTO planner_session_state (chat_id, lesson_fingerprint, pending_fingerprint, seed_pending, updated_at) VALUES (?, '', ?, 1, ?)
        ON CONFLICT(chat_id) DO UPDATE SET pending_fingerprint = excluded.pending_fingerprint, seed_pending = 1, updated_at = excluded.updated_at
      `).run(chat_id, lesson_fingerprint, now);
      this.recordMemoryEvent("planner_session_reset", { reason: "lesson_change", chat_id }, `planner:${chat_id}`);
    });
  }

  /** Set an ACTIVE lesson's theme (memory A1: the migration's theme step, and fingerprint tests); false when missing or not active. */
  setLessonTheme(id: number, theme: string): boolean {
    return this.db.prepare(`UPDATE lessons SET theme = ? WHERE id = ? AND status = 'active'`).run(theme, id).changes === 1;
  }

  /** The first dispatch after a reset made the new transcript non-empty: commit its fingerprint. True when one was pending. */
  promotePlannerSession(chat_id: string): boolean {
    return this.db.prepare(`
      UPDATE planner_session_state SET lesson_fingerprint = pending_fingerprint, pending_fingerprint = NULL
      WHERE chat_id = ? AND pending_fingerprint IS NOT NULL
    `).run(chat_id).changes === 1;
  }

  /** A spawn resumed the committed transcript (no reset needed): an unprompted reset and its seed no longer apply. */
  dropPendingPlannerSession(chat_id: string): void {
    this.db.prepare(`
      UPDATE planner_session_state SET pending_fingerprint = NULL, seed_pending = 0 WHERE chat_id = ? AND pending_fingerprint IS NOT NULL
    `).run(chat_id);
  }

  /** The seed goes to one dispatch: true only for the first claim after a reset. */
  claimSessionSeed(chat_id: string): boolean {
    return this.db.prepare(`
      UPDATE planner_session_state SET seed_pending = 0 WHERE chat_id = ? AND seed_pending = 1
    `).run(chat_id).changes === 1;
  }

  /**
   * The seed's source (memory A1 §6): pick the last `runLimit` qualifying RUNS (completed, Telegram — so never
   * schedule-born — and not `excludeRunId`), then return every user turn of those runs, oldest first. A run that holds
   * two user turns contributes both; LIMIT applies to runs, never to turns. Only turns at/after `since` qualify.
   */
  recentTelegramUserTurns(chat_id: string, excludeRunId: string, runLimit: number, since: string): ChatTurnRow[] {
    return this.db.prepare(`
      WITH picked AS (
        SELECT u.run_id, MAX(u.created_at) AS last_at
        FROM chat_turns u JOIN runs r ON r.run_id = u.run_id
        WHERE u.chat_id = ? AND u.role = 'user' AND r.source = 'telegram' AND r.state = 'completed' AND u.run_id <> ?
          AND u.created_at >= ?
        GROUP BY u.run_id
        ORDER BY last_at DESC
        LIMIT ?
      )
      SELECT u.turn_id, u.chat_id, u.run_id, u.role, u.text, u.intent, u.created_at, u.quoted_turn_id
      FROM chat_turns u
      WHERE u.chat_id = ? AND u.role = 'user' AND u.run_id IN (SELECT run_id FROM picked)
      ORDER BY u.created_at ASC, u.rowid ASC
    `).all<ChatTurnRow>(chat_id, excludeRunId, since, runLimit, chat_id);
  }

  /** The newest boot (the live one, once the daemon recorded it), or null if none was ever recorded. */
  getLatestDaemonBoot(): DaemonBoot | null {
    const row = this.db.prepare(`
      SELECT boot_id, started_at, pid, reason, reload_sha, reload_subject, reload_branch, reload_merged_at,
        head_sha, head_subject, head_committed_at, build_input_committed_at, dist_built_at, src_newer_than_dist, stopped_at
      FROM daemon_boots ORDER BY seq DESC LIMIT 1
    `).get<Omit<DaemonBoot, "src_newer_than_dist"> & { src_newer_than_dist: number }>();
    return row ? { ...row, src_newer_than_dist: row.src_newer_than_dist === 1 } : null;
  }

  countDaemonBoots(): number {
    return this.db.prepare(`SELECT COUNT(*) AS count FROM daemon_boots`).get<{ count: number }>()?.count ?? 0;
  }

  /** The daemon loop exited cleanly: the next boot reads this to tell a clean stop from a crash. */
  markDaemonBootStopped(boot_id: string, at: string): void {
    this.db.prepare(`UPDATE daemon_boots SET stopped_at = ? WHERE boot_id = ?`).run(at, boot_id);
  }

  /** The unconsumed reload marker (a merge waiting for its restart) else the newest boot that consumed one. */
  getLastSelfWriteMerge(): SelfWriteMergeRecord | null {
    const pending = this.db.prepare(`SELECT sha, branch, merged_at FROM reload_marker WHERE id = 1`)
      .get<{ sha: string; branch: string; merged_at: string }>();
    if (pending) return { branch: pending.branch, sha: pending.sha, merged_at: pending.merged_at, pending: true };
    const row = this.db.prepare(`
      SELECT reload_sha AS sha, reload_branch AS branch, reload_merged_at AS merged_at FROM daemon_boots
      WHERE reload_sha IS NOT NULL ORDER BY seq DESC LIMIT 1
    `).get<{ sha: string; branch: string | null; merged_at: string | null }>();
    return row ? { branch: row.branch ?? "unknown", sha: row.sha, merged_at: row.merged_at ?? "unknown", pending: false } : null;
  }

  /** The provider/model of the newest ok planner (`compose`) attempt in a run of this chat; null when none. */
  lastPlannerModel(chat_id: string): { provider: string; model: string } | null {
    const row = this.db.prepare(`
      SELECT json_extract(payload_json, '$.provider') AS provider, json_extract(payload_json, '$.model') AS model
      FROM ledger_events
      WHERE event_type = 'llm_attempt' AND json_extract(payload_json, '$.role') = 'compose'
        AND json_extract(payload_json, '$.outcome') = 'ok'
        AND run_id IN (SELECT run_id FROM chat_turns WHERE chat_id = ?)
      ORDER BY occurred_at DESC, sequence DESC LIMIT 1
    `).get<{ provider: unknown; model: unknown }>(chat_id);
    return row && typeof row.provider === "string" && typeof row.model === "string" ? { provider: row.provider, model: row.model } : null;
  }

  // --- Session ratings + lesson signal path (⓪·3 S2, ADR 0012 §1/§3) ---------

  /**
   * Record a rating ask (⓪·3 S2a): upsert the chat's single pending row. `asked_at`
   * doubles as the durable ask cooldown — consume/expiry deactivates the row but never
   * deletes it, so the trigger can't re-ask early after a silent expiry.
   */
  writePendingRating(input: { chat_id: string; asked_at: string; window_start: string }): void {
    this.db.prepare(`
      INSERT INTO pending_rating (chat_id, asked_at, window_start, active)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(chat_id) DO UPDATE SET
        asked_at = excluded.asked_at,
        window_start = excluded.window_start,
        active = 1
    `).run(input.chat_id, input.asked_at, input.window_start);
  }

  getPendingRating(chat_id: string): PendingRating | null {
    const row = this.db.prepare(`
      SELECT chat_id, asked_at, window_start, active FROM pending_rating WHERE chat_id = ?
    `).get<{ chat_id: string; asked_at: string; window_start: string; active: number }>(chat_id);
    if (!row) return null;
    return { chat_id: row.chat_id, asked_at: row.asked_at, window_start: row.window_start, active: row.active === 1 };
  }

  /** The user kept chatting instead of rating → the pending ask expires silently. */
  cancelPendingRating(chat_id: string): void {
    this.db.prepare(`UPDATE pending_rating SET active = 0 WHERE chat_id = ?`).run(chat_id);
  }

  /** Store one captured rating and deactivate the chat's pending ask. Returns the row id. */
  recordSessionRating(input: {
    chat_id: string;
    rating: number;
    comment?: string;
    asked_at: string;
    captured_at: string;
    applied_lesson_ids: number[];
  }): number {
    const result = this.db.prepare(`
      INSERT INTO session_ratings (chat_id, rating, comment, asked_at, captured_at, applied_lesson_ids)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.chat_id,
      input.rating,
      input.comment ?? null,
      input.asked_at,
      input.captured_at,
      JSON.stringify(input.applied_lesson_ids)
    );
    this.cancelPendingRating(input.chat_id);
    return Number(result.lastInsertRowid);
  }

  /** The most recent captured rating for a chat (or any chat when omitted). */
  getLastSessionRating(chat_id?: string): SessionRating | null {
    const row = chat_id
      ? this.db.prepare(`
          SELECT id, chat_id, rating, comment, asked_at, captured_at, applied_lesson_ids
          FROM session_ratings WHERE chat_id = ?
          ORDER BY captured_at DESC, id DESC LIMIT 1
        `).get<SessionRating>(chat_id)
      : this.db.prepare(`
          SELECT id, chat_id, rating, comment, asked_at, captured_at, applied_lesson_ids
          FROM session_ratings
          ORDER BY captured_at DESC, id DESC LIMIT 1
        `).get<SessionRating>();
    return row ?? null;
  }

  /** The `/status` rating snapshot: a still-answerable pending ask + the last capture. */
  getRatingStatus(now: string, pendingWindowMs: number): RatingStatus {
    const pending = this.db.prepare(`
      SELECT asked_at FROM pending_rating WHERE active = 1
      ORDER BY asked_at DESC LIMIT 1
    `).get<{ asked_at: string }>();
    const pending_since =
      pending && Date.parse(now) - Date.parse(pending.asked_at) <= pendingWindowMs
        ? pending.asked_at
        : null;
    const last = this.getLastSessionRating();
    return {
      pending_since,
      last_rating: last?.rating ?? null,
      last_rating_at: last?.captured_at ?? null
    };
  }

  /** User turns in a chat strictly after `sinceIso` (all of them when omitted) — the ask's SUBSTANCE gate. */
  countUserTurnsSince(chat_id: string, sinceIso?: string): number {
    const row = sinceIso
      ? this.db.prepare(`
          SELECT COUNT(*) AS n FROM chat_turns WHERE chat_id = ? AND role = 'user' AND created_at > ?
        `).get<{ n: number }>(chat_id, sinceIso)
      : this.db.prepare(`
          SELECT COUNT(*) AS n FROM chat_turns WHERE chat_id = ? AND role = 'user'
        `).get<{ n: number }>(chat_id);
    return row?.n ?? 0;
  }

  /** The chat's last user turn timestamp — the ask's LULL gate. */
  lastUserTurnAt(chat_id: string): string | null {
    const row = this.db.prepare(`
      SELECT MAX(created_at) AS at FROM chat_turns WHERE chat_id = ? AND role = 'user'
    `).get<{ at: string | null }>(chat_id);
    return row?.at ?? null;
  }

  /**
   * Attribution (⓪·3 S2a): the union of `loop_started.applied_artifacts.lesson_ids`
   * across the window's runs — the lessons that were live while the rated session ran.
   * Window's runs = runs with a chat turn in this chat at/after `sinceIso`.
   */
  appliedLessonIdsForChat(chat_id: string, sinceIso: string): number[] {
    const rows = this.db.prepare(`
      SELECT payload_json FROM ledger_events
      WHERE event_type = 'loop_started'
        AND run_id IN (SELECT DISTINCT run_id FROM chat_turns WHERE chat_id = ? AND created_at >= ?)
    `).all<{ payload_json: string }>(chat_id, sinceIso);
    const ids = new Set<number>();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as {
          applied_artifacts?: { lesson_ids?: unknown };
        };
        const list = payload.applied_artifacts?.lesson_ids;
        if (!Array.isArray(list)) continue;
        for (const id of list) {
          if (typeof id === "number" && Number.isInteger(id)) ids.add(id);
        }
      } catch {
        // A malformed payload never blocks attribution over the rest.
      }
    }
    return [...ids].sort((a, b) => a - b);
  }

  /**
   * Absorb one captured rating into the applied lessons (⓪·3 S2a): append {rating, at}
   * to each rating_history; a good session (≥2) is the positive reuse signal (+0.25 per
   * applied lesson). A low rating appends only — the penalty rides the attribution pass.
   */
  applyRatingToLessons(ids: number[], rating: number, at: string): void {
    for (const id of ids) {
      const row = this.getLesson(id);
      if (!row) continue;
      const history = parseRatingHistory(row.rating_history);
      history.push({ rating, at });
      this.db.prepare(`
        UPDATE lessons SET rating_history = ?, reuse_value = reuse_value + ? WHERE id = ?
      `).run(JSON.stringify(history), rating >= 2 ? 0.25 : 0, id);
    }
  }

  /**
   * The attribution pass named this lesson the likely culprit of a low-rated session:
   * record the correction, pay the reuse penalty (−0.5), note the flag in
   * rating_history. ACCUMULATE-BEFORE-ACTING (ADR 0012 §1): demotion to 'pruned'
   * (reversible) only on a PATTERN — ≥2 rating_history entries with rating ≤1 — a
   * single low rating only flags.
   */
  flagRatingCulprit(id: number, reason: string, at: string): { demoted: boolean } {
    const row = this.getLesson(id);
    if (!row) return { demoted: false };
    const history = parseRatingHistory(row.rating_history);
    history.push({ at, flag: "culprit", ...(reason ? { reason } : {}) });
    const lowRatings = history.filter(
      (entry) => typeof entry.rating === "number" && entry.rating <= 1
    ).length;
    const demoted = lowRatings >= 2;
    this.db.prepare(`
      UPDATE lessons
      SET rating_history = ?,
          corrected_count = corrected_count + 1,
          reuse_value = reuse_value - 0.5${demoted ? ", status = 'pruned'" : ""}
      WHERE id = ?
    `).run(JSON.stringify(history), id);
    return { demoted };
  }

  /**
   * The daily decay+prune pass (⓪·3 S2b, the forgetting the papers omit): at most once
   * per 24h (the `lesson_decay_state` row makes it idempotent across poll cycles).
   * Active lessons unused for `decayDays` (never-applied rows date from created_at, so
   * migration-sourced lessons decay too) lose 20% reuse_value; below `pruneThreshold`
   * they demote to 'pruned' (reversible). One summary ledger event per executed tick.
   */
  runLessonDecayTick(
    now: string,
    options: { decayDays?: number; pruneThreshold?: number } = {}
  ): { ran: boolean; lessons_decayed: number; pruned_ids: number[] } {
    const state = this.db.prepare(`
      SELECT last_decay_at FROM lesson_decay_state WHERE id = 1
    `).get<{ last_decay_at: string | null }>();
    if (state?.last_decay_at && Date.parse(now) - Date.parse(state.last_decay_at) < 86_400_000) {
      return { ran: false, lessons_decayed: 0, pruned_ids: [] };
    }

    const decayDays = options.decayDays ?? resolveLessonDecayDays(process.env);
    const threshold = options.pruneThreshold ?? resolveLessonPruneThreshold(process.env);
    const cutoff = new Date(Date.parse(now) - decayDays * 86_400_000).toISOString();
    const stale = this.db.prepare(`
      SELECT id, reuse_value FROM lessons
      WHERE status = 'active' AND COALESCE(last_used, created_at) < ?
    `).all<{ id: number; reuse_value: number }>(cutoff);

    const pruned_ids: number[] = [];
    for (const row of stale) {
      const decayed = row.reuse_value * 0.8;
      const prune = decayed < threshold;
      this.db.prepare(`
        UPDATE lessons SET reuse_value = ?${prune ? ", status = 'pruned'" : ""} WHERE id = ?
      `).run(decayed, row.id);
      if (prune) pruned_ids.push(row.id);
    }

    this.db.prepare(`UPDATE lesson_decay_state SET last_decay_at = ? WHERE id = 1`).run(now);
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "lesson-decay",
        event_type: "lesson_decay_tick",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload: { lessons_decayed: stale.length, pruned_ids }
      })
    );
    return { ran: true, lessons_decayed: stale.length, pruned_ids };
  }

  // --- Episodic facts (Phase M B1/B2, ADR 0005 §3/§4) ------------------------

  /** Insert one active fact row (valid_from = created_at — valid from when learned); returns its id. */
  addEpisodicFact(input: EpisodicFactCandidate & { created_at?: string }): number {
    const created = input.created_at ?? new Date().toISOString();
    const blob = input.embedding ? float32ToBlob(input.embedding) : null;
    const result = this.db.prepare(`
      INSERT INTO episodic_facts (
        fact, participants, chat_id, source_turn_ids, occurred_at, valid_from,
        salience, embedding, embedding_model, created_at, is_core
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.fact.trim(),
      JSON.stringify(input.participants ?? []),
      input.chat_id,
      JSON.stringify(input.source_turn_ids ?? []),
      input.occurred_at ?? null,
      created,
      input.salience ?? 1.0,
      blob,
      blob ? input.embedding_model ?? null : null,
      created,
      input.is_core ? 1 : 0
    );
    return Number(result.lastInsertRowid);
  }

  getEpisodicFact(id: number): EpisodicFactRow | undefined {
    return this.db.prepare(`
      SELECT ${EPISODIC_FACT_COLUMNS} FROM episodic_facts WHERE id = ?
    `).get<EpisodicFactRow>(id);
  }

  /**
   * Final-review C3: store an embedding on a row written without one (memory_correct, the migration's restored core
   * row, the daily backfill). Only a row still NULL is changed, so a concurrent write never loses its own vector.
   */
  setEpisodicFactEmbedding(id: number, embedding: Float32Array, model: string): boolean {
    return this.db.prepare(`
      UPDATE episodic_facts SET embedding = ?, embedding_model = ? WHERE id = ? AND embedding IS NULL
    `).run(float32ToBlob(embedding), model, id).changes === 1;
  }

  /** Active facts with no embedding, core first then newest (the backfill's batch; unreachable for CJK under the gate). */
  listUnembeddedEpisodicFacts(limit: number): EpisodicFactRow[] {
    return this.db.prepare(`
      SELECT ${EPISODIC_FACT_COLUMNS} FROM episodic_facts
      WHERE status = 'active' AND embedding IS NULL
      ORDER BY is_core DESC, id DESC
      LIMIT ?
    `).all<EpisodicFactRow>(limit);
  }

  /** A chat's ACTIVE facts, newest first (M2 retrieval/consolidation + tests read through this). */
  getActiveEpisodicFacts(chat_id: string, cap?: number): EpisodicFactRow[] {
    const limit = cap ?? -1; // SQLite: LIMIT -1 = unbounded
    return this.db.prepare(`
      SELECT ${EPISODIC_FACT_COLUMNS} FROM episodic_facts
      WHERE chat_id = ? AND status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all<EpisodicFactRow>(chat_id, limit);
  }

  /** Chats whose ACTIVE core facts exceed `cap` (the `core_overflow` sweep invariant, memory A1 §4). */
  listCoreOverflow(cap: number): Array<{ chat_id: string; core_count: number }> {
    return this.db.prepare(`
      SELECT chat_id, COUNT(*) AS core_count FROM episodic_facts
      WHERE status = 'active' AND is_core = 1 AND chat_id IS NOT NULL
      GROUP BY chat_id HAVING COUNT(*) > ? ORDER BY chat_id ASC
    `).all<{ chat_id: string; core_count: number }>(cap);
  }

  /**
   * A chat's ACTIVE core facts (is_core=1) — the always-known biography band folded above
   * the scored retrieval. Highest-salience first, then newest, capped by the core cap;
   * the caller dedupes these ids out of the scored episodic band so nothing renders twice.
   */
  getCoreEpisodicFacts(chat_id: string, cap: number = resolveEpisodicCoreCap(process.env)): EpisodicFactRow[] {
    return this.db.prepare(`
      SELECT ${EPISODIC_FACT_COLUMNS} FROM episodic_facts
      WHERE chat_id = ? AND status = 'active' AND is_core = 1
      ORDER BY salience DESC, created_at DESC, id DESC
      LIMIT ?
    `).all<EpisodicFactRow>(chat_id, Math.max(1, cap));
  }

  /**
   * Link a supersede pair BIDIRECTIONALLY and stamp the old row's `valid_until`
   * (ADR 0005 §4: invalidate-don't-delete — the superseded fact stays queryable as
   * "true until `now`"). NEVER deletes.
   */
  supersedeEpisodicFact(oldId: number, newId: number, now: string): void {
    this.db.prepare(`
      UPDATE episodic_facts SET status = 'superseded', superseded_by = ?, valid_until = ? WHERE id = ?
    `).run(newId, now, oldId);
    this.db.prepare(`UPDATE episodic_facts SET supersedes = ? WHERE id = ?`).run(oldId, newId);
  }

  /**
   * Apply a reconcile verdict to a fact candidate (Phase M B2, mirroring
   * {@link RunStore.saveReconciledLesson}): ADD inserts; SUPERSEDE/UPDATE insert a NEW
   * row linked to the prior via bidirectional pointers (never an in-place rewrite, never
   * a delete); DROP writes nothing. A SUPERSEDE/UPDATE whose target is missing, no longer
   * active, or in a DIFFERENT chat (defense-in-depth — a verdict must never retire another
   * chat's fact) degrades to ADD. A SUPERSEDE is a correction against the target (its
   * corrected_count/reuse_value pay for it). Overflow beyond the per-chat cap prunes the
   * lowest reuse_value rows (never the row just written).
   */
  saveReconciledFact(
    candidate: EpisodicFactCandidate,
    verdict: LessonReconcileVerdict,
    now: string,
    cap: number = resolveEpisodicFactCapPerChat(process.env)
  ): EpisodicFactSaveResult {
    const fact = candidate.fact.trim();
    if (verdict.verdict === "DROP") {
      return { verb: "drop", fact, prunedIds: [] };
    }

    const prior = verdict.verdict === "ADD" ? undefined : this.getEpisodicFact(verdict.id);
    const target = prior?.status === "active" && prior.chat_id === candidate.chat_id ? prior : undefined;
    const merged =
      verdict.verdict === "UPDATE" && target && verdict.text?.trim() ? verdict.text.trim() : fact;
    // Preserve core across the supersede chain: a row that replaces or supplements a core
    // fact inherits core (never demote biography by superseding it with a narrower item).
    const is_core = Boolean(candidate.is_core) || target?.is_core === 1;

    const id = this.addEpisodicFact({ ...candidate, fact: merged, is_core, created_at: now });
    if (target) this.supersedeEpisodicFact(target.id, id, now);
    if (verdict.verdict === "SUPERSEDE" && target) {
      this.db.prepare(`
        UPDATE episodic_facts SET corrected_count = corrected_count + 1, reuse_value = reuse_value - 0.5 WHERE id = ?
      `).run(target.id);
    }
    const prunedIds = this.pruneEpisodicOverflow(candidate.chat_id, cap, id);
    const verb: LessonWriteVerb = !target ? "add" : verdict.verdict === "UPDATE" ? "update" : "supersede";
    return { verb, id, ...(target ? { supersededId: target.id } : {}), fact: merged, prunedIds };
  }

  /**
   * Prune (reversibly) the lowest-value active rows over the chat cap, sparing `keepId`. Core rows count toward the
   * cap but are never pruned (memory A1 §4): core leaves only through memory_correct or a supersede.
   */
  private pruneEpisodicOverflow(chat_id: string, cap: number, keepId: number): number[] {
    if (cap <= 0) return [];
    const total = this.db.prepare(`
      SELECT COUNT(*) AS n FROM episodic_facts WHERE chat_id = ? AND status = 'active' AND id != ?
    `).get<{ n: number }>(chat_id, keepId)?.n ?? 0;
    const candidates = this.db.prepare(`
      SELECT id FROM episodic_facts
      WHERE chat_id = ? AND status = 'active' AND id != ? AND is_core = 0
      ORDER BY reuse_value ASC, COALESCE(last_used, created_at) ASC, id ASC
    `).all<{ id: number }>(chat_id, keepId);
    const toPrune = candidates.slice(0, Math.max(0, total + 1 - cap)).map((r) => r.id);
    for (const id of toPrune) {
      this.db.prepare(`UPDATE episodic_facts SET status = 'pruned' WHERE id = ?`).run(id);
    }
    return toPrune;
  }

  /**
   * Neighbours for the fact-reconcile compare (memory A1 §7). With the candidate's embedding: FTS hits union the active
   * facts at cosine >= {@link RECONCILE_NEIGHBOR_MIN_COSINE} (best first), deduplicated, at most `k`, with up to
   * {@link RECONCILE_COSINE_SLOTS} slots reserved for cosine-only hits (CJK and paraphrases have no FTS hit). Without one
   * (Ollama down): FTS hits, else the chat's newest `k` — CJK has no FTS hit, and dropping the fallback would
   * turn every such fact into an ADD. A hostile MATCH string never throws.
   */
  getEpisodicFactsForReconcile(chat_id: string, candidateText: string, k: number, embedding: Float32Array | null = null): EpisodicFactRow[] {
    const hits = this.searchEpisodicFactsFts(chat_id, candidateText, k);
    if (!embedding) return hits.length > 0 ? hits : this.getActiveEpisodicFacts(chat_id, k);
    const close = this.getActiveEpisodicFacts(chat_id)
      .flatMap((row) => {
        const c = row.embedding ? cosineSimilarity(embedding, blobToFloat32(row.embedding)) : Number.NaN;
        return Number.isFinite(c) && c >= RECONCILE_NEIGHBOR_MIN_COSINE ? [{ row, c }] : [];
      })
      .sort((a, b) => b.c - a.c || a.row.id - b.row.id)
      .map((x) => x.row);
    const fromFts = new Set(hits.map((h) => h.id));
    const cosineOnly = close.filter((row) => !fromFts.has(row.id));
    const reserved = Math.min(RECONCILE_COSINE_SLOTS, cosineOnly.length, k);
    return [...hits.slice(0, k - reserved), ...cosineOnly].slice(0, k);
  }

  /**
   * FTS5/BM25 keyword leg of M2 retrieval (also the reconcile candidate source): the
   * query's sanitized tokens OR-matched against the chat's ACTIVE facts, best `rank`
   * (bm25 — more negative = better) first, id ASC on ties (deterministic). Hostile
   * MATCH syntax or an unsegmentable query (CJK under unicode61) degrades to [] —
   * NEVER throws; the caller's cosine/recency legs carry relevance from there.
   */
  searchEpisodicFactsFts(
    chat_id: string,
    queryText: string,
    k: number
  ): Array<EpisodicFactRow & { rank: number }> {
    const tokens = ftsQueryTokens(queryText);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"`).join(" OR ");
    try {
      return this.db.prepare(`
        SELECT ${EPISODIC_FACT_COLUMNS_QUALIFIED}, fts.rank AS rank
        FROM episodic_facts_fts fts
        JOIN episodic_facts f ON f.id = fts.rowid
        WHERE episodic_facts_fts MATCH ? AND f.chat_id = ? AND f.status = 'active'
        ORDER BY fts.rank, f.id
        LIMIT ?
      `).all<EpisodicFactRow & { rank: number }>(match, chat_id, k);
    } catch {
      return []; // MATCH parse error → keyword leg contributes nothing
    }
  }

  /** Attribution (M2 will call it): these facts were applied to a turn's prompt. */
  touchEpisodicApplied(ids: number[], now: string = new Date().toISOString()): void {
    const stmt = this.db.prepare(`
      UPDATE episodic_facts SET applied_count = applied_count + 1, last_used = ? WHERE id = ?
    `);
    for (const id of ids) stmt.run(now, id);
  }

  /** Prune one active fact by id (memory A1 migration --revert retires the restored core row). */
  retireEpisodicFactById(id: number): boolean {
    return this.db.prepare(`UPDATE episodic_facts SET status = 'pruned' WHERE id = ? AND status = 'active'`).run(id).changes === 1;
  }

  getEpisodicDistillWatermark(chat_id: string): EpisodicDistillWatermark | null {
    const row = this.db.prepare(`
      SELECT chat_id, last_turn_created_at, last_distilled_at
      FROM episodic_distill_watermark WHERE chat_id = ?
    `).get<EpisodicDistillWatermark>(chat_id);
    return row ?? null;
  }

  setEpisodicDistillWatermark(input: EpisodicDistillWatermark): void {
    this.db.prepare(`
      INSERT INTO episodic_distill_watermark (chat_id, last_turn_created_at, last_distilled_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        last_turn_created_at = excluded.last_turn_created_at,
        last_distilled_at = excluded.last_distilled_at
    `).run(input.chat_id, input.last_turn_created_at, input.last_distilled_at);
  }

  /**
   * Chats holding USER turns newer than their distill watermark, oldest undistilled
   * turn first — the trigger's pick order (one chat per tick, most-starved first).
   */
  listChatsWithUndistilledTurns(): Array<{ chat_id: string; oldest_undistilled_at: string }> {
    return this.db.prepare(`
      SELECT c.chat_id AS chat_id, MIN(c.created_at) AS oldest_undistilled_at
      FROM chat_turns c
      LEFT JOIN episodic_distill_watermark w ON w.chat_id = c.chat_id
      WHERE c.role = 'user'
        AND (w.last_turn_created_at IS NULL OR c.created_at > w.last_turn_created_at)
      GROUP BY c.chat_id
      ORDER BY oldest_undistilled_at ASC
    `).all<{ chat_id: string; oldest_undistilled_at: string }>();
  }

  /** One summary event per executed distill pass (run-less, like lesson_decay_tick). */
  recordEpisodicDistillPass(
    chat_id: string,
    payload: { facts_added: number; superseded: number; dropped: number; turns_read: number }
  ): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: `episodic-distill:${chat_id}`,
        event_type: "episodic_distill_pass",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload: { chat_id, ...payload }
      })
    );
  }

  // --- Episodic consolidation primitives (Phase M B4) ------------------------

  /** Last executed consolidate tick (single-row state, like lesson_decay_state). */
  getEpisodicConsolidateLastRun(): string | null {
    const row = this.db.prepare(`
      SELECT last_consolidate_at FROM episodic_consolidate_state WHERE id = 1
    `).get<{ last_consolidate_at: string | null }>();
    return row?.last_consolidate_at ?? null;
  }

  markEpisodicConsolidateRan(now: string): void {
    this.db.prepare(`UPDATE episodic_consolidate_state SET last_consolidate_at = ? WHERE id = 1`).run(now);
  }

  /**
   * B4 step 1 — DECAY: active non-core facts untouched for `decayDays` (from max(created_at, last_used) — a
   * retrieval-applied fact is not stale) lose 20% reuse_value. Memory A1 §3: decay no longer PRUNES (the gate
   * touches fewer rows, so valid rarely-matched facts would age out); the per-chat cap-prune still bounds the
   * count, and B redesigns the lifecycle. `pruneThreshold` is kept for B and ignored here.
   */
  decayEpisodicFacts(
    now: string,
    options: { decayDays: number; pruneThreshold: number }
  ): { facts_decayed: number; pruned_ids: number[] } {
    const cutoff = new Date(Date.parse(now) - options.decayDays * 86_400_000).toISOString();
    // Scalar MAX over ISO strings orders correctly (fixed-width UTC timestamps).
    const stale = this.db.prepare(`
      SELECT id, reuse_value FROM episodic_facts
      WHERE status = 'active' AND is_core = 0 AND MAX(created_at, COALESCE(last_used, created_at)) < ?
      ORDER BY id ASC
    `).all<{ id: number; reuse_value: number }>(cutoff);
    const stmt = this.db.prepare(`UPDATE episodic_facts SET reuse_value = ? WHERE id = ?`);
    for (const row of stale) stmt.run(row.reuse_value * 0.8, row.id);
    return { facts_decayed: stale.length, pruned_ids: [] };
  }

  /** Chats that hold at least one ACTIVE fact (the merge pass walks per chat). */
  listEpisodicChatIds(): string[] {
    return this.db.prepare(`
      SELECT DISTINCT chat_id FROM episodic_facts
      WHERE status = 'active' AND chat_id IS NOT NULL
      ORDER BY chat_id ASC
    `).all<{ chat_id: string }>().map((r) => r.chat_id);
  }

  /**
   * B4 step 2 — MERGE: store the merged fact as a NEW row and supersede EVERY source
   * (bidirectional pointers + valid_until — invalidate, never delete; the single
   * `supersedes` column ends up naming the last source, `superseded_by` is set on all).
   * The merged row INHERITS its sources' standing: max(salience), reuse_value summed
   * and capped at {@link DEFAULT_EPISODIC_MERGE_REUSE_CAP} (a merged duplicate must
   * not out-rank everything forever), earliest valid_from (the fact has been true
   * since the FIRST source), and the union of participants + source_turn_ids
   * (provenance survives the merge). Non-destructive refusal (`undefined`) unless
   * ALL sources are ≥2 ACTIVE rows of the SAME chat and ALL core or ALL non-core — a bad cluster can never retire
   * another chat's facts or half-merge.
   */
  mergeEpisodicFacts(
    sourceIds: number[],
    merged: { fact: string; embedding?: Float32Array | null; embedding_model?: string },
    now: string
  ): { id: number } | undefined {
    if (sourceIds.length < 2) return undefined;
    const sources: EpisodicFactRow[] = [];
    for (const id of sourceIds) {
      const row = this.getEpisodicFact(id);
      if (!row || row.status !== "active" || row.chat_id === null) return undefined;
      sources.push(row);
    }
    const chat_id = sources[0]!.chat_id!;
    if (!sources.every((s) => s.chat_id === chat_id)) return undefined;
    // Memory A1 §4: a mixed core/non-core cluster would demote core into a prunable row — refuse it.
    if (new Set(sources.map((s) => s.is_core)).size > 1) return undefined;

    const participants = new Set<string>();
    const source_turn_ids = new Set<string>();
    for (const s of sources) {
      for (const p of parseStringArray(s.participants)) participants.add(p);
      for (const t of parseStringArray(s.source_turn_ids)) source_turn_ids.add(t);
    }
    const salience = Math.max(...sources.map((s) => s.salience));
    const reuse = Math.min(
      DEFAULT_EPISODIC_MERGE_REUSE_CAP,
      sources.reduce((sum, s) => sum + Math.max(0, s.reuse_value), 0)
    );
    const valid_from = sources
      .map((s) => s.valid_from ?? s.created_at)
      .sort()[0]!;

    const id = this.addEpisodicFact({
      chat_id,
      fact: merged.fact,
      participants: [...participants],
      source_turn_ids: [...source_turn_ids],
      salience,
      is_core: sources.every((s) => s.is_core === 1), // uniform here: mixed clusters were refused above
      embedding: merged.embedding ?? null,
      ...(merged.embedding && merged.embedding_model ? { embedding_model: merged.embedding_model } : {}),
      created_at: now
    });
    this.db.prepare(`
      UPDATE episodic_facts SET reuse_value = ?, valid_from = ? WHERE id = ?
    `).run(reuse, valid_from, id);
    for (const s of sources) this.supersedeEpisodicFact(s.id, id, now);
    return { id };
  }

  /**
   * B4 step 3 — PROMOTE: a fact applied ≥ `minApplied` times and at least
   * `minAgeDays` old has proven durable — bump salience by `bump`, capped at 1.
   * Convergent by construction: only rows with salience < 1 qualify, so repeated
   * daily ticks walk a hot fact up to exactly 1 and then stop (no marker column
   * needed, no unbounded growth).
   */
  promoteEpisodicFacts(
    now: string,
    options: { minApplied: number; minAgeDays: number; bump: number }
  ): number[] {
    const cutoff = new Date(Date.parse(now) - options.minAgeDays * 86_400_000).toISOString();
    const rows = this.db.prepare(`
      SELECT id, salience FROM episodic_facts
      WHERE status = 'active' AND applied_count >= ? AND created_at <= ? AND salience < 1
      ORDER BY id ASC
    `).all<{ id: number; salience: number }>(options.minApplied, cutoff);
    for (const row of rows) {
      this.db.prepare(`UPDATE episodic_facts SET salience = ? WHERE id = ?`)
        .run(Math.min(1, row.salience + options.bump), row.id);
    }
    return rows.map((r) => r.id);
  }

  /** One summary event per consolidate tick THAT DID WORK (run-less, like lesson_decay_tick). */
  recordEpisodicConsolidateTick(payload: {
    facts_decayed: number;
    pruned_ids: number[];
    clusters_merged: number;
    promoted_ids: number[];
  }): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "episodic-consolidate",
        event_type: "episodic_consolidate_tick",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload
      })
    );
  }

  // --- Lesson consolidation primitives (lesson-consolidation design, 2026-07-23) ------

  /** Last executed lesson-consolidate tick (single-row state, like episodic_consolidate_state). */
  getLessonConsolidateLastRun(): string | null {
    const row = this.db.prepare(`
      SELECT last_consolidated_at FROM lesson_consolidate_state WHERE id = 1
    `).get<{ last_consolidated_at: string | null }>();
    return row?.last_consolidated_at ?? null;
  }

  markLessonConsolidateRan(now: string): void {
    this.db.prepare(`UPDATE lesson_consolidate_state SET last_consolidated_at = ? WHERE id = 1`).run(now);
  }

  /** The merge's members re-read under the write lock: all active, same scope, same theme (memory A1 §5) — else undefined. */
  private lockedMergeMembers(memberIds: number[], scope: string): LessonRow[] | undefined {
    const members: LessonRow[] = [];
    for (const id of memberIds) {
      const row = this.getLesson(id);
      if (!row || row.status !== "active" || row.scope !== scope) return undefined;
      members.push(row);
    }
    return new Set(members.map((m) => m.theme)).size === 1 ? members : undefined;
  }

  /**
   * Preserve-all lesson merge (ADD-then-supersede-all — mirrors {@link RunStore.mergeEpisodicFacts}):
   * store the merged text/avoid as a NEW active lesson and supersede EVERY member (bidirectional
   * pointers via {@link RunStore.supersedeLesson} — invalidate, never delete; the single
   * `supersedes` column ends up naming the last member, `superseded_by` is set on all). The merged
   * row starts fresh: `applied_count` = Σ members' applied_count, `reuse_value` = the members' summed
   * reuse CAPPED at {@link LESSON_MERGE_REUSE_CAP} and NEGATIVE-CLAMPED (a negative member can't drag
   * it below 0; a huge sum can't inflate past the cap — decay can still walk it down), empty
   * rating_history. One `BEGIN IMMEDIATE` txn. Non-destructive refusal (`undefined`) unless ALL
   * members are ≥2 ACTIVE lessons of the SAME scope — a bad cluster can never retire another scope's
   * lesson or half-merge.
   */
  applyLessonMerge(input: {
    scope: string;
    memberIds: number[];
    text: string;
    avoid: string | null;
    now?: string;
  }): { new_id: number } | undefined {
    if (input.memberIds.length < 2) return undefined;
    const text = input.text.trim();
    if (text.length === 0) return undefined;
    const avoid = input.avoid?.trim() || null;
    const now = input.now ?? new Date().toISOString();

    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;
    try {
      // AUTHORITATIVE member check INSIDE the write lock (TOCTOU close): re-SELECT every member's
      // status+scope now that we hold BEGIN IMMEDIATE, so check-and-supersede is serialized against
      // a concurrent writer (daemon tick vs. a manual `houge lessons-consolidate`). Any member no
      // longer active or drifted to another scope → ROLLBACK and refuse (non-destructive contract).
      const members = this.lockedMergeMembers(input.memberIds, input.scope);
      if (!members) {
        this.db.exec("ROLLBACK");
        activeTransaction = false;
        return undefined;
      }
      const applied_count = members.reduce((sum, m) => sum + m.applied_count, 0);
      const reuse_value = Math.min(
        LESSON_MERGE_REUSE_CAP,
        members.reduce((sum, m) => sum + Math.max(0, m.reuse_value), 0)
      );

      const new_id = this.addLesson({
        scope: input.scope,
        text,
        ...(avoid ? { avoid } : {}),
        theme: members[0]!.theme,
        source: "consolidation",
        created_at: now
      });
      this.db.prepare(`UPDATE lessons SET applied_count = ?, reuse_value = ? WHERE id = ?`)
        .run(applied_count, reuse_value, new_id);
      for (const m of members) this.supersedeLesson(m.id, new_id);
      this.db.exec("COMMIT");
      activeTransaction = false;
      return { new_id };
    } catch (error) {
      if (activeTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** One summary event per lesson-consolidate tick THAT DID WORK (run-less, like episodic). */
  recordLessonConsolidateTick(payload: {
    scopes_processed: number;
    clusters_merged: number;
    lessons_superseded: number;
    merges: Array<{ new_id: number; superseded_ids: number[] }>;
  }): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "lesson-consolidate",
        event_type: "lesson_consolidate_tick",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload
      })
    );
  }

  // --- Idea radar (Idea Radar R1, spec 2026-07-24) -----------------------------

  /** Last executed radar tick (single-row state, like lesson_consolidate_state). */
  getRadarLastRun(): string | null {
    const row = this.db.prepare(`
      SELECT last_run_at FROM radar_state WHERE id = 1
    `).get<{ last_run_at: string | null }>();
    return row?.last_run_at ?? null;
  }

  markRadarRan(now: string): void {
    this.db.prepare(`UPDATE radar_state SET last_run_at = ? WHERE id = 1`).run(now);
  }

  /**
   * Insert one NEW idea card (extract verdict "new"). Distinct counts are computed
   * HERE from the sources map (never trusted from a caller); each source list is
   * bounded at {@link IDEA_CARD_ITEMS_PER_SOURCE_CAP}. A slug collision gets a
   * deterministic `-2`/`-3` suffix — slug is a filename/identity key, NOT the dedupe
   * mechanism (B3: the tick computes it in code via normalizeTopicSlug).
   */
  insertIdeaCard(input: {
    slug: string;
    title: string;
    summary: string;
    sources: Record<string, IdeaSourceItem[]>;
    now: string;
  }): { id: number } {
    const sources = capIdeaSources(input.sources);
    const { distinct_items, distinct_sources } = countIdeaSources(sources);

    // Deterministic collision suffix: first free of slug, slug-2, slug-3, …
    let slug = input.slug;
    for (let n = 2; this.ideaSlugTaken(slug); n += 1) {
      slug = `${input.slug}-${n}`;
    }

    const result = this.db.prepare(`
      INSERT INTO ideas (slug, title, summary, status, sources_json, distinct_items, distinct_sources, first_seen, last_seen)
      VALUES (?, ?, ?, 'seen', ?, ?, ?, ?, ?)
    `).run(
      slug,
      input.title,
      input.summary,
      JSON.stringify(sources),
      distinct_items,
      distinct_sources,
      input.now,
      input.now
    );
    return { id: Number(result.lastInsertRowid) };
  }

  private ideaSlugTaken(slug: string): boolean {
    return this.db.prepare(`SELECT id FROM ideas WHERE slug = ?`).get<{ id: number }>(slug) !== undefined;
  }

  /**
   * Touch an existing card (extract verdict "match"): union the new items into the
   * per-source lists (known ids never re-add — the front-page-persistence fix: a
   * re-sighting bumps `last_seen` ONLY, no count inflation), cap each list at
   * {@link IDEA_CARD_ITEMS_PER_SOURCE_CAP} dropping oldest-first, recompute the
   * distinct counts, and apply `summaryUpdate` when non-null. Missing card → no-op
   * (the parse floor should have dropped it; stay non-destructive anyway).
   *
   * R2 L7 fix: `summaryUpdate` applies ONLY while status ∈ seen|tracked —
   * shortlisted/picked summaries are panel/operator-blessed, LLM drift blocked.
   * The item union + counts + last_seen still apply for every active status.
   */
  touchIdeaCard(input: {
    id: number;
    newItems: Record<string, IdeaSourceItem[]>;
    summaryUpdate: string | null;
    now: string;
  }): { updated: boolean } {
    const row = this.db.prepare(`
      SELECT sources_json, status FROM ideas WHERE id = ?
    `).get<{ sources_json: string; status: IdeaStatus }>(input.id);
    if (!row) return { updated: false };
    const summaryUpdate =
      row.status === "seen" || row.status === "tracked" ? input.summaryUpdate : null;

    const sources = JSON.parse(row.sources_json) as Record<string, IdeaSourceItem[]>;
    for (const [key, items] of Object.entries(input.newItems)) {
      const existing = sources[key] ?? [];
      const known = new Set(existing.map((i) => i.id));
      for (const item of items) {
        if (known.has(item.id)) continue; // re-sighted → last_seen only
        known.add(item.id);
        existing.push(item);
      }
      // Oldest-first drop: lists append in sighting order, so overflow trims the front.
      sources[key] = existing.slice(-IDEA_CARD_ITEMS_PER_SOURCE_CAP);
    }
    const { distinct_items, distinct_sources } = countIdeaSources(sources);

    this.db.prepare(`
      UPDATE ideas
      SET sources_json = ?, distinct_items = ?, distinct_sources = ?, last_seen = ?,
          summary = COALESCE(?, summary)
      WHERE id = ?
    `).run(
      JSON.stringify(sources),
      distinct_items,
      distinct_sources,
      input.now,
      summaryUpdate,
      input.id
    );
    return { updated: true };
  }

  /**
   * Active cards (NOT archived/killed) — the /radar order AND the panel's input order.
   * Status priority pins picked, then shortlisted, above the momentum ranking (R2 W5:
   * a top-10 render must never hide the shortlist below un-blessed high-momentum cards);
   * within a band: momentum DESC, last_seen DESC, id ASC.
   */
  listActiveIdeas(limit: number): IdeaRow[] {
    return this.db.prepare(`
      SELECT id, slug, title, summary, status, sources_json, distinct_items, distinct_sources,
             scores_json, first_seen, last_seen, archived_at,
             distinct_items * distinct_sources AS momentum
      FROM ideas
      WHERE status NOT IN ('archived', 'killed')
      ORDER BY CASE status WHEN 'picked' THEN 0 WHEN 'shortlisted' THEN 1 ELSE 2 END ASC,
               momentum DESC, last_seen DESC, id ASC
      LIMIT ?
    `).all<IdeaRawRow>(limit).map(parseIdeaRow);
  }

  countActiveIdeas(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM ideas WHERE status NOT IN ('archived', 'killed')
    `).get<{ count: number }>();
    return row?.count ?? 0;
  }

  /**
   * Archive active cards not sighted for `afterDays` — ONLY statuses seen/tracked
   * (shortlisted/picked are operator judgments, never auto-archived). Reversible:
   * status flips back re-activate; `archived_at` is bookkeeping. Returns the count.
   */
  archiveStaleIdeas(input: { now: string; afterDays: number }): number {
    const cutoff = new Date(Date.parse(input.now) - input.afterDays * 86_400_000).toISOString();
    return this.db.prepare(`
      UPDATE ideas SET status = 'archived', archived_at = ?
      WHERE status IN ('seen', 'tracked') AND last_seen < ?
    `).run(input.now, cutoff).changes;
  }

  /**
   * Overflow guard: while more than `cap` cards are active, archive the lowest-momentum
   * (oldest-sighted on ties) first. Deterministic, no LLM. Returns the count archived.
   *
   * Victim exclusions (R2): a card created THIS tick (`first_seen = now`) is never the
   * victim (L4 — a fresh signal must survive its birth tick), and shortlisted/picked
   * cards are never auto-archived (B1 — panel/operator judgments have no third archive
   * path). Excluded cards still COUNT toward the cap total, so the board can overshoot
   * by at most the shortlist size + 1.
   */
  pruneIdeaOverflow(input: { cap: number; now: string }): number {
    const overflow = this.countActiveIdeas() - input.cap;
    if (overflow <= 0) return 0;
    return this.db.prepare(`
      UPDATE ideas SET status = 'archived', archived_at = ?
      WHERE id IN (
        SELECT id FROM ideas
        WHERE status NOT IN ('archived', 'killed')
          AND first_seen != ?
          AND status NOT IN ('shortlisted', 'picked')
        ORDER BY distinct_items * distinct_sources ASC, last_seen ASC, id ASC
        LIMIT ?
      )
    `).run(input.now, input.now, overflow).changes;
  }

  /** One summary event per non-dry radar tick that RAN (visibility over parsimony — once/day). */
  recordIdeaRadarTick(payload: {
    sources_ok: string[];
    sources_failed: string[];
    cards_new: number;
    cards_updated: number;
    cards_archived: number;
  }): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "idea-radar",
        event_type: "idea_radar_tick",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload
      })
    );
  }

  // --- Idea panel (Idea Radar R2, spec 2026-07-25) -----------------------------

  /** Last executed panel tick (single-row weekly latch, like radar_state; NULL = first arm). */
  getPanelLastRun(): string | null {
    const row = this.db.prepare(`
      SELECT last_run_at FROM radar_panel_state WHERE id = 1
    `).get<{ last_run_at: string | null }>();
    return row?.last_run_at ?? null;
  }

  /** Stamped BEFORE any judge call (M3 posture) — a crashing panel never retry-storms. */
  markPanelRan(now: string): void {
    this.db.prepare(`UPDATE radar_panel_state SET last_run_at = ? WHERE id = 1`).run(now);
  }

  /** Put the weekly latch back to its value before this run stamped it (null on a first arm): the run was cut by shutdown. */
  restorePanelLastRun(previous: string | null): void {
    this.db.prepare(`UPDATE radar_panel_state SET last_run_at = ? WHERE id = 1`).run(previous);
  }

  // --- Skill re-verify advisor (skill retirement spec, 2026-07-29) -------------

  /** Last executed re-verify tick (single-row weekly latch, like radar_panel_state). */
  getSkillReverifyLastRun(): string | null {
    const row = this.db.prepare(`
      SELECT last_run_at FROM skill_reverify_state WHERE id = 1
    `).get<{ last_run_at: string | null }>();
    return row?.last_run_at ?? null;
  }

  /** Stamped BEFORE any Gate B call (M3 posture) — a crashing tick never retry-storms. */
  setSkillReverifyLastRun(now: string): void {
    this.db.prepare(`UPDATE skill_reverify_state SET last_run_at = ? WHERE id = 1`).run(now);
  }

  /** One summary event per weekly re-verify tick — counts only, no skill text. */
  recordSkillReverifyTick(payload: { checked: number; passed: number; flagged: number }): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "skill-reverify",
        event_type: "skill_reverify_tick",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload
      })
    );
  }

  /**
   * Guarded status write — the ONLY path the panel and `/idea pick` use. Allowed
   * transitions are exactly {@link IDEA_STATUS_TRANSITIONS}; anything else (same-status,
   * archived/killed source, unknown id) returns `{updated: false}` and never throws.
   * `now` is accepted for write-path parity but deliberately NOT stamped anywhere:
   * a status change is a judgment, not a sighting — last_seen stays put.
   */
  setIdeaStatus(input: { id: number; status: IdeaStatus; now: string }): { updated: boolean } {
    void input.now;
    const row = this.db.prepare(`
      SELECT status FROM ideas WHERE id = ?
    `).get<{ status: IdeaStatus }>(input.id);
    if (!row) return { updated: false };
    const allowed = IDEA_STATUS_TRANSITIONS.some(
      ([from, to]) => from === row.status && to === input.status
    );
    if (!allowed) return { updated: false };
    this.db.prepare(`UPDATE ideas SET status = ? WHERE id = ?`).run(input.status, input.id);
    return { updated: true };
  }

  /**
   * Full scores_json overwrite per panel run (history lives in snapshots + briefs,
   * not in the card). Missing card → `{updated: false}` (partial-trace posture).
   */
  writeIdeaScores(input: { id: number; scoresJson: string }): { updated: boolean } {
    const changes = this.db.prepare(`
      UPDATE ideas SET scores_json = ? WHERE id = ?
    `).run(input.scoresJson, input.id).changes;
    return { updated: changes > 0 };
  }

  /**
   * Frozen weekly shortlist snapshot — idempotent per week: a re-fired week REPLACES
   * created_at/cards_json and RESETS picked_idea_id to NULL (the old pick pointed at
   * ranks that no longer exist; the ideas-table `picked` status is untouched here).
   */
  upsertShortlistSnapshot(input: { weekKey: string; cardsJson: string; now: string }): { id: number } {
    this.db.prepare(`
      INSERT INTO radar_shortlists (created_at, week_key, cards_json, picked_idea_id)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(week_key) DO UPDATE SET
        created_at = excluded.created_at,
        cards_json = excluded.cards_json,
        picked_idea_id = NULL
    `).run(input.now, input.weekKey, input.cardsJson);
    const row = this.db.prepare(`
      SELECT id FROM radar_shortlists WHERE week_key = ?
    `).get<{ id: number }>(input.weekKey);
    if (!row) throw new Error(`shortlist upsert failed for week ${input.weekKey}`);
    return { id: row.id };
  }

  /** The snapshot `/idea` renders and `/idea pick` resolves against (max id = latest fire). */
  getLatestShortlist(): ShortlistRow | null {
    const row = this.db.prepare(`
      SELECT id, created_at, week_key, cards_json, picked_idea_id
      FROM radar_shortlists
      ORDER BY id DESC
      LIMIT 1
    `).get<{
      id: number;
      created_at: string;
      week_key: string;
      cards_json: string;
      picked_idea_id: number | null;
    }>();
    if (!row) return null;
    const { cards_json, ...rest } = row;
    return { ...rest, cards: JSON.parse(cards_json) as ShortlistCard[] };
  }

  /** Display bookkeeping only — the pick truth is the ideas-table `picked` singleton. */
  setShortlistPick(input: { snapshotId: number; ideaId: number }): void {
    this.db.prepare(`
      UPDATE radar_shortlists SET picked_idea_id = ? WHERE id = ?
    `).run(input.ideaId, input.snapshotId);
  }

  /** One card by id, any status (the /radar <n> detail + pick-resolution read). */
  getIdeaById(id: number): IdeaRow | null {
    const row = this.db.prepare(`
      SELECT id, slug, title, summary, status, sources_json, distinct_items, distinct_sources,
             scores_json, first_seen, last_seen, archived_at,
             distinct_items * distinct_sources AS momentum
      FROM ideas
      WHERE id = ?
    `).get<IdeaRawRow>(id);
    return row ? parseIdeaRow(row) : null;
  }

  /**
   * The global pick singleton backing `/idea pick` (spec §5 B3): at most one
   * `status='picked'` card exists by construction — the pick handler reverts the
   * previous one before setting the next. Read first-by-id; tests assert the count.
   */
  getPickedIdea(): IdeaRow | null {
    const row = this.db.prepare(`
      SELECT id, slug, title, summary, status, sources_json, distinct_items, distinct_sources,
             scores_json, first_seen, last_seen, archived_at,
             distinct_items * distinct_sources AS momentum
      FROM ideas
      WHERE status = 'picked'
      ORDER BY id ASC
      LIMIT 1
    `).get<IdeaRawRow>();
    return row ? parseIdeaRow(row) : null;
  }

  /**
   * ONE event per weekly panel tick covering ALL outcomes (R2 spec §4 W7): result ∈
   * ok|skipped|aborted; skip/abort paths zero the counts and set `reason`. Judge names +
   * counts + ids only, zero prose — card text and judge rationales live in the
   * ideas/radar_shortlists rows, never the ledger. Mirrors {@link recordIdeaRadarTick}.
   */
  recordIdeaPanelTick(payload: {
    result: "ok" | "skipped" | "aborted";
    reason?: "thin_board" | "quorum";
    judges_ok: string[];
    judges_failed: string[];
    chair_used: boolean;
    cards_scored: number;
    shortlist_ids: number[];
    week_key: string;
    brief_written: boolean;
  }): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "idea-panel",
        event_type: "idea_panel_tick",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload
      })
    );
  }

  // --- Wiki pages (Phase W, ADR 0020) -----------------------------------------

  /** Insert one active page row; returns its id. */
  addWikiPage(input: WikiPageCandidate & { created_at?: string }): number {
    const created = input.created_at ?? new Date().toISOString();
    const blob = input.embedding ? float32ToBlob(input.embedding) : null;
    const result = this.db.prepare(`
      INSERT INTO wiki_pages (
        topic_slug, title, summary, key_facts, body_md, sources, contradictions,
        confidence, verified_passes, last_verified, embedding, embedding_model, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.topic_slug,
      input.title.trim(),
      input.summary?.trim() ?? "",
      JSON.stringify(input.key_facts ?? []),
      input.body_md ?? "",
      JSON.stringify(input.sources ?? []),
      JSON.stringify(input.contradictions ?? []),
      input.confidence ?? null,
      input.verified_passes ?? 0,
      input.last_verified ?? null,
      blob,
      blob ? input.embedding_model ?? null : null,
      created
    );
    return Number(result.lastInsertRowid);
  }

  /** Final-review C3: the wiki twin of setEpisodicFactEmbedding (only a row still NULL changes). */
  setWikiPageEmbedding(id: number, embedding: Float32Array, model: string): boolean {
    return this.db.prepare(`
      UPDATE wiki_pages SET embedding = ?, embedding_model = ? WHERE id = ? AND embedding IS NULL
    `).run(float32ToBlob(embedding), model, id).changes === 1;
  }

  /** Active wiki pages with no embedding, newest first (the backfill's batch). */
  listUnembeddedWikiPages(limit: number): WikiPageRow[] {
    return this.db.prepare(`
      SELECT ${WIKI_PAGE_COLUMNS} FROM wiki_pages WHERE status = 'active' AND embedding IS NULL ORDER BY id DESC LIMIT ?
    `).all<WikiPageRow>(limit);
  }

  getWikiPage(id: number): WikiPageRow | undefined {
    return this.db.prepare(`
      SELECT ${WIKI_PAGE_COLUMNS} FROM wiki_pages WHERE id = ?
    `).get<WikiPageRow>(id);
  }

  /** ACTIVE pages, newest first (W2 retrieval + the cosine identity leg read through this). */
  getActiveWikiPages(cap?: number): WikiPageRow[] {
    const limit = cap ?? -1; // SQLite: LIMIT -1 = unbounded
    return this.db.prepare(`
      SELECT ${WIKI_PAGE_COLUMNS} FROM wiki_pages
      WHERE status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all<WikiPageRow>(limit);
  }

  /**
   * FTS5/BM25 keyword leg over ACTIVE pages (title/summary/body_md), best rank first,
   * id ASC on ties. The query's letter/number tokens are individually quoted, so hostile
   * MATCH syntax cannot reach the parser; an unsegmentable query (CJK under unicode61)
   * or a parse error degrades to [] — NEVER throws. `mode` selects the token semantics:
   * `"any"` (default — the W2 retrieval pool wants breadth) ORs the tokens; `"all"`
   * ANDs them (the identity leg's F2 relevance floor — see findWikiPageForTopic).
   */
  searchWikiPagesFts(
    queryText: string,
    k: number,
    mode: "any" | "all" = "any"
  ): Array<WikiPageRow & { rank: number }> {
    // "all" is the topic-identity leg (the false-merge floor): a short token (q2, v3, ai) discriminates, so keep it
    const tokens = ftsQueryTokens(queryText, mode === "any");
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"`).join(mode === "all" ? " AND " : " OR ");
    try {
      return this.db.prepare(`
        SELECT ${WIKI_PAGE_COLUMNS_QUALIFIED}, fts.rank AS rank
        FROM wiki_pages_fts fts
        JOIN wiki_pages w ON w.id = fts.rowid
        WHERE wiki_pages_fts MATCH ? AND w.status = 'active'
        ORDER BY fts.rank, w.id
        LIMIT ?
      `).all<WikiPageRow & { rank: number }>(match, k);
    } catch {
      return []; // MATCH parse error → keyword leg contributes nothing
    }
  }

  /**
   * Topic identity (C6, ADR 0020 decision 4): does an active page for this topic already
   * exist? Three legs, each graceful: exact slug → FTS top-1 over the topic's tokens →
   * best cosine ≥ {@link WIKI_TOPIC_COSINE_THRESHOLD} over the active embeddings. A null
   * query embedding (Ollama down) simply skips the cosine leg — degradation, never an
   * error. build⇄refine auto-route rides this: a hit means REFINE, never a duplicate.
   *
   * F2 (W2, live-observed W1 residual): the FTS leg requires EVERY topic token to match
   * (`"all"` mode) — an any-token match let token-overlapping DISTINCT topics merge
   * ("Tesla Q2 earnings" matched the ASML Q2-earnings page on q2+earnings alone). A
   * fractional floor cannot separate that shape (2/3 overlap on the false merge vs 1/2
   * on a legitimate rephrase), so identity demands full coverage; PARAPHRASE recurrence
   * is the cosine leg's job, unchanged.
   */
  findWikiPageForTopic(topic: string, slug: string, embedding: Float32Array | null): WikiPageRow | undefined {
    const exact = this.db.prepare(`
      SELECT ${WIKI_PAGE_COLUMNS} FROM wiki_pages
      WHERE topic_slug = ? AND status = 'active'
      ORDER BY id DESC LIMIT 1
    `).get<WikiPageRow>(slug);
    if (exact) return exact;

    const fts = this.searchWikiPagesFts(topic, 1, "all");
    if (fts.length > 0) return fts[0];

    if (!embedding) return undefined;
    let best: WikiPageRow | undefined;
    let bestSim = 0;
    for (const row of this.getActiveWikiPages()) {
      if (!row.embedding) continue;
      const sim = cosineSimilarity(embedding, blobToFloat32(row.embedding));
      // ≥ the floor, best similarity wins; ties keep the NEWEST (rows arrive newest first).
      if (sim >= WIKI_TOPIC_COSINE_THRESHOLD && (best === undefined || sim > bestSim)) {
        best = row;
        bestSim = sim;
      }
    }
    return best;
  }

  /**
   * Link a supersede pair BIDIRECTIONALLY (invalidate-don't-delete — the superseded page
   * stays queryable as lineage). NEVER deletes. `_now` is reserved for a bi-temporal
   * stamp should wiki pages ever grow one (episodic's valid_until); unused today.
   */
  supersedeWikiPage(oldId: number, newId: number, _now: string): void {
    this.db.prepare(`
      UPDATE wiki_pages SET status = 'superseded', superseded_by = ? WHERE id = ?
    `).run(newId, oldId);
    this.db.prepare(`UPDATE wiki_pages SET supersedes = ? WHERE id = ?`).run(oldId, newId);
  }

  /**
   * Save a synthesized page against its (optional) prior (Phase W, mirroring
   * {@link RunStore.saveReconciledFact}): unchanged+prior touches last_verified only;
   * a prior means insert NEW + supersede (never an in-place rewrite, never a delete) —
   * the old row pays corrected_count/reuse ONLY when it was contradicted; no prior is a
   * plain add. A stale prior (no longer active) degrades to add. Overflow beyond the
   * global cap prunes the lowest reuse_value rows (never the row just written).
   */
  saveReconciledWikiPage(
    candidate: WikiPageCandidate,
    prior: WikiPageRow | undefined,
    now: string,
    cap: number
  ): WikiPageSaveResult {
    const target = prior && this.getWikiPage(prior.id)?.status === "active" ? prior : undefined;

    if (candidate.unchanged && target) {
      this.db.prepare(`UPDATE wiki_pages SET last_verified = ? WHERE id = ?`).run(now, target.id);
      return { verb: "unchanged", id: target.id, prunedIds: [] };
    }

    const id = this.addWikiPage({ ...candidate, created_at: now });
    if (target) {
      this.supersedeWikiPage(target.id, id, now);
      if (candidate.priorContradicted) {
        this.db.prepare(`
          UPDATE wiki_pages SET corrected_count = corrected_count + 1, reuse_value = reuse_value - 0.5 WHERE id = ?
        `).run(target.id);
      }
    }
    const prunedIds = this.pruneWikiOverflow(cap, id);
    return { verb: target ? "refine" : "add", id, ...(target ? { supersededId: target.id } : {}), prunedIds };
  }

  /** Prune (reversibly) the lowest-value active rows over the global cap, sparing `keepId`. */
  private pruneWikiOverflow(cap: number, keepId: number): number[] {
    if (cap <= 0) return [];
    const others = this.db.prepare(`
      SELECT id FROM wiki_pages
      WHERE status = 'active' AND id != ?
      ORDER BY reuse_value ASC, COALESCE(last_used, created_at) ASC, id ASC
    `).all<{ id: number }>(keepId);
    const toPrune = others.slice(0, Math.max(0, others.length + 1 - cap)).map((r) => r.id);
    for (const id of toPrune) {
      this.db.prepare(`UPDATE wiki_pages SET status = 'pruned' WHERE id = ?`).run(id);
    }
    return toPrune;
  }

  /** Attribution (W2): these pages were folded into a turn's prompt (touchApplied twin). */
  touchWikiApplied(ids: number[], now: string = new Date().toISOString()): void {
    const stmt = this.db.prepare(`
      UPDATE wiki_pages SET applied_count = applied_count + 1, last_used = ? WHERE id = ?
    `);
    for (const id of ids) stmt.run(now, id);
  }

  /**
   * Attribution (W2, the appliedLessonIdsForChat twin): the union of
   * `loop_started.applied_artifacts.wiki_page_ids` across the window's runs — the wiki
   * pages that rode the rated session's prompts. Window's runs = runs with a chat turn
   * in this chat at/after `sinceIso` (all of the chat's runs when omitted).
   */
  appliedWikiPageIdsForChat(chat_id: string, sinceIso?: string): number[] {
    const rows = sinceIso
      ? this.db.prepare(`
          SELECT payload_json FROM ledger_events
          WHERE event_type = 'loop_started'
            AND run_id IN (SELECT DISTINCT run_id FROM chat_turns WHERE chat_id = ? AND created_at >= ?)
        `).all<{ payload_json: string }>(chat_id, sinceIso)
      : this.db.prepare(`
          SELECT payload_json FROM ledger_events
          WHERE event_type = 'loop_started'
            AND run_id IN (SELECT DISTINCT run_id FROM chat_turns WHERE chat_id = ?)
        `).all<{ payload_json: string }>(chat_id);
    const ids = new Set<number>();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as {
          applied_artifacts?: { wiki_page_ids?: unknown };
        };
        const list = payload.applied_artifacts?.wiki_page_ids;
        if (!Array.isArray(list)) continue;
        for (const id of list) {
          if (typeof id === "number" && Number.isInteger(id)) ids.add(id);
        }
      } catch {
        // A malformed payload never blocks attribution over the rest.
      }
    }
    return [...ids].sort((a, b) => a - b);
  }

  /**
   * Absorb one captured session rating into the applied wiki pages (W2, the
   * applyRatingToLessons twin): append {rating, at} to each rating_history; a good
   * session (≥2) is the positive reuse signal (+0.25 per applied page). A low rating
   * appends only — culprit attribution stays lessons-only for now (ADR 0020 deferral).
   */
  applyRatingToWikiPages(ids: number[], rating: number, at: string): void {
    for (const id of ids) {
      const row = this.getWikiPage(id);
      if (!row) continue;
      const history = parseRatingHistory(row.rating_history);
      history.push({ rating, at });
      this.db.prepare(`
        UPDATE wiki_pages SET rating_history = ?, reuse_value = reuse_value + ? WHERE id = ?
      `).run(JSON.stringify(history), rating >= 2 ? 0.25 : 0, id);
    }
  }

  /**
   * The daily wiki decay pass (W2, the runLessonDecayTick twin): at most once per
   * 24h (the `wiki_decay_state` row makes it idempotent across poll cycles). ACTIVE
   * pages unused for `decayDays` (never-used rows date from created_at) lose 20%
   * reuse_value. It no longer prunes in A1 (memory A1 §3; `pruneThreshold` is ignored,
   * the global cap still bounds the count). Superseded rows are exempt by construction
   * (they are already inactive lineage, not candidates). One summary ledger event per
   * executed tick.
   */
  runWikiDecayTick(
    now: string,
    options: { decayDays?: number; pruneThreshold?: number } = {}
  ): { ran: boolean; pages_decayed: number; pruned_ids: number[] } {
    const state = this.db.prepare(`
      SELECT last_decay_at FROM wiki_decay_state WHERE id = 1
    `).get<{ last_decay_at: string | null }>();
    if (state?.last_decay_at && Date.parse(now) - Date.parse(state.last_decay_at) < 86_400_000) {
      return { ran: false, pages_decayed: 0, pruned_ids: [] };
    }

    const decayDays = options.decayDays ?? resolveWikiDecayDays(process.env);
    const cutoff = new Date(Date.parse(now) - decayDays * 86_400_000).toISOString();
    const stale = this.db.prepare(`
      SELECT id, reuse_value FROM wiki_pages
      WHERE status = 'active' AND COALESCE(last_used, created_at) < ?
    `).all<{ id: number; reuse_value: number }>(cutoff);

    // Memory A1 §3: decay no longer prunes pages (reuse still decays; the global cap still bounds the count).
    const pruned_ids: number[] = [];
    for (const row of stale) {
      this.db.prepare(`UPDATE wiki_pages SET reuse_value = ? WHERE id = ?`).run(row.reuse_value * 0.8, row.id);
    }

    this.db.prepare(`UPDATE wiki_decay_state SET last_decay_at = ? WHERE id = 1`).run(now);
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "wiki-decay",
        event_type: "wiki_decay_tick",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload: { pages_decayed: stale.length, pruned_ids }
      })
    );
    return { ran: true, pages_decayed: stale.length, pruned_ids };
  }

  // --- Self-service memory correction (2026-10-02) -----------------------------

  /** Run `fn` in one IMMEDIATE transaction; a throw rolls everything back. `fn` must be synchronous (never span an await). */
  inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.outerTxDepth += 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.outerTxDepth -= 1;
    }
  }

  /** >0 while an `inTransaction` callback runs: `insertRun` then joins it instead of opening its own (a nested BEGIN throws). */
  private outerTxDepth = 0;

  /** Thrown inside a memory transaction when an id is not an active row of this chat: rolls the whole change back. */
  private static readonly MEMORY_REFUSED = new Error("memory_change_refused");

  /** Flip one active row (a fact only when it is this chat's) to `next`; refuse the change otherwise. */
  private flipActiveMemoryRow(kind: MemoryKind, id: number, chat_id: string, next: "pruned"): void {
    const chatClause = kind === "fact" ? " AND chat_id = ?" : "";
    const args: Array<string | number> = kind === "fact" ? [next, id, chat_id] : [next, id];
    const changed = this.db.prepare(`
      UPDATE ${MEMORY_TABLE[kind]} SET status = ? WHERE id = ? AND status = 'active'${chatClause}
    `).run(...args).changes;
    if (changed !== 1) throw RunStore.MEMORY_REFUSED;
  }

  private insertMemoryChange(c: Omit<MemoryChange, "change_id" | "undone_at">): MemoryChange {
    const change: MemoryChange = { change_id: `mc_${randomUUID()}`, ...c, undone_at: null };
    this.db.prepare(`
      INSERT INTO memory_changes (change_id, kind, action, old_ids, new_id, run_id, chat_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(change.change_id, change.kind, change.action, JSON.stringify(change.old_ids), change.new_id, change.run_id,
      change.chat_id, change.created_at);
    return change;
  }

  /** Run a memory change; null (nothing written) when any id was refused. */
  private memoryChange(fn: () => MemoryChange): MemoryChange | null {
    try {
      return this.inTransaction(fn);
    } catch (error) {
      if (error === RunStore.MEMORY_REFUSED) return null;
      throw error;
    }
  }

  /** Retire (prune, reversibly) active rows; null and no write when any id is not active (or, for a fact, not this chat's). */
  retireMemoryRows(input: { kind: MemoryKind; ids: number[]; chat_id: string; run_id: string | null; now?: string }): MemoryChange | null {
    return this.memoryChange(() => this.retireMemoryRowsTx(input));
  }

  /** {@link retireMemoryRows}'s body for a caller already in a transaction (memory A1 migration): a refusal throws. */
  retireMemoryRowsTx(input: { kind: MemoryKind; ids: number[]; chat_id: string; run_id: string | null; now?: string }): MemoryChange {
    for (const id of input.ids) this.flipActiveMemoryRow(input.kind, id, input.chat_id, "pruned");
    return this.insertMemoryChange({ kind: input.kind, action: "retire", old_ids: [...input.ids], new_id: null,
      run_id: input.run_id, chat_id: input.chat_id, created_at: input.now ?? new Date().toISOString() });
  }

  /**
   * Replace active facts with Paco's corrected wording: one new active, non-core fact (M-H1: a correction never mints
   * always-on biography), each old fact superseded by it, and the new row's `supersedes` = the first old id. Null and
   * no write when any id is refused.
   */
  correctEpisodicFacts(input: {
    ids: number[]; correction: string; chat_id: string; run_id: string | null; source_turn_id?: string; now?: string;
  }): MemoryChange | null {
    const now = input.now ?? new Date().toISOString();
    return this.memoryChange(() => {
      const olds = input.ids.map((id) => this.getEpisodicFact(id));
      if (olds.some((f) => f?.status !== "active" || f.chat_id !== input.chat_id)) throw RunStore.MEMORY_REFUSED;
      const newId = this.addEpisodicFact({ chat_id: input.chat_id, fact: input.correction, created_at: now,
        source_turn_ids: input.source_turn_id ? [input.source_turn_id] : [] });
      // Reverse order: supersedeEpisodicFact sets the new row's `supersedes` each time, so the first id lands last.
      for (const id of [...input.ids].reverse()) this.supersedeEpisodicFact(id, newId, now);
      return this.insertMemoryChange({ kind: "fact", action: "correct", old_ids: [...input.ids], new_id: newId,
        run_id: input.run_id, chat_id: input.chat_id, created_at: now });
    });
  }

  getMemoryChange(change_id: string): MemoryChange | undefined {
    const row = this.db.prepare(`
      SELECT change_id, kind, action, old_ids, new_id, run_id, chat_id, created_at, undone_at FROM memory_changes WHERE change_id = ?
    `).get<Omit<MemoryChange, "old_ids"> & { old_ids: string }>(change_id);
    return row ? { ...row, old_ids: JSON.parse(row.old_ids) as number[] } : undefined;
  }

  /**
   * Undo a change (the Undo button): the old rows it flipped go back to active with no successor, the correction's new
   * row is pruned. Only rows still in the state this change left are touched, and the result names exactly those. A
   * correct whose new row is no longer active (consolidation moved on) is not undone at all: changed_since, no write.
   * Idempotent: a second undo changes nothing.
   */
  undoMemoryChange(change_id: string, now: string = new Date().toISOString()): MemoryUndoResult {
    return this.inTransaction(() => this.undoMemoryChangeTx(change_id, now));
  }

  /** {@link undoMemoryChange}'s body for a caller already in a transaction (memory A1 migration --revert). */
  undoMemoryChangeTx(change_id: string, now: string = new Date().toISOString()): MemoryUndoResult {
    const change = this.getMemoryChange(change_id);
    if (!change) return { status: "not_found" };
    if (change.undone_at !== null) return { status: "already_undone", change };
    if (change.action === "correct" && this.getEpisodicFact(change.new_id ?? -1)?.status !== "active") return { status: "changed_since", change };
    this.db.prepare(`UPDATE memory_changes SET undone_at = ? WHERE change_id = ?`).run(now, change_id);
    const { restored, retired } = this.restoreMemoryRows(change);
    return { status: "undone", change: { ...change, undone_at: now }, restored, retired };
  }

  /** Flip back what is still as the change left it; returns the ids it really restored and the new row it retired. */
  private restoreMemoryRows(change: MemoryChange): { restored: number[]; retired: number | null } {
    const table = MEMORY_TABLE[change.kind];
    const restored = change.old_ids.filter((id) => (change.action === "retire"
      ? this.db.prepare(`UPDATE ${table} SET status = 'active' WHERE id = ? AND status = 'pruned'`).run(id)
      : this.db.prepare(`
          UPDATE episodic_facts SET status = 'active', superseded_by = NULL, valid_until = NULL
          WHERE id = ? AND status = 'superseded' AND superseded_by = ?
        `).run(id, change.new_id)).changes === 1);
    if (change.action === "retire") return { restored, retired: null };
    const pruned = this.db.prepare(`UPDATE episodic_facts SET status = 'pruned' WHERE id = ? AND status = 'active'`).run(change.new_id).changes;
    return { restored, retired: pruned === 1 ? change.new_id : null };
  }

  // ── Jev decisions (ADR 0029 §3.4) ─────────────────────────────────────────

  insertJevDecision(row: Omit<JevDecisionRow, "decision_id" | "created_at" | "outcome_source" | "outcome_value" | "thread_cut_at" | "state_built_at">
    & { created_at?: string; thread_cut_at?: string | null; state_built_at?: string | null }): string {
    const decision_id = `jd_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO jev_decisions (decision_id, run_id, point, question_id, criteria_hash, model_reported, state_hash, lang, answers_json, confidence,
        top_prob, margin, threshold_version, threshold_used, decision, latency_ms, input_tokens, status, skip_reason, created_at, thread_cut_at, state_built_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(decision_id, row.run_id, row.point, row.question_id, row.criteria_hash, row.model_reported, row.state_hash, row.lang, row.answers_json,
      row.confidence, row.top_prob, row.margin, row.threshold_version, row.threshold_used, row.decision, row.latency_ms, row.input_tokens,
      row.status, row.skip_reason, row.created_at ?? new Date().toISOString(), row.thread_cut_at ?? null, row.state_built_at ?? null);
    return decision_id;
  }

  markJevDecision(decision_id: string, decision: JevDecisionOutcome, threshold_used: string | null): void {
    this.db.prepare(`UPDATE jev_decisions SET decision = ?, threshold_used = ? WHERE decision_id = ?`).run(decision, threshold_used, decision_id);
  }

  recordJevOutcome(decision_id: string, source: JevDecisionRow["outcome_source"], value: string): void {
    this.db.prepare(`UPDATE jev_decisions SET outcome_source = ?, outcome_value = ? WHERE decision_id = ?`).run(source, value, decision_id);
  }

  listJevDecisions(run_id: string): JevDecisionRow[] {
    return this.db.prepare(`SELECT * FROM jev_decisions WHERE run_id = ? ORDER BY rowid ASC`).all<JevDecisionRow>(run_id);
  }

  // ── Jev verdicts: one row per decision point call (spec §6) ──────────────

  insertJevVerdict(i: JevVerdictInsert): string {
    const verdict_id = `jv_${randomUUID()}`;
    const at = i.created_at ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO jev_verdicts (verdict_id, run_id, category, breadth, reasoning, actions, sets_rule, rule_scope, lane, role, effort, cascade,
        save_outcome, route_outcome, handler_outcome, reason, skip_reason, quoted_turn_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(verdict_id, i.run_id, i.category, i.breadth, i.reasoning, i.actions, i.sets_rule, i.rule_scope, i.lane, i.role, i.effort, i.cascade,
      i.save_outcome, i.route_outcome, i.reason, i.skip_reason, i.quoted_turn_id, at, at);
    return verdict_id;
  }

  updateJevVerdict(verdict_id: string, p: JevVerdictPatch): void {
    const sets: string[] = []; const values: Array<string | number | null> = [];
    for (const column of VERDICT_PATCH_COLUMNS) {
      const v = p[column];
      if (v === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE jev_verdicts SET ${sets.join(", ")}, updated_at = ? WHERE verdict_id = ?`).run(...values, new Date().toISOString(), verdict_id);
  }

  /**
   * The run's terminal closes a verdict still 'pending' (review F12: every terminal path, one guarded write). The guard
   * means a lane reply, a lane fall-through or an earlier close is never overwritten. Returns the rows moved (0 or 1).
   */
  closePendingJevVerdict(run_id: string, handler_outcome: "planner_done" | "planner_failed"): number {
    const r = this.db.prepare(`UPDATE jev_verdicts SET handler_outcome = ?, updated_at = ? WHERE run_id = ? AND handler_outcome = 'pending'`)
      .run(handler_outcome, new Date().toISOString(), run_id);
    return Number(r.changes);
  }

  getJevVerdictForRun(run_id: string): JevVerdictRow | undefined {
    return this.db.prepare(`SELECT * FROM jev_verdicts WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get<JevVerdictRow>(run_id);
  }

  /** The chat's latest verdict at or before `beforeIso` (same-millisecond turns must still see each other); the run's notify target is the chat. */
  latestJevVerdictForChat(chat_id: string, beforeIso: string): JevVerdictRow | undefined {
    return this.db.prepare(`
      SELECT v.* FROM jev_verdicts v JOIN runs r ON r.run_id = v.run_id
      WHERE json_extract(r.notify_json, '$.chat_id') = ? AND v.created_at <= ?
      ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1
    `).get<JevVerdictRow>(chat_id, beforeIso);
  }

  // ── Lesson changes: the memory lane's undoable change set (ADR 0029 §5.6) ──

  insertLessonChange(c: Omit<LessonChange, "change_id" | "created_at" | "undone_at"> & { created_at?: string }): LessonChange {
    const change: LessonChange = { change_id: `lc_${randomUUID()}`, run_id: c.run_id, chat_id: c.chat_id, new_id: c.new_id, superseded_id: c.superseded_id,
      pruned_ids: [...c.pruned_ids], created_at: c.created_at ?? new Date().toISOString(), undone_at: null };
    this.db.prepare(`INSERT INTO lesson_changes (change_id, run_id, chat_id, new_id, superseded_id, pruned_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(change.change_id, change.run_id, change.chat_id, change.new_id, change.superseded_id, JSON.stringify(change.pruned_ids), change.created_at);
    return change;
  }

  getLessonChange(change_id: string): LessonChange | undefined {
    const r = this.db.prepare(`SELECT * FROM lesson_changes WHERE change_id = ?`).get<Omit<LessonChange, "pruned_ids"> & { pruned_ids: string }>(change_id);
    return r ? { ...r, pruned_ids: JSON.parse(r.pruned_ids) as number[] } : undefined;
  }

  /** The latest change the memory lane made for a run (the override label points at it). */
  getLessonChangeByRun(run_id: string): LessonChange | undefined {
    const r = this.db.prepare(`SELECT * FROM lesson_changes WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get<Omit<LessonChange, "pruned_ids"> & { pruned_ids: string }>(run_id);
    return r ? { ...r, pruned_ids: JSON.parse(r.pruned_ids) as number[] } : undefined;
  }

  /** The run an event already created (source + idempotency key), if any: lets a caller tell a new run from a redelivery. */
  runIdForIdempotencyKey(source: string, idempotency_key: string): string | undefined {
    return this.db.prepare(`SELECT run_id FROM runs WHERE source = ? AND idempotency_key = ?`).get<{ run_id: string }>(source, idempotency_key)?.run_id;
  }

  /** Only a pruned row comes back; a row that moved since (active or superseded) is left alone. */
  unpruneLesson(id: number): boolean {
    return this.db.prepare(`UPDATE lessons SET status = 'active' WHERE id = ? AND status = 'pruned'`).run(id).changes === 1;
  }

  /** Compare-and-set in one transaction: valid only while the new row is still active (spec §5.6). */
  undoLessonChange(change_id: string, now: string = new Date().toISOString()): LessonUndoResult {
    return this.inTransaction((): LessonUndoResult => {
      const change = this.getLessonChange(change_id);
      if (!change) return { status: "not_found" };
      if (change.undone_at !== null) return { status: "already_undone", change };
      if (this.getLesson(change.new_id)?.status !== "active") return { status: "changed_since", change };
      this.db.prepare(`UPDATE lesson_changes SET undone_at = ? WHERE change_id = ?`).run(now, change_id);
      this.db.prepare(`UPDATE lessons SET status = 'pruned' WHERE id = ? AND status = 'active'`).run(change.new_id);
      const restored: number[] = []; const skipped: number[] = [];
      if (change.superseded_id !== null) (this.reactivateLesson(change.superseded_id) ? restored : skipped).push(change.superseded_id);
      for (const id of change.pruned_ids) (this.unpruneLesson(id) ? restored : skipped).push(id);
      // the event rides the same transaction as the restore (spec §5.6); recordMemoryEvent opens no transaction of its own
      this.recordMemoryEvent("lesson_change_undone", { change_id, restored, skipped });
      return { status: "undone", change: { ...change, undone_at: now }, restored, skipped };
    });
  }

  // ── small readers for lane 1 ───────────────────────────────────────────────

  /** True when an "Ask Houge anyway" tap re-submitted this run: triage is skipped for it (the tap is the override label). */
  triageOverrideFor(run_id: string): boolean {
    const r = this.db.prepare(`SELECT 1 AS one FROM ledger_events WHERE event_type = 'triage_override' AND json_extract(payload_json, '$.new_run_id') = ? LIMIT 1`).get<{ one: number }>(run_id);
    return r !== undefined;
  }

  countRecentLedgerEvents(event_type: LedgerEventType, sinceIso: string): number {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM ledger_events WHERE event_type = ? AND occurred_at >= ?`).get<{ n: number }>(event_type, sinceIso)?.n ?? 0;
  }

  userTurnTextForRun(run_id: string): string | undefined {
    return this.db.prepare(`SELECT text FROM chat_turns WHERE run_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`).get<{ text: string }>(run_id)?.text;
  }

  // --- DB backup (backlog #3, ADR 0021) ---------------------------------------

  /** The backup latch's last successful snapshot time (NULL = never — first tick fires). */
  getLastBackupAt(): string | null {
    const row = this.db.prepare(`
      SELECT last_backup_at FROM backup_state WHERE id = 1
    `).get<{ last_backup_at: string | null }>();
    return row?.last_backup_at ?? null;
  }

  /** Advance the backup latch — called ONLY after a verified snapshot landed. */
  advanceBackupLatch(now: string): void {
    this.db.prepare(`UPDATE backup_state SET last_backup_at = ? WHERE id = 1`).run(now);
  }

  /**
   * Transactional WAL-safe snapshot of the LIVE database into `path` (SQLite
   * `VACUUM INTO` — refuses an existing path, so callers write tmp + rename).
   */
  vacuumInto(path: string): void {
    this.db.prepare(`VACUUM INTO ?`).run(path);
  }

  /** One `db_backup_completed` ledger event per landed snapshot (run-less, like decay ticks). */
  recordDbBackupCompleted(payload: {
    path: string;
    bytes: number;
    kept_count: number;
    duration_ms: number;
  }): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "db-backup",
        event_type: "db_backup_completed",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload
      })
    );
  }

  /**
   * A `db_backup_failed` ledger event (the latch stays put — retries). Emission is
   * THROTTLED by the caller via the failure-event timestamp below: a permanently
   * broken backup retries every poll tick (~30s) but must not append thousands of
   * identical ledger rows a day.
   */
  recordDbBackupFailed(payload: { reason: string }): void {
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: "db-backup",
        event_type: "db_backup_failed",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload
      })
    );
  }

  /** When the last db_backup_failed EVENT was emitted (NULL = never). Throttle input. */
  getLastBackupFailureEventAt(): string | null {
    const row = this.db.prepare(`
      SELECT last_failure_event_at FROM backup_state WHERE id = 1
    `).get<{ last_failure_event_at: string | null }>();
    return row?.last_failure_event_at ?? null;
  }

  /** Stamp the failure-event throttle clock (called only when an event was emitted). */
  markBackupFailureEvent(now: string): void {
    this.db.prepare(`UPDATE backup_state SET last_failure_event_at = ? WHERE id = 1`).run(now);
  }

  // --- Scheduled tasks (B10b, ADR 0017) ---------------------------------------

  /** Insert a new enabled schedule (id minted here, like run ids). */
  addScheduledTask(input: {
    chat_id: string;
    goal: string;
    spec_json: string;
    tz: string;
    next_run_at: string;
    created_by?: string;
    now?: string;
  }): ScheduledTaskRow {
    const schedule_id = `sch_${randomUUID()}`;
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scheduled_tasks (
        schedule_id, chat_id, goal, spec_json, tz, state, next_run_at,
        last_fired_at, consecutive_failures, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'enabled', ?, NULL, 0, ?, ?, ?)
    `).run(
      schedule_id,
      input.chat_id,
      input.goal,
      input.spec_json,
      input.tz,
      input.next_run_at,
      input.created_by ?? null,
      now,
      now
    );
    return this.getScheduledTask(schedule_id)!;
  }

  /** Every schedule (or one chat's), newest first. Disabled/failed rows included — the caller filters. */
  listScheduledTasks(chat_id?: string): ScheduledTaskRow[] {
    return chat_id
      ? this.db.prepare(`
          SELECT * FROM scheduled_tasks WHERE chat_id = ? ORDER BY created_at DESC, schedule_id DESC
        `).all<ScheduledTaskRow>(chat_id)
      : this.db.prepare(`
          SELECT * FROM scheduled_tasks ORDER BY created_at DESC, schedule_id DESC
        `).all<ScheduledTaskRow>();
  }

  getScheduledTask(schedule_id: string): ScheduledTaskRow | undefined {
    return this.db.prepare(`
      SELECT * FROM scheduled_tasks WHERE schedule_id = ?
    `).get<ScheduledTaskRow>(schedule_id);
  }

  /** Enabled schedules due at/before `now`, soonest first (the tick's fire query). */
  listDueScheduledTasks(now: string, limit: number): ScheduledTaskRow[] {
    return this.db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE state = 'enabled' AND next_run_at <= ?
      ORDER BY next_run_at ASC, schedule_id ASC
      LIMIT ?
    `).all<ScheduledTaskRow>(now, limit);
  }

  /**
   * Cancel = state→'disabled' (reversible — rows are NEVER deleted). False when
   * absent/already off. 'failed' rows are cancellable too, or the ⚠ list entry could
   * never be cleared (verifier F2: no re-enable path exists, so a parked row was
   * permanent list noise).
   */
  cancelScheduledTask(schedule_id: string, now: string = new Date().toISOString()): boolean {
    const result = this.db.prepare(`
      UPDATE scheduled_tasks SET state = 'disabled', updated_at = ?
      WHERE schedule_id = ? AND state IN ('enabled', 'failed')
    `).run(now, schedule_id);
    return result.changes === 1;
  }

  /**
   * Update an existing schedule in place (scheduler v2, ADR 0017 amendment). Only the
   * provided fields change; omitted fields keep the stored value. Enabled AND failed
   * rows are updatable — an update re-enables a failed row and resets its counter,
   * because fixing the goal/spec IS the repair path (cancel is the only other exit).
   * Disabled rows are history — untouchable, same scoping as cancel. next_run_at is
   * the CALLER's decision (the adapter recomputes it only when spec/tz changed).
   */
  updateScheduledTask(input: {
    schedule_id: string;
    goal?: string | undefined;
    spec_json?: string | undefined;
    tz?: string | undefined;
    next_run_at?: string | undefined;
    now?: string | undefined;
  }): boolean {
    const row = this.getScheduledTask(input.schedule_id);
    if (!row || row.state === "disabled") return false;
    const now = input.now ?? new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE scheduled_tasks
      SET goal = ?, spec_json = ?, tz = ?, next_run_at = ?,
          state = 'enabled', consecutive_failures = 0, updated_at = ?
      WHERE schedule_id = ? AND state IN ('enabled', 'failed')
    `).run(
      input.goal ?? row.goal,
      input.spec_json ?? row.spec_json,
      input.tz ?? row.tz,
      input.next_run_at ?? row.next_run_at,
      now,
      input.schedule_id
    );
    return result.changes === 1;
  }

  /**
   * Advance a fired schedule: stamp last_fired_at, move next_run_at, reset the
   * consecutive-failure counter. Called BEFORE the fired run executes (fire-then-run:
   * a crash mid-run must not re-fire the same occurrence — see schedule-tick.ts).
   */
  markScheduleFired(schedule_id: string, fired_at: string, next_run_at: string): void {
    this.db.prepare(`
      UPDATE scheduled_tasks
      SET last_fired_at = ?, next_run_at = ?, consecutive_failures = 0, updated_at = ?
      WHERE schedule_id = ?
    `).run(fired_at, next_run_at, fired_at, schedule_id);
  }

  /**
   * Count a failed fire attempt; at `maxConsecutive` the row flips to 'failed' (a schedule
   * that cannot fire must not retry forever — the /schedule list surfaces the state).
   */
  recordScheduleFailure(
    schedule_id: string,
    now: string,
    maxConsecutive: number
  ): { failures: number; failed: boolean } {
    const row = this.getScheduledTask(schedule_id);
    if (!row) return { failures: 0, failed: false };
    const failures = row.consecutive_failures + 1;
    const failed = failures >= maxConsecutive;
    this.db.prepare(`
      UPDATE scheduled_tasks SET consecutive_failures = ?${failed ? ", state = 'failed'" : ""}, updated_at = ?
      WHERE schedule_id = ?
    `).run(failures, now, schedule_id);
    return { failures, failed };
  }

  // --- introspection: incidents + invariant detection (ADR 0024) -----------------

  /** Fingerprint an invariant violation — deterministic, so repeat detections dedupe. */
  incidentFingerprint(kind: string, subject: string): string {
    return `${kind}:${subject}`;
  }

  /**
   * Open a new incident and record the transition on the ledger. The ledger append happens
   * HERE (not in the sweep) so the store's redaction pass applies, matching how the wiki and
   * lesson decay ticks emit their own run-less system events.
   */
  openIncident(input: {
    kind: string;
    subject: string;
    detail: Record<string, unknown>;
    now?: string | undefined;
  }): IncidentRow {
    const incident_id = `inc_${randomUUID()}`;
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO incidents (
        incident_id, kind, subject, fingerprint, state, detail_json,
        seen_count, first_seen_at, last_seen_at, resolved_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'open', ?, 1, ?, ?, NULL, ?, ?)
    `).run(
      incident_id,
      input.kind,
      input.subject,
      this.incidentFingerprint(input.kind, input.subject),
      JSON.stringify(input.detail),
      now,
      now,
      now,
      now
    );
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: incident_id,
        event_type: "incident_opened",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload: { incident_id, kind: input.kind, subject: input.subject }
      })
    );
    return this.getIncident(incident_id)!;
  }

  getIncident(incident_id: string): IncidentRow | undefined {
    return this.db.prepare(`
      SELECT * FROM incidents WHERE incident_id = ?
    `).get<IncidentRow>(incident_id);
  }

  /** The open row for a fingerprint, if any (resolved rows never match — recurrence reopens). */
  findOpenIncident(fingerprint: string): IncidentRow | undefined {
    return this.db.prepare(`
      SELECT * FROM incidents WHERE fingerprint = ? AND state = 'open'
      ORDER BY first_seen_at ASC LIMIT 1
    `).get<IncidentRow>(fingerprint);
  }

  /**
   * The most recent RESOLVED incident for a fingerprint closed at/after `since` — the flap
   * detector. A condition oscillating around its threshold reopens legitimately (recurrence
   * must stay countable) but must not re-alert every cycle.
   */
  findRecentlyResolvedIncident(fingerprint: string, since: string): IncidentRow | undefined {
    return this.db.prepare(`
      SELECT * FROM incidents
      WHERE fingerprint = ? AND state = 'resolved' AND resolved_at >= ?
      ORDER BY resolved_at DESC LIMIT 1
    `).get<IncidentRow>(fingerprint, since);
  }

  /** A repeat detection: bump recency + counter ONLY — no notification, no new row. */
  touchIncident(incident_id: string, now: string): void {
    this.db.prepare(`
      UPDATE incidents SET seen_count = seen_count + 1, last_seen_at = ?, updated_at = ?
      WHERE incident_id = ? AND state = 'open'
    `).run(now, now, incident_id);
  }

  /** Close an incident. False when absent or already resolved (idempotent, never a throw). */
  resolveIncident(incident_id: string, now: string): boolean {
    const result = this.db.prepare(`
      UPDATE incidents SET state = 'resolved', resolved_at = ?, updated_at = ?
      WHERE incident_id = ? AND state = 'open'
    `).run(now, now, incident_id);
    if (result.changes !== 1) return false;
    const row = this.getIncident(incident_id)!;
    this.appendLedgerEvent(
      createLedgerEvent({
        correlation_id: incident_id,
        event_type: "incident_resolved",
        actor: "system",
        sequence: this.nextLedgerSequence(),
        payload: {
          incident_id,
          kind: row.kind,
          subject: row.subject,
          open_minutes: Math.floor((Date.parse(now) - Date.parse(row.first_seen_at)) / 60000)
        }
      })
    );
    return true;
  }

  /** Every currently-open incident, oldest first (the sweep's resolve pass + SQL inspection). */
  listOpenIncidents(): IncidentRow[] {
    return this.db.prepare(`
      SELECT * FROM incidents WHERE state = 'open' ORDER BY first_seen_at ASC, incident_id ASC
    `).all<IncidentRow>();
  }

  /**
   * Read-only twin of {@link claimInvariantSweep}: the self-check's last sweep instant for
   * /status, or null if it has never swept. MUST NOT mutate — reading must never reset the
   * throttle latch.
   */
  getInvariantSweepState(): { last_swept_at: string } | null {
    return (
      this.db.prepare(`
        SELECT last_swept_at FROM invariant_sweep_state WHERE id = 1
      `).get<{ last_swept_at: string }>() ?? null
    );
  }

  /**
   * Throttle latch for the invariant sweep: true at most once per `intervalMs`. Persisted
   * (not in-memory) so a daemon restart cannot turn a 5-minute cadence into a per-restart storm.
   */
  claimInvariantSweep(now: string, intervalMs: number): boolean {
    const row = this.db.prepare(`
      SELECT last_swept_at FROM invariant_sweep_state WHERE id = 1
    `).get<{ last_swept_at: string }>();
    if (row && Date.parse(now) - Date.parse(row.last_swept_at) < intervalMs) return false;
    this.db.prepare(`
      INSERT INTO invariant_sweep_state (id, last_swept_at) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET last_swept_at = excluded.last_swept_at
    `).run(now);
    return true;
  }

  /**
   * Invariant detection (ADR 0024). Each query returns rows carrying a `subject` (the
   * fingerprint's stable half) plus counts/ids for the incident detail — never user text.
   * All six are pure reads: the sweep can never mutate through them.
   *
   * NOTE on the duplicate-group subject: it is MIN(schedule_id) over the group, which is
   * deterministic for a FIXED group but shifts if the group's membership changes. A group
   * that loses and regains a member can therefore fingerprint differently — correctly so,
   * since it is a different set of rows; it just means flap damping does not span such a
   * change. Per-row invariants (failed/overdue/stuck) use the row id and are stable.
   */
  findDuplicateEnabledSchedules(): Array<{
    subject: string;
    chat_id: string;
    duplicate_count: number;
    schedule_ids: string[];
  }> {
    const rows = this.db.prepare(`
      SELECT MIN(schedule_id) AS subject, chat_id, COUNT(*) AS duplicate_count,
             GROUP_CONCAT(schedule_id) AS ids
      FROM scheduled_tasks
      WHERE state = 'enabled'
      GROUP BY chat_id, spec_json, tz, goal
      HAVING COUNT(*) > 1
      ORDER BY subject ASC
    `).all<{ subject: string; chat_id: string; duplicate_count: number; ids: string }>();
    return rows.map((r) => ({
      subject: r.subject,
      chat_id: r.chat_id,
      duplicate_count: r.duplicate_count,
      schedule_ids: r.ids.split(",").sort()
    }));
  }

  /**
   * Runs stuck mid-flight: an ACTIVE state whose lease expired before `leaseExpiredBefore`, or a turn
   * queued (never claimed) since before `queuedTurnBefore` (it may legitimately wait out an approval, N3).
   * `waiting_for_approval` is EXCLUDED by design — a run parked on Paco's /approve is the
   * system working, and alerting on it would make the sweep noisiest exactly when Paco is
   * slowest to answer.
   */
  findStuckRuns(leaseExpiredBefore: string, queuedTurnBefore: string = leaseExpiredBefore): Array<{
    subject: string;
    state: string;
    lease_expires_at: string | null;
  }> {
    return this.db.prepare(`
      SELECT run_id AS subject, state, lease_expires_at
      FROM runs
      WHERE (state IN ('created', 'contracted', 'queued', 'running', 'reconciliation_required', 'reporting')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ?)
        -- a turn queued and never claimed has no lease to expire (B1)
        OR (state = 'queued' AND type = 'turn' AND lease_expires_at IS NULL AND created_at < ?)
      ORDER BY updated_at ASC
    `).all<{ subject: string; state: string; lease_expires_at: string | null }>(leaseExpiredBefore, queuedTurnBefore);
  }

  /**
   * Undelivered outbox rows, EXCLUDING the sweep's own alerts (`incident_*` keys).
   *
   * A monitor must not observe its own output. Without this exclusion, broken Telegram
   * delivery is self-amplifying: the sweep opens an incident about an undelivered alert, its
   * alert about that is also undelivered, the next sweep opens an incident about THAT, and the
   * pile grows every cycle while never resolving. Excluding own-alerts means a delivery outage
   * surfaces once — via the genuinely stuck run/schedule notifications — and stays bounded.
   */
  findUndeliveredNotifications(now: string, graceMs: number, terminalWindowMs: number = TERMINAL_NOTIFICATION_REPORT_MS): Array<{
    subject: string;
    intent_type: string;
    attempt_count: number;
  }> {
    const cutoff = new Date(Date.parse(now) - graceMs).toISOString();
    // A terminal row (attempt cap, or abandoned as stale) stops counting `terminalWindowMs` after it WENT terminal
    // (updated_at, not created_at): every one is reported by at least one sweep, and none keeps the incident open forever.
    const abandonedBefore = new Date(Date.parse(now) - terminalWindowMs).toISOString();
    return this.db.prepare(`
      SELECT notification_id AS subject, intent_type, attempt_count
      FROM notification_outbox
      WHERE state != 'delivered'
        AND created_at < ?
        AND NOT (state = 'failed_terminal' AND updated_at < ?)
        AND idempotency_key NOT LIKE 'incident\\_%' ESCAPE '\\'
      ORDER BY created_at ASC
    `).all<{ subject: string; intent_type: string; attempt_count: number }>(cutoff, abandonedBefore);
  }

  findOverdueSchedules(now: string, graceMs: number): Array<{
    subject: string;
    next_run_at: string;
    overdue_minutes: number;
  }> {
    const cutoff = new Date(Date.parse(now) - graceMs).toISOString();
    const rows = this.db.prepare(`
      SELECT schedule_id AS subject, next_run_at
      FROM scheduled_tasks
      WHERE state = 'enabled' AND next_run_at < ?
      ORDER BY next_run_at ASC
    `).all<{ subject: string; next_run_at: string }>(cutoff);
    return rows.map((r) => ({
      ...r,
      overdue_minutes: Math.floor((Date.parse(now) - Date.parse(r.next_run_at)) / 60000)
    }));
  }

  findFailedSchedules(): Array<{ subject: string; consecutive_failures: number }> {
    return this.db.prepare(`
      SELECT schedule_id AS subject, consecutive_failures
      FROM scheduled_tasks
      WHERE state = 'failed'
      ORDER BY updated_at ASC
    `).all<{ subject: string; consecutive_failures: number }>();
  }

  /** `loop_started` turns in (since, until] that carry retrieval telemetry, and how many of them got no query embedding. */
  countEmbeddingTurns(since: string, until: string): { turns: number; without: number } {
    return this.db.prepare(`
      SELECT COUNT(*) AS turns,
        COALESCE(SUM(CASE WHEN json_extract(payload_json, '$.retrieval.facts.embedding') = 0 THEN 1 ELSE 0 END), 0) AS without
      FROM ledger_events
      WHERE event_type = 'loop_started' AND occurred_at > ? AND occurred_at <= ?
        AND json_extract(payload_json, '$.retrieval.facts.embedding') IS NOT NULL
    `).get<{ turns: number; without: number }>(since, until) ?? { turns: 0, without: 0 };
  }

  /**
   * Jev calls at one decision point in (since, until]: an answered call counts once (its question rows share the run), a
   * skipped call is one row. Skips whose reason is in `notAttempts` are not calls; `failed` counts those in `silent`.
   */
  countJevCalls(point: string, since: string, until: string, notAttempts: readonly string[], silent: readonly string[]): { attempts: number; failed: number } {
    // An empty list must mean "none": `IN (NULL)` matches nothing, but `NOT IN (NULL)` would also match nothing.
    const inList = (xs: readonly string[]) => (xs.length ? `skip_reason IN (${xs.map(() => "?").join(", ")})` : "0");
    const row = this.db.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN status = 'answered' THEN COALESCE(run_id, decision_id) END)
          + COALESCE(SUM(CASE WHEN status = 'skipped' AND NOT (${inList(notAttempts)}) THEN 1 ELSE 0 END), 0) AS attempts,
        COALESCE(SUM(CASE WHEN status = 'skipped' AND ${inList(silent)} THEN 1 ELSE 0 END), 0) AS failed
      FROM jev_decisions
      WHERE point = ? AND created_at > ? AND created_at <= ?
    `).get<{ attempts: number; failed: number }>(...notAttempts, ...silent, point, since, until);
    return row ?? { attempts: 0, failed: 0 };
  }

  /** Whether any Jev call at `point` was answered after `since` (what resolves a sticky `jev_skip_rate`). */
  hasAnsweredJevCallSince(point: string, since: string): boolean {
    return this.db.prepare(`SELECT 1 AS hit FROM jev_decisions WHERE point = ? AND status = 'answered' AND created_at > ? LIMIT 1`)
      .get<{ hit: number }>(point, since) !== undefined;
  }

  /**
   * Slice 2 (review W4): a provider tried at least `minAttempts` times in the window with ZERO
   * `ok` is a dead leg — the D1 shape (agy failed every call for ~3 months while `pi` answered),
   * now detectable instead of silent. Reads `llm_attempt` only (history has no failures to
   * count). Pure read.
   *
   * An `error_kind: "auth"` rejection is deterministic, not unlucky (spec amendment 14): a low-
   * volume leg (~1.5 turns/day) would never reach `minAttempts` in the window, so one auth failure
   * with zero `ok` is enough on its own, for any provider.
   *
   * `last_error_kind` is a correlated subquery over the SAME provider's non-ok rows in the SAME
   * window, ordered by `occurred_at DESC, sequence DESC` (codex review, Task 12 fix 5) — the
   * kind of the most recent failure. A plain `MAX(CASE ... error_kind)` returns the
   * ALPHABETICALLY GREATEST kind ("transport" > "timeout" lexically), which is wrong whenever
   * two error kinds both occur in the window: the ledger would report a stale cause instead of
   * what just happened. `sequence` breaks ties within the same millisecond.
   *
   * Grouped by PROVIDER — one binary is dead for every role at once; a role-specific pin that
   * differs by model is the residual this grouping does not catch.
   *
   * Replay roles (`classify_replay*`) are operator CLI runs, not daemon health, and are excluded. So are
   * `error_kind: "shutdown"` rows: the daemon's own stop cut the request, not the provider. `aborted` rows count:
   * that label also covers a hung planner turn (frame_idle, turn_timeout) and a provider's own "aborted" error.
   */
  findFailingLlmLegs(now: string, windowMs: number, minAttempts: number): Array<{ subject: string; attempts: number; ok: number; last_error_kind: string | null }> {
    const since = new Date(Date.parse(now) - windowMs).toISOString();
    return this.db.prepare(`
      SELECT
        json_extract(payload_json, '$.provider') AS subject,
        COUNT(*) AS attempts,
        SUM(CASE WHEN json_extract(payload_json, '$.outcome') = 'ok' THEN 1 ELSE 0 END) AS ok,
        (
          SELECT json_extract(e2.payload_json, '$.error_kind')
          FROM ledger_events e2
          WHERE e2.event_type = 'llm_attempt'
            AND e2.occurred_at > ?
            AND json_extract(e2.payload_json, '$.provider') = json_extract(ledger_events.payload_json, '$.provider')
            AND json_extract(e2.payload_json, '$.outcome') <> 'ok'
            AND COALESCE(json_extract(e2.payload_json, '$.error_kind'), '') <> 'shutdown'
            AND COALESCE(json_extract(e2.payload_json, '$.role'), '') NOT LIKE 'classify_replay%'
            -- Jev has its own incidents (jev_*); never double-page through llm_leg_failing (ADR 0029 §3.3)
            AND json_extract(e2.payload_json, '$.provider') <> 'jev'
          ORDER BY e2.occurred_at DESC, e2.sequence DESC
          LIMIT 1
        ) AS last_error_kind
      FROM ledger_events
      WHERE event_type = 'llm_attempt' AND occurred_at > ?
        AND COALESCE(json_extract(payload_json, '$.error_kind'), '') <> 'shutdown'
        AND COALESCE(json_extract(payload_json, '$.role'), '') NOT LIKE 'classify_replay%'
        -- Jev has its own incidents (jev_*); never double-page through llm_leg_failing (ADR 0029 §3.3)
        AND json_extract(payload_json, '$.provider') <> 'jev'
      GROUP BY subject
      HAVING ok = 0 AND (attempts >= ? OR last_error_kind = 'auth')
      ORDER BY subject
    `).all<{ subject: string; attempts: number; ok: number; last_error_kind: string | null }>(since, since, minAttempts);
  }

  /**
   * A heartbeat older than the grace window means the daemon was DOWN and has just come back
   * (the sweep only runs inside a live daemon) — a retroactive gap report, which is exactly
   * the thing Paco cannot otherwise see.
   */
  findHeartbeatGap(now: string, graceMs: number): { subject: string; gap_minutes: number } | undefined {
    const row = this.db.prepare(`
      SELECT last_success_at FROM daemon_heartbeat WHERE id = 1
    `).get<{ last_success_at: string | null }>();
    if (!row?.last_success_at) return undefined;
    const gapMs = Date.parse(now) - Date.parse(row.last_success_at);
    if (gapMs < graceMs) return undefined;
    return { subject: "daemon", gap_minutes: Math.floor(gapMs / 60000) };
  }

  /** D10 sweep: how many `wall_collapse` rows landed after `since` (every row when null — the first sweep). Counts only. */
  countWallCollapsesSince(since: string | null): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM ledger_events WHERE event_type = 'wall_collapse' AND (? IS NULL OR occurred_at > ?)
    `).get<{ count: number }>(since, since);
    return row?.count ?? 0;
  }

  /** Enabled schedules for one chat (the per-chat creation cap). */
  countActiveSchedules(chat_id: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM scheduled_tasks WHERE chat_id = ? AND state = 'enabled'
    `).get<{ count: number }>(chat_id);
    return row?.count ?? 0;
  }

  /** Per-fire audit: the vestigial `schedule_fired` ledger event, now live (run-ledger.ts). */
  recordScheduleFired(input: {
    run_id: string;
    schedule_id: string;
    scheduled_time: string;
    command_hash: string;
  }): void {
    this.appendRunLedgerEvent(input.run_id, "schedule_fired", "trigger_adapter", {
      schedule_id: input.schedule_id,
      scheduled_time: input.scheduled_time,
      command_hash: input.command_hash
    });
  }

  /** Per-fire audit: a fire whose idempotency key hit an existing run (crash replay). */
  recordScheduleSkippedDuplicate(input: {
    schedule_id: string;
    scheduled_time: string;
    idempotency_key: string;
    existing_run_id: string;
  }): void {
    this.appendRunLedgerEvent(
      input.existing_run_id,
      "schedule_skipped_duplicate",
      "trigger_adapter",
      {
        schedule_id: input.schedule_id,
        scheduled_time: input.scheduled_time,
        idempotency_key: input.idempotency_key,
        existing_run_id: input.existing_run_id
      }
    );
  }

  // --- Projects + bounty sightings (Money-Work P2, spec 2026-07-18) ------------

  /**
   * Track a pursued bounty. Idempotent on source_url (UNIQUE): tracking an already-
   * tracked URL returns the existing row unchanged — no duplicate, no ledger event.
   * Returns `{ row, created }` so the caller ledgers only genuine creations.
   */
  addProject(input: {
    source_url: string;
    kind?: string;
    title?: string | null;
    amount_usd?: number | null;
    now?: string;
  }): { row: ProjectRow; created: boolean } {
    const existing = this.getProjectBySourceUrl(input.source_url);
    if (existing) {
      return { row: existing, created: false };
    }
    const project_id = `proj_${randomUUID()}`;
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects (
        project_id, kind, source_url, title, amount_usd, state, state_reason,
        notes_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'tracked', NULL, NULL, ?, ?)
    `).run(
      project_id,
      input.kind ?? "bounty",
      input.source_url,
      input.title ?? null,
      input.amount_usd ?? null,
      now,
      now
    );
    return { row: this.getProject(project_id)!, created: true };
  }

  getProject(project_id: string): ProjectRow | undefined {
    return this.db.prepare(`
      SELECT * FROM projects WHERE project_id = ?
    `).get<ProjectRow>(project_id);
  }

  getProjectBySourceUrl(source_url: string): ProjectRow | undefined {
    return this.db.prepare(`
      SELECT * FROM projects WHERE source_url = ?
    `).get<ProjectRow>(source_url);
  }

  /** All projects (or one state's), newest first. Rows are never deleted — callers filter. */
  listProjects(state?: ProjectState): ProjectRow[] {
    return state
      ? this.db.prepare(`
          SELECT * FROM projects WHERE state = ? ORDER BY created_at DESC, project_id DESC
        `).all<ProjectRow>(state)
      : this.db.prepare(`
          SELECT * FROM projects ORDER BY created_at DESC, project_id DESC
        `).all<ProjectRow>();
  }

  /**
   * Move a project along the P2 state machine (state-machines.ts). An illegal move
   * returns `{ ok: false }` and writes NOTHING (no row change, no ledger event) — the
   * tool surfaces the error; bookkeeping never silently skips a state.
   */
  transitionProject(
    project_id: string,
    to: ProjectState,
    reason?: string,
    now: string = new Date().toISOString()
  ): { ok: true; row: ProjectRow; from: ProjectState } | { ok: false; error: string } {
    const row = this.getProject(project_id);
    if (!row) {
      return { ok: false, error: `unknown project: ${project_id}` };
    }
    const from = row.state;
    if (from === to) {
      return { ok: false, error: `project already in state '${to}'` };
    }
    if (!canTransitionProject(from, to)) {
      return { ok: false, error: `illegal transition ${from} → ${to}` };
    }
    this.db.prepare(`
      UPDATE projects SET state = ?, state_reason = ?, updated_at = ? WHERE project_id = ?
    `).run(to, reason ?? null, now, project_id);
    return { ok: true, row: this.getProject(project_id)!, from };
  }

  /**
   * Record a scan sighting. Non-downgrading (spec §4): an `unverified` pass never
   * overwrites a substantive verdict/score; last_seen_at/times_seen always advance.
   * Returns true when the URL was never seen before (the NEW marker).
   */
  upsertBountySighting(input: {
    issue_url: string;
    score: number | null;
    verdict: string | null;
    now?: string;
  }): { isNew: boolean } {
    const now = input.now ?? new Date().toISOString();
    const existing = this.db.prepare(`
      SELECT * FROM bounty_sightings WHERE issue_url = ?
    `).get<BountySightingRow>(input.issue_url);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO bounty_sightings (
          issue_url, first_seen_at, last_seen_at, last_score, last_verdict, times_seen
        ) VALUES (?, ?, ?, ?, ?, 1)
      `).run(input.issue_url, now, now, input.score, input.verdict);
      return { isNew: true };
    }
    const downgrade =
      input.verdict === "unverified" &&
      existing.last_verdict !== null &&
      existing.last_verdict !== "unverified";
    if (downgrade) {
      this.db.prepare(`
        UPDATE bounty_sightings SET last_seen_at = ?, times_seen = times_seen + 1
        WHERE issue_url = ?
      `).run(now, input.issue_url);
    } else {
      this.db.prepare(`
        UPDATE bounty_sightings
        SET last_seen_at = ?, times_seen = times_seen + 1, last_score = ?, last_verdict = ?
        WHERE issue_url = ?
      `).run(now, input.score, input.verdict, input.issue_url);
    }
    return { isNew: false };
  }

  getBountySighting(issue_url: string): BountySightingRow | undefined {
    return this.db.prepare(`
      SELECT * FROM bounty_sightings WHERE issue_url = ?
    `).get<BountySightingRow>(issue_url);
  }

  /** The last scan's completion time (the 10-min re-scan throttle reads this). */
  latestBountyScanAt(): string | undefined {
    const row = this.db.prepare(`
      SELECT occurred_at FROM ledger_events
      WHERE event_type = 'bounty_scan_completed'
      ORDER BY occurred_at DESC LIMIT 1
    `).get<{ occurred_at: string }>();
    return row?.occurred_at;
  }

  /** P2 audit: one event per completed scan — counts only, never venue text. */
  recordBountyScanCompleted(input: {
    run_id: string;
    venue_count: number;
    candidates: number;
    scam_suspects: number;
    new_sightings: number;
  }): void {
    this.appendRunLedgerEvent(input.run_id, "bounty_scan_completed", "core", {
      venue_count: input.venue_count,
      candidates: input.candidates,
      scam_suspects: input.scam_suspects,
      new_sightings: input.new_sightings
    });
  }

  /** ADR 0025 audit: one event per Google API tool op — counts only, never mail content. */
  recordGoogleApiCallCompleted(input: {
    run_id: string;
    service: string;
    op: string;
    count: number;
    extracted_codes: number;
    extracted_links: number;
  }): void {
    this.appendRunLedgerEvent(input.run_id, "google_api_call_completed", "core", {
      service: input.service,
      op: input.op,
      count: input.count,
      extracted_codes: input.extracted_codes,
      extracted_links: input.extracted_links
    });
  }

  /** P2 audit: a genuinely-new tracked project (idempotent re-tracks are NOT ledgered). */
  recordProjectCreated(input: { run_id: string; project_id: string; source_url: string }): void {
    this.appendRunLedgerEvent(input.run_id, "project_created", "core", {
      project_id: input.project_id,
      source_url: input.source_url
    });
  }

  /** P2 audit: one event per legal state move (illegal moves write nothing). */
  recordProjectStateChanged(input: {
    run_id: string;
    project_id: string;
    from: ProjectState;
    to: ProjectState;
  }): void {
    this.appendRunLedgerEvent(input.run_id, "project_state_changed", "core", {
      project_id: input.project_id,
      from: input.from,
      to: input.to
    });
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
          text: buildApprovalPromptText(approval_id, input, this.redact),
          action_summary: input.action_summary,
          buttons: approvalButtons(approval_id)
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

      const resolveInput = {
        approval_id: input.event.approval_id ?? "",
        decision: input.decision,
        requester: input.event.requested_by,
        resolved_at: input.resolved_at
      };
      const result = this.getToolApproval(resolveInput.approval_id)
        ? this.resolveToolApprovalWithinTransaction(resolveInput)
        : this.resolveApprovalWithinTransaction(resolveInput);

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

  createToolApproval(input: ToolApprovalInput): ToolApprovalRow {
    const approval_id = `appr_${randomUUID()}`;
    const created_at = new Date().toISOString();
    let active = false;
    this.db.exec("BEGIN IMMEDIATE");
    active = true;
    try {
      this.db.prepare(`
        INSERT INTO tool_approvals (
          approval_id, run_id, worker_id, tool_call_id, capability, input_hash,
          action_fingerprint, requester_json, summary, side_effect_level, state, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        approval_id, input.run_id, input.worker_id, input.tool_call_id, input.capability,
        input.input_hash, input.action_fingerprint, JSON.stringify(input.requester),
        input.summary, input.side_effect_level, created_at, input.expires_at
      );
      this.appendRunLedgerEvent(input.run_id, "approval_requested", "capability_runner", {
        approval_id,
        action_fingerprint: input.action_fingerprint,
        action_summary: input.summary,
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
          text: buildToolApprovalPromptText(approval_id, input, this.redact),
          action_summary: input.summary,
          buttons: approvalButtons(approval_id),
          ...(input.card_detail !== undefined ? { card_detail: this.redact(input.card_detail) } : {})
        }
      }));
      this.db.exec("COMMIT");
      active = false;
      return { ...input, approval_id, state: "pending", created_at, resolved_at: null };
    } catch (error) {
      if (active) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getToolApproval(approval_id: string): ToolApprovalRow | null {
    const row = this.db.prepare(`
      SELECT * FROM tool_approvals WHERE approval_id = ?
    `).get<ToolApprovalDbRow>(approval_id);
    if (!row) return null;
    const { requester_json, summary, ...rest } = row;
    return { ...rest, summary, requester: JSON.parse(requester_json) as Identity };
  }

  /** Single CAS approved -> consumed; valid only while the same owner still holds the run lease. */
  consumeToolApproval(input: {
    approval_id: string;
    run_id: string;
    worker_id: string;
    capability: string;
    action_fingerprint: string;
    requester: Identity;
    now: string;
  }): { ok: true } | { ok: false; code: string } {
    const row = this.getToolApproval(input.approval_id);
    if (!row || row.run_id !== input.run_id) return { ok: false, code: "unknown_approval" };
    if (row.state !== "approved") return { ok: false, code: "not_approved" };
    if (row.expires_at <= input.now) return { ok: false, code: "expired" };
    if (row.capability !== input.capability || row.action_fingerprint !== input.action_fingerprint) {
      return { ok: false, code: "action_mismatch" };
    }
    if (row.worker_id !== input.worker_id) return { ok: false, code: "owner_mismatch" };
    if (!sameIdentity(row.requester, input.requester)) return { ok: false, code: "requester_mismatch" };
    const updated = this.db.prepare(`
      UPDATE tool_approvals SET state = 'consumed', resolved_at = COALESCE(resolved_at, ?)
      WHERE approval_id = ? AND state = 'approved'
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE run_id = ? AND worker_id = ? AND state = 'running' AND lease_expires_at > ?
        )
    `).run(input.now, input.approval_id, input.run_id, input.worker_id, input.now);
    return updated.changes === 1 ? { ok: true } : { ok: false, code: "lease_lost" };
  }

  expireToolApproval(approval_id: string, now: string): boolean {
    const updated = this.db.prepare(`
      UPDATE tool_approvals SET state = 'expired', resolved_at = ?
      WHERE approval_id = ? AND state IN ('pending', 'approved')
    `).run(now, approval_id);
    return updated.changes === 1;
  }

  /** Pending approval ids from both tables, oldest first (for `/approvals`). */
  listPendingApprovalIds(): string[] {
    return this.db.prepare(`
      SELECT approval_id, created_at FROM approvals WHERE state = 'pending'
      UNION ALL
      SELECT approval_id, created_at FROM tool_approvals WHERE state = 'pending'
      ORDER BY created_at ASC, approval_id ASC
    `).all<{ approval_id: string }>().map((r) => r.approval_id);
  }

  /** Pending approvals from both tables that can still be answered (expires_at > now), oldest first — `/approvals`. */
  listLiveApprovals(now: string): Array<{ approval_id: string; summary: string; expires_at: string }> {
    return this.db.prepare(`
      SELECT approval_id, action_summary AS summary, expires_at, created_at FROM approvals WHERE state = 'pending' AND expires_at > ?
      UNION ALL
      SELECT approval_id, summary, expires_at, created_at FROM tool_approvals WHERE state = 'pending' AND expires_at > ?
      ORDER BY created_at ASC, approval_id ASC
    `).all<{ approval_id: string; summary: string; expires_at: string }>(now, now)
      .map((r) => ({ approval_id: r.approval_id, summary: r.summary, expires_at: r.expires_at }));
  }

  /** @internal Test hook: resolves through the same private resolver `processApprovalTrigger` uses. */
  resolveToolApprovalForTest(approval_id: string, decision: ApprovalDecision): ApprovalResolutionResult {
    const row = this.getToolApproval(approval_id);
    if (!row) return approvalFailure("APPROVAL_NOT_FOUND");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.resolveToolApprovalWithinTransaction({
        approval_id, decision, requester: row.requester, resolved_at: new Date().toISOString()
      });
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
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
    input: { text: string; report_path: string; buttons?: NotificationButton[]; attachments?: string[] }
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
        text: truncateForChat(input.text, this.redact),
        report_path: input.report_path,
        // Phase 3.3: inline buttons (the self-write merge controls) ride only when supplied;
        // every other final report omits them and stays byte-identical to before.
        ...(input.buttons ? { buttons: input.buttons } : {}),
        // omp turns: workspace files the planner attached; the Telegram adapter re-checks each at send time.
        ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {})
      }
    });
  }

  /**
   * Enqueue a terminal FAILURE notification so a failed run is NEVER silent (Phase 3.4): the user
   * sees "I hit an error on that one: <reason>" instead of nothing — which previously looked like
   * Houge was dead when he had actually errored. Rides the same delivery path and idempotency key as
   * the success final-report, so a run emits exactly ONE terminal notification — success OR failure,
   * never both (a failed run never reaches `enqueueFinalReportNotification`). `report_path` is the
   * partial report when one was written; omitted when even that failed.
   */
  enqueueFailureNotification(
    run_id: string,
    text: string,
    report_path?: string
  ): NotificationQueueResult {
    return this.enqueueNotification({
      target: this.getRunNotifyTarget(run_id),
      intent_type: "final_report",
      idempotency_key: `${run_id}:final_report`,
      run_id,
      correlation_id: run_id,
      payload: {
        text: truncateForChat(text, this.redact),
        ...(report_path ? { report_path } : {})
      }
    });
  }

  /**
   * Enqueue the backgrounded evolution pipeline's COMPLETION notification (⓪·3g): the
   * publish text + merge-control buttons, or the code-owned failure/timeout text. Rides
   * the run's original notify target on its own idempotency key (the turn's kickoff
   * reply already consumed `${run_id}:final_report`). The key carries the TOOL (F2): the
   * lane serializes pipelines but the once-per-turn guard is per-TOOL, so one turn can
   * run e.g. a fast self_diagnose AND a self_write_propose sequentially — a run-only key
   * would conflict the second outcome into a silent drop.
   */
  enqueueEvolutionReportNotification(
    run_id: string,
    tool: string,
    input: { text: string; buttons?: NotificationButton[] }
  ): NotificationQueueResult {
    const target = this.getRunNotifyTarget(run_id);
    const text = truncateForChat(input.text, this.redact);
    const result = this.enqueueNotification({
      target,
      intent_type: "final_report",
      idempotency_key: `${run_id}:evolution_report:${tool}`,
      run_id,
      correlation_id: run_id,
      payload: {
        text,
        ...(input.buttons ? { buttons: input.buttons } : {})
      }
    });
    // B10a: the delivered report ALSO becomes an assistant chat turn, at its true time —
    // without it the model's next-turn thread context ends at the kickoff digest, so a
    // follow-up about "the report above" cannot resolve (live gap, 07-13 03:27 report).
    // The `queued` status is the exactly-once latch (a duplicate/conflict re-enqueue must
    // not re-record); a `local` target has no chat thread, so nothing is recorded.
    if (result.status === "queued" && target.kind === "telegram") {
      this.recordChatTurn({
        chat_id: target.chat_id,
        run_id,
        role: "assistant",
        text,
        intent: "evolution_report"
      });
    }
    return result;
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
      // Resolve the winner FIRST (BEGIN IMMEDIATE holds the write lock, so nothing can
      // claim it between this SELECT and the UPDATE), then claim and return THAT id.
      // Re-discovering the claimed row afterwards via `lease_owner + state='sending'
      // ORDER BY updated_at DESC, notification_id DESC` was wrong: an owner with an
      // earlier, still-unacked `sending` row claimed within the same millisecond ties on
      // updated_at, and the random-UUID tiebreak then returned the OLD row half the time.
      const next = this.db.prepare(`
        SELECT notification_id
        FROM notification_outbox
        WHERE state = 'queued' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT 1
      `).get<{ notification_id: string }>(now);

      if (!next) {
        this.db.exec("COMMIT");
        activeTransaction = false;
        return null;
      }

      const updated = this.db.prepare(`
        UPDATE notification_outbox
        SET state = 'sending',
            lease_owner = ?,
            lease_expires_at = ?,
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE notification_id = ? AND state = 'queued'
      `).run(lease_owner, lease_expires_at, now, next.notification_id);

      this.db.exec("COMMIT");
      activeTransaction = false;
      return updated.changes === 1 ? this.getNotificationRecord(next.notification_id) : null;
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
      const next_attempt_at = willRetry ? this.addSeconds(now, retryBackoffMs(record.attempt_count) / 1000) : record.next_attempt_at;

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

  /**
   * The outbox retry step (live gate 2026-10-01: retry_wait rows were never sent again). The daemon runs it once per
   * poll cycle inside its serialized sender, so no send of this process is in flight: abandon the stale rows first,
   * then return orphaned `sending` rows and due `retry_wait` rows to the queue for the flush that follows.
   */
  retryUndeliveredNotifications(now: string): { abandoned: string[]; recovered: string[]; requeued: string[] } {
    const abandoned = this.abandonStaleNotifications(now);
    return { abandoned, recovered: this.recoverStaleSendingNotifications(now), requeued: this.requeueRetryWaitNotifications(now) };
  }

  /**
   * A queued or retry_wait row, or a `sending` row whose lease expired, created more than NOTIFICATION_RESEND_MAX_AGE_MS
   * ago is moved to failed_terminal and never sent: a reply hours late, out of context, is worse than none. Each one
   * leaves a `notification_failed` ledger line (error_ref `stale_retry_abandoned`).
   */
  abandonStaleNotifications(now: string): string[] {
    const cutoff = new Date(Date.parse(now) - NOTIFICATION_RESEND_MAX_AGE_MS).toISOString();
    const rows = this.db.prepare(`
      SELECT notification_id FROM notification_outbox
      WHERE created_at < ?
        AND (state IN ('queued', 'retry_wait')
          OR (state = 'sending' AND lease_expires_at IS NOT NULL AND (lease_expires_at <= ? OR lease_expires_at <= updated_at)))
      ORDER BY created_at ASC
    `).all<{ notification_id: string }>(cutoff, now);
    return rows.map((r) => r.notification_id).filter((id) => this.abandonNotification(id, now, "stale_retry_abandoned"));
  }

  /** Move one undelivered row to failed_terminal (never sent again) with a `notification_failed` ledger line. */
  private abandonNotification(notification_id: string, now: string, error_ref: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const record = this.getNotificationRecord(notification_id);
      const updated = this.db.prepare(`
        UPDATE notification_outbox
        SET state = 'failed_terminal', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE notification_id = ? AND state IN ('queued', 'retry_wait', 'sending')
      `).run(now, notification_id);
      if (updated.changes === 1) {
        this.appendNotificationLedgerEvent(record, "notification_failed", {
          notification_id, target: record.target, adapter: record.target.kind, error_ref,
          retryable: false, run_id: record.run_id, approval_id: record.approval_id, correlation_id: record.correlation_id
        });
      }
      this.db.exec("COMMIT");
      return updated.changes === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
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

  /**
   * Orphaned `sending` rows (expired lease: the sender crashed mid-send) go back to the queue, unless the row already
   * used every attempt: a send that crashes the daemon must not be re-sent on every launchd restart, so it ends
   * failed_terminal (`attempt_cap_after_crash`). Returns the requeued ids only.
   */
  recoverStaleSendingNotifications(now: string): string[] {
    const rows = this.db.prepare(`
      SELECT notification_id, attempt_count
      FROM notification_outbox
      WHERE state = 'sending'
        AND lease_expires_at IS NOT NULL
        AND (lease_expires_at <= ? OR lease_expires_at <= updated_at)
      ORDER BY lease_expires_at ASC, created_at ASC
    `).all<{ notification_id: string; attempt_count: number }>(now);

    const recovered: string[] = [];
    for (const row of rows) {
      if (row.attempt_count >= NOTIFICATION_MAX_ATTEMPTS) {
        this.abandonNotification(row.notification_id, now, "attempt_cap_after_crash");
        continue;
      }
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

  /** The fields the worker needs to route a queued run (turns go to the planner supervisor). Undefined when absent. */
  getRunForWorker(run_id: string): { type: string; source: string; goal: string | null; contract_json: string | null; notify: NotificationIntent["target"]; requested_by: Identity } | undefined {
    const row = this.db.prepare(`
      SELECT type, source, goal, contract_json, notify_json, requested_by_json FROM runs WHERE run_id = ?
    `).get<{ type: string; source: string; goal: string | null; contract_json: string | null; notify_json: string; requested_by_json: string }>(run_id);
    if (!row) return undefined;
    const { notify_json, requested_by_json, ...rest } = row;
    return { ...rest, notify: JSON.parse(notify_json) as NotificationIntent["target"], requested_by: JSON.parse(requested_by_json) as Identity };
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
    // Inside an outer `inTransaction` (the memory lane's "Ask anyway" admission) the run joins it: commit/rollback are the outer's.
    const owned = this.outerTxDepth === 0;
    if (owned) this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = owned;

    try {
      try {
        this.insertRunRow(run_id, event);
      } catch (error) {
        const race = isUniqueConstraintError(error) ? this.getCreateOrGetExisting(event) : null;
        if (race) {
          if (owned) this.db.exec("COMMIT");
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

      if (owned) this.db.exec("COMMIT");
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

  private resolveToolApprovalWithinTransaction(input: {
    approval_id: string;
    decision: ApprovalDecision;
    requester: Identity;
    resolved_at: string;
  }): ApprovalResolutionResult {
    const row = this.getToolApproval(input.approval_id);
    if (!row) return approvalFailure("APPROVAL_NOT_FOUND");
    if (!sameIdentity(row.requester, input.requester)) {
      return approvalFailure("APPROVAL_REQUESTER_MISMATCH");
    }
    if (row.state === "pending" && row.expires_at <= input.resolved_at) {
      return approvalFailure("APPROVAL_EXPIRED");
    }
    if (row.state !== "pending") return approvalFailure("APPROVAL_NOT_PENDING");
    const updated = this.db.prepare(`
      UPDATE tool_approvals SET state = ?, resolved_at = ?
      WHERE approval_id = ? AND state = 'pending' AND expires_at > ?
    `).run(input.decision, input.resolved_at, input.approval_id, input.resolved_at);
    if (updated.changes !== 1) return approvalFailure("APPROVAL_NOT_PENDING");
    return { ok: true, run_id: row.run_id, status: "approval_resolved" };
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

  /** The run-scoped ledger writer (sequence + validation). Public for the omp bridge's tool events. */
  appendRunLedgerEvent(
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

  /** A run-less memory ledger row (memory A1): ids and counts only, never text. */
  recordMemoryEvent(event_type: LedgerEventType, payload: Record<string, unknown>, correlation_id = "memory"): void {
    this.appendLedgerEvent(
      createLedgerEvent({ correlation_id, event_type, actor: "system", sequence: this.nextLedgerSequence(), payload })
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
    this.applyLessonsMigration();
    this.applyReloadMarkerMigration();
    this.applySignalPathMigration();
    this.applyEpisodicFactsMigration();
    this.applyEpisodicConsolidateMigration();
    this.applyLessonConsolidateMigration();
    this.applyEpisodicCoreMigration();
    this.applyScheduledTasksMigration();
    this.applyMeteredFuseMigration();
    this.applyWikiPagesMigration();
    this.applyBackupStateMigration();
    this.applyProjectsMigration();
    this.applyIncidentsMigration();
    this.applyIdeaRadarMigration();
    this.applyIdeaPanelMigration();
    this.applySkillReverifyMigration();
    this.applyOmpRuntimeMigration();
    this.applyDaemonBootsMigration();
    this.applyMemoryChangesMigration();
    this.applyLessonThemeMigration();
    this.applyPlannerSessionStateMigration();
    this.applyJevDecisionsMigration();
    this.applyLessonChangesMigration();
    this.applyJevDecisionInstantsMigration();
    this.applyChatTurnsQuotedMigration();
    this.applyJevVerdictsMigration();
  }

  /** Memory A1 §6: the lesson-set fingerprint each chat's omp session started on, persisted so a restart still compares. */
  private applyPlannerSessionStateMigration(): void {
    const version = "2026-10-02-planner-session-state";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS planner_session_state (
          chat_id TEXT PRIMARY KEY,
          lesson_fingerprint TEXT NOT NULL,
          seed_pending INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);
      if (!this.tableColumns("planner_session_state").has("pending_fingerprint")) {
        this.db.exec(`ALTER TABLE planner_session_state ADD COLUMN pending_fingerprint TEXT`);
      }
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** Memory A1 §5: one closed-list theme per lesson; existing rows read 'unthemed'. Guarded by table_info (idempotent). */
  private applyLessonThemeMigration(): void {
    const version = "2026-10-02-lesson-theme";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      if (!this.tableColumns("lessons").has("theme")) {
        this.db.exec(`ALTER TABLE lessons ADD COLUMN theme TEXT NOT NULL DEFAULT 'unthemed'`);
      }
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** Jev System One (ADR 0029 §3.4): one row per answered question, one skipped row per skipped call. No text columns. */
  private applyJevDecisionsMigration(): void {
    const version = "2026-10-04-jev-decisions";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jev_decisions (
          decision_id TEXT PRIMARY KEY,
          run_id TEXT,
          point TEXT NOT NULL,
          question_id TEXT,
          criteria_hash TEXT,
          model_reported TEXT,
          state_hash TEXT,
          lang TEXT NOT NULL,
          answers_json TEXT,
          confidence REAL,
          top_prob REAL,
          margin REAL,
          threshold_version TEXT,
          threshold_used TEXT,
          decision TEXT CHECK (decision IN ('act', 'ask', 'fallback', 'shadow')),
          outcome_source TEXT NOT NULL DEFAULT 'none' CHECK (outcome_source IN ('llm_label', 'paco_correction', 'observed_action', 'none')),
          outcome_value TEXT,
          latency_ms INTEGER,
          input_tokens INTEGER,
          status TEXT NOT NULL CHECK (status IN ('answered', 'skipped')),
          skip_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jev_decisions_run_idx ON jev_decisions(run_id, created_at);
        CREATE INDEX IF NOT EXISTS jev_decisions_point_idx ON jev_decisions(point, created_at);
      `);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /**
   * The two instants a live triage state was built at (ADR 0029 §3.6 parity): the thread cut at claim and the state build
   * that fixed `last_houge_turn.age_s`. The replay rebuilds from these, so a state_hash mismatch is a real difference.
   */
  private applyJevDecisionInstantsMigration(): void {
    const version = "2026-10-06-jev-decision-instants";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      const cols = this.tableColumns("jev_decisions");
      if (!cols.has("thread_cut_at")) this.db.exec(`ALTER TABLE jev_decisions ADD COLUMN thread_cut_at TEXT`);
      if (!cols.has("state_built_at")) this.db.exec(`ALTER TABLE jev_decisions ADD COLUMN state_built_at TEXT`);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** Jev decision tree (spec §6): one row per decision point call, joined to its first model call. Ids, enums, numbers; no text. */
  private applyJevVerdictsMigration(): void {
    const version = "2026-10-07-jev-verdicts";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jev_verdicts (
          verdict_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          category TEXT,
          breadth REAL,
          reasoning REAL,
          actions REAL,
          sets_rule REAL,
          rule_scope TEXT CHECK (rule_scope IS NULL OR rule_scope IN ('ask', 'research')),
          lane TEXT NOT NULL CHECK (lane IN ('memory', 'status', 'planner')),
          role TEXT NOT NULL CHECK (role IN ('fast', 'default', 'thinking')),
          effort TEXT CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high')),
          model TEXT,
          cascade TEXT CHECK (cascade IS NULL OR cascade = 'tiny'),
          save_outcome TEXT NOT NULL CHECK (save_outcome IN ('saved', 'not_durable', 'capped', 'none')),
          route_outcome TEXT NOT NULL CHECK (route_outcome IN ('act', 'fallback', 'pin_failed')),
          handler_outcome TEXT NOT NULL CHECK (handler_outcome IN ('pending', 'lane_reply', 'planner_done', 'planner_failed') OR handler_outcome LIKE 'fallthrough:%'),
          reason TEXT NOT NULL,
          skip_reason TEXT,
          fast_used_tool INTEGER NOT NULL DEFAULT 0,
          paco_correction TEXT CHECK (paco_correction IS NULL OR paco_correction IN ('ask_anyway', 'think_harder', 'escalation', 'low_rating')),
          quoted_turn_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jev_verdicts_run_idx ON jev_verdicts(run_id);
        CREATE INDEX IF NOT EXISTS jev_verdicts_created_idx ON jev_verdicts(created_at);
      `);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** Spec §2.2.1: the turn a Telegram quote resolved to, recorded on the new message's row. Guarded by table_info (idempotent). */
  private applyChatTurnsQuotedMigration(): void {
    const version = "2026-10-07-chat-turns-quoted";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      if (!this.tableColumns("chat_turns").has("quoted_turn_id")) this.db.exec(`ALTER TABLE chat_turns ADD COLUMN quoted_turn_id TEXT`);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** Memory lane Undo (ADR 0029 §5.6): the change set a lane save produced. Separate from memory_changes (its kind CHECK excludes lessons). */
  private applyLessonChangesMigration(): void {
    const version = "2026-10-04-lesson-changes";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lesson_changes (
          change_id TEXT PRIMARY KEY,
          run_id TEXT,
          chat_id TEXT NOT NULL,
          new_id INTEGER NOT NULL,
          superseded_id INTEGER,
          pruned_ids TEXT NOT NULL,
          created_at TEXT NOT NULL,
          undone_at TEXT
        );
      `);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /** Self-service memory correction (2026-10-02): one row per retire/correct, ids only, so Undo can reverse it. */
  private applyMemoryChangesMigration(): void {
    const version = "2026-10-02-memory-changes";
    this.inTransaction(() => {
      const applied = this.db.prepare(`SELECT version FROM schema_migrations WHERE version = ?`).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_changes (
          change_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'wiki')),
          action TEXT NOT NULL CHECK (action IN ('retire', 'correct')),
          old_ids TEXT NOT NULL,
          new_id INTEGER,
          run_id TEXT,
          chat_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          undone_at TEXT
        );
      `);
      if (!applied) this.db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(version, new Date().toISOString());
    });
  }

  /**
   * houge_status (2026-10-02): one row per daemon boot (`seq` orders them: same-millisecond boots in tests), and
   * which chats already got this boot's restart note.
   */
  private applyDaemonBootsMigration(): void {
    const version = "2026-10-02-daemon-boots";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;
    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS daemon_boots (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          boot_id TEXT NOT NULL UNIQUE,
          started_at TEXT NOT NULL,
          pid INTEGER NOT NULL,
          reason TEXT NOT NULL,
          reload_sha TEXT, reload_subject TEXT, reload_branch TEXT, reload_merged_at TEXT,
          head_sha TEXT, head_subject TEXT, head_committed_at TEXT, build_input_committed_at TEXT, dist_built_at TEXT,
          src_newer_than_dist INTEGER NOT NULL DEFAULT 0,
          stopped_at TEXT
        );
        CREATE TABLE IF NOT EXISTS boot_chat_notes (
          boot_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          noted_at TEXT NOT NULL,
          PRIMARY KEY (boot_id, chat_id)
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
      if (activeTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Introspection slice A (ADR 0024): `incidents` (behavioral invariant violations with an
   * open/resolved lifecycle — rows are NEVER deleted, a recurrence opens a new row) plus the
   * sweep's throttle latch. Indexed on (state, fingerprint): every sweep looks up the open
   * row for a fingerprint, which is the only hot path.
   */
  private applyIncidentsMigration(): void {
    const version = "2026-07-20-incidents";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;
    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS incidents (
          incident_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          state TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          seen_count INTEGER NOT NULL DEFAULT 1,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          resolved_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS incidents_state_fingerprint_idx
          ON incidents(state, fingerprint)
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS invariant_sweep_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_swept_at TEXT NOT NULL
        )
      `);

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
        `).run(version, new Date().toISOString());
      }
      this.db.exec("COMMIT");
      activeTransaction = false;
    } catch (error) {
      if (activeTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Idea Radar R1 (spec 2026-07-24, W1): ONE migration block for BOTH radar tables —
   * `ideas` (durable idea cards; rows never deleted, archived/killed are states) +
   * `radar_state` (the single-row last-run marker, seeded NULL so the first tick runs
   * immediately — mirrors lesson_consolidate_state). No indexes — active cards are
   * capped at human-decision scale (RADAR_MAX_ACTIVE_CARDS).
   */
  private applyIdeaRadarMigration(): void {
    const version = "2026-07-24-idea-radar";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;
    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ideas (
          id INTEGER PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'seen',
          sources_json TEXT NOT NULL,
          distinct_items INTEGER NOT NULL DEFAULT 1,
          distinct_sources INTEGER NOT NULL DEFAULT 1,
          scores_json TEXT,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          archived_at TEXT
        );

        CREATE TABLE IF NOT EXISTS radar_state (id INTEGER PRIMARY KEY, last_run_at TEXT);
        INSERT OR IGNORE INTO radar_state (id) VALUES (1);
      `);

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
        `).run(version, new Date().toISOString());
      }
      this.db.exec("COMMIT");
      activeTransaction = false;
    } catch (error) {
      if (activeTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Idea Radar R2 (spec 2026-07-25 §8): ONE migration block for BOTH panel tables —
   * `radar_panel_state` (the single-row weekly latch, seeded NULL so the first armed
   * tick fires immediately — mirrors radar_state) + `radar_shortlists` (frozen weekly
   * shortlist snapshots; `week_key` UNIQUE so a re-fired week replaces via upsert).
   * No indexes — one snapshot row per week, human-decision scale.
   */
  private applyIdeaPanelMigration(): void {
    const version = "2026-07-25-idea-panel";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;
    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS radar_panel_state (id INTEGER PRIMARY KEY, last_run_at TEXT);
        INSERT OR IGNORE INTO radar_panel_state (id) VALUES (1);

        CREATE TABLE IF NOT EXISTS radar_shortlists (
          id INTEGER PRIMARY KEY,
          created_at TEXT NOT NULL,
          week_key TEXT NOT NULL UNIQUE,
          cards_json TEXT NOT NULL,
          picked_idea_id INTEGER
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
      if (activeTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Skill retirement spec (2026-07-29): `skill_reverify_state` — the single-row weekly
   * latch for the suggest-only re-verify advisor (seeded NULL so arming fires immediately
   * — a first sweep today, then weekly at the slot; mirrors radar_panel_state).
   */
  private applySkillReverifyMigration(): void {
    const version = "2026-07-29-skill-reverify";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;
    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS skill_reverify_state (id INTEGER PRIMARY KEY, last_run_at TEXT);
        INSERT OR IGNORE INTO skill_reverify_state (id) VALUES (1);
      `);

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
        `).run(version, new Date().toISOString());
      }
      this.db.exec("COMMIT");
      activeTransaction = false;
    } catch (error) {
      if (activeTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * omp runtime (spec 2026-09-30 §7, §8): `tool_approvals` (per-tool-call approvals for detached
   * planner turns, one per (run, tool_call)) and the `llm_attempt` request_key unique index
   * that makes audit replays idempotent. Rows without a request_key are outside the index.
   */
  private applyOmpRuntimeMigration(): void {
    const version = "2026-10-01-omp-runtime";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;
    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tool_approvals (
          approval_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          capability TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          action_fingerprint TEXT NOT NULL,
          requester_json TEXT NOT NULL,
          summary TEXT NOT NULL,
          side_effect_level TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','expired','consumed')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS tool_approvals_one_per_call ON tool_approvals(run_id, tool_call_id);
        CREATE UNIQUE INDEX IF NOT EXISTS ledger_llm_attempt_request_key
          ON ledger_events(correlation_id, json_extract(payload_json, '$.request_key'))
          WHERE event_type = 'llm_attempt' AND json_extract(payload_json, '$.request_key') IS NOT NULL;
      `);

      if (!applied) {
        this.db.prepare(`
          INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
        `).run(version, new Date().toISOString());
      }
      this.db.exec("COMMIT");
      activeTransaction = false;
    } catch (error) {
      if (activeTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Money-Work P2 (spec 2026-07-18): `projects` (durable pursued-bounty state, rows
   * never deleted) + `bounty_sightings` (scan memory: dedupe, NEW deltas, last
   * substantive judgment). No indexes — row counts are human-decision-scale.
   */
  private applyProjectsMigration(): void {
    const version = "2026-07-18-projects";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          project_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          source_url TEXT NOT NULL UNIQUE,
          title TEXT,
          amount_usd INTEGER,
          state TEXT NOT NULL,
          state_reason TEXT,
          notes_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bounty_sightings (
          issue_url TEXT PRIMARY KEY,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          last_score INTEGER,
          last_verdict TEXT,
          times_seen INTEGER NOT NULL
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
   * DB backup latch (backlog #3, ADR 0021): the single-row interval latch for the
   * periodic VACUUM INTO snapshot (the lesson_decay_state pattern; seeded NULL so the
   * first armed tick fires immediately). Advanced only on a verified snapshot — a
   * failed attempt leaves it put, so the next tick retries.
   */
  private applyBackupStateMigration(): void {
    const version = "2026-07-17-backup-state";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS backup_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_backup_at TEXT,
          last_failure_event_at TEXT
        );

        INSERT OR IGNORE INTO backup_state (id) VALUES (1);
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
   * Wiki pages (Phase W, ADR 0020): one row per synthesized knowledge page — global
   * (no chat_id), lesson-style eval metadata, bidirectional supersede lineage, an
   * optional local embedding (BLOB; null when Ollama was down — backfillable), and the
   * FTS5 mirror (external-content + sync triggers) as the keyword identity/retrieval
   * floor that works with no embedding at all. `wiki_decay_state` is W2's single-row
   * 24h decay latch (the lesson_decay_state pattern), created NOW so the schema is
   * complete in one migration.
   */
  private applyWikiPagesMigration(): void {
    const version = "2026-07-16-wiki-pages";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS wiki_pages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_slug TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          key_facts TEXT NOT NULL DEFAULT '[]',
          body_md TEXT NOT NULL DEFAULT '',
          sources TEXT NOT NULL DEFAULT '[]',
          contradictions TEXT NOT NULL DEFAULT '[]',
          confidence REAL,
          verified_passes INTEGER NOT NULL DEFAULT 0,
          last_verified TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          supersedes INTEGER,
          superseded_by INTEGER,
          applied_count INTEGER NOT NULL DEFAULT 0,
          corrected_count INTEGER NOT NULL DEFAULT 0,
          reuse_value REAL NOT NULL DEFAULT 1.0,
          rating_history TEXT NOT NULL DEFAULT '[]',
          embedding BLOB,
          embedding_model TEXT,
          created_at TEXT NOT NULL,
          last_used TEXT
        );

        CREATE INDEX IF NOT EXISTS wiki_pages_slug_status_idx
          ON wiki_pages(topic_slug, status);

        CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts
          USING fts5(title, summary, body_md, content='wiki_pages', content_rowid='id');

        CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_ai AFTER INSERT ON wiki_pages BEGIN
          INSERT INTO wiki_pages_fts(rowid, title, summary, body_md)
            VALUES (new.id, new.title, new.summary, new.body_md);
        END;

        CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_ad AFTER DELETE ON wiki_pages BEGIN
          INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, summary, body_md)
            VALUES ('delete', old.id, old.title, old.summary, old.body_md);
        END;

        CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_au AFTER UPDATE OF title, summary, body_md ON wiki_pages BEGIN
          INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, summary, body_md)
            VALUES ('delete', old.id, old.title, old.summary, old.body_md);
          INSERT INTO wiki_pages_fts(rowid, title, summary, body_md)
            VALUES (new.id, new.title, new.summary, new.body_md);
        END;

        CREATE TABLE IF NOT EXISTS wiki_decay_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_decay_at TEXT
        );

        INSERT OR IGNORE INTO wiki_decay_state (id) VALUES (1);
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
   * Metered-API $ ceiling (ADR 0019): the single-row alert-dedupe latch for the metered
   * fuse — the exact twin of `global_budget_fuse_state` (one alert per fuse episode via
   * the 0→1 transition; disarmed when spend falls back under the ceilings).
   */
  private applyMeteredFuseMigration(): void {
    const version = "2026-07-15-metered-fuse";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metered_fuse_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          fused INTEGER NOT NULL DEFAULT 0,
          since TEXT
        );

        INSERT OR IGNORE INTO metered_fuse_state (id, fused, since)
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

  /**
   * The signal path (⓪·3 S2, ADR 0012 §1): per-chat pending rating asks (single row per
   * chat, deactivated — never deleted — on consume/expiry so the ask cooldown survives),
   * captured session ratings with their applied-lesson attribution, and the single-row
   * decay-tick state (like daemon_heartbeat; seeded so the first tick runs immediately).
   */
  private applySignalPathMigration(): void {
    const version = "2026-07-03-signal-path";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_rating (
          chat_id TEXT PRIMARY KEY,
          asked_at TEXT NOT NULL,
          window_start TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS session_ratings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          rating INTEGER NOT NULL,
          comment TEXT,
          asked_at TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          applied_lesson_ids TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS lesson_decay_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_decay_at TEXT
        );

        INSERT OR IGNORE INTO lesson_decay_state (id) VALUES (1);
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
   * Episodic facts (Phase M B1, ADR 0005 §3/§4): one row per atomic fact with
   * provenance (source_turn_ids → chat_turns), bi-temporal validity (valid_from /
   * valid_until — invalidate, don't delete), lesson-style eval metadata, and an
   * optional local embedding (BLOB; null when Ollama was down — backfillable). The
   * FTS5 mirror (external-content table + sync triggers) is the keyword-retrieval
   * floor that works with no embedding at all; the per-chat watermark makes the
   * fast-path distill pass incremental (never re-reads distilled turns).
   */
  private applyEpisodicFactsMigration(): void {
    const version = "2026-07-15-episodic-facts";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS episodic_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fact TEXT NOT NULL,
          participants TEXT NOT NULL DEFAULT '[]',
          chat_id TEXT,
          source_turn_ids TEXT NOT NULL DEFAULT '[]',
          occurred_at TEXT,
          valid_from TEXT,
          valid_until TEXT,
          salience REAL NOT NULL DEFAULT 1.0,
          status TEXT NOT NULL DEFAULT 'active',
          supersedes INTEGER,
          superseded_by INTEGER,
          applied_count INTEGER NOT NULL DEFAULT 0,
          corrected_count INTEGER NOT NULL DEFAULT 0,
          reuse_value REAL NOT NULL DEFAULT 1.0,
          rating_history TEXT NOT NULL DEFAULT '[]',
          embedding BLOB,
          embedding_model TEXT,
          created_at TEXT NOT NULL,
          last_used TEXT
        );

        CREATE INDEX IF NOT EXISTS episodic_facts_chat_status_idx
          ON episodic_facts(chat_id, status);

        CREATE VIRTUAL TABLE IF NOT EXISTS episodic_facts_fts
          USING fts5(fact, content='episodic_facts', content_rowid='id');

        CREATE TRIGGER IF NOT EXISTS episodic_facts_fts_ai AFTER INSERT ON episodic_facts BEGIN
          INSERT INTO episodic_facts_fts(rowid, fact) VALUES (new.id, new.fact);
        END;

        CREATE TRIGGER IF NOT EXISTS episodic_facts_fts_ad AFTER DELETE ON episodic_facts BEGIN
          INSERT INTO episodic_facts_fts(episodic_facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
        END;

        CREATE TRIGGER IF NOT EXISTS episodic_facts_fts_au AFTER UPDATE OF fact ON episodic_facts BEGIN
          INSERT INTO episodic_facts_fts(episodic_facts_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
          INSERT INTO episodic_facts_fts(rowid, fact) VALUES (new.id, new.fact);
        END;

        CREATE TABLE IF NOT EXISTS episodic_distill_watermark (
          chat_id TEXT PRIMARY KEY,
          last_turn_created_at TEXT,
          last_distilled_at TEXT
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
   * Episodic consolidation state (Phase M B4): the single-row last-run marker that
   * makes the daily decay/merge/promote tick idempotent per 24h across poll cycles
   * (the lesson_decay_state pattern; seeded NULL so the first tick runs immediately).
   * Deliberately its OWN migration — M1's episodic-facts migration is already applied
   * on live databases and stays untouched.
   */
  private applyEpisodicConsolidateMigration(): void {
    const version = "2026-07-15-episodic-consolidate-state";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS episodic_consolidate_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_consolidate_at TEXT
        );

        INSERT OR IGNORE INTO episodic_consolidate_state (id) VALUES (1);
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
   * Lesson consolidation state (lesson-consolidation design, 2026-07-23): the single-row
   * last-run marker that makes the daily preserve-all lesson-merge tick idempotent per
   * interval across poll cycles (mirrors episodic_consolidate_state exactly; seeded NULL
   * so the first tick runs immediately). Its OWN migration — a stamp table, never touching
   * the live `lessons` table.
   */
  private applyLessonConsolidateMigration(): void {
    const version = "2026-07-23-lesson-consolidate-state";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lesson_consolidate_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_consolidated_at TEXT
        );

        INSERT OR IGNORE INTO lesson_consolidate_state (id) VALUES (1);
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
   * Episodic core band (location-grounding): add `is_core` to episodic_facts so stable
   * biography/identity facts (where the user lives, their name, occupation) can be folded
   * into an always-known band above the scored retrieval. Its OWN migration — the M1
   * episodic-facts table is already live; existing rows default 0 (not core). The ALTER
   * is guarded by table_info so a double-open is idempotent even before the version row.
   */
  private applyEpisodicCoreMigration(): void {
    const version = "2026-07-17-episodic-core";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      if (!this.tableColumns("episodic_facts").has("is_core")) {
        this.db.exec(`ALTER TABLE episodic_facts ADD COLUMN is_core INTEGER NOT NULL DEFAULT 0`);
      }

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
   * Scheduled tasks (B10b, ADR 0017): one row per schedule — the declarative spec
   * (spec_json + tz) and the durable fire cursor (next_run_at, UTC ISO). Row state is
   * enabled|disabled|failed; per-fire outcomes are ledger events. The (state, next_run_at)
   * index is the tick's due query.
   */
  private applyScheduledTasksMigration(): void {
    const version = "2026-07-15-scheduled-tasks";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          schedule_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          tz TEXT NOT NULL,
          state TEXT NOT NULL,
          next_run_at TEXT NOT NULL,
          last_fired_at TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS scheduled_tasks_state_next_run_idx
          ON scheduled_tasks(state, next_run_at);
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
   * Per-lesson rows (⓪·3 S1, ADR 0012 §2/§3): the durable memory reshape from one
   * char-capped block per scope to ONE ROW PER LESSON with eval metadata and a
   * bidirectional supersede chain. One-time: each legacy block's `- <lesson>` bullets
   * split into individual active rows (source 'migration'). The lesson_blocks table is
   * KEPT as a frozen archive — nothing reads or writes it after this migration (verified
   * 2026-07-03: composer/gateway/worker all moved to rows) — so rollback stays possible.
   */
  private applyLessonsMigration(): void {
    const version = "2026-07-03-lessons-rows";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lessons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          text TEXT NOT NULL,
          avoid TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          supersedes INTEGER,
          superseded_by INTEGER,
          applied_count INTEGER NOT NULL DEFAULT 0,
          corrected_count INTEGER NOT NULL DEFAULT 0,
          reuse_value REAL NOT NULL DEFAULT 1.0,
          rating_history TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          last_used TEXT,
          source TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS lessons_scope_status_idx
          ON lessons(scope, status);
      `);

      if (!applied) {
        const blocks = this.db.prepare(`
          SELECT scope, block, updated_at FROM lesson_blocks
        `).all<{ scope: string; block: string; updated_at: string }>();
        const insert = this.db.prepare(`
          INSERT INTO lessons (scope, text, created_at, source)
          VALUES (?, ?, ?, 'migration')
        `);
        for (const b of blocks) {
          for (const line of b.block.split("\n")) {
            // "- <lesson>" bullets become rows; a stray non-bullet line migrates as-is.
            const text = line.trim().replace(/^-\s*/, "").trim();
            if (text.length > 0) insert.run(b.scope, text, b.updated_at);
          }
        }

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
   * Self-write reload marker (⓪·2c U2, stage 1 of ADR 0012 D4): a single-row record of
   * the last green merge, consumed exactly once by the next daemon boot to confirm the
   * reload over Telegram. No seed row — absence means "no pending confirmation".
   */
  private applyReloadMarkerMigration(): void {
    const version = "2026-07-03-reload-marker";
    let activeTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    activeTransaction = true;

    try {
      const applied = this.db.prepare(`
        SELECT version FROM schema_migrations WHERE version = ?
      `).get<{ version: string }>(version);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS reload_marker (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          sha TEXT NOT NULL,
          subject TEXT NOT NULL,
          branch TEXT NOT NULL,
          merged_at TEXT NOT NULL
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
   * LEGACY lesson blocks (ADR 0010): one char-capped block per scope. Superseded by
   * per-lesson rows (⓪·3 S1 — see applyLessonsMigration, which split the bullets into
   * the `lessons` table). The table is kept as a frozen archive; nothing reads it.
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

        CREATE INDEX IF NOT EXISTS ledger_events_type_time_idx
          ON ledger_events(event_type, occurred_at);
        CREATE INDEX IF NOT EXISTS ledger_events_sequence_idx
          ON ledger_events(sequence);

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
      "ledger_events_type_time_idx",
      "ledger_events_sequence_idx",
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

/** SELECT list for LessonRow reads (one place, so every accessor returns the same shape). */
const LESSON_COLUMNS =
  "id, scope, text, avoid, status, supersedes, superseded_by, applied_count, " +
  "corrected_count, reuse_value, rating_history, created_at, last_used, source, theme";

/** Per-scope active-row cap (⓪·3 S1): overflow prunes the lowest reuse_value rows. */
export const DEFAULT_LESSON_CAP_PER_SCOPE = 20;

/**
 * Ceiling on a merged lesson's inherited reuse_value (lesson-consolidation merge): the sum of
 * the members, capped so a merged near-duplicate carries its earned standing without becoming
 * immortal — decay can still walk it down to the prune line. Reuses the episodic cap value (5)
 * for consistency across the two consolidators.
 */
export const LESSON_MERGE_REUSE_CAP = 5;

export function resolveLessonCapPerScope(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_LESSON_CAP_PER_SCOPE);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LESSON_CAP_PER_SCOPE;
}

/** Days without use before an active lesson decays (⓪·3 S2b). */
export const DEFAULT_LESSON_DECAY_DAYS = 14;

export function resolveLessonDecayDays(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_LESSON_DECAY_DAYS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LESSON_DECAY_DAYS;
}

/** reuse_value below which a decayed lesson is pruned (reversibly). */
export const DEFAULT_LESSON_PRUNE_THRESHOLD = 0.2;

export function resolveLessonPruneThreshold(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_LESSON_PRUNE_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LESSON_PRUNE_THRESHOLD;
}

/**
 * English function words the FTS keyword legs ignore (live gate 2026-10-02: with Ollama down, "Explain how attention
 * works in transformers" admitted 4 facts and a wiki page on "how"/"in"). Genuine function words only: a content
 * word, however common, stays a search term. Words of 2 characters or fewer are not listed: the OR legs drop every
 * such token, and the wiki identity leg (AND) keeps them on purpose.
 */
const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "you", "your", "him", "his", "she", "her", "its", "they", "them", "their", "this", "that", "these", "those",
  "are", "was", "were", "been", "being", "does", "did", "have", "has", "had", "can", "could", "will", "would",
  "shall", "should", "may", "might", "must", "for", "from", "with", "about", "into", "and", "but", "not", "what",
  "which", "who", "whom", "whose", "when", "where", "why", "how", "there", "here", "than", "then", "our"
]);

/** A token with any CJK character: unicode61 cannot segment it, and a 2-character word is a real word. */
const CJK_TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The FTS keyword legs' query terms (facts and wiki pages): letter/number runs minus English function words and, when
 * `dropShort` (the OR legs), non-CJK tokens of 2 characters or fewer; at most 12. Empty → the caller returns [].
 */
function ftsQueryTokens(queryText: string, dropShort = true): string[] {
  return (queryText.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => CJK_TOKEN.test(t) || (!(dropShort && t.length <= 2) && !FTS_STOPWORDS.has(t.toLowerCase())))
    .slice(0, 12);
}

/** SELECT list for EpisodicFactRow reads (one place, so every accessor returns the same shape). */
const EPISODIC_FACT_COLUMNS =
  "id, fact, participants, chat_id, source_turn_ids, occurred_at, valid_from, valid_until, " +
  "salience, status, supersedes, superseded_by, applied_count, corrected_count, reuse_value, " +
  "rating_history, embedding, embedding_model, created_at, last_used, is_core";

/** The same list qualified for the FTS join (`f.` = episodic_facts). */
const EPISODIC_FACT_COLUMNS_QUALIFIED = EPISODIC_FACT_COLUMNS.split(", ")
  .map((column) => `f.${column}`)
  .join(", ");

/** SELECT list for WikiPageRow reads (one place, so every accessor returns the same shape). */
const WIKI_PAGE_COLUMNS =
  "id, topic_slug, title, summary, key_facts, body_md, sources, contradictions, " +
  "confidence, verified_passes, last_verified, status, supersedes, superseded_by, " +
  "applied_count, corrected_count, reuse_value, rating_history, embedding, embedding_model, " +
  "created_at, last_used";

/** The same list qualified for the FTS join (`w.` = wiki_pages). */
const WIKI_PAGE_COLUMNS_QUALIFIED = WIKI_PAGE_COLUMNS.split(", ")
  .map((column) => `w.${column}`)
  .join(", ");

/** Cosine floor for the topic-identity embedding leg (ADR 0020 decision 4). */
export const WIKI_TOPIC_COSINE_THRESHOLD = 0.75;

/** Memory A1 §7: a stored fact is a reconcile neighbour of a candidate at cosine >= this. */
export const RECONCILE_NEIGHBOR_MIN_COSINE = 0.5;

/** Up to this many of the k neighbour slots are reserved for cosine-only hits, so FTS hits cannot crowd them out. */
export const RECONCILE_COSINE_SLOTS = 4;

/** Per-chat active-fact cap (Phase M B1): overflow prunes the lowest reuse_value rows. */
export const DEFAULT_EPISODIC_FACT_CAP_PER_CHAT = 200;

export function resolveEpisodicFactCapPerChat(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_EPISODIC_FACT_CAP_PER_CHAT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EPISODIC_FACT_CAP_PER_CHAT;
}

/** Cap on core facts folded into the always-known band (HOUGE_EPISODIC_CORE_CAP, min 1). */
export const DEFAULT_EPISODIC_CORE_CAP = 8;

export function resolveEpisodicCoreCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_EPISODIC_CORE_CAP);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_EPISODIC_CORE_CAP;
}

/**
 * Ceiling on a merged fact's inherited reuse_value (B4 merge): the sum of the sources,
 * capped so a merged duplicate carries its earned standing without becoming immortal —
 * decay (×0.8/tick past the decay window) can still walk it down to the prune line.
 */
export const DEFAULT_EPISODIC_MERGE_REUSE_CAP = 5;

/** Tolerant JSON-string-array parse (participants / source_turn_ids) — garbage degrades to []. */
function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** A repeat supersede inside this window marks the memory layer ineffective (escalate). */
export const DEFAULT_LESSON_REPEAT_DAYS = 7;

export function resolveLessonRepeatDays(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_LESSON_REPEAT_DAYS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LESSON_REPEAT_DAYS;
}

/** How long a failed_terminal notification keeps counting as undelivered for the sweep, by when it went terminal. */
export const TERMINAL_NOTIFICATION_REPORT_MS = 24 * 60 * 60_000;

/**
 * Wait after the Nth failed attempt before the row is due again (code-owned; live gate round 2). With the 5-attempt cap
 * the attempts span about 40 min, so a Telegram outage of minutes is ridden out instead of burning every attempt.
 */
export const NOTIFICATION_RETRY_BACKOFF_MS: readonly number[] = [30_000, 2 * 60_000, 8 * 60_000, 30 * 60_000];

function retryBackoffMs(attempt_count: number): number {
  const table = NOTIFICATION_RETRY_BACKOFF_MS;
  return table[Math.min(Math.max(attempt_count, 1), table.length) - 1]!;
}

/**
 * A chat reply more than this late (by created_at) is stale: the retry step abandons it instead of sending it (live gate
 * 2026-10-01, controller ruling: 6 h). Code-owned, not an env var.
 */
export const NOTIFICATION_RESEND_MAX_AGE_MS = 6 * 60 * 60_000;

const TELEGRAM_COMMAND_WINDOW_SECONDS = 60;
const TELEGRAM_MAX_COMMANDS_PER_WINDOW = 5;
const TELEGRAM_MAX_ACTIVE_RUNS = 3;
const TELEGRAM_MAX_PENDING_APPROVALS = 5;

// Telegram caps a message at 4096 chars; leave headroom for the truncation note.
const CHAT_TEXT_MAX = 3900;

function truncateForChat(text: string, redact: (s: string) => string = (s) => s): string {
  // Redact BEFORE truncating so a masked value is never split into a leaking fragment (ADR 0015).
  const trimmed = redact(text).trim();
  if (trimmed.length <= CHAT_TEXT_MAX) return trimmed;
  return `${trimmed.slice(0, CHAT_TEXT_MAX)}\n\n… (truncated)`;
}

/** The card's Approve / Deny buttons; a tap is the typed /approve or /deny (src/triggers parseApprovalCallback). */
function approvalButtons(approval_id: string): NotificationButton[] {
  return [
    { text: "✅ Approve", data: `approval:approve:${approval_id}` },
    { text: "❌ Deny", data: `approval:deny:${approval_id}` }
  ];
}

function buildApprovalPromptText(
  approval_id: string,
  input: ApprovalRequestInput,
  redact: (s: string) => string = (s) => s
): string {
  return redact([
    `Approval required: \`${approval_id}\``,
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
    `Reply /approve \`${approval_id}\` to continue or /deny \`${approval_id}\` to stop.`
  ].join("\n"));
}

/** The tool-approval card. The id is inline code: Telegram shows it as tap-to-copy monospace. Exported for tests. */
export function buildToolApprovalPromptText(
  approval_id: string,
  input: ToolApprovalInput,
  redact: (s: string) => string = (s) => s
): string {
  return redact([
    `Approval required: \`${approval_id}\``,
    `Action: ${input.summary}`,
    ...(input.card_detail !== undefined ? [`Command: ${input.card_detail}`] : []),
    `Side effect: ${input.side_effect_level}`,
    `Capability: ${input.capability}`,
    `Requester: ${input.requester.kind}:${input.requester.id}`,
    `Expires: ${input.expires_at}`,
    `Reply /approve \`${approval_id}\` to continue or /deny \`${approval_id}\` to stop.`
  ].join("\n"));
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

export function isTerminalRunState(state: RunState): boolean {
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
