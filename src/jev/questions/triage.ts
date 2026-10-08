import { feedTurnText } from "../../capabilities/intent.js";
import type { TurnModality } from "../../media/media-config.js";
import type { ChatTurnRow } from "../../run/run-store.js";
import { sanitizeJevText } from "../egress-redact.js";
import { MAX_LATEST_MESSAGE_CHARS, MAX_REQUEST_CHARS } from "../intent-question.js";
import { toJevQuestion, type ChoiceQuestion, type Question } from "./types.js";

/**
 * Lane 1 questions (spec §5.3), frozen: the fall-through option first on `lane`, the cautious option first on
 * `complete`. Wording is literal and names its boundary cases; Jev reads literally. Changing a word here changes
 * the criteria hash (types.ts) and un-arms the lane until re-calibrated.
 */
export const TRIAGE_LANE: ChoiceQuestion = {
  id: "lane",
  type: "choice",
  instructions:
    "What should Houge do with `latest_message`? Houge is the AI agent in this conversation; \"Houge\", \"猴哥\", " +
    "\"you\" and \"your\" mean Houge. `recent_turns` is the conversation before `latest_message`, oldest first. " +
    "`last_houge_turn.kind` says what Houge's previous message was.",
  criteria: [
    ["none",
      "Everything else: a question, a task, a lookup, small talk, a bare acknowledgement such as 好 / 嗯 / ok / 👍 / 是的 " +
      "even right after Houge saved or proposed something, an answer to a question Houge asked, or a message about " +
      "Houge's code or schedules."],
    ["status",
      "`latest_message` asks whether Houge restarted, which build or code is live, or whether it is running normally; " +
      "nothing else."],
    ["memory",
      "`latest_message` tells Houge how to behave from now on, states something about the user to remember, or corrects " +
      "something Houge believes. Signals: 以后 / 从现在起 / 记住 / 不要再 / 别再 / always / never / from now on / remember / " +
      "prefer, or a correction of Houge's previous reply in `recent_turns` that applies to future replies too."]
  ]
};

export const TRIAGE_COMPLETE: ChoiceQuestion = {
  id: "complete",
  type: "choice",
  instructions: "Does `latest_message` contain anything besides a preference, fact or correction for Houge to keep?",
  criteria: [
    ["mixed", "`latest_message` also asks something, requests work, or continues a task."],
    ["pure", "It contains only the preference, fact or correction; nothing asks a question, requests work, or expects more than a confirmation."]
  ]
};

export const TRIAGE_SCOPE: ChoiceQuestion = {
  id: "scope",
  type: "choice",
  instructions: "If `latest_message` is a preference or correction, which part of Houge's behaviour is it about?",
  criteria: [
    ["ask", "How Houge replies in conversation: length, tone, language, format, what to include or leave out."],
    ["research", "How Houge searches, which sources it trusts, or how it cites and reports what it found."]
  ]
};

export const TRIAGE_QUESTIONS: readonly Question[] = [TRIAGE_LANE, TRIAGE_COMPLETE, TRIAGE_SCOPE];


export type LastHougeTurn = { kind: "clarify" | "answer"; age_s: number } | null;

/** The last assistant turn before `nowMs`; `intent === "clarify"` is the stored clarify mark (turn-context.ts assistantIntentFor). */
export function lastHougeTurnOf(recent: ChatTurnRow[], nowMs: number): LastHougeTurn {
  const last = [...recent].reverse().find((t) => t.role === "assistant");
  if (!last) return null;
  const age = Math.round((nowMs - Date.parse(last.created_at)) / 1000);
  return { kind: last.intent === "clarify" ? "clarify" : "answer", age_s: Number.isFinite(age) ? Math.max(0, age) : 0 };
}

export interface TriageStateInput { userText: string; recentTurns: ChatTurnRow[]; turnChars: number; modality: TurnModality; lastHougeTurn: LastHougeTurn }
export type TriageStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };

/** Same envelope as the intent shadow (2026-09-25 approval) plus `last_houge_turn`; every text field sanitised; skip, never truncate. */
export function buildTriageState(i: TriageStateInput, brokerRedact?: (s: string) => string): TriageStateResult {
  if (i.userText.length > MAX_LATEST_MESSAGE_CHARS) return { ok: false, skip: "state_too_large" };
  const state: Record<string, unknown> = {
    modality: i.modality,
    latest_message: sanitizeJevText(i.userText, brokerRedact),
    recent_turns: i.recentTurns.map((t) => ({ role: t.role === "user" ? "user" : "houge", text: sanitizeJevText(feedTurnText(t.text, i.turnChars), brokerRedact) })),
    last_houge_turn: i.lastHougeTurn
  };
  const chars = JSON.stringify({ state, questions: TRIAGE_QUESTIONS.map(toJevQuestion) }).length;
  if (chars > MAX_REQUEST_CHARS) return { ok: false, skip: "state_too_large" };
  return { ok: true, state, chars };
}
