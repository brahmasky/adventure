import { enqueueMemoryChangeCard, searchActiveMemory } from "../capabilities/memory-correct.js";
import { escapeForTelegram } from "../capabilities/text-hygiene.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { EpisodicFactRow, MemoryChange, RunStore } from "../run/run-store.js";
import { clipText } from "../status/houge-status.js";
import type { GatewayIntakeResult } from "./gateway.js";

/**
 * Paco's memory control plane (2026-10-02): /memories, /forget-memory and the Undo button on a memory change card. Control commands, no run, no
 * budget; idempotent on the trigger key; every reply code-owned (never stored text beyond the row ids).
 */

export const MEMORY_CHANGE_NOT_FOUND = "MEMORY_CHANGE_NOT_FOUND";
export const MEMORY_CHANGE_NOT_FOUND_TEXT = "That memory change does not exist here, so nothing was undone.";
export const MEMORY_ALREADY_UNDONE_TEXT = "↩️ Already undone.";
export const MEMORY_CHANGED_SINCE_TEXT = "↩️ Not undone: this memory has changed since; use /memories.";

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

/** L1 (review round 2): the reply states exactly what the undo restored and retired, and what it left alone. */
export function undoneText(change: MemoryChange, restored: number[], retired: number | null): string {
  if (restored.length === 0 && retired === null) return MEMORY_CHANGED_SINCE_TEXT;
  const parts = [`↩️ Undone: ${restored.length > 0 ? `${tags(change, restored)} ${restored.length === 1 ? "is" : "are"} active again` : "nothing restored"}`];
  if (retired !== null) parts.push(`#${retired} is retired`);
  const left = change.old_ids.filter((id) => !restored.includes(id));
  const tail = left.length > 0 ? ` ${tags(change, left)} had changed since and ${left.length === 1 ? "was" : "were"} left as is.` : "";
  return `${parts.join("; ")}.${tail}`;
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
    const text = r.status === "undone" ? undoneText(change, r.restored, r.retired)
      : r.status === "changed_since" ? MEMORY_CHANGED_SINCE_TEXT : MEMORY_ALREADY_UNDONE_TEXT;
    replyTo(store, event, "memory_undo", text);
    return { ok: true, status: "memory_undone", run_id: "" };
  });
}

export const MEMORY_NOT_FOUND = "MEMORY_NOT_FOUND";
export const MEMORIES_LIST_MAX = 10;
export const MEMORIES_TEXT_CHARS = 120;

/** `#id · text · YYYY-MM-DD`; the fact text is stored LLM output, so it is rendered markdown-inert. */
function memoryLine(f: EpisodicFactRow): string {
  return `#${f.id} · ${clipText(escapeForTelegram(f.fact), MEMORIES_TEXT_CHARS)} · ${f.created_at.slice(0, 10)}`;
}

/** The query's matches (same search as the tool, without the embedding leg: intake is synchronous), else the most applied. */
function memoriesFor(store: RunStore, chat_id: string, query: string): EpisodicFactRow[] {
  if (!query) {
    return [...store.getActiveEpisodicFacts(chat_id)].sort((a, b) => b.applied_count - a.applied_count).slice(0, MEMORIES_LIST_MAX);
  }
  return searchActiveMemory(store, "fact", chat_id, query, null).slice(0, MEMORIES_LIST_MAX)
    .map((c) => store.getEpisodicFact(c.id)).filter((f): f is EpisodicFactRow => f !== undefined);
}

/** `/memories [query]`: up to 10 of this chat's ACTIVE facts. Read-only (no applied counter moves). */
export function handleMemories(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const query = typeof event.program === "string" ? event.program.trim() : "";
    const rows = memoriesFor(store, chatOf(event), query);
    const head = query ? `🧠 **Memories** matching your query (${rows.length})` : `🧠 **Memories** most used (${rows.length})`;
    const text = rows.length === 0
      ? (query ? "🧠 No active memories match." : "🧠 No active memories yet.")
      : [head, ...rows.map(memoryLine), "· /forget-memory <id> retires one (with Undo)"].join("\n");
    replyTo(store, event, "memories", text);
    return { ok: true, status: "memories_returned", run_id: "" };
  });
}

/** `/forget-memory <id>`: Paco's direct command, so no turn or taint rule; only an active fact of this chat. */
export function handleForgetMemory(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const id = Number(event.program);
    const change = Number.isSafeInteger(id) && id > 0
      ? store.retireMemoryRows({ kind: "fact", ids: [id], chat_id: chatOf(event), run_id: null })
      : null;
    if (!change) {
      replyTo(store, event, "forget_memory_refused", `No active memory #${Number.isSafeInteger(id) ? id : "?"} here. /memories lists them.`);
      return { ok: false, error: { code: MEMORY_NOT_FOUND, message: "No active memory with that id in this chat" } };
    }
    enqueueMemoryChangeCard(store, change, { target: event.notify, idempotency_key: `${event.idempotency_key}:memory`,
      correlation_id: event.source_reference });
    return { ok: true, status: "memory_forgotten", run_id: "" };
  });
}
