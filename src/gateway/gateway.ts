import { compileTaskContract } from "../contracts/task-contract.js";
import type { ApprovalDecision, TypedTaskEvent } from "../domain/types.js";
import type { CompiledTaskContract } from "../domain/types.js";
import {
  formatFuseAlert,
  resolveGlobalBudgetCaps,
  type GlobalBudgetCaps
} from "../budget/global-budget-ledger.js";
import { parseRatingHistory, type LessonRow, type RunStore } from "../run/run-store.js";
import {
  parseBareRating,
  RATING_ACK_TEXT,
  resolveRatingPendingMinutes
} from "../capabilities/session-rating.js";
import { SkillStore, type SkillMeta } from "../skills/skill-store.js";
import { join } from "node:path";
import { evolutionLaneSnapshot } from "../core/evolution-lane.js";
import { queryStatus } from "../status/status-query.js";

/** A freshly captured rating the daemon follows up on (the low-rating attribution pass). */
export interface RatingSignal {
  chat_id: string;
  rating: number;
  applied_lesson_ids: number[];
}

export type GatewayIntakeResult =
  | { ok: true; status: "created" | "duplicate"; run_id: string; rating_signal?: RatingSignal }
  | { ok: true; status: "status_returned"; run_id: string }
  | { ok: true; status: "approval_resolved"; run_id: string }
  | { ok: true; status: "lessons_returned"; run_id: string }
  | { ok: true; status: "skills_returned"; run_id: string }
  | { ok: true; status: "forgotten"; run_id: string }
  | {
      ok: true;
      status: "rating_captured";
      run_id: string;
      chat_id: string;
      rating: number;
      applied_lesson_ids: number[];
    }
  | { ok: false; error: { code: string; message: string; run_id?: string } };

/**
 * The capture verdict (⓪·3 S2a fix 1): a BARE digit is consumed (ack, no run); a digit
 * WITH a comment captures the rating but FORWARDS the comment as the turn's message —
 * a piggy-backed request/feedback must get a real answer, never be swallowed.
 */
type RatingCaptureOutcome =
  | { kind: "consumed"; result: GatewayIntakeResult }
  | { kind: "forward"; goal: string; rating_signal?: RatingSignal };

/** The processed-trigger marker recorded for a captured digit+comment (replay support). */
interface RatingCommentMarker {
  ok: true;
  status: "rating_comment_captured";
  comment: string;
}

export class Gateway {
  private readonly caps: GlobalBudgetCaps;
  private readonly projectRoot: string;
  private readonly skillStore: SkillStore;

  constructor(
    private readonly runStore: RunStore,
    caps?: GlobalBudgetCaps,
    projectRoot?: string,
    skillStore?: SkillStore
  ) {
    this.caps = caps ?? resolveGlobalBudgetCaps(process.env);
    this.projectRoot = projectRoot ?? process.cwd();
    // Skills live as markdown under `<projectRoot>/skills/` (same root the worker reads);
    // injectable so tests point at a temp dir.
    this.skillStore = skillStore ?? new SkillStore({ root: join(this.projectRoot, "skills") });
  }

