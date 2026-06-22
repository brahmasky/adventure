import { describe, expect, it } from "vitest";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";

describe("parseTelegramCommand", () => {
  it("parses run, status, approve, and deny control commands", () => {
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

  it("routes plain-language text to a turn, taking the message verbatim (ADR 0010)", () => {
    expect(parseTelegramCommand("what's new with Claude this week?")).toEqual({
      ok: true,
      command: { type: "turn", goal: "what's new with Claude this week?" }
    });
    expect(parseTelegramCommand("  hello there  ")).toEqual({
      ok: true,
      command: { type: "turn", goal: "hello there" }
    });
  });

  it("no longer parses /ask or /research — they become turns", () => {
    expect(parseTelegramCommand("/ask compare Pi and Hermes")).toEqual({
      ok: true,
      command: { type: "turn", goal: "/ask compare Pi and Hermes" }
    });
    expect(parseTelegramCommand("/research latest SpaceX news")).toEqual({
      ok: true,
      command: { type: "turn", goal: "/research latest SpaceX news" }
    });
  });

  it("routes unknown slash commands to a turn instead of rejecting", () => {
    expect(parseTelegramCommand("/foo bar")).toEqual({
      ok: true,
      command: { type: "turn", goal: "/foo bar" }
    });
  });

  it("rejects malformed control commands with missing arguments", () => {
    expect(parseTelegramCommand("/run research-brief")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/run requires a goal" }
    });
    expect(parseTelegramCommand("/forget")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/forget requires a scope" }
    });
  });

  it("parses /lessons (optional scope) and /forget <scope> control commands", () => {
    expect(parseTelegramCommand("/lessons")).toEqual({
      ok: true,
      command: { type: "lessons" }
    });
    expect(parseTelegramCommand("/lessons research")).toEqual({
      ok: true,
      command: { type: "lessons", scope: "research" }
    });
    expect(parseTelegramCommand("/lessons research extra")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/lessons requires at most one scope" }
    });
    expect(parseTelegramCommand("/forget research")).toEqual({
      ok: true,
      command: { type: "forget", scope: "research" }
    });
    expect(parseTelegramCommand("/forget research extra")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/forget requires exactly one scope" }
    });
  });

  it("parses /skills (optional scope) and rejects more than one scope", () => {
    expect(parseTelegramCommand("/skills")).toEqual({
      ok: true,
      command: { type: "skills" }
    });
    expect(parseTelegramCommand("/skills research")).toEqual({
      ok: true,
      command: { type: "skills", scope: "research" }
    });
    expect(parseTelegramCommand("/skills a b")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/skills requires at most one scope" }
    });
    // `/skills pending` rides the scope slot (handled specially by the gateway).
    expect(parseTelegramCommand("/skills pending")).toEqual({
      ok: true,
      command: { type: "skills", scope: "pending" }
    });
  });

  it("no longer parses /teach — it becomes a turn", () => {
    expect(parseTelegramCommand("/teach research: prefer filings")).toEqual({
      ok: true,
      command: { type: "turn", goal: "/teach research: prefer filings" }
    });
  });

  it("takes a turn message literally, including apostrophes and quotes", () => {
    expect(parseTelegramCommand("what's new with Houge's design?")).toEqual({
      ok: true,
      command: { type: "turn", goal: "what's new with Houge's design?" }
    });
    expect(parseTelegramCommand('say "hello" then stop')).toEqual({
      ok: true,
      command: { type: "turn", goal: 'say "hello" then stop' }
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
