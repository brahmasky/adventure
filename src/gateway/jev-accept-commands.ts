import { acceptJevModel } from "../decisions/jev-version-controls.js";
import { modelHash } from "../decisions/jev-version-job.js";
import { errorCode } from "../domain/error-code.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { TAP_FAILED_TEXT, TAP_HANDLED_TEXT } from "./improvement-commands.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * The Accept button on a Jev version check card (spec 2026-10-22 §2.6). The adapter passed the sender allowlist;
 * oncePerTrigger replays a redelivered callback id. It acts only from the chat the card went to (`card_chat` in the
 * model's detail), only on the check generation the card showed and a model still `drifted` or `insufficient` (fenced), and
 * answers "Already handled." otherwise.
 */
export const JEV_ACCEPTED_TEXT = (model: string): string => `✅ Accepted ${model}: the triage tree arms everything on it.`;
const chatOf = (e: TypedTaskEvent): string => (e.notify.kind === "telegram" ? e.notify.chat_id : "");

function cardChat(detail: string | null): string | null {
  try { const c = (JSON.parse(detail ?? "null") as { card_chat?: unknown } | null)?.card_chat; return typeof c === "string" ? c : null; } catch { return null; }
}

function acceptByHash(store: RunStore, hash: string, generation: number, chat: string, now: string): string {
  const row = store.listJevModels().find((m) => modelHash(m.model) === hash);
  if (!row || row.generation !== generation || cardChat(row.detail_json) !== chat) return TAP_HANDLED_TEXT;
  return acceptJevModel(store, row, ["drifted", "insufficient"], "tap", now) ? JEV_ACCEPTED_TEXT(row.model) : TAP_HANDLED_TEXT;
}

export function handleJevAcceptTap(store: RunStore, event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    let text = TAP_FAILED_TEXT;
    try {
      const generation = event.metadata?.generation;
      text = typeof generation === "number" ? acceptByHash(store, String(event.metadata?.model_hash ?? ""), generation, chatOf(event), now) : TAP_HANDLED_TEXT;
    } catch (e) {
      console.error(`[jev] accept tap failed: ${errorCode(e)}`);
    }
    try {
      replyTo(store, event, "jev_accept_tap", text);
    } catch (e) {
      console.error(`[jev] accept tap reply failed: ${errorCode(e)}`);
    }
    return { ok: true, status: "jev_accept_tapped", run_id: "" };
  });
}
