import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { RunStore } from "../../src/run/run-store.js";

let seq = 0;

/** A queued turn run born through the real gateway intake (same path as the core-worker tests). Tests only. */
export function createQueuedTurnRun(store: RunStore, message = "hello"): string {
  seq += 1;
  const intake = new Gateway(store).intake(
    buildTypedTaskEvent({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: message,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "555" },
      idempotency_key: `helper:${seq}:${message}`,
      source_reference: "telegram:update:1:message:1"
    })
  );
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  return intake.run_id;
}

/** A telegram turn WITH its user chat_turns row (createQueuedTurnRun stops at intake; the planner writes the turn in production). Tests only. */
export function createTelegramTurn(store: RunStore, message = "hello", created_at?: string): { run_id: string; turn_id: string } {
  const run_id = createQueuedTurnRun(store, message);
  store.recordChatTurn({ chat_id: "555", run_id, role: "user", text: message, ...(created_at ? { created_at } : {}) });
  return { run_id, turn_id: store.userTurnIdForRun(run_id)! };
}
