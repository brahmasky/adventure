import { feedTurnText } from "../../capabilities/intent.js";
import type { TurnModality } from "../../media/media-config.js";
import type { ChatTurnRow } from "../../run/run-store.js";
import { sanitizeJevText } from "../egress-redact.js";
import { MAX_LATEST_MESSAGE_CHARS, MAX_REQUEST_CHARS } from "../intent-question.js";
import { toJevQuestion, type ChoiceQuestion, type NoulQuestion, type Question, type ScoreQuestion } from "./types.js";

/**
 * The decision tree's six questions (spec 2026-10-06 §2.3), frozen. Wording follows mu's measured rules: one predicate
 * per question, state fields in backticks, no "and/or", an escape option on every choice. jev-1.13 leans toward the
 * first option, so `category` lists the fall-through option (`other` → the planner on Default, today's path) first and
 * the two no-planner lanes (`status`, `memory`) last. Changing a word or the order changes the criteria hash (types.ts)
 * and un-arms the question until Paco commits a new calibration row.
 */
export const CATEGORIES = ["answer", "lookup", "research", "memory", "self_change", "machine_task", "schedule", "wiki",
  "mail_calendar", "status", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

const HOUGE = "Houge is the AI agent in this conversation; \"Houge\", \"猴哥\", \"you\" and \"your\" mean Houge. ";
const THREAD = "`recent_turns` is the conversation before `latest_message`, oldest first. `quoted_turn`, when not null, is " +
  "the earlier message `latest_message` replies to. ";
/** The offered-work clause (spec §2.2.1): a bare "好" quoting an hour-old proposal is judged as that proposal's work. */
const OFFERED = "If `latest_message` only agrees to, picks or continues something Houge offered in `quoted_turn` or " +
  "`recent_turns`, answer for that offered work.";

export const TREE_CATEGORY: ChoiceQuestion = {
  id: "category",
  type: "choice",
  instructions: `${HOUGE}${THREAD}What work does \`latest_message\` ask Houge to do? ${OFFERED}`,
  criteria: [
    ["other", "None of the other options fits the work `latest_message` asks for."],
    ["self_change", "Change or diagnose Houge itself: its code, its behaviour, its configuration."],
    ["machine_task", "Work on the Mac: shell commands, files, a project on disk."],
    ["schedule", "Create, change or cancel a scheduled job or a reminder."],
    ["mail_calendar", "Read, search, write or change Gmail messages or Google Calendar events."],
    ["wiki", "Build or refine a wiki page."],
    ["research", "Investigate a topic: several sources, compared, with a conclusion or a recommendation."],
    ["lookup", "One fact or one item that a web search answers."],
    ["answer", "Chat, an explanation, an opinion or a piece of writing; nothing to fetch, nothing to do."],
    ["status", "Houge's own state: whether it restarted, which version is live, whether it is healthy."],
    ["memory", "A rule or preference for Houge to follow from now on, or a correction or retirement of a lesson or fact Houge stored."]
  ]
};

export const TREE_SETS_RULE: NoulQuestion = {
  id: "sets_rule",
  type: "noul",
  instructions: `${HOUGE}Does \`latest_message\` state a rule for Houge to follow from now on?`,
  criteria: {
    true: "`latest_message` states how Houge should behave in later turns too, not only in this reply.",
    false: "`latest_message` asks for something in this turn only, corrects one stored fact, or states no rule."
  }
};

export const TREE_RULE_SCOPE: ChoiceQuestion = {
  id: "rule_scope",
  type: "choice",
  instructions: `${HOUGE}Is the rule in \`latest_message\` about how Houge answers, or about how Houge researches?`,
  criteria: [
    ["ask", "How Houge answers: length, tone, language, format, what to include or leave out."],
    ["research", "How Houge researches: how it searches, which sources it trusts, how it cites what it found."]
  ]
};

export const TREE_BREADTH: ScoreQuestion = {
  id: "breadth",
  type: "score",
  instructions: `${HOUGE}${THREAD}How much ground does \`latest_message\` cover? ${OFFERED}`,
  levels: ["one known thing", "one topic", "several topics", "open-ended"]
};

export const TREE_REASONING: ScoreQuestion = {
  id: "reasoning",
  type: "score",
  instructions: `${HOUGE}${THREAD}How much careful reasoning does answering \`latest_message\` need? ${OFFERED}`,
  levels: ["recall", "straightforward", "non-obvious analysis", "deep multi-factor"]
};

export const TREE_ACTIONS: ScoreQuestion = {
  id: "actions",
  type: "score",
  instructions: `${HOUGE}${THREAD}How many tool actions does doing what \`latest_message\` asks need? ${OFFERED}`,
  levels: ["none", "one or two reads", "several including changes", "many with checks"]
};

export const TREE_QUESTIONS: readonly Question[] = [TREE_CATEGORY, TREE_SETS_RULE, TREE_RULE_SCOPE, TREE_BREADTH, TREE_REASONING, TREE_ACTIONS];

export type HougeTurnKind = "answer" | "clarify" | "proposal";
export type LastHougeTurn = { kind: HougeTurnKind; age_s: number } | null;

/** An offer in Houge's own words (spec §2.2): 要不要 / 我可以 / 需要我 / approve (the approval card's verb). */
const OFFER = /要不要|我可以|需要我|\bapprove\b|\bwant me to\b|\bshall i\b|\bshould i\b|\bwould you like me to\b/i;
/** The trailing-question shape turn-context.ts assistantIntentFor uses for a clarify (closing quotes and brackets allowed). */
const TRAILING_QUESTION = /[?？][\s"'”」）)]*$/;

export function isProposal(text: string): boolean {
  return OFFER.test(text);
}

/**
 * Read-time kind of a stored Houge reply (spec §2.2; the stored `intent` enum is not widened). An offer in the text is a
 * proposal, even on a row stored as `clarify` ("要不要我直接查？" offers work: an agreeing "好" must read as taking it).
 * Then the stored clarify mark. Then a trailing question on a `loop` row (assistantIntentFor stores `loop` for every
 * reply that used a tool) is a proposal: a question after a tool run offers the next step. Everything else answers.
 */
function hougeTurnKind(t: ChatTurnRow): HougeTurnKind {
  if (isProposal(t.text)) return "proposal";
  if (t.intent === "clarify") return "clarify";
  if (t.intent === "loop" && TRAILING_QUESTION.test(t.text.trim())) return "proposal";
  return "answer";
}

function ageSeconds(created_at: string, nowMs: number): number {
  const age = Math.round((nowMs - Date.parse(created_at)) / 1000);
  return Number.isFinite(age) ? Math.max(0, age) : 0;
}

/** The last assistant turn before `nowMs`, with its read-time kind and age. One rule for live, the quote and the replay. */
export function lastHougeTurnOf(recent: ChatTurnRow[], nowMs: number): LastHougeTurn {
  const last = [...recent].reverse().find((t) => t.role === "assistant");
  return last ? { kind: hougeTurnKind(last), age_s: ageSeconds(last.created_at, nowMs) } : null;
}

/**
 * A quoted stored turn as the tree's state reads it (spec §2.2.1). ONE builder for the live decision point (Task 10) and
 * the replay (Task 12): a second copy would give every quoted turn a different `state_hash` in the replay.
 * A Houge row gets its read-time kind; a user row has no Houge kind, so "answer", the neutral value the type needs.
 */
export function quotedTurnFromRow(row: ChatTurnRow, nowMs: number): QuotedTurn {
  const houge = row.role === "assistant";
  return { role: houge ? "houge" : "user", kind: houge ? hougeTurnKind(row) : "answer", age_s: ageSeconds(row.created_at, nowMs), text: row.text };
}

export interface QuotedTurn { role: "houge" | "user"; kind: HougeTurnKind; age_s: number; text: string }
export interface TreeStateInput {
  userText: string; recentTurns: ChatTurnRow[]; turnChars: number; modality: TurnModality;
  lastHougeTurn: LastHougeTurn; quotedTurn: QuotedTurn | null;
}
export type TreeStateResult = { ok: true; state: Record<string, unknown>; chars: number } | { ok: false; skip: "state_too_large" };

/**
 * Lane 1's egress envelope (2026-09-25 approval) plus `quoted_turn`: every text field through `feedTurnText` (thread and
 * quote only), `sanitizeJevText` and the broker's redactor; the quote counts toward the request cap. Skip, never truncate.
 */
export function buildTreeState(i: TreeStateInput, brokerRedact?: (s: string) => string): TreeStateResult {
  if (i.userText.length > MAX_LATEST_MESSAGE_CHARS) return { ok: false, skip: "state_too_large" };
  const text = (t: string): string => sanitizeJevText(feedTurnText(t, i.turnChars), brokerRedact);
  const q = i.quotedTurn;
  const state: Record<string, unknown> = {
    modality: i.modality,
    latest_message: sanitizeJevText(i.userText, brokerRedact),
    recent_turns: i.recentTurns.map((t) => ({ role: t.role === "user" ? "user" : "houge", text: text(t.text) })),
    last_houge_turn: i.lastHougeTurn,
    quoted_turn: q ? { role: q.role, kind: q.kind, age_s: q.age_s, text: text(q.text) } : null
  };
  const chars = JSON.stringify({ state, questions: TREE_QUESTIONS.map(toJevQuestion) }).length;
  if (chars > MAX_REQUEST_CHARS) return { ok: false, skip: "state_too_large" };
  return { ok: true, state, chars };
}
