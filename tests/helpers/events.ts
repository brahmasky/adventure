import { buildTypedTaskEvent, type TypedTaskEvent } from "../../src/domain/types.js";

let seq = 0;

/** The TypedTaskEvent a Telegram message (or a schedule fire) turns into at intake. Tests only. */
export function telegramTurnEvent(o: { source?: "telegram" | "schedule"; goal?: string; chat_id?: string } = {}): TypedTaskEvent {
  seq += 1;
  return buildTypedTaskEvent({
    source: o.source ?? "telegram",
    type: "turn",
    program: "turn",
    goal: o.goal ?? "hello",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: o.chat_id ?? "555" },
    idempotency_key: `events:${seq}`,
    source_reference: `telegram:update:${seq}:message:1`
  });
}
