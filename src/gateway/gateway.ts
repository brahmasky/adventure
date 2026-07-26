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
  parseScheduleSpec,
  resolveDisplayZone,
  visibleSchedules
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
import { resolveRadarEnabled } from "../capabilities/idea-radar.js";
import { CHAIR_FALLBACK_RATIONALE, resolvePanelEnabled } from "../capabilities/idea-panel.js";
import { resolvePanelAt } from "../capabilities/week-key.js";
import { escapeForTelegram } from "../capabilities/text-hygiene.js";
import type { IdeaRow, ShortlistRow } from "../run/run-store.js";

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
  | { ok: true; status: "radar_returned"; run_id: string }
  | { ok: true; status: "idea_returned"; run_id: string }
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

    if (event.type === "radar") {
      return this.handleRadar(event, now);
    }

    if (event.type === "idea") {
      return this.handleIdea(event, now);
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
      const arg =
        typeof event.metadata?.schedule_id === "string" ? event.metadata.schedule_id : "";
      text = this.cancelSchedule(chat_id, arg, now);
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
   * Resolve `/schedule cancel <arg>` to a reply. `arg` is either a stable list number
   * (`#N` from the bare `/schedule` list) or a full `sch_<uuid>` (backward compat).
   * A pure positive integer resolves against the SAME ordered, chat-scoped, non-disabled
   * list the renderer numbers (listScheduledTasks → visibleSchedules) — so `#N` in the
   * list maps to the same schedule here; out-of-range `#N` gets a distinct error. A
   * non-integer is an exact id match, chat-scoped (cross-chat reads as not-found — no
   * probe signal).
   */
  private cancelSchedule(chat_id: string, arg: string, now: string): string {
    if (/^[1-9][0-9]*$/.test(arg)) {
      const n = Number(arg);
      const target = visibleSchedules(this.runStore.listScheduledTasks(chat_id))[n - 1];
      if (!target) return formatScheduleNumberNotFoundText(n);
      return this.runStore.cancelScheduledTask(target.schedule_id, now)
        ? formatScheduleCancelledText(target.schedule_id)
        : SCHEDULE_CANCEL_NOT_FOUND_TEXT;
    }
    const row = arg ? this.runStore.getScheduledTask(arg) : undefined;
    return row && row.chat_id === chat_id && this.runStore.cancelScheduledTask(arg, now)
      ? formatScheduleCancelledText(arg)
      : SCHEDULE_CANCEL_NOT_FOUND_TEXT;
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
   * `/radar` — a read-only VIEWER over the ideas store (Idea Radar R1/R2; no run, no
   * budget). Bare: the numbered top-10 active cards (status-pinned ordering — the ordinals
   * ARE the addressing scheme for `/radar <n>` and `/idea pick`). With `metadata.radar_number`:
   * one card's detail view resolved against the SAME ordered list, out-of-range → a distinct
   * not-found line (the `/schedule cancel <N>` idiom). Every card-derived string renders
   * through `escapeForTelegram` (card text originated in external feeds — render it inert).
   * Flag off → a one-line "radar off" notice. Idempotent on the trigger key, like /usage.
   */
  private handleRadar(event: TypedTaskEvent, now: string): GatewayIntakeResult {
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

    const rawNumber = event.metadata?.radar_number;
    const radarNumber =
      typeof rawNumber === "number" && Number.isInteger(rawNumber) && rawNumber >= 1
        ? rawNumber
        : undefined;

    let text: string;
    if (!resolveRadarEnabled(process.env)) {
      text = RADAR_OFF_TEXT;
    } else if (radarNumber !== undefined) {
      const card = this.runStore.listActiveIdeas(10)[radarNumber - 1];
      text = card ? formatRadarDetailText(radarNumber, card, now) : formatRadarNumberNotFoundText(radarNumber);
    } else {
      text = formatRadarText(this.runStore.listActiveIdeas(10), this.runStore.countActiveIdeas(), this.runStore.getRadarLastRun(), now);
    }
    const result: GatewayIntakeResult = { ok: true, status: "radar_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      // The list reply keeps the R1 `:radar` key; a detail reply keys on its ordinal so a
      // hypothetical list+detail pair from one update could never collapse to one row.
      idempotency_key: `${event.idempotency_key}:radar${radarNumber !== undefined ? `:${radarNumber}` : ""}`,
      correlation_id: event.source_reference,
      payload: { text }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * `/idea` — the weekly shortlist viewer + pick control (Idea Radar R2, spec §5; no run,
   * no budget). Show renders the LATEST frozen snapshot (week_key header, ranked rows, the
   * picked marker); pick resolves rank n in that snapshot and flips the global pick
   * singleton. Gated on the PANEL flag (its own dark-feature notice — `/idea` surfaces
   * belong to the panel, not the R1 radar). Idempotent on the trigger key, like /radar.
   */
  private handleIdea(event: TypedTaskEvent, now: string): GatewayIntakeResult {
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

    const action = event.metadata?.idea_action === "pick" ? "pick" : "show";
    let text: string;
    if (!resolvePanelEnabled(process.env)) {
      text = IDEA_OFF_TEXT;
    } else if (action === "pick") {
      text = this.pickIdea(event, now);
    } else {
      const snapshot = this.runStore.getLatestShortlist();
      text = snapshot ? formatIdeaText(snapshot, snapshot.picked_idea_id) : IDEA_EMPTY_TEXT;
    }

    const rawNumber = event.metadata?.idea_number;
    const pickSuffix =
      action === "pick" && typeof rawNumber === "number" ? `:pick:${rawNumber}` : "";
    const result: GatewayIntakeResult = { ok: true, status: "idea_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:idea${pickSuffix}`,
      correlation_id: event.source_reference,
      payload: { text }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * Resolve `/idea pick <n>` to a reply (spec §5 singleton mechanism, set-BEFORE-revert):
   *   1. rank n resolves in the LATEST snapshot (frozen — board drift cannot misresolve);
   *   2. the new card flips `→ picked` FIRST; a refusal here means IT was archived since
   *      the snapshot froze — reply the failure line, write NOTHING else (the prior pick,
   *      if any, stays intact — never end with zero picked cards);
   *   3. only then the CURRENT prior pick (global `status='picked'` query, never snapshot
   *      fields — those diverge across weeks) reverts `picked→shortlisted`; a refused
   *      revert, or a snapshot pick pointer whose card left the singleton, means the
   *      previous pick was archived/killed — the reply notes it. The transient two-picked
   *      state between steps 2 and 3 lives inside this synchronous handler only; the
   *      handler always ends with the singleton restored;
   *   4. stamp the snapshot's display pointer, confirm "picked #n from <week_key>".
   * Re-picking the already-picked card skips the status churn (the guard refuses
   * picked→picked) and just re-stamps + confirms — an idempotent operator nudge.
   */
  private pickIdea(event: TypedTaskEvent, now: string): string {
    const rawNumber = event.metadata?.idea_number;
    const n = typeof rawNumber === "number" && Number.isInteger(rawNumber) && rawNumber >= 1 ? rawNumber : undefined;
    const snapshot = this.runStore.getLatestShortlist();
    if (!snapshot) return IDEA_EMPTY_TEXT;
    const card = n !== undefined ? snapshot.cards.find((c) => c.rank === n) : undefined;
    if (n === undefined || !card) return formatIdeaNumberNotFoundText(n ?? 0);

    const notes: string[] = [];
    const prior = this.runStore.getPickedIdea();
    if (prior && prior.id === card.idea_id) {
      // Same-week same-card re-pick: already the singleton — re-stamp display + confirm.
      this.runStore.setShortlistPick({ snapshotId: snapshot.id, ideaId: card.idea_id });
      return formatIdeaPickedText(card.rank, snapshot.week_key, card.title);
    }
    // Set BEFORE revert: `shortlisted→picked` is an allowed transition even while the prior
    // card is still `picked` (no uniqueness guard in setIdeaStatus), so a refusal here —
    // the card was archived since the snapshot froze — leaves the prior pick untouched
    // instead of ending the system with ZERO picked cards.
    const set = this.runStore.setIdeaStatus({ id: card.idea_id, status: "picked", now });
    if (!set.updated) return IDEA_PICK_CARD_ARCHIVED_TEXT;

    if (prior) {
      const reverted = this.runStore.setIdeaStatus({ id: prior.id, status: "shortlisted", now });
      if (!reverted.updated) notes.push("上一个 pick 已归档");
    } else if (snapshot.picked_idea_id !== null && snapshot.picked_idea_id !== card.idea_id) {
      // The snapshot remembers a pick the global singleton no longer has: the previous
      // picked card was archived/killed out from under it — nothing to revert, say so.
      notes.push("上一个 pick 已归档");
    }

    this.runStore.setShortlistPick({ snapshotId: snapshot.id, ideaId: card.idea_id });
    return [formatIdeaPickedText(card.rank, snapshot.week_key, card.title), ...notes].join("\n");
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
      // Count first reads naturally ("21 completed"), not "completed 21".
      const byState = Object.entries(runs_by_state)
        .map(([state, count]) => `${count} ${state}`)
        .join(", ");
      const budgetText = budget
        .map((b) => `${b.kind} ${b.used}/${b.limit}`)
        .join(", ");

      // Human-facing times render in the display zone (no per-item tz on these lines).
      const zone = resolveDisplayZone(process.env);
      const city = zone.split("/").pop() ?? zone;
      const localOf = (iso: string): string => `${formatInstantInZone(iso, zone)} (${city})`;

      // ⓪·3 S2c: the rating signal at a glance — an open ask, or the last capture (local time).
      const ratingText = rating.pending_since
        ? `pending ask since ${rating.pending_since}`
        : rating.last_rating !== null && rating.last_rating_at
          ? `last ${rating.last_rating}/3 at ${localOf(rating.last_rating_at)}`
          : "none yet";

      // HEALTH — daemon liveness, the invariant-sweep self-check, and the last poll error.
      const daemonText = poller
        ? poller.last_success_at
          ? `polling · last ${localOf(poller.last_success_at)} · ${relativeTimeAgo(poller.last_success_at, now)} ago`
          : "polling · last never"
        : "not running";
      const sweptText = sweep.last_swept_at ? `${relativeTimeAgo(sweep.last_swept_at, now)} ago` : "never";
      const incidentText = `${sweep.open_incidents} open incident${sweep.open_incidents === 1 ? "" : "s"}`;
      // Idea Radar R1: the sweeps-section rot line — last tick + active-card count. Absent
      // when the flag is off (a dark feature must not advertise itself in /status).
      const radarLine = resolveRadarEnabled(process.env)
        ? [
            `Radar: last tick ${
              this.runStore.getRadarLastRun()
                ? `${relativeTimeAgo(this.runStore.getRadarLastRun()!, now)} ago`
                : "never"
            } · ${this.runStore.countActiveIdeas()} active cards`
          ]
        : [];
      // Idea Radar R2: the panel health line — last weekly tick, the RESOLVED schedule
      // slot (a swallowed HOUGE_RADAR_PANEL_AT typo is visible here as the default), and
      // the latest shortlist size. Absent when the panel flag is off (dark feature).
      const panelLine = resolvePanelEnabled(process.env)
        ? [
            (() => {
              const lastRun = this.runStore.getPanelLastRun();
              const slot = resolvePanelAt(process.env);
              const shortlist = this.runStore.getLatestShortlist();
              // Spec §2 W3: a rejected chair argv flag would silently fall back to
              // mean-score forever — when EVERY rationale in the latest snapshot is the
              // fallback constant, the last panel ran chairless; say so here.
              const chairOff =
                shortlist !== null &&
                shortlist.cards.length > 0 &&
                shortlist.cards.every((c) => c.chair_rationale === CHAIR_FALLBACK_RATIONALE);
              return `Panel: last ${lastRun ? `${relativeTimeAgo(lastRun, now)} ago` : "never"} · ${
                slot ? `${slot.day} ${slot.at}` : "off"
              } · shortlist ${shortlist ? shortlist.cards.length : "none"}${chairOff ? " · chair off" : ""}`;
            })()
          ]
        : [];
      // Only a STILL-CURRENT error shows: if a poll succeeded after the last error, it
      // already recovered — don't leave a stale red line under a green header.
      const errorRecovered =
        !!poller?.last_success_at &&
        !!poller?.last_error_at &&
        Date.parse(poller.last_success_at) > Date.parse(poller.last_error_at);
      const errorsText =
        poller && poller.last_error && !errorRecovered
          ? `${poller.last_error}${poller.last_error_at ? ` · ${localOf(poller.last_error_at)}` : ""}`
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
        ...radarLine,
        ...panelLine,
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
 * first, each with its id + text (+ an AVOID line, + a ⚠ flag when a low-rating pass
 * implicated it). Internal telemetry (reuse/applied/ratings counts, supersede lineage) is
 * NOT shown — it is plumbing, not signal. `scope` set → one scope; unset → every scope.
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
  // ⓪·3 S2c: the ⚠ flag (a low-rating attribution pass implicated this lesson) is a real
  // signal and stays; the reuse/applied/ratings counts and supersede lineage are internal.
  const flagged = parseRatingHistory(lesson.rating_history).some((entry) => entry.flag === "culprit");
  const lines = [`#${lesson.id} ${lesson.text}${flagged ? " ⚠ flagged" : ""}`];
  if (lesson.avoid) lines.push(`   AVOID: ${lesson.avoid}`);
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
  "/radar — 创意雷达：活跃 idea 卡片",
  "/radar <n> — 查看第 n 个 idea 卡片详情",
  "/idea — 本周 shortlist（/idea pick <n> 选定）",
  "/schedule — 列出定时任务（/schedule cancel <编号或 id> 取消）",
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

/** `/radar` while the feature is dark — name the flag so the operator knows what to arm. */
export const RADAR_OFF_TEXT = "📡 Houge · radar\nradar off — HOUGE_RADAR_ENABLED 未开启";

/**
 * Render the `/radar` reply: top active cards (status-pinned, then momentum), each
 * `<n>. <title> — momentum <m>, seen <age>[, <status>]`, plus the one-line footer
 * (`N active · last tick <when> · /radar <n> 看详情`). Rows are NUMBERED (R2): the ordinal
 * is the `/radar <n>` address, resolved against this same ordering. The default `seen`
 * status is HIDDEN — every fresh card carries it, and "seen 21m ago, seen" read as a
 * stutter (Paco, first live render); a status is only news once R2 moves a card to
 * tracked/shortlisted/picked. Card titles originated in EXTERNAL feeds (slimmed +
 * sanitized at parse time) — `escapeForTelegram` at render keeps them markdown-inert.
 */
export function formatRadarText(
  cards: IdeaRow[],
  activeCount: number,
  lastTick: string | null,
  now: string
): string {
  const lines = cards.map(
    (card, index) =>
      `${index + 1}. ${escapeForTelegram(card.title)} — momentum ${card.momentum}, seen ${relativeTimeAgo(card.last_seen, now)} ago${card.status === "seen" ? "" : `, ${card.status}`}`
  );
  const footer = `${activeCount} active · last tick ${lastTick ? `${relativeTimeAgo(lastTick, now)} ago` : "never"} · /radar <n> 看详情`;
  return [
    "📡 Houge · radar",
    ...(lines.length > 0 ? lines : ["还没有活跃的 idea 卡片。"]),
    "",
    footer
  ].join("\n");
}

/** Per-source item cap in the `/radar <n>` detail view (spec §5). */
const RADAR_DETAIL_ITEMS_PER_SOURCE = 3;
/** Total source-item line cap in the detail view (spec §5). */
const RADAR_DETAIL_ITEM_LINES_MAX = 12;

/**
 * Render the `/radar <n>` detail view (Idea Radar R2, spec §5): title line under the list
 * ordinal, summary, the momentum/age/status line (status ALWAYS shows here — a detail view
 * is where "seen" is an answer, not a stutter), the panel line when `scores_json` carries
 * one (stale weeks render as-is — the week label makes them self-describing), and up to
 * 3 items per source / 12 lines total from the sources map. URLs render as plain escaped
 * text (no markdown link syntax — Telegram auto-links, and escaping stays trivial).
 * EVERY stored string (title/summary/source keys/item titles/URLs/panel week) escapes.
 */
export function formatRadarDetailText(n: number, card: IdeaRow, now: string): string {
  const lines = [
    `${n}. ${escapeForTelegram(card.title)}`,
    escapeForTelegram(card.summary),
    `momentum ${card.momentum} (${card.distinct_items} items × ${card.distinct_sources} sources) · seen ${relativeTimeAgo(card.last_seen, now)} ago · first seen ${relativeTimeAgo(card.first_seen, now)} ago · status ${card.status}`
  ];
  const panelLine = formatPanelScoreLine(card.scores_json);
  if (panelLine) lines.push(panelLine);
  const itemLines: string[] = [];
  for (const [sourceKey, items] of Object.entries(card.sources)) {
    for (const item of items.slice(0, RADAR_DETAIL_ITEMS_PER_SOURCE)) {
      if (itemLines.length >= RADAR_DETAIL_ITEM_LINES_MAX) break;
      // The source key is a CODE-OWNED registry constant (`hn_front`, `hf_papers`, …) —
      // never feed/model-derived — so it renders verbatim (escaping would mangle the
      // underscore). Item titles/URLs originated in external feeds: escaped.
      itemLines.push(
        `  ${sourceKey}: ${escapeForTelegram(item.title)} — ${escapeForTelegram(item.url)}`
      );
    }
    if (itemLines.length >= RADAR_DETAIL_ITEM_LINES_MAX) break;
  }
  if (itemLines.length > 0) lines.push("sources:", ...itemLines);
  return lines.join("\n");
}

/**
 * The detail view's panel line, or null when the card has no (parseable) panel scores:
 * `panel <week>: kimi <s> · gemini <s> · codex <s> · chair #<r>` — an absent judge omits
 * its segment; a null chair_rank omits the chair segment. Total function over hostile
 * JSON: any parse/shape failure renders as "no panel line", never a throw.
 */
function formatPanelScoreLine(scoresJson: string | null): string | null {
  if (!scoresJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(scoresJson);
  } catch {
    return null;
  }
  const panel = (parsed as { panel?: unknown } | null)?.panel;
  if (typeof panel !== "object" || panel === null) return null;
  const { week, judges, chair_rank } = panel as { week?: unknown; judges?: unknown; chair_rank?: unknown };
  const segments: string[] = [];
  for (const judge of ["kimi", "gemini", "codex"]) {
    const entry = (judges as Record<string, { score?: unknown }> | undefined)?.[judge];
    if (entry && typeof entry.score === "number" && Number.isFinite(entry.score)) {
      segments.push(`${judge} ${entry.score}`);
    }
  }
  if (typeof chair_rank === "number" && Number.isFinite(chair_rank)) {
    segments.push(`chair #${chair_rank}`);
  }
  if (segments.length === 0) return null;
  const weekLabel = typeof week === "string" ? escapeForTelegram(week) : "?";
  return `panel ${weekLabel}: ${segments.join(" · ")}`;
}

/** `/radar <n>` when there is no nth active card (out of range / empty board). */
export function formatRadarNumberNotFoundText(n: number): string {
  return `没有第 ${n} 个 idea 卡片 (no idea #${n}) — see /radar for the list.`;
}

/** `/idea` while the panel is dark — name the flag so the operator knows what to arm. */
export const IDEA_OFF_TEXT = "📋 Houge · idea\npanel off — HOUGE_RADAR_PANEL_ENABLED 未开启";

/** `/idea` (and a pick) before the first panel run — no snapshot exists yet. */
export const IDEA_EMPTY_TEXT = "📋 Houge · idea\npanel 未跑过 — 周日 09:00";

/** `/idea pick <n>` when the resolved card was archived after the snapshot froze (§11). */
export const IDEA_PICK_CARD_ARCHIVED_TEXT =
  "pick 失败 — 该卡片在 snapshot 之后已归档 (card archived since snapshot)。";

/** `/idea pick <n>` when the latest snapshot has no rank n. */
export function formatIdeaNumberNotFoundText(n: number): string {
  return `没有第 ${n} 个 shortlist 项 (no shortlist #${n}) — see /idea for the list.`;
}

/** The `/idea pick` confirmation (spec §5 step 4). Title is stored card text — escape. */
export function formatIdeaPickedText(rank: number, weekKey: string, title: string): string {
  return `picked #${rank} from ${weekKey}: ${escapeForTelegram(title)}`;
}

/**
 * Render the `/idea` shortlist reply from a frozen snapshot (Idea Radar R2, spec §5) —
 * PURE so the §7 Sunday digest push reuses it verbatim (T3). Header names the week_key;
 * rows render the frozen rank/title/mean/rationale (+ the picked marker against
 * `pickedIdeaId` — passed separately because the push renders a just-created snapshot
 * whose pointer is still NULL); footer teaches the pick verb. Titles and rationales are
 * stored card/chair text — `escapeForTelegram` keeps them markdown-inert.
 */
export function formatIdeaText(snapshot: ShortlistRow, pickedIdeaId: number | null): string {
  const rows = snapshot.cards.map(
    (card) =>
      `${card.rank}. ${escapeForTelegram(card.title)} — mean ${card.mean_score}${
        card.chair_rationale ? `, ${escapeForTelegram(card.chair_rationale)}` : ""
      }${card.idea_id === pickedIdeaId ? " ✅ picked" : ""}`
  );
  return [
    `📋 ${snapshot.week_key} shortlist`,
    ...(rows.length > 0 ? rows : ["(空 shortlist)"]),
    "",
    "· /idea pick <n>"
  ].join("\n");
}

/** `/schedule cancel` refusal — not-found and cross-chat read IDENTICALLY (no probe signal). */
export const SCHEDULE_CANCEL_NOT_FOUND_TEXT =
  "No active schedule with that id in this chat — see /schedule for the list.";

export function formatScheduleCancelledText(schedule_id: string): string {
  return `Cancelled ✓ ${schedule_id} — it will not fire again.`;
}

/** `/schedule cancel <N>` when there is no Nth row (out of range / empty list). */
export function formatScheduleNumberNotFoundText(n: number): string {
  return `没有第 ${n} 个定时任务 (no schedule #${n}) — see /schedule for the list.`;
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
