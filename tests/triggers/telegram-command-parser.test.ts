import { describe, expect, it } from "vitest";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";

describe("parseTelegramCommand", () => {
  it("parses ask, run, status, approve, and deny", () => {
    expect(parseTelegramCommand("/ask compare Pi and Hermes")).toEqual({
      ok: true,
      command: { type: "ask", goal: "compare Pi and Hermes" }
    });
    expect(parseTelegramCommand('/run research-brief "compare gateway designs"')).toEqual({
      ok: true,
      command: { type: "run", program: "research-brief", goal: "compare gateway designs" }
    });
    expect(parseTelegramCommand("/status run_123")).toEqual({
      ok: true,
      command: { type: "status", run_id: "run_123" }
    });
    expect(parseTelegramCommand("/approve appr_abc")).toEqual({
      ok: true,
      command: { type: "approve", approval_id: "appr_abc" }
    });
    expect(parseTelegramCommand("/deny appr_abc")).toEqual({
      ok: true,
      command: { type: "deny", approval_id: "appr_abc" }
    });
  });

  it("rejects non-command text, unsupported commands, and missing arguments", () => {
    expect(parseTelegramCommand("hello")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "Telegram command must start with /" }
    });
    expect(parseTelegramCommand("/teach remember this")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_UNSUPPORTED", message: "Unsupported command: /teach" }
    });
    expect(parseTelegramCommand("/run research-brief")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/run requires a goal" }
    });
  });
});
