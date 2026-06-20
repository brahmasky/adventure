import type { TaskEventType } from "../domain/types.js";

export type TelegramCommand =
  | { type: "turn"; goal: string }
  | { type: "run"; program: string; goal: string }
  | { type: "status"; run_id?: string }
  | { type: "lessons"; scope?: string }
  | { type: "forget"; scope: string }
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
  if (command === "/forget") return parseForget(rest);
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

function parseForget(words: string[]): TelegramCommandParseResult {
  if (words.length === 0) return invalid("/forget requires a scope");
  if (words.length > 1) return invalid("/forget requires exactly one scope");
  return { ok: true, command: { type: "forget", scope: words[0]! } };
}

function requiredApproval(type: Extract<TaskEventType, "approve" | "deny">, words: string[]): TelegramCommandParseResult {
  const [approval_id] = words;
  if (words.length > 1) return invalid(`/${type} requires exactly one approval id`);
  return approval_id ? { ok: true, command: { type, approval_id } } : invalid(`/${type} requires an approval id`);
}

function invalid(message: string): TelegramCommandParseResult {
  return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message } };
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
