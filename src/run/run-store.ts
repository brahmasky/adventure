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
import { canTransitionProject, canTransitionRun } from "./state-machines.js";
import type { LlmUsage } from "./llm-usage.js";
import { blobToFloat32, cosineSimilarity, float32ToBlob } from "../llm/embeddings.js";
import { resolveWikiDecayDays } from "../capabilities/wiki.js";

/** The LLM-call roles recorded by {@link RunStore.recordLlmCall} (spec §"Real telemetry"). */
export type LlmCallRole = "writer" | "reviewer" | "classify" | "frame" | "answer" | "compose" | "reader";

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

export type LessonStatus = "active" | "superseded" | "pruned";
export type LessonSource = "user_feedback" | "loop" | "migration" | "consolidation";

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
}

/** The reconcile verdict {@link RunStore.saveReconciledLesson} applies (structurally matches capabilities/reconcile.ts). */
export type LessonReconcileVerdict =
  | { verdict: "ADD" }
  | { verdict: "DROP" }
  | { verdict: "SUPERSEDE"; id: number }
  | { verdict: "UPDATE"; id: number; text?: string };

export type LessonWriteVerb = "add" | "supersede" | "update" | "drop";

export interface LessonSaveResult {
  verb: LessonWriteVerb;
  /** The new active row's id (absent on drop). */
  id?: number;
  supersededId?: number;
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
   * The OLDEST `limit` turns strictly after `afterIso` (or from the beginning), in
   * chronological order. The episodic distill pass reads with this so a burst longer
   * than one window is caught up oldest-first across successive passes — a newest-first
   * read would advance the watermark past turns it never distilled, silently losing
   * durable facts stated early in a long session (verifier finding, Phase M).
   */
  getChatTurnsAfter(chat_id: string, afterIso: string | undefined, limit: number): ChatTurnRow[] {
    return afterIso
      ? this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at
          FROM chat_turns
          WHERE chat_id = ? AND created_at > ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
        `).all<ChatTurnRow>(chat_id, afterIso, limit)
      : this.db.prepare(`
          SELECT turn_id, chat_id, run_id, role, text, intent, created_at
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

  /** Insert one active lesson row; returns its id. */
  addLesson(input: {
    scope: string;
    text: string;
    avoid?: string;
    source: LessonSource;
    created_at?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO lessons (scope, text, avoid, created_at, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.scope,
      input.text.trim(),
      input.avoid?.trim() || null,
      input.created_at ?? new Date().toISOString(),
      input.source
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
    this.db.prepare(`UPDATE lessons SET text = ? WHERE id = ?`).run(text.trim(), id);
  }

  /** Attribution (S1→S2 hookup): these lessons were applied to a turn's prompt. */
  touchApplied(ids: number[], now: string = new Date().toISOString()): void {
    const stmt = this.db.prepare(`
      UPDATE lessons SET applied_count = applied_count + 1, last_used = ? WHERE id = ?
    `);
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
   * Apply a reconcile verdict (⓪·3 S1b, ADR 0012 §2): ADD inserts; SUPERSEDE/UPDATE
   * insert a NEW row linked to the prior via bidirectional pointers (auditable — never
   * an in-place rewrite, never a delete); DROP writes nothing. A SUPERSEDE/UPDATE whose
   * target is missing, no longer active, or in a DIFFERENT scope (⓪·3f P1 defense-in-
   * depth — reconcile only ever compares within one scope, but a verdict must never
   * retire another scope's lesson) degrades to ADD. Overflow beyond the per-scope cap
   * prunes the lowest reuse_value rows (never the row just written).
   */
  saveReconciledLesson(
    candidate: { scope: string; text: string; avoid?: string },
    verdict: LessonReconcileVerdict,
    source: LessonSource,
    now: string,
    cap: number = resolveLessonCapPerScope(process.env),
    repeatDays: number = resolveLessonRepeatDays(process.env)
  ): LessonSaveResult {
    const text = candidate.text.trim();
    if (verdict.verdict === "DROP") {
      return { verb: "drop", lesson: text, prunedIds: [] };
    }

    const prior = verdict.verdict === "ADD" ? undefined : this.getLesson(verdict.id);
    const target = prior?.status === "active" && prior.scope === candidate.scope ? prior : undefined;
    const merged =
      verdict.verdict === "UPDATE" && target && verdict.text?.trim() ? verdict.text.trim() : text;
    // UPDATE supplements: the revised row inherits the prior AVOID unless the candidate brings one.
    const avoid =
      candidate.avoid?.trim() ||
      (verdict.verdict === "UPDATE" && target?.avoid ? target.avoid : undefined);

    const id = this.addLesson({ scope: candidate.scope, text: merged, ...(avoid ? { avoid } : {}), source, created_at: now });
    if (target) this.supersedeLesson(target.id, id);
    // ⓪·3 S2b correction wiring: a SUPERSEDE is a correction against the target — it
    // pays the reuse penalty. And when the target's chain ALREADY holds a recent
    // supersede (a superseding row created within `repeatDays`) or the target has been
    // corrected repeatedly, the memory layer looks ineffective → escalate the digest
    // (layer-routing iii) so the model can pivot to the code layer in-turn.
    let escalate = false;
    if (verdict.verdict === "SUPERSEDE" && target) {
      this.recordCorrection(target.id);
      this.db.prepare(`UPDATE lessons SET reuse_value = reuse_value - 0.5 WHERE id = ?`).run(target.id);
      const cutoff = new Date(Date.parse(now) - repeatDays * 86_400_000).toISOString();
      const repeatInLineage = this.lessonLineage(target.id).some(
        (row) => row.id !== id && row.supersedes !== null && row.created_at >= cutoff
      );
      escalate = repeatInLineage || target.corrected_count + 1 >= 2;
    }
    const prunedIds = this.pruneScopeOverflow(candidate.scope, cap, id);
    const verb: LessonWriteVerb = !target ? "add" : verdict.verdict === "UPDATE" ? "update" : "supersede";
    return {
      verb,
      id,
      ...(target ? { supersededId: target.id } : {}),
      lesson: merged,
      prunedIds,
      ...(escalate ? { escalate: true } : {})
    };
  }

  /** Prune (reversibly) the lowest-value active rows over the scope cap, sparing `keepId`. */
  private pruneScopeOverflow(scope: string, cap: number, keepId: number): number[] {
    if (cap <= 0) return [];
    const others = this.db.prepare(`
      SELECT id FROM lessons
      WHERE scope = ? AND status = 'active' AND id != ?
      ORDER BY reuse_value ASC, COALESCE(last_used, created_at) ASC, id ASC
    `).all<{ id: number }>(scope, keepId);
    const toPrune = others.slice(0, Math.max(0, others.length + 1 - cap)).map((r) => r.id);
    for (const id of toPrune) {
      this.db.prepare(`UPDATE lessons SET status = 'pruned' WHERE id = ?`).run(id);
    }
    return toPrune;
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
    payload: { manifest: string[]; hint: string; applied_artifacts: Record<string, unknown> }
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

  // --- Metered-API $ ceiling (ADR 0019) -----------------------------------

  /**
   * Metered spend, DERIVED from `llm_call` ledger events' `cost_usd` (populated at the
   * recording seam via src/llm/metered-pricing.ts — no second bookkeeping):
   *   - `daily_usd`   — rolling 24h window (same precedent as the count caps),
   *   - `monthly_usd` — the calendar month (UTC) containing `now` (how the bill arrives).
   * Events without a `cost_usd` (flat-rate legs, unknown metered models) contribute 0.
   */
  meteredSpendUsd(now: string): { daily_usd: number; monthly_usd: number } {
    const windowStart = this.addSeconds(now, -GLOBAL_BUDGET_WINDOW_HOURS * 3600);
    const daily = this.db.prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(payload_json, '$.cost_usd') AS REAL)), 0) AS spend
      FROM ledger_events
      WHERE event_type = 'llm_call'
        AND json_extract(payload_json, '$.cost_usd') IS NOT NULL
        AND occurred_at > ?
    `).get<{ spend: number }>(windowStart);
    const monthly = this.db.prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(payload_json, '$.cost_usd') AS REAL)), 0) AS spend
      FROM ledger_events
      WHERE event_type = 'llm_call'
        AND json_extract(payload_json, '$.cost_usd') IS NOT NULL
        AND strftime('%Y-%m', occurred_at) = strftime('%Y-%m', ?)
    `).get<{ spend: number }>(now);
    return { daily_usd: daily?.spend ?? 0, monthly_usd: monthly?.spend ?? 0 };
  }

  /**
   * Per-model token/cost breakdown DERIVED from `llm_call` ledger events (the same source as
   * {@link meteredSpendUsd}) — powers `houge usage`. Groups by provider+model, summing calls,
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
      WHERE event_type = 'llm_call'
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

  /** Prune (reversibly) the lowest-value active rows over the chat cap, sparing `keepId`. */
  private pruneEpisodicOverflow(chat_id: string, cap: number, keepId: number): number[] {
    if (cap <= 0) return [];
    const others = this.db.prepare(`
      SELECT id FROM episodic_facts
      WHERE chat_id = ? AND status = 'active' AND id != ?
      ORDER BY reuse_value ASC, COALESCE(last_used, created_at) ASC, id ASC
    `).all<{ id: number }>(chat_id, keepId);
    const toPrune = others.slice(0, Math.max(0, others.length + 1 - cap)).map((r) => r.id);
    for (const id of toPrune) {
      this.db.prepare(`UPDATE episodic_facts SET status = 'pruned' WHERE id = ?`).run(id);
    }
    return toPrune;
  }

  /**
   * Top-k neighbors for the reconcile compare (Phase M B2): FTS5 MATCH over the
   * candidate's sanitized tokens, best rank first. FTS candidates SUFFICE here —
   * reconcile is an LLM verdict over the neighbor texts, so recall (not semantic
   * ranking) is all this must provide, and the pass must work with Ollama down —
   * embeddings are deliberately not used (M2 retrieval is where they earn their keep).
   * No FTS hits (e.g. CJK text, which unicode61 doesn't word-segment) falls back to
   * the chat's most recent active facts; a hostile MATCH string never throws.
   */
  getEpisodicFactsForReconcile(chat_id: string, candidateText: string, k: number): EpisodicFactRow[] {
    const hits = this.searchEpisodicFactsFts(chat_id, candidateText, k);
    if (hits.length > 0) return hits;
    return this.getActiveEpisodicFacts(chat_id, k);
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
    const tokens = (queryText.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
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
   * B4 step 1 — DECAY (the lessons `runLessonDecayTick` twin, but a primitive: the
   * async consolidate tick owns the 24h idempotency): active facts untouched for
   * `decayDays` (from max(created_at, last_used) — a retrieval-applied fact is not
   * stale) lose 20% reuse_value; below `pruneThreshold` they demote to 'pruned'
   * (reversible — NEVER a delete).
   */
  decayEpisodicFacts(
    now: string,
    options: { decayDays: number; pruneThreshold: number }
  ): { facts_decayed: number; pruned_ids: number[] } {
    const cutoff = new Date(Date.parse(now) - options.decayDays * 86_400_000).toISOString();
    // Scalar MAX over ISO strings orders correctly (fixed-width UTC timestamps).
    const stale = this.db.prepare(`
      SELECT id, reuse_value FROM episodic_facts
      WHERE status = 'active' AND MAX(created_at, COALESCE(last_used, created_at)) < ?
      ORDER BY id ASC
    `).all<{ id: number; reuse_value: number }>(cutoff);

    const pruned_ids: number[] = [];
    for (const row of stale) {
      const decayed = row.reuse_value * 0.8;
      const prune = decayed < options.pruneThreshold;
      this.db.prepare(`
        UPDATE episodic_facts SET reuse_value = ?${prune ? ", status = 'pruned'" : ""} WHERE id = ?
      `).run(decayed, row.id);
      if (prune) pruned_ids.push(row.id);
    }
    return { facts_decayed: stale.length, pruned_ids };
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
   * ALL sources are ≥2 ACTIVE rows of the SAME chat — a bad cluster can never retire
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
      const members: LessonRow[] = [];
      for (const id of input.memberIds) {
        const row = this.getLesson(id);
        if (!row || row.status !== "active" || row.scope !== input.scope) {
          this.db.exec("ROLLBACK");
          activeTransaction = false;
          return undefined;
        }
        members.push(row);
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
    const tokens = (queryText.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
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
   * The daily wiki decay+prune pass (W2, the runLessonDecayTick twin): at most once per
   * 24h (the `wiki_decay_state` row makes it idempotent across poll cycles). ACTIVE
   * pages unused for `decayDays` (never-used rows date from created_at) lose 20%
   * reuse_value; below `pruneThreshold` (the lessons prune line) they demote to
   * 'pruned' — reversible, never a DELETE. Superseded rows are exempt by construction
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
    const threshold = options.pruneThreshold ?? resolveLessonPruneThreshold(process.env);
    const cutoff = new Date(Date.parse(now) - decayDays * 86_400_000).toISOString();
    const stale = this.db.prepare(`
      SELECT id, reuse_value FROM wiki_pages
      WHERE status = 'active' AND COALESCE(last_used, created_at) < ?
    `).all<{ id: number; reuse_value: number }>(cutoff);

    const pruned_ids: number[] = [];
    for (const row of stale) {
      const decayed = row.reuse_value * 0.8;
      const prune = decayed < threshold;
      this.db.prepare(`
        UPDATE wiki_pages SET reuse_value = ?${prune ? ", status = 'pruned'" : ""} WHERE id = ?
      `).run(decayed, row.id);
      if (prune) pruned_ids.push(row.id);
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
   * Runs stuck mid-flight: an ACTIVE state whose lease expired before `leaseExpiredBefore`.
   * `waiting_for_approval` is EXCLUDED by design — a run parked on Paco's /approve is the
   * system working, and alerting on it would make the sweep noisiest exactly when Paco is
   * slowest to answer.
   */
  findStuckRuns(leaseExpiredBefore: string): Array<{
    subject: string;
    state: string;
    lease_expires_at: string | null;
  }> {
    return this.db.prepare(`
      SELECT run_id AS subject, state, lease_expires_at
      FROM runs
      WHERE state IN ('created', 'contracted', 'queued', 'running', 'reconciliation_required', 'reporting')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < ?
      ORDER BY updated_at ASC
    `).all<{ subject: string; state: string; lease_expires_at: string | null }>(leaseExpiredBefore);
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
  findUndeliveredNotifications(now: string, graceMs: number): Array<{
    subject: string;
    intent_type: string;
    attempt_count: number;
  }> {
    const cutoff = new Date(Date.parse(now) - graceMs).toISOString();
    return this.db.prepare(`
      SELECT notification_id AS subject, intent_type, attempt_count
      FROM notification_outbox
      WHERE state != 'delivered'
        AND created_at < ?
        AND idempotency_key NOT LIKE 'incident\\_%' ESCAPE '\\'
      ORDER BY created_at ASC
    `).all<{ subject: string; intent_type: string; attempt_count: number }>(cutoff);
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
        text: truncateForChat(input.text, this.redact),
        report_path: input.report_path,
        // Phase 3.3: inline buttons (the self-write merge controls) ride only when supplied;
        // every other final report omits them and stays byte-identical to before.
        ...(input.buttons ? { buttons: input.buttons } : {})
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

/** SELECT list for LessonRow reads (one place, so every accessor returns the same shape). */
const LESSON_COLUMNS =
  "id, scope, text, avoid, status, supersedes, superseded_by, applied_count, " +
  "corrected_count, reuse_value, rating_history, created_at, last_used, source";

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

function buildApprovalPromptText(
  approval_id: string,
  input: ApprovalRequestInput,
  redact: (s: string) => string = (s) => s
): string {
  return redact([
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
