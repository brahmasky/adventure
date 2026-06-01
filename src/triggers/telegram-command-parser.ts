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
  const [rawCommand, ...rest] = splitShellWords(trimmed);
  const command = rawCommand?.split("@")[0] ?? "";
  const args = rest.join(" ").trim();

  if (command === "/ask") return args ? { ok: true, command: { type: "ask", goal: args } } : invalid("/ask requires a question");
  if (command === "/run") return parseRun(rest);
  if (command === "/status") return args ? { ok: true, command: { type: "status", run_id: args } } : { ok: true, command: { type: "status" } };
  if (command === "/approve") return requiredApproval("approve", args);
  if (command === "/deny") return requiredApproval("deny", args);
  return { ok: false, error: { code: "TELEGRAM_COMMAND_UNSUPPORTED", message: `Unsupported command: ${command}` } };
}

function parseRun(words: string[]): TelegramCommandParseResult {
  const [program, ...goalWords] = words;
  const goal = goalWords.join(" ").trim();
  if (!program) return invalid("/run requires a program");
  if (!goal) return invalid("/run requires a goal");
  return { ok: true, command: { type: "run", program, goal } };
}

function requiredApproval(type: Extract<TaskEventType, "approve" | "deny">, approval_id: string): TelegramCommandParseResult {
  return approval_id ? { ok: true, command: { type, approval_id } } : invalid(`/${type} requires an approval id`);
}

function invalid(message: string): TelegramCommandParseResult {
  return { ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message } };
}

function splitShellWords(input: string): string[] {
  const matches = input.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}
