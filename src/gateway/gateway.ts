import { compileTaskContract } from "../contracts/task-contract.js";
import type { ApprovalDecision, TypedTaskEvent } from "../domain/types.js";
import type { CompiledTaskContract } from "../domain/types.js";
import {
  formatFuseAlert,
  formatMeteredStatusLine,
  resolveGlobalBudgetCaps,
  resolveMeteredCeilings,
  type GlobalBudgetCaps
} from "../budget/global-budget-ledger.js";
import {
  applyDisarmPosture,
  clearDisarmPosture,
  formatDisarmAckText,
  formatRearmAckText,
  resolveDisarmPath,
  writeDisarmPosture
} from "../config/disarm-posture.js";
import { formatKillAckText, writeTombstone } from "../run/tombstone.js";
import { parseRatingHistory, type LessonRow, type RunStore, type ScheduledTaskRow } from "../run/run-store.js";
import {
  describeScheduleSpec,
  formatInstantInZone,
  formatScheduleListText,
  parseScheduleSpec
} from "../run/schedule-spec.js";
import {
  parseBareRating,
  RATING_ACK_TEXT,
  resolveRatingPendingMinutes
} from "../capabilities/session-rating.js";
import { SkillStore, type SkillMeta } from "../skills/skill-store.js";
import { join } from "node:path";
import { evolutionLaneSnapshot } from "../core/evolution-lane.js";
import { queryStatus } from "../status/status-query.js";
import { formatUsageTable } from "../status/usage-report.js";

/** A freshly captured rating the daemon follows up on (the low-rating attribution pass). */
export interface RatingSignal {
  chat_id: string;
  rating: number;
  applied_lesson_ids: number[];
}

export type GatewayIntakeResult =
  | { ok: true; status: "created" | "duplicate"; run_id: string; rating_signal?: RatingSignal }
  | { ok: true; status: "status_returned"; run_id: string }
  | { ok: true; status: "usage_returned"; run_id: string }
  | { ok: true; status: "help_returned"; run_id: string }
  | { ok: true; status: "approval_resolved"; run_id: string }
  | { ok: true; status: "lessons_returned"; run_id: string }
  | { ok: true; status: "skills_returned"; run_id: string }
  | { ok: true; status: "forgotten"; run_id: string }
  | { ok: true; status: "schedule_admin_returned"; run_id: string }
  | { ok: true; status: "killed"; run_id: string }
  | { ok: true; status: "disarmed"; run_id: string }
  | { ok: true; status: "rearmed"; run_id: string }
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

/**
 * Runtime hooks the daemon threads in (ADR 0018). `requestShutdown` lets `/kill` stop the
 * poll loop AFTER its ack is durably enqueued (the daemon's flush delivers it before exit).
 * Absent in `--once`/`run` contexts — the tombstone is still written, the ack still queued.
 */
export interface GatewayHooks {
  requestShutdown?: () => void;
}

export class Gateway {
  private readonly caps: GlobalBudgetCaps;
  private readonly projectRoot: string;
  private readonly skillStore: SkillStore;
  private readonly hooks: GatewayHooks;

  constructor(
    private readonly runStore: RunStore,
    caps?: GlobalBudgetCaps,
    projectRoot?: string,
    skillStore?: SkillStore,
    hooks?: GatewayHooks
  ) {
    this.caps = caps ?? resolveGlobalBudgetCaps(process.env);
    this.projectRoot = projectRoot ?? process.cwd();
    // Skills live as markdown under `<projectRoot>/skills/` (same root the worker reads);
    // injectable so tests point at a temp dir.
    this.skillStore = skillStore ?? new SkillStore({ root: join(this.projectRoot, "skills") });
    this.hooks = hooks ?? {};
  }

