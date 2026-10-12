import { inertCode } from "../capabilities/memory-correct.js";
import { escapeForTelegram } from "../capabilities/text-hygiene.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import { digDeeperButton } from "./lanes/lane-card.js";

/** Memory lane reply (ADR 0029 §5.6): code-owned, through the rich renderer, never a score or a "safe" word. */
export const MEMLANE_UNDO_PREFIX = "memlane:undo:";
const CALLBACK_DATA_MAX_BYTES = 64;

function button(text: string, data: string): NotificationButton {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) throw new Error("memlane callback_data exceeds 64 bytes");
  return { text, data };
}

/** The ↩️ Undo button for a lesson change. Paco 2026-10-12: every automatic save carries it, whatever the turn's route. */
export function memlaneUndoButton(change_id: string): NotificationButton {
  return button("↩️ Undo", `${MEMLANE_UNDO_PREFIX}${change_id}`);
}

export function memoryLaneCard(i: {
  lesson_id: number; theme: string; text: string; avoid?: string; superseded_id?: number;
  verb: "add" | "update" | "supersede"; change_id: string; run_id: string;
}): { text: string; buttons: NotificationButton[] } {
  const tail = i.superseded_id !== undefined ? ` (${i.verb === "update" ? "updated" : "replaced"} #${i.superseded_id})` : "";
  const lines = [`📒 Saved lesson #${i.lesson_id} · ${i.theme}${tail}`, inertCode(escapeForTelegram(i.text))];
  if (i.avoid) lines.push(`AVOID: ${inertCode(escapeForTelegram(i.avoid))}`);
  return { text: lines.join("\n"), buttons: [memlaneUndoButton(i.change_id), digDeeperButton(i.run_id)] };
}

export function memoryInformNote(lesson_id: number, theme: string): string {
  return `[memory] Lesson #${lesson_id} (${theme}) was just saved from this message; do not save it again.`;
}
