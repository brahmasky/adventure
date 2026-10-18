import { inertCode, memoryUndoButton } from "../capabilities/memory-correct.js";
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

type SaveVerb = "add" | "update" | "supersede";
export interface CardLesson { lesson_id: number; theme: string; text: string; avoid?: string; superseded_id?: number; verb: SaveVerb; change_id: string }
export interface CardFact { fact_id: number; text: string; superseded_id?: number; verb: SaveVerb; change_id: string }
export interface CardItems { lesson?: CardLesson; fact?: CardFact }

const tail = (verb: SaveVerb, superseded_id?: number): string =>
  superseded_id !== undefined ? ` (${verb === "update" ? "updated" : "replaced"} #${superseded_id})` : "";

function lessonLines(l: CardLesson): string[] {
  const lines = [`📒 Saved lesson #${l.lesson_id} · ${l.theme}${tail(l.verb, l.superseded_id)}`, inertCode(escapeForTelegram(l.text))];
  if (l.avoid) lines.push(`AVOID: ${inertCode(escapeForTelegram(l.avoid))}`);
  return lines;
}

function factLines(f: CardFact): string[] {
  return [`🧠 Saved fact (事实) #${f.fact_id}${tail(f.verb, f.superseded_id)}`, inertCode(escapeForTelegram(f.text))];
}

/** One Undo per saved item (spec §9): lesson → memlane:undo, fact → memory:undo. Labelled by kind only when both are on the card. */
export function memoryUndoButtons(i: { lesson?: { change_id: string }; fact?: { change_id: string } }): NotificationButton[] {
  const both = i.lesson !== undefined && i.fact !== undefined;
  return [
    ...(i.lesson ? [{ ...memlaneUndoButton(i.lesson.change_id), ...(both ? { text: "↩️ Undo 规则" } : {}) }] : []),
    ...(i.fact ? [{ ...memoryUndoButton(i.fact.change_id), ...(both ? { text: "↩️ Undo 事实" } : {}) }] : [])
  ];
}

/** The memory card: one block per saved item, each Undo, then Dig deeper. A lesson-only card is the stage-1 card byte for byte. */
export function memoryLaneCard(i: CardItems & { run_id: string }): { text: string; buttons: NotificationButton[] } {
  const lines = [...(i.lesson ? lessonLines(i.lesson) : []), ...(i.fact ? factLines(i.fact) : [])];
  return { text: lines.join("\n"), buttons: [...memoryUndoButtons(i), digDeeperButton(i.run_id)] };
}

export function memoryInformNote(s: { lesson?: { id: number; theme: string }; fact?: { id: number } }): string {
  const parts = [...(s.lesson ? [`Lesson #${s.lesson.id} (${s.lesson.theme})`] : []), ...(s.fact ? [`${s.lesson ? "fact" : "Fact"} #${s.fact.id}`] : [])];
  const many = parts.length > 1;
  return `[memory] ${parts.join(" and ")} ${many ? "were" : "was"} just saved from this message; do not save ${many ? "them" : "it"} again.`;
}