  intake(event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult {
    if (event.source === "telegram") {
      const limit = this.runStore.checkTelegramRateLimit({
        actor_id: event.requested_by.id,
        chat_id: this.telegramChatId(event),
        command: event.type,
        now
      });
      if (!limit.ok) {
        this.runStore.recordTelegramCommandAudit({
          actor_id: event.requested_by.id,
          chat_id: this.telegramChatId(event),
          command: event.type,
          source_reference: event.source_reference,
          decision: "denied",
          reason_code: limit.error.reason,
          occurred_at: now
        });
        return {
          ok: false,
          error: { code: limit.error.code, message: limit.error.message }
        };
      }
    }

    if (event.type === "status") {
      return this.handleStatus(event, now);
    }

    if (event.type === "approve" || event.type === "deny") {
      return this.handleApproval(event, now);
    }

    if (event.type === "lessons") {
      return this.handleLessons(event, now);
    }

    if (event.type === "skills") {
      return this.handleSkills(event, now);
    }

    if (event.type === "forget") {
      return this.handleForget(event, now);
    }

    if (event.type === "turn") {
      // ⓪·3 S2a: an active rating ask intercepts a rating reply BEFORE the turn compiles;
      // any other message lets the pending expire silently and rides the normal path.
      const captured = this.captureRatingReply(event, now);
      if (captured?.kind === "consumed") return captured.result;
      if (captured?.kind === "forward") {
        // Digit + comment: the rating is banked; the COMMENT is the real message — run
        // the turn on it (the chat record shows what the model saw), no code-owned ack.
        const result = this.handleTaskIntake({ ...event, goal: captured.goal }, now);
        return result.ok &&
          (result.status === "created" || result.status === "duplicate") &&
          captured.rating_signal
          ? { ...result, rating_signal: captured.rating_signal }
          : result;
      }
    }

    return this.handleTaskIntake(event, now);
  }

  /**
   * Rating capture (⓪·3 S2a): when the chat has an active pending ask (asked within
   * HOUGE_RATING_PENDING_MINUTES) and the message is a rating reply, bank it — store the
   * rating attached to the window's applied lessons (loop_started attribution union) and
   * absorb the signal into rating_history/reuse_value. A BARE digit is consumed with a
   * code-owned ack (no run). A digit WITH a comment is NOT consumed: the comment forwards
   * as the turn's message so a piggy-backed request/feedback still gets a real answer
   * (and can ride the normal feedback/lesson paths). ANY other message deactivates the
   * pending silently (the user just kept chatting — never hijack a real message); a bare
   * digit with NO active pending routes to the normal turn. Idempotent on the trigger key.
   */
  private captureRatingReply(event: TypedTaskEvent, now: string): RatingCaptureOutcome | undefined {
    if (event.notify.kind !== "telegram") return undefined;
    const chat_id = event.notify.chat_id;

    // Replay first (a read-only peek): a redelivered capture must repeat its verdict —
    // consumption already deactivated the pending row, so the checks below can't.
    const replay = this.runStore.beginTriggerProcessing(event);
    if (replay.status === "duplicate") {
      const recorded = JSON.parse(replay.result_json) as GatewayIntakeResult | RatingCommentMarker;
      if (recorded.ok && recorded.status === "rating_captured") {
        return { kind: "consumed", result: recorded };
      }
      if (recorded.ok && recorded.status === "rating_comment_captured") {
        // Forward again (the run intake dedupes itself); never re-capture or re-attribute.
        return { kind: "forward", goal: recorded.comment };
      }
      return undefined;
    }
    if (replay.status === "conflict") {
      return {
        kind: "consumed",
        result: {
          ok: false,
          error: { code: replay.error, message: "Trigger idempotency key conflicts with a different payload" }
        }
      };
    }

    const pending = this.runStore.getPendingRating(chat_id);
    if (!pending || !pending.active) return undefined;
    const pendingMs = resolveRatingPendingMinutes(process.env) * 60_000;
    if (Date.parse(now) - Date.parse(pending.asked_at) > pendingMs) return undefined;

    const parsed = parseBareRating(typeof event.goal === "string" ? event.goal : "");
    if (!parsed) {
      this.runStore.cancelPendingRating(chat_id);
      return undefined;
    }

    const applied = this.runStore.appliedLessonIdsForChat(chat_id, pending.window_start);
    this.runStore.recordSessionRating({
      chat_id,
      rating: parsed.rating,
      ...(parsed.comment ? { comment: parsed.comment } : {}),
      asked_at: pending.asked_at,
      captured_at: now,
      applied_lesson_ids: applied
    });
    this.runStore.applyRatingToLessons(applied, parsed.rating, now);
    const rating_signal: RatingSignal = { chat_id, rating: parsed.rating, applied_lesson_ids: applied };

    if (parsed.comment) {
      // Not consumed: the comment is the message. No ack — the turn's answer replies.
      const marker: RatingCommentMarker = { ok: true, status: "rating_comment_captured", comment: parsed.comment };
      this.runStore.recordTriggerProcessed(event, marker);
      return { kind: "forward", goal: parsed.comment, rating_signal };
    }

    const result: GatewayIntakeResult = {
      ok: true,
      status: "rating_captured",
      run_id: "",
      chat_id,
      rating: parsed.rating,
      applied_lesson_ids: applied
    };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:rating`,
      correlation_id: event.source_reference,
      payload: { text: RATING_ACK_TEXT }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return { kind: "consumed", result };
  }

  /**
   * `/lessons [scope]` — a control command (no run, no budget). Renders the ACTIVE
   * lesson rows (⓪·3 S1: per-lesson rows with reuse_value, applied counts, AVOID, and
   * supersede lineage) so the owner can inspect what Houge has silently learned.
   * Idempotent on the trigger key (a redelivered update enqueues once).
   */
  private handleLessons(event: TypedTaskEvent, now: string): GatewayIntakeResult {
    const replay = this.runStore.beginTriggerProcessing(event);
    if (replay.status === "duplicate") {
      return JSON.parse(replay.result_json) as GatewayIntakeResult;
    }
    if (replay.status === "conflict") {
      return {
        ok: false,
        error: { code: replay.error, message: "Trigger idempotency key conflicts with a different payload" }
      };
    }

    const scope = typeof event.program === "string" ? event.program.trim() : "";
    const lessons = this.runStore.listLessons(scope || undefined);

    const result: GatewayIntakeResult = { ok: true, status: "lessons_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:lessons`,
      correlation_id: event.source_reference,
      payload: { text: formatLessonsText(scope || undefined, lessons) }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * `/skills [scope]` — a read-only VIEWER (no run, no budget; Phase 2a). Regenerates the
   * registry then lists the ambient skills (all scopes, or one) so the owner can see what
   * procedures Houge applies. Skills are never invoked by name — this is awareness only.
   * Idempotent on the trigger key, exactly like `/lessons`.
   */
  private handleSkills(event: TypedTaskEvent, now: string): GatewayIntakeResult {
    const replay = this.runStore.beginTriggerProcessing(event);
    if (replay.status === "duplicate") {
      return JSON.parse(replay.result_json) as GatewayIntakeResult;
    }
    if (replay.status === "conflict") {
      return {
        ok: false,
        error: { code: replay.error, message: "Trigger idempotency key conflicts with a different payload" }
      };
    }

    const scope = typeof event.program === "string" ? event.program.trim() : "";
    // `/skills pending` → list the parked (blocked) drafts instead of the active library.
    const isPending = scope.toLowerCase() === "pending";
    this.skillStore.regenerateRegistry();
    const metas = isPending ? this.skillStore.listPending() : this.skillStore.list(scope || undefined);

    const result: GatewayIntakeResult = { ok: true, status: "skills_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:skills`,
      correlation_id: event.source_reference,
      payload: { text: isPending ? formatPendingText(metas) : formatSkillsText(scope || undefined, metas) }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * `/forget <scope|id>` — a control command (no run, no budget). Prunes that scope's
   * active lessons, or one lesson by numeric id (⓪·3 S1: a reversible status flip —
   * rows are never deleted). Idempotent on the trigger key.
   */
  private handleForget(event: TypedTaskEvent, now: string): GatewayIntakeResult {
    const replay = this.runStore.beginTriggerProcessing(event);
    if (replay.status === "duplicate") {
      return JSON.parse(replay.result_json) as GatewayIntakeResult;
    }
    if (replay.status === "conflict") {
      return {
        ok: false,
        error: { code: replay.error, message: "Trigger idempotency key conflicts with a different payload" }
      };
    }

    const arg = typeof event.program === "string" ? event.program.trim() : "";
    if (!arg) {
      const result: GatewayIntakeResult = {
        ok: false,
        error: { code: "FORGET_INVALID", message: "/forget requires a scope or a lesson id" }
      };
      this.runStore.recordTriggerProcessed(event, result);
      return result;
    }

    let text: string;
    if (/^\d+$/.test(arg)) {
      const pruned = this.runStore.forgetLesson(Number(arg));
      text = pruned ? `Forgotten ✓ — pruned lesson #${arg}` : `No active lesson #${arg} to forget.`;
    } else {
      this.runStore.forgetScope(arg);
      text = `Forgotten ✓ — cleared lessons for "${arg}"`;
    }

    const result: GatewayIntakeResult = { ok: true, status: "forgotten", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:forget`,
      correlation_id: event.source_reference,
      payload: { text }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  private handleStatus(event: TypedTaskEvent, now: string): GatewayIntakeResult {
    const replay = this.runStore.beginTriggerProcessing(event);
    if (replay.status === "duplicate") {
      return JSON.parse(replay.result_json) as GatewayIntakeResult;
    }
    if (replay.status === "conflict") {
      return {
        ok: false,
        error: {
          code: replay.error,
          message: "Trigger idempotency key conflicts with a different payload"
        }
      };
    }

    const run_id = typeof event.metadata?.run_id === "string" ? event.metadata.run_id : undefined;
    const status = queryStatus(this.runStore, run_id);
    const result: GatewayIntakeResult = run_id
      ? { ok: true, status: "status_returned", run_id }
      : { ok: true, status: "status_returned", run_id: "" };

    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:status`,
      ...(run_id ? { run_id } : {}),
      correlation_id: event.source_reference,
      payload: { text: this.formatStatusText(status), status }
    });

    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  private handleApproval(event: TypedTaskEvent, now: string): GatewayIntakeResult {
    const decision: ApprovalDecision = event.type === "approve" ? "approved" : "denied";
    const resolution = this.runStore.processApprovalTrigger({
      event,
      decision,
      resolved_at: event.created_at
    });

    if (resolution.ok) {
      this.recordTelegramAccepted(event, now);
      return { ok: true, status: "approval_resolved", run_id: resolution.run_id };
    }

    return { ok: false, error: { code: resolution.error.code, message: resolution.error.message } };
  }

  private handleTaskIntake(event: TypedTaskEvent, now: string): GatewayIntakeResult {
    const contract = compileTaskContract(event);
    if (!contract.ok) {
      return { ok: false, error: contract.error };
    }

    // Global autonomy circuit-breaker: refuse new run admissions once any
    // rolling-24h cap is reached. Status/approve/deny never reach here, so
    // control commands are never blocked by the breaker.
    const budget = this.runStore.checkGlobalBudget(this.caps, now);
    if (!budget.ok) {
      this.runStore.recordGlobalBudgetFuse({
        breaches: budget.breaches,
        correlation_id: event.source_reference,
        now
      });
      // Exactly one alert per fuse episode: only the 0→1 latch transition emits.
      const fuse = this.runStore.armGlobalFuseIfNeeded(now);
      if (fuse.armed) {
        this.runStore.enqueueNotification({
          target: event.notify,
          intent_type: "progress",
          idempotency_key: `global-budget-fuse:${fuse.since}`,
          correlation_id: event.source_reference,
          payload: { text: formatFuseAlert(budget.breaches), breaches: budget.breaches }
        });
      }
      if (event.source === "telegram") {
        this.runStore.recordTelegramCommandAudit({
          actor_id: event.requested_by.id,
          chat_id: this.telegramChatId(event),
          command: event.type,
          source_reference: event.source_reference,
          decision: "denied",
          reason_code: "global_budget_fuse",
          occurred_at: now
        });
      }
      return {
        ok: false,
        error: {
          code: "GLOBAL_BUDGET_FUSE",
          message: "Global 24h budget reached; new runs are paused until the window clears"
        }
      };
    }

    const created = this.runStore.createOrGet(event);
    if (created.status === "conflict") {
      return {
        ok: false,
        error: {
          code: created.error,
          message: "Idempotency key conflicts with a different payload",
          run_id: created.existing_run_id
        }
      };
    }

    if (created.status === "duplicate") {
      const resumed = this.resumeDuplicate(created.run_id, contract.contract);
      if (!resumed.ok) {
        return resumed;
      }

      if (resumed.resumed) {
        this.recordTelegramAccepted(event, now);
        return { ok: true, status: "created", run_id: created.run_id };
      }

      this.recordTelegramAccepted(event, now);
      return { ok: true, status: "duplicate", run_id: created.run_id };
    }

    const queued = this.attachAndQueue(created.run_id, contract.contract);
    if (queued.ok) {
      // Count the admitted run against the global breaker, and re-arm the fuse
      // (admissions are back under cap). Only genuinely-new runs reach here;
      // duplicates resume above without double-counting.
      this.runStore.recordGlobalBudgetRun({
        now,
        run_id: created.run_id,
        correlation_id: event.source_reference
      });
      this.runStore.disarmGlobalFuse();
      // No "queued" ack: a single-shot poll answers within seconds, so a
      // progress message is just noise. The final answer is the only user-facing
      // message. (A smarter "still working…" could return for long/async runs.)
      this.recordTelegramAccepted(event, now);
    }
    return queued;
  }

  private recordTelegramAccepted(event: TypedTaskEvent, now: string): void {
    if (event.source !== "telegram") return;
    this.runStore.recordTelegramCommandAudit({
      actor_id: event.requested_by.id,
      chat_id: this.telegramChatId(event),
      command: event.type,
      source_reference: event.source_reference,
      decision: "accepted",
      occurred_at: now
    });
  }

  private telegramChatId(event: TypedTaskEvent): string {
    return event.notify.kind === "telegram" ? event.notify.chat_id : "";
  }

  private formatStatusText(status: ReturnType<typeof queryStatus>): string {
    if (!status.ok) {
      return status.error.message;
    }
    if ("runs" in status.status) {
      const runsText =
        status.status.runs.length === 0
          ? "No runs yet"
          : status.status.runs.map((run) => `${run.run_id} ${run.state}`).join("\n");

      const { runs_by_state, last_error, budget, window_hours, poller, rating } =
        status.status.overview;
      const byState = Object.entries(runs_by_state)
        .map(([state, count]) => `${state} ${count}`)
        .join(", ");
      const budgetText = budget
        .map((b) => `${b.kind} ${b.used}/${b.limit}`)
        .join(", ");
      const pollerText = poller
        ? `last poll ${poller.last_success_at ?? "never"}${poller.last_error ? `, last error ${poller.last_error}` : ""}`
        : "not running";
      // ⓪·3 S2c: the rating signal at a glance — an open ask, or the last capture.
      const ratingText = rating.pending_since
        ? `pending ask since ${rating.pending_since}`
        : rating.last_rating !== null
          ? `last ${rating.last_rating}/3 at ${rating.last_rating_at}`
          : "none yet";

      // ⓪·3g: surface an in-flight background evolution pipeline (in-process lane state,
      // so only the daemon's own /status shows it — exactly where it is meaningful).
      const lane = evolutionLaneSnapshot();
      return [
        runsText,
        "",
        `Last ${window_hours}h: ${byState || "no runs"}`,
        `Last error: ${last_error ?? "none"}`,
        `Budget: ${budgetText}`,
        `Daemon: ${pollerText}`,
        ...(lane.busy && lane.current ? [`Evolution: ${lane.current.tool} running since ${lane.current.started_at}`] : []),
        `Rating: ${ratingText}`
      ].join("\n");
    }
    return `${status.status.run_id} ${status.status.state}`;
  }

  private resumeDuplicate(
    run_id: string,
    contract: CompiledTaskContract
  ): { ok: true; resumed: boolean } | Extract<GatewayIntakeResult, { ok: false }> {
    const state = this.runStore.getRunState(run_id);

    if (state === "created") {
      const result = this.attachAndQueue(run_id, contract);
      return result.ok ? { ok: true, resumed: true } : result;
    }

    if (state === "contracted") {
      if (!this.runStore.transition(run_id, "contracted", "queued", "ready for worker")) {
        return {
          ok: false,
          error: {
            code: "RUN_TRANSITION_FAILED",
            message: "Failed to transition run from contracted to queued",
            run_id
          }
        };
      }

      return { ok: true, resumed: true };
    }

    return { ok: true, resumed: false };
  }

  private attachAndQueue(
    run_id: string,
    contract: CompiledTaskContract
  ): GatewayIntakeResult {
    if (!this.runStore.attachContract(run_id, contract)) {
      return {
        ok: false,
        error: {
          code: "CONTRACT_ATTACH_FAILED",
          message: "Run was not in created state",
          run_id
        }
      };
    }

    if (!this.runStore.transition(run_id, "created", "contracted", "contract attached")) {
      return {
        ok: false,
        error: {
          code: "RUN_TRANSITION_FAILED",
          message: "Failed to transition run from created to contracted",
          run_id
        }
      };
    }

    if (!this.runStore.transition(run_id, "contracted", "queued", "ready for worker")) {
      return {
        ok: false,
        error: {
          code: "RUN_TRANSITION_FAILED",
          message: "Failed to transition run from contracted to queued",
          run_id
        }
      };
    }

    return { ok: true, status: "created", run_id };
  }
}

/**
 * Render the `/lessons` reply (⓪·3 S1): active rows grouped by scope, most valuable
 * first, each with its id, reuse_value/applied counts, AVOID line, and supersede lineage
 * (`supersedes #n`). `scope` set → one scope (or "none yet"); unset → every scope.
 */
function formatLessonsText(scope: string | undefined, lessons: LessonRow[]): string {
  if (lessons.length === 0) {
    return scope
      ? `No lessons for "${scope}" yet.`
      : "No lessons yet. Houge learns durable preferences silently from your feedback.";
  }
  const byScope = new Map<string, LessonRow[]>();
  for (const lesson of lessons) {
    const group = byScope.get(lesson.scope) ?? [];
    group.push(lesson);
    byScope.set(lesson.scope, group);
  }
  return [...byScope.entries()]
    .map(([s, group]) =>
      [`## ${s} (${group.length} active)`, ...group.map((l) => formatLessonLines(l))].join("\n")
    )
    .join("\n\n");
}

function formatLessonLines(lesson: LessonRow): string {
  // ⓪·3 S2c: surface the rating signal — how many session ratings touched the lesson,
  // and a ⚠ when the low-rating attribution pass implicated it.
  const history = parseRatingHistory(lesson.rating_history);
  const ratings = history.filter((entry) => typeof entry.rating === "number").length;
  const flagged = history.some((entry) => entry.flag === "culprit");
  const lines = [
    `#${lesson.id} ${lesson.text} — reuse ${lesson.reuse_value.toFixed(1)}, applied ${lesson.applied_count}` +
      (ratings > 0 ? `, ratings ${ratings}` : "") +
      (flagged ? " ⚠ flagged" : "")
  ];
  if (lesson.avoid) lines.push(`   AVOID: ${lesson.avoid}`);
  if (lesson.supersedes !== null) lines.push(`   supersedes #${lesson.supersedes}`);
  return lines.join("\n");
}

/**
 * Render the `/skills` reply: a readable list of the ambient procedures (name, scope, the
 * `when:` hint, and version) so the owner sees what Houge can apply. `scope` set → one
 * scope (or "none yet"); unset → every scope.
 */
function formatSkillsText(scope: string | undefined, metas: SkillMeta[]): string {
  if (metas.length === 0) {
    return scope
      ? `No skills for "${scope}" yet.`
      : "No skills yet. Skills are reusable procedures Houge applies automatically when relevant.";
  }
  return metas
    .map((m) => `## ${m.name} (${m.scope}) v${m.version ?? 1}\nwhen: ${m.when}`)
    .join("\n\n");
}

/**
 * Render the `/skills pending` reply: the parked (blocked) auto-author drafts under
 * `_pending/` — INERT (never applied), inspectable so Paco can hand-fix + promote or discard.
 */
function formatPendingText(metas: SkillMeta[]): string {
  if (metas.length === 0) {
    return "No pending skills. Blocked auto-authored drafts park here (inert) for you to inspect.";
  }
  return [
    "Pending (blocked) skills — parked, NOT applied. Hand-fix + move to active, or discard:",
    "",
    ...metas.map((m) => `## ${m.name} (${m.scope})\nwhen: ${m.when}`)
  ].join("\n");
}
