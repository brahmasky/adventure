import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/** Spec 2026-11-02 §6.2: the reset happens at the next start, so the reply does not claim it already has. */
export const FRESH_REPLY = "The next message starts a fresh conversation; the planner will not see earlier turns.";

/**
 * `/fresh` (Paco only, as every command: the adapter's allowlist). Writes the persisted marker for the chat; the daemon then
 * stops an idle planner child (onPlannerControl). Only a Telegram event can carry it (the parser), so the non-chat branch is
 * unreachable from the poll loop and needs no HANDLED_INTAKE_DENIAL_CODES entry.
 */
export function handleFresh(store: RunStore, event: TypedTaskEvent, now: string): GatewayIntakeResult {
  if (event.notify.kind !== "telegram") return { ok: false, error: { code: "TELEGRAM_COMMAND_UNSUPPORTED", message: "/fresh is a chat command" } };
  const chat = event.notify.chat_id;
  return oncePerTrigger(store, event, () => {
    store.requestFreshTranscript(chat, now);
    replyTo(store, event, "fresh", FRESH_REPLY);
    return { ok: true, status: "fresh_requested", run_id: "" };
  });
}
