import { compileTaskContract } from "../contracts/task-contract.js";
import type { ApprovalDecision, TypedTaskEvent } from "../domain/types.js";
import type { CompiledTaskContract } from "../domain/types.js";
import {
  formatFuseAlert,
  resolveGlobalBudgetCaps,
  type GlobalBudgetCaps
} from "../budget/global-budget-ledger.js";
import type { RunStore } from "../run/run-store.js";
import { queryStatus } from "../status/status-query.js";

export type GatewayIntakeResult =
  | { ok: true; status: "created" | "duplicate"; run_id: string }
  | { ok: true; status: "status_returned"; run_id: string }
  | { ok: true; status: "approval_resolved"; run_id: string }
  | { ok: false; error: { code: string; message: string; run_id?: string } };

export class Gateway {
  private readonly caps: GlobalBudgetCaps;

  constructor(private readonly runStore: RunStore, caps?: GlobalBudgetCaps) {
    this.caps = caps ?? resolveGlobalBudgetCaps(process.env);
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

    return this.handleTaskIntake(event, now);
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

      const { runs_by_state, last_error, budget, window_hours } = status.status.overview;
      const byState = Object.entries(runs_by_state)
        .map(([state, count]) => `${state} ${count}`)
        .join(", ");
      const budgetText = budget
        .map((b) => `${b.kind} ${b.used}/${b.limit}`)
        .join(", ");

      return [
        runsText,
        "",
        `Last ${window_hours}h: ${byState || "no runs"}`,
        `Last error: ${last_error ?? "none"}`,
        `Budget: ${budgetText}`
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
