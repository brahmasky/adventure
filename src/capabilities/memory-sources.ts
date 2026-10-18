import { flattenTurnText, type TranscriptLine } from "./episodic-evidence.js";

/**
 * The memory save's trust anchor (spec 2026-10-15 §4, rulings R2 and R7). Fixed in code, never from the model or Jev:
 * Paco's newest message in the turn is the instruction (a steered one when there is one), his earlier turns are content
 * (the quoted one first, then the newest), and Houge's reply is reference only. The worker filters schedule-born turns out
 * before calling; this module picks, cuts and numbers. The lines the evidence check reads are the cut text the model saw.
 */
export const MEMORY_THREAD_TEXT_CAP = 4;
export const MEMORY_THREAD_TEXT_CHARS = 600;
export const MEMORY_THREAD_CHAR_CAP = 1500;
/** The turn id an unstored message carries on its evidence line (the lane records the user turn after the save). */
export const PENDING_TURN_PREFIX = "pending:";

/** One of Paco's messages: its stored turn, or null when it is not stored yet (the turn's own message on the lane path). */
export interface PacoMessage { run_id: string; turn_id: string | null; text: string }
export interface MemorySources { instruction: PacoMessage; thread: PacoMessage[]; prior: string }
export interface MemorySourceInput {
  /** The turn's own message (`state.objective ?? claim.contract.objective`). */
  own: PacoMessage;
  /** Paco's messages steered into this turn, oldest first. */
  steered: readonly PacoMessage[];
  /** The user turn this message quotes, when it is Paco's. */
  quoted: PacoMessage | null;
  /** Paco's earlier turns, newest first, the quoted one removed. */
  recent: readonly PacoMessage[];
  /** The quoted Houge reply, else the last Houge reply ("" if none). */
  prior: string;
}

export function memorySources(i: MemorySourceInput): MemorySources {
  const newest = i.steered.at(-1);
  const earlier = newest ? [...i.steered.slice(0, -1).reverse(), i.own] : [];
  const ordered = [...(i.quoted ? [i.quoted] : []), ...earlier, ...i.recent];
  return { instruction: { ...(newest ?? i.own), text: flattenTurnText(newest?.text ?? i.own.text) }, thread: cutThread(ordered), prior: i.prior };
}

/** At most four texts in the given order, each flattened and cut to 600 chars, 1,500 in all; an empty text is dropped. */
export function cutThread(ordered: readonly PacoMessage[]): PacoMessage[] {
  const out: PacoMessage[] = [];
  let budget = MEMORY_THREAD_CHAR_CAP;
  for (const msg of ordered) {
    if (out.length >= MEMORY_THREAD_TEXT_CAP || budget <= 0) break;
    const text = flattenTurnText(msg.text).trim().slice(0, Math.min(MEMORY_THREAD_TEXT_CHARS, budget));
    if (text.length === 0) continue;
    budget -= text.length;
    out.push({ ...msg, text });
  }
  return out;
}

/** The numbered lines of the distill question (thread 1..n, the instruction n+1), as checkEvidence reads them. */
export function evidenceLines(s: MemorySources): TranscriptLine[] {
  return [...s.thread, s.instruction].map((msg, k) => ({
    n: k + 1,
    turn: { role: "user" as const, text: msg.text, run_id: msg.run_id, turn_id: msg.turn_id ?? `${PENDING_TURN_PREFIX}${msg.run_id}` },
    text: msg.text
  }));
}

/** A cited line's stored turn id, or none for an unstored message (the trigger row links its run instead). */
export function storedTurnIds(turn_id: string): string[] {
  return turn_id.startsWith(PENDING_TURN_PREFIX) ? [] : [turn_id];
}

/** Paco's words as the lesson backstop judges them: the instruction and the cut thread. */
export function pacoTextOf(s: MemorySources): string {
  return [s.instruction.text, ...s.thread.map((msg) => msg.text)].join("\n");
}
