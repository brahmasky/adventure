import { compileTaskContract } from "../contracts/task-contract.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";

export type GatewayIntakeResult =
  | { ok: true; status: "created" | "duplicate"; run_id: string }
  | { ok: false; error: { code: string; message: string; run_id?: string } };

export class Gateway {
  constructor(private readonly runStore: RunStore) {}

  intake(event: TypedTaskEvent): GatewayIntakeResult {
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
      return { ok: true, status: "duplicate", run_id: created.run_id };
    }

    if (!this.runStore.attachContract(created.run_id, contract.contract)) {
      return {
        ok: false,
        error: {
          code: "CONTRACT_ATTACH_FAILED",
          message: "Run was not in created state",
          run_id: created.run_id
        }
      };
    }

    if (!this.runStore.transition(created.run_id, "created", "contracted", "contract attached")) {
      return {
        ok: false,
        error: {
          code: "RUN_TRANSITION_FAILED",
          message: "Failed to transition run from created to contracted",
          run_id: created.run_id
        }
      };
    }

    if (!this.runStore.transition(created.run_id, "contracted", "queued", "ready for worker")) {
      return {
        ok: false,
        error: {
          code: "RUN_TRANSITION_FAILED",
          message: "Failed to transition run from contracted to queued",
          run_id: created.run_id
        }
      };
    }

    return { ok: true, status: "created", run_id: created.run_id };
  }
}
