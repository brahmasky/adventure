import { compileTaskContract } from "../contracts/task-contract.js";
import type { ApprovalDecision, TypedTaskEvent } from "../domain/types.js";
import type { CompiledTaskContract } from "../domain/types.js";
import {
  formatFuseAlert,
  resolveGlobalBudgetCaps,
  type GlobalBudgetCaps
} from "../budget/global-budget-ledger.js";
import type { LessonBlockRow, RunStore } from "../run/run-store.js";
import { SkillStore, type SkillMeta } from "../skills/skill-store.js";
import { join } from "node:path";
import { queryStatus } from "../status/status-query.js";

export type GatewayIntakeResult =
  | { ok: true; status: "created" | "duplicate"; run_id: string }
  | { ok: true; status: "status_returned"; run_id: string }
  | { ok: true; status: "approval_resolved"; run_id: string }
  | { ok: true; status: "lessons_returned"; run_id: string }
  | { ok: true; status: "skills_returned"; run_id: string }
  | { ok: true; status: "forgotten"; run_id: string }
  | { ok: false; error: { code: string; message: string; run_id?: string } };

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

    return this.handleTaskIntake(event, now);
  }

  /**
   * `/lessons [scope]` — a control command (no run, no budget). Renders the durable
   * lesson block(s) from lesson_blocks so the owner can inspect what Houge has silently
   * learned (ADR 0010). Shows each block's char-count/cap so consolidation pressure is
   * visible. Idempotent on the trigger key (a redelivered update enqueues once).
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
    const blocks = scope
      ? this.lessonBlocksForScope(scope)
      : this.runStore.listLessonBlocks();

    const result: GatewayIntakeResult = { ok: true, status: "lessons_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:lessons`,
      correlation_id: event.source_reference,
      payload: { text: formatLessonsText(scope || undefined, blocks) }
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
    this.skillStore.regenerateRegistry();
    const metas = this.skillStore.list(scope || undefined);

    const result: GatewayIntakeResult = { ok: true, status: "skills_returned", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:skills`,
      correlation_id: event.source_reference,
      payload: { text: formatSkillsText(scope || undefined, metas) }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  /**
   * `/forget <scope>` — a control command (no run, no budget). Clears that scope's
   * lesson block and acks. Idempotent on the trigger key.
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

    const scope = typeof event.program === "string" ? event.program.trim() : "";
    if (!scope) {
      const result: GatewayIntakeResult = {
        ok: false,
        error: { code: "FORGET_INVALID", message: "/forget requires a scope" }
      };
      this.runStore.recordTriggerProcessed(event, result);
      return result;
    }

    this.runStore.forgetScope(scope);

    const result: GatewayIntakeResult = { ok: true, status: "forgotten", run_id: "" };
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${event.idempotency_key}:forget`,
      correlation_id: event.source_reference,
      payload: { text: `Forgotten ✓ — cleared lessons for "${scope}"` }
    });
    this.runStore.recordTriggerProcessed(event, result);
    this.recordTelegramAccepted(event, now);
    return result;
  }

  private lessonBlocksForScope(scope: string): LessonBlockRow[] {
    return this.runStore.listLessonBlocks().filter((b) => b.scope === scope);
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

      const { runs_by_state, last_error, budget, window_hours, poller } =
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

      return [
        runsText,
        "",
        `Last ${window_hours}h: ${byState || "no runs"}`,
        `Last error: ${last_error ?? "none"}`,
        `Budget: ${budgetText}`,
        `Daemon: ${pollerText}`
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
 * Render the `/lessons` reply: the raw block(s) with each scope's char-count/cap so the
 * owner sees consolidation pressure. `scope` set → one scope (or "none yet"); unset →
 * every scope.
 */
function formatLessonsText(scope: string | undefined, blocks: LessonBlockRow[]): string {
  if (blocks.length === 0) {
    return scope
      ? `No lessons for "${scope}" yet.`
      : "No lessons yet. Houge learns durable preferences silently from your feedback.";
  }
  return blocks
    .map((b) => `## ${b.scope} (${b.block.length}/${b.char_cap} chars)\n${b.block}`)
    .join("\n\n");
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
