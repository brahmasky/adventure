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

  it("parses /research as a web-research run, taking the topic literally", () => {
    expect(parseTelegramCommand("/research what's new with Claude this week?")).toEqual({
      ok: true,
      command: { type: "run", program: "web-research", goal: "what's new with Claude this week?" }
    });
    expect(parseTelegramCommand("/research")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/research requires a topic" }
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

  it("takes the /ask question literally, including apostrophes and quotes", () => {
    expect(parseTelegramCommand("/ask what's new with Houge's design?")).toEqual({
      ok: true,
      command: { type: "ask", goal: "what's new with Houge's design?" }
    });
    expect(parseTelegramCommand('/ask say "hello" then stop')).toEqual({
      ok: true,
      command: { type: "ask", goal: 'say "hello" then stop' }
    });
    expect(parseTelegramCommand("/ask@hougebot don't break on a mention")).toEqual({
      ok: true,
      command: { type: "ask", goal: "don't break on a mention" }
    });
  });

  it("rejects malformed quoted input", () => {
    expect(parseTelegramCommand('/run research-brief "compare gateway designs')).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "Unterminated quote" }
    });
  });

  it("rejects extra tokens for single-id commands", () => {
    expect(parseTelegramCommand("/approve appr_abc please")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/approve requires exactly one approval id" }
    });
    expect(parseTelegramCommand("/deny appr_abc please")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/deny requires exactly one approval id" }
    });
    expect(parseTelegramCommand("/status run_123 extra")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/status requires at most one run id" }
    });
  });

  it("covers no-argument command branches", () => {
    expect(parseTelegramCommand("/ask")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/ask requires a question" }
    });
    expect(parseTelegramCommand("/approve")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/approve requires an approval id" }
    });
    expect(parseTelegramCommand("/deny")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/deny requires an approval id" }
    });
    expect(parseTelegramCommand("/status")).toEqual({
      ok: true,
      command: { type: "status" }
    });
  });
});
