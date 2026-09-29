import { feedTurnText, type Intent } from "../capabilities/intent.js";
import type { TurnModality } from "../media/media-config.js";
import type { ChatTurnRow } from "../run/run-store.js";
import type { JevChoiceQuestion, JevRequest } from "./jev-client.js";

/**
 * The Jev twin of the LLM intent classifier (Jev spec 2026-09-25). Same inputs as
 * `buildIntentQuestion`, so a disagreement measures the model, not input drift. Criteria are
 * rewritten from INTENT_DISCIPLINE in literal, boundary-explicit wording — jev-1.13 reads literally.
 */
export const JEV_INTENTS: readonly Intent[] = ["answer", "research", "feedback", "clarify", "selfcode", "skill"];
export const MAX_LATEST_MESSAGE_CHARS = 8_000;
export const MAX_REQUEST_CHARS = 24_000;

export const JEV_INTENT_QUESTION: JevChoiceQuestion = {
  type: "choice",
  instructions:
    "How should Houge handle `latest_message`? Houge is the AI agent in this conversation; " +
    "\"Houge\", \"猴哥\", \"you\" and \"your\" in the messages all mean Houge. `recent_turns` is the " +
    "conversation before `latest_message`, oldest first. If `already_asked_clarification` is true, " +
    "Houge just asked a clarifying question and `latest_message` is the user's reply to it.",
  criteria: {
    answer:
      "Houge can answer from general knowledge, with no live web lookup. This includes requests to " +
      "explain, analyse or write something when no current information is needed.",
    research:
      "Answering needs current or live information from the web: current events, news, prices, " +
      "\"latest\", anything time-sensitive, or an explicit request to look up, find or research a topic.",
    feedback:
      "`latest_message` reacts to or corrects Houge's previous answer in `recent_turns` (for example " +
      "\"too long\", \"that's wrong\", \"prefer primary sources\") instead of asking a new question.",
    clarify:
      "`latest_message` is so ambiguous or underspecified that Houge cannot act without first asking " +
      "one question. Never this option when `already_asked_clarification` is true.",
    selfcode:
      "Asks Houge to read, inspect, diagnose, fix or change Houge's own source code or internal behaviour.",
    skill:
      "Explicitly asks Houge to create, write, improve or refine a reusable skill or procedure, or to " +
      "retire, restore, deactivate or re-enable (退役/停用/恢复/启用) an existing skill. Asking Houge to " +
      "PERFORM a task is not this option, even when a matching skill exists."
  }
};

export type Lang = "zh" | "en" | "mixed";

const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN_WORD = /[A-Za-z]+/g;

/** Language tag for the per-language report split. One CJK char ≈ one latin word. */
export function langOf(text: string): Lang {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.match(LATIN_WORD)?.length ?? 0;
  if (cjk + latin === 0) return "en";
  const share = cjk / (cjk + latin);
  if (share >= 0.7) return "zh";
  if (share <= 0.2) return "en";
  return "mixed";
}

export type JevIntentRequest = { ok: true; request: JevRequest; chars: number } | { ok: false; skip: "state_too_large" };

export function buildJevIntentRequest(
  message: string,
  recentTurns: ChatTurnRow[],
  turnChars: number,
  recentClarifyCount: number,
  modality: TurnModality = "text"
): JevIntentRequest {
  if (message.length > MAX_LATEST_MESSAGE_CHARS) return { ok: false, skip: "state_too_large" };
  const request: JevRequest = {
    state: {
      modality,
      latest_message: message,
      recent_turns: recentTurns.map((t) => ({ role: t.role === "user" ? "user" : "houge", text: feedTurnText(t.text, turnChars) })),
      already_asked_clarification: recentClarifyCount > 0
    },
    questions: { intent: JEV_INTENT_QUESTION }
  };
  const chars = JSON.stringify(request).length;
  if (chars > MAX_REQUEST_CHARS) return { ok: false, skip: "state_too_large" };
  return { ok: true, request, chars };
}
