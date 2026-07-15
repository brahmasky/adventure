import type { TaskEventType } from "../domain/types.js";

export type TelegramCommand =
  | { type: "turn"; goal: string }
  | { type: "run"; program: string; goal: string }
  | { type: "status"; run_id?: string }
  | { type: "lessons"; scope?: string }
  | { type: "skills"; scope?: string }
  | { type: "forget"; scope: string }
  | { type: "schedule_admin"; action: "list" }
  | { type: "schedule_admin"; action: "cancel"; schedule_id: string }
  | { type: "approve"; approval_id: string }
  | { type: "deny"; approval_id: string };

export type TelegramCommandParseResult =
  | { ok: true; command: TelegramCommand }
  | { ok: false; error: { code: "TELEGRAM_COMMAND_INVALID" | "TELEGRAM_COMMAND_UNSUPPORTED"; message: string } };

export function parseTelegramCommand(text: string): TelegramCommandParseResult {
  const trimmed = text.trim();
  if (!trimmed) return invalid("Telegram message is empty");

  // Natural-language front door (ADR 0010): any message that is NOT a known control
  // command becomes a `turn` run, carrying the text verbatim. The worker classifies
  // intent (answer/research/clarify) on the LLM chain — no command prefix required.
  if (!trimmed.startsWith("/")) return { ok: true, command: { type: "turn", goal: trimmed } };

  const firstSpace = trimmed.search(/\s/);
  const rawCommand = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const command = rawCommand.split("@")[0] ?? "";

  // Structured commands tokenize with shell-style quoting.
  const words = splitShellWords(trimmed);
  if (!words.ok) return words;
  const rest = words.words.slice(1);

  if (command === "/run") return parseRun(rest);
  if (command === "/status") return parseStatus(rest);
  if (command === "/lessons") return parseLessons(rest);
  if (command === "/skills") return parseSkills(rest);
  if (command === "/forget") return parseForget(rest);
  if (command === "/schedule") return parseSchedule(rest);
  if (command === "/approve") return requiredApproval("approve", rest);
  if (command === "/deny") return requiredApproval("deny", rest);
  // Unknown slash-prefixed text is NOT a control command — treat it as natural
  // language (a `turn`), carrying the text verbatim, rather than rejecting it.
  return { ok: true, command: { type: "turn", goal: trimmed } };
}

function parseRun(words: string[]): TelegramCommandParseResult {
  const [program, ...goalWords] = words;
  const goal = goalWords.join(" ").trim();
  if (!program) return invalid("/run requires a program");
  if (!goal) return invalid("/run requires a goal");
  return { ok: true, command: { type: "run", program, goal } };
}

function parseStatus(words: string[]): TelegramCommandParseResult {
  if (words.length === 0) return { ok: true, command: { type: "status" } };
  if (words.length > 1) return invalid("/status requires at most one run id");
  const run_id = words[0];
  return run_id ? { ok: true, command: { type: "status", run_id } } : { ok: true, command: { type: "status" } };
}

function parseLessons(words: string[]): TelegramCommandParseResult {
  if (words.length === 0) return { ok: true, command: { type: "lessons" } };
  if (words.length > 1) return invalid("/lessons requires at most one scope");
  const scope = words[0];
  return scope
    ? { ok: true, command: { type: "lessons", scope } }
    : { ok: true, command: { type: "lessons" } };
}

function parseSkills(words: string[]): TelegramCommandParseResult {
  if (words.length === 0) return { ok: true, command: { type: "skills" } };
  if (words.length > 1) return invalid("/skills requires at most one scope");
  const scope = words[0];
  return scope
    ? { ok: true, command: { type: "skills", scope } }
    : { ok: true, command: { type: "skills" } };
}

function parseForget(words: string[]): TelegramCommandParseResult {
  if (words.length === 0) return invalid("/forget requires a scope");
  if (words.length > 1) return invalid("/forget requires exactly one scope");
  return { ok: true, command: { type: "forget", scope: words[0]! } };
}

/** `/schedule` (bare) lists this chat's schedules; `/schedule cancel <id>` disables one. */
function parseSchedule(words: string[]): TelegramCommandParseResult {
  if (words.length === 0) return { ok: true, command: { type: "schedule_admin", action: "list" } };
  if (words[0] === "cancel") {
    const schedule_id = words[1];
    if (words.length !== 2 || !schedule_id) return invalid("/schedule cancel requires exactly one schedule id");
    return { ok: true, command: { type: "schedule_admin", action: "cancel", schedule_id } };
  }
  return invalid("/schedule takes no arguments, or: /schedule cancel <schedule_id>");
}

function requiredApproval(type: Extract<TaskEventType, "approve" | "deny">, words: string[]): TelegramCommandParseResult {
  const [approval_id] = words;
  if (words.length > 1) return invalid(`/${type} requires exactly one approval id`);
  return approval_id ? { ok: true, command: { type, approval_id } } : invalid(`/${type} requires an approval id`);
}

function invalid(message: string): TelegramCommandParseResult {
  return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message } };
}

/**
 * Self-write inline-button actions (Phase 3.3). A callback button's `callback_data`
 * follows the convention `selfwrite:<action>:<run-id>` where action ∈ view|merge|discard.
 */
export type SelfWriteCallbackAction = "view" | "merge" | "discard";

export interface SelfWriteCallback {
  action: SelfWriteCallbackAction;
  runId: string;
}

const SELF_WRITE_CALLBACK_ACTIONS: ReadonlySet<string> = new Set(["view", "merge", "discard"]);

/**
 * Parse a Telegram `callback_data` string of the form `selfwrite:<action>:<run-id>`.
 * Tolerant: returns `null` for anything that is not a well-formed self-write callback
 * (wrong prefix, unknown action, missing/empty run id) so an unrelated callback is
 * simply ignored rather than misrouted.
 */
export function parseSelfWriteCallback(data: unknown): SelfWriteCallback | null {
  if (typeof data !== "string") return null;
  // Split into exactly three parts; the run id may itself contain no `:` (run ids
  // are token-shaped, e.g. `run_x`). Anything with extra colons is rejected.
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, action, runId] = parts;
  if (prefix !== "selfwrite") return null;
  if (!action || !SELF_WRITE_CALLBACK_ACTIONS.has(action)) return null;
  if (!runId) return null;
  return { action: action as SelfWriteCallbackAction, runId };
}

type SplitShellWordsResult = { ok: true; words: string[] } | { ok: false; error: { code: "TELEGRAM_COMMAND_INVALID"; message: string } };

function splitShellWords(input: string): SplitShellWordsResult {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (const character of input) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  if (quote) return invalidSplit("Unterminated quote");
  if (current) words.push(current);
  return { ok: true, words };
}

function invalidSplit(message: string): SplitShellWordsResult {
  return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message } };
}
