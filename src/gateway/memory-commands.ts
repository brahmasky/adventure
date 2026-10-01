import type { TypedTaskEvent } from "../domain/types.js";
import type { MemoryChange, RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";

/**
 * Paco's memory control plane (2026-10-02): the Undo button on a memory change card. Control commands, no run, no
 * budget; idempotent on the trigger key; every reply code-owned (never stored text beyond the row ids).
 */

export const MEMORY_CHANGE_NOT_FOUND = "MEMORY_CHANGE_NOT_FOUND";
export const MEMORY_CHANGE_NOT_FOUND_TEXT = "That memory change does not exist here, so nothing was undone.";
export const MEMORY_ALREADY_UNDONE_TEXT = "↩️ Already undone.";

/** Run `fn` once per trigger: a redelivered update replays the recorded result (and its reply key dedupes). */
export function oncePerTrigger(store: RunStore, event: TypedTaskEvent, fn: () => GatewayIntakeResult): GatewayIntakeResult {
  const replay = store.beginTriggerProcessing(event);
  if (replay.status === "duplicate") return JSON.parse(replay.result_json) as GatewayIntakeResult;
  if (replay.status === "conflict") {
    return { ok: false, error: { code: replay.error, message: "Trigger idempotency key conflicts with a different payload" } };
  }
  const result = fn();
  store.recordTriggerProcessed(event, result);
  return result;
}

/** One code-owned reply to the event's chat, keyed on the event so a redelivery never replies twice. */
export function replyTo(store: RunStore, event: TypedTaskEvent, suffix: string, text: string): void {
  store.enqueueNotification({
    target: event.notify, intent_type: "progress", idempotency_key: `${event.idempotency_key}:${suffix}`,
    correlation_id: event.source_reference, payload: { text }
  });
}

const chatOf = (event: TypedTaskEvent): string => (event.notify.kind === "telegram" ? event.notify.chat_id : "");
const tags = (change: MemoryChange, ids: number[]): string => ids.map((id) => `${change.kind === "wiki" ? "wiki " : ""}#${id}`).join(", ");

export function undoneText(change: MemoryChange): string {
  const verb = change.old_ids.length === 1 ? "is" : "are";
  const restored = `↩️ Undone: ${tags(change, change.old_ids)} ${verb} active again`;
  return change.new_id !== null ? `${restored}; #${change.new_id} is retired.` : `${restored}.`;
}

/** The Undo tap: only this chat's change; a second tap changes nothing and says so. */
export function handleMemoryUndo(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const change_id = typeof event.metadata?.change_id === "string" ? event.metadata.change_id : "";
    const change = store.getMemoryChange(change_id);
    if (!change || change.chat_id !== chatOf(event)) {
      replyTo(store, event, "memory_undo_refused", MEMORY_CHANGE_NOT_FOUND_TEXT);
      return { ok: false, error: { code: MEMORY_CHANGE_NOT_FOUND, message: "No such memory change in this chat" } };
    }
    const r = store.undoMemoryChange(change_id);
    replyTo(store, event, "memory_undo", r.status === "undone" ? undoneText(change) : MEMORY_ALREADY_UNDONE_TEXT);
    return { ok: true, status: "memory_undone", run_id: "" };
  });
}