  intake(event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult {
    // ADR 0018: the kill switch is the operator's emergency stop — the per-chat command
    // rate limit (5 accepted/min) must never delay it. Auth (allowlist, no forwards) was
    // already enforced upstream in the trigger adapter; nothing here weakens it.
    if (event.source === "telegram" && event.type !== "kill") {
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

    if (event.type === "usage") {
      return this.handleUsage(event, now);
    }

    if (event.type === "help" || event.type === "unknown_command") {
      return this.handleHelp(event, now);
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

    if (event.type === "schedule_admin") {
      return this.handleScheduleAdmin(event, now);
    }

    if (event.type === "kill") {
      return this.handleKill(event, now);
    }

    if (event.type === "disarm") {
      return this.handleDisarm(event, now);
    }

    if (event.type === "rearm") {
      return this.handleRearm(event, now);
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
    // B10b: a scheduled fire replays a STORED goal — never a human reply. A scheduled
    // goal that happens to be a bare digit must run as a turn, not be eaten as a rating.
    if (event.source === "schedule") return undefined;
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
    // Phase W W2: the wiki pages folded into the window's turns absorb the same signal
    // (+0.25 reuse on a good session). Attribution rides the ledger, so this is inert
    // ([] → no-op) unless wiki retrieval actually seeded wiki_page_ids.
    const appliedWiki = this.runStore.appliedWikiPageIdsForChat(chat_id, pending.window_start);
    this.runStore.applyRatingToWikiPages(appliedWiki, parsed.rating, now);
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

  /**
   * `/schedule [cancel <id>]` — a control command (no run, no budget; B10b, ADR 0017).
   * Bare `/schedule` lists the REQUESTING chat's schedules (enabled + failed — disabled
   * rows are history, not noise); `cancel` flips one of THIS chat's schedules to
   * 'disabled' — another chat's id cancels nothing and reads exactly like not-found (no
   * cross-chat probe signal). Idempotent on the trigger key, like `/lessons`.
   */
  private handleScheduleAdmin(event: TypedTaskEvent, now: string): GatewayIntakeResult {
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

    const chat_id = this.telegramChatId(event);
    const action = typeof event.program === "string" ? event.program : "list";

    let text: string;
    if (action === "cancel") {
      const schedule_id =
        typeof event.metadata?.schedule_id === "string" ? event.metadata.schedule_id : "";
      const row = schedule_id ? this.runStore.getScheduledTask(schedule_id) : undefined;
      text =
        row && row.chat_id === chat_id && this.runStore.cancelScheduledTask(schedule_id, now)
          ? formatScheduleCancelledText(schedule_id)
          : SCHEDULE_CANCEL_NOT_FOUND_TEXT;
    } else {
      text = formatScheduleListText(this.runStore.listScheduledTasks(chat_id));
    }

    const result: GatewayIntakeResult = { ok: true, status: "schedule_admin_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:schedule`,
      correlation_id: event.source_reference,
      payload: { text }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * `/kill` — the durable kill switch (ADR 0018). Order is load-bearing:
   *   1. write the tombstone (the boot gate now refuses to start — launchd KeepAlive
   *      relaunches into a PARKED process, never a live agent),
   *   2. enqueue the ack (killed + the manual revival steps),
   *   3. record the trigger, THEN
   *   4. signal shutdown — the daemon's flush delivers the already-queued ack on the
   *      way out. In `--once`/`run` contexts the hook is absent; steps 1–3 still hold.
   * Unforgeable: slash-only in the parser's explicit chain + the allowlist auth upstream.
   * Revival is MANUAL by design (delete the file, restart) — nothing automatic undoes a kill.
   */
  private handleKill(event: TypedTaskEvent, now: string): GatewayIntakeResult {
    const replay = this.runStore.beginTriggerProcessing(event);
    if (replay.status === "duplicate") {
      // A redelivered /kill repeats its verdict but never re-signals shutdown — the
      // tombstone already parks the next boot; re-aborting a healthy replay is noise.
      return JSON.parse(replay.result_json) as GatewayIntakeResult;
    }
    if (replay.status === "conflict") {
      return {
        ok: false,
        error: { code: replay.error, message: "Trigger idempotency key conflicts with a different payload" }
      };
    }

    const reason = typeof event.goal === "string" && event.goal.trim() ? event.goal.trim() : undefined;
    const path = writeTombstone({
      killed_at: now,
      by: event.requested_by.id,
      ...(reason ? { reason } : {})
    });

    const result: GatewayIntakeResult = { ok: true, status: "killed", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:kill`,
      correlation_id: event.source_reference,
      payload: { text: formatKillAckText(path) }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    // LAST: the ack is durably queued and the trigger recorded — now stop the daemon.
    this.hooks.requestShutdown?.();
    return result;
  }

  /**
   * `/disarm` — the one-command "hands off the controls" posture (ADR 0018): flips the
   * evolution + unattended-autonomy flags to "false" LIVE (they are read at every call
   * site) and writes the posture file so the disarm survives restarts (applied before
   * `.env` in `loadHougeEnv`). Idempotent on the trigger key.
   */
  private handleDisarm(event: TypedTaskEvent, now: string): GatewayIntakeResult {
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

    const path = writeDisarmPosture({ disarmed_at: now, by: event.requested_by.id });
    applyDisarmPosture(); // immediate effect: flags are read live at their call sites

    const result: GatewayIntakeResult = { ok: true, status: "disarmed", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:disarm`,
      correlation_id: event.source_reference,
      payload: { text: formatDisarmAckText(path) }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * `/rearm` — deletes the posture file; the flags re-apply from `.env` on the NEXT
   * restart (live re-enable would need the pre-disarm values remembered — deliberately
   * not done; the ack says so). Idempotent on the trigger key.
   */
  private handleRearm(event: TypedTaskEvent, now: string): GatewayIntakeResult {
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

    const path = resolveDisarmPath();
    clearDisarmPosture();

    const result: GatewayIntakeResult = { ok: true, status: "rearmed", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:rearm`,
      correlation_id: event.source_reference,
      payload: { text: formatRearmAckText(path) }
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
      payload: { text: this.formatStatusText(status, now), status }
    });

    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * `/usage` — a control command (no run, no budget). Renders the SAME per-model token/cost
   * table as the `houge usage` CLI (all-time window, matching a bare `houge usage`), wrapped
   * in a code fence so the fixed-width columns stay aligned in Telegram (the outbound HTML
   * converter renders the fence as <pre>). Idempotent on the trigger key, like /status.
   */
  private handleUsage(event: TypedTaskEvent, now: string): GatewayIntakeResult {
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

    const table = formatUsageTable(this.runStore.usageByModel());
    const result: GatewayIntakeResult = { ok: true, status: "usage_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:usage`,
      correlation_id: event.source_reference,
      payload: { text: `📊 Houge · usage · all-time\n\`\`\`\n${table}\n\`\`\`` }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * `/help` (and any unknown `/command`) — a control command (no run, no budget). Lists the
   * real supported commands so a typo/removed command guides the user instead of hallucinating
   * an LLM answer. An `unknown_command` names the attempted word first. Idempotent, like /status.
   */
  private handleHelp(event: TypedTaskEvent, now: string): GatewayIntakeResult {
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

    const attempted =
      event.type === "unknown_command" && typeof event.program === "string" ? event.program : undefined;
    const text = attempted ? `${attempted} 不是命令。\n\n${HELP_TEXT}` : HELP_TEXT;
    const result: GatewayIntakeResult = { ok: true, status: "help_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:help`,
      correlation_id: event.source_reference,
      payload: { text }
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

  private formatStatusText(status: ReturnType<typeof queryStatus>, now: string): string {
    if (!status.ok) {
      return status.error.message;
    }
    if ("runs" in status.status) {
      const { runs_by_state, last_error, budget, window_hours, poller, rating, sweep } =
        status.status.overview;
      const byState = Object.entries(runs_by_state)
        .map(([state, count]) => `${state} ${count}`)
        .join(", ");
      const budgetText = budget
        .map((b) => `${b.kind} ${b.used}/${b.limit}`)
        .join(", ");
      // ⓪·3 S2c: the rating signal at a glance — an open ask, or the last capture.
      const ratingText = rating.pending_since
        ? `pending ask since ${rating.pending_since}`
        : rating.last_rating !== null
          ? `last ${rating.last_rating}/3 at ${rating.last_rating_at}`
          : "none yet";

      // HEALTH — daemon liveness, the invariant-sweep self-check, and the last poll error.
      const daemonText = poller
        ? `polling, last ${poller.last_success_at ?? "never"}`
        : "not running";
      const sweptText = sweep.last_swept_at ? `${relativeTimeAgo(sweep.last_swept_at, now)} ago` : "never";
      const incidentText = `${sweep.open_incidents} open incident${sweep.open_incidents === 1 ? "" : "s"}`;
      const errorsText =
        poller && poller.last_error
          ? `${poller.last_error}${poller.last_error_at ? ` (${poller.last_error_at})` : ""}`
          : "none";

      // ⓪·3g: surface an in-flight background evolution pipeline (in-process lane state,
      // so only the daemon's own /status shows it — exactly where it is meaningful).
      const lane = evolutionLaneSnapshot();

      return [
        "📊 Houge · status",
        "",
        "🟢 HEALTH",
        `Daemon: ${daemonText}`,
        `Self-check: swept ${sweptText} · ${incidentText}`,
        `Errors: ${errorsText}`,
        ...(lane.busy && lane.current
          ? [`Evolution: ${lane.current.tool} running since ${lane.current.started_at}`]
          : []),
        "",
        "📈 ACTIVITY (24h)",
        `Runs: ${byState || "no runs"}`,
        `Last error: ${last_error ?? "none"}`,
        `Rating: ${ratingText}`,
        "",
        "💰 COST & USAGE",
        // Metered-$ ceiling (ADR 0019): spend vs both ceilings at a glance (line self-labels "Metered:").
        formatMeteredStatusLine(this.runStore.meteredSpendUsd(now), resolveMeteredCeilings(process.env)),
        `Volume: ${budgetText}`,
        "Tokens: run `houge usage` for per-model breakdown"
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
 * Compact "how long ago" label for /status (e.g. "5m", "2h", "3d"). Caller appends " ago".
 * Sub-minute deltas floor to "0m" rather than a negative — /status favors scannability over
 * second-level precision.
 */
function relativeTimeAgo(then: string, now: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(then)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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

// The list renderer lives in schedule-spec.ts since scheduler v2 (the schedule_task
// list verb and the /schedule command share ONE renderer); re-exported here for the
// command-path callers and their tests.
export {
  SCHEDULE_LIST_EMPTY_TEXT,
  SCHEDULE_GOAL_PREVIEW_CHARS,
  formatScheduleListText
} from "../run/schedule-spec.js";

/** `/help` (and any unknown `/command`) reply — the ACTUAL supported commands, one line each. */
export const HELP_TEXT = [
  "Houge · 命令",
  "",
  "/status — 运行与健康状态",
  "/usage — 各模型 token/费用用量",
  "/schedule — 列出定时任务（/schedule cancel <id> 取消）",
  "/lessons — 已学到的经验（可选 scope）",
  "/skills — 可用技能（可选 scope）",
  "/forget <scope|id> — 清除某条经验",
  "/approve <id> — 批准待处理操作",
  "/deny <id> — 拒绝待处理操作",
  "/kill — 紧急停机（写入 tombstone）",
  "/disarm — 关闭自主/进化开关",
  "/rearm — 重新启用（下次重启生效）",
  "/run <program> <goal> — 运行指定程序",
  "/help — 显示本帮助",
  "",
  "或者直接用自然语言提问。"
].join("\n");

/** `/schedule cancel` refusal — not-found and cross-chat read IDENTICALLY (no probe signal). */
export const SCHEDULE_CANCEL_NOT_FOUND_TEXT =
  "No active schedule with that id in this chat — see /schedule for the list.";

export function formatScheduleCancelledText(schedule_id: string): string {
  return `Cancelled ✓ ${schedule_id} — it will not fire again.`;
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
