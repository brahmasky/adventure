import type { TaskEventType } from "../domain/types.js";

export type TelegramCommand =
  | { type: "ask"; goal: string }
  | { type: "run"; program: string; goal: string }
  | { type: "status"; run_id?: string }
  | { type: "approve"; approval_id: string }
  | { type: "deny"; approval_id: string };

export type TelegramCommandParseResult =
  | { ok: true; command: TelegramCommand }
  | { ok: false; error: { code: "TELEGRAM_COMMAND_INVALID" | "TELEGRAM_COMMAND_UNSUPPORTED"; message: string } };

export function parseTelegramCommand(text: string): TelegramCommandParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return invalid("Telegram command must start with /");

  const firstSpace = trimmed.search(/\s/);
  const rawCommand = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const command = rawCommand.split("@")[0] ?? "";

  // /ask carries a free-text question — take the remainder literally so normal
  // punctuation (apostrophes in "what's", quotes) is not shell-tokenized.
  if (command === "/ask") {
    const goal = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
    return goal ? { ok: true, command: { type: "ask", goal } } : invalid("/ask requires a question");
  }

  // /research <topic> — free-text topic taken literally (like /ask); it's sugar
  // for the `web-research` run program (Tier-1 web read, ADR 0006).
  if (command === "/research") {
    const goal = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
    return goal
      ? { ok: true, command: { type: "run", program: "web-research", goal } }
      : invalid("/research requires a topic");
  }

  // Structured commands tokenize with shell-style quoting.
  const words = splitShellWords(trimmed);
  if (!words.ok) return words;
  const rest = words.words.slice(1);

  if (command === "/run") return parseRun(rest);
  if (command === "/status") return parseStatus(rest);
  if (command === "/approve") return requiredApproval("approve", rest);
  if (command === "/deny") return requiredApproval("deny", rest);
  return { ok: false, error: { code: "TELEGRAM_COMMAND_UNSUPPORTED", message: `Unsupported command: ${command}` } };
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
