import { compileTaskContract } from "../contracts/task-contract.js";
import type { ApprovalDecision, TypedTaskEvent } from "../domain/types.js";
import type { CompiledTaskContract } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import { queryStatus } from "../status/status-query.js";

export type GatewayIntakeResult =
  | { ok: true; status: "created" | "duplicate"; run_id: string }
  | { ok: true; status: "status_returned"; run_id: string }
  | { ok: true; status: "approval_resolved"; run_id: string }
  | { ok: false; error: { code: string; message: string; run_id?: string } };

export class Gateway {
  constructor(private readonly runStore: RunStore) {}

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
        this.enqueueProgress(event, created.run_id);
        this.recordTelegramAccepted(event, now);
        return { ok: true, status: "created", run_id: created.run_id };
      }

      this.recordTelegramAccepted(event, now);
      return { ok: true, status: "duplicate", run_id: created.run_id };
    }

    const queued = this.attachAndQueue(created.run_id, contract.contract);
    if (queued.ok) {
      this.enqueueProgress(event, created.run_id);
      this.recordTelegramAccepted(event, now);
    }
    return queued;
  }

  private enqueueProgress(event: TypedTaskEvent, run_id: string): void {
    if (event.source !== "telegram") return;
    this.runStore.enqueueNotification({
      target: event.notify,
      intent_type: "progress",
      idempotency_key: `${run_id}:progress:queued`,
      run_id,
      correlation_id: event.source_reference,
      payload: { text: `Queued ${run_id}` }
    });
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
      if (status.status.runs.length === 0) {
        return "No runs yet";
      }
      return status.status.runs
        .map((run) => `${run.run_id} ${run.state}`)
        .join("\n");
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
