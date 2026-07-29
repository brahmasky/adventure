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

  it("parses /usage and /help as real control commands (no LLM turn)", () => {
    expect(parseTelegramCommand("/usage")).toEqual({ ok: true, command: { type: "usage" } });
    expect(parseTelegramCommand("/help")).toEqual({ ok: true, command: { type: "help" } });
    // The `@BotName` suffix is stripped before matching (group-chat mentions).
    expect(parseTelegramCommand("/usage@HougeBot")).toEqual({ ok: true, command: { type: "usage" } });
    expect(parseTelegramCommand("/help@HougeBot")).toEqual({ ok: true, command: { type: "help" } });
  });

  it("parses /radar as a real control command (Idea Radar R1 viewer)", () => {
    expect(parseTelegramCommand("/radar")).toEqual({ ok: true, command: { type: "radar" } });
    expect(parseTelegramCommand("/radar@HougeBot")).toEqual({ ok: true, command: { type: "radar" } });
  });

  it("parses /radar <n> as a detail request; anything non-ordinal is a named parse error (R2)", () => {
    expect(parseTelegramCommand("/radar 3")).toEqual({
      ok: true,
      command: { type: "radar", radar_number: 3 }
    });
    expect(parseTelegramCommand("/radar 12")).toEqual({
      ok: true,
      command: { type: "radar", radar_number: 12 }
    });
    // Quoted noise: shell-style tokenizing strips the quotes, the ordinal survives.
    expect(parseTelegramCommand('/radar "3"')).toEqual({
      ok: true,
      command: { type: "radar", radar_number: 3 }
    });
    const badArg = {
      ok: false,
      error: {
        code: "TELEGRAM_COMMAND_INVALID",
        message: "/radar 用法: /radar · /radar <编号> · /radar week · /radar pick <编号>"
      }
    };
    expect(parseTelegramCommand("/radar 0")).toEqual(badArg);
    expect(parseTelegramCommand("/radar -1")).toEqual(badArg);
    expect(parseTelegramCommand("/radar x")).toEqual(badArg);
    expect(parseTelegramCommand("/radar 1.5")).toEqual(badArg);
    expect(parseTelegramCommand("/radar 3 4")).toEqual(badArg);
  });

  it("parses /radar week and /radar pick <n> as the merged shortlist surfaces", () => {
    expect(parseTelegramCommand("/radar week")).toEqual({
      ok: true,
      command: { type: "idea", idea_action: "show" }
    });
    expect(parseTelegramCommand("/radar pick 2")).toEqual({
      ok: true,
      command: { type: "idea", idea_action: "pick", idea_number: 2 }
    });
    // Quoted noise: tokenizing strips the quotes, the rank survives.
    expect(parseTelegramCommand('/radar pick "2"')).toEqual({
      ok: true,
      command: { type: "idea", idea_action: "pick", idea_number: 2 }
    });
    const badPick = {
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/radar pick requires exactly one 编号" }
    };
    expect(parseTelegramCommand("/radar pick")).toEqual(badPick);
    expect(parseTelegramCommand("/radar pick 0")).toEqual(badPick);
    expect(parseTelegramCommand("/radar pick x")).toEqual(badPick);
    expect(parseTelegramCommand("/radar pick 2 3")).toEqual(badPick);
    // `week` takes nothing after it; an unknown subcommand names the whole family.
    const family = {
      ok: false,
      error: {
        code: "TELEGRAM_COMMAND_INVALID",
        message: "/radar 用法: /radar · /radar <编号> · /radar week · /radar pick <编号>"
      }
    };
    expect(parseTelegramCommand("/radar week 2")).toEqual(family);
    expect(parseTelegramCommand("/radar junk")).toEqual(family);
  });

  it("/idea and /idea pick <n> are silent aliases — byte-identical command shapes", () => {
    expect(parseTelegramCommand("/idea")).toEqual(parseTelegramCommand("/radar week"));
    expect(parseTelegramCommand("/idea pick 3")).toEqual(parseTelegramCommand("/radar pick 3"));
  });

  it("parses /idea (show) and /idea pick <n>; loose args are named parse errors (R2)", () => {
    expect(parseTelegramCommand("/idea")).toEqual({
      ok: true,
      command: { type: "idea", idea_action: "show" }
    });
    expect(parseTelegramCommand("/idea@HougeBot")).toEqual({
      ok: true,
      command: { type: "idea", idea_action: "show" }
    });
    expect(parseTelegramCommand("/idea pick 2")).toEqual({
      ok: true,
      command: { type: "idea", idea_action: "pick", idea_number: 2 }
    });
    // Quoted noise: tokenizing strips the quotes, the rank survives.
    expect(parseTelegramCommand('/idea pick "2"')).toEqual({
      ok: true,
      command: { type: "idea", idea_action: "pick", idea_number: 2 }
    });
    const badPick = {
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/idea pick requires exactly one 编号" }
    };
    expect(parseTelegramCommand("/idea pick")).toEqual(badPick);
    expect(parseTelegramCommand("/idea pick 0")).toEqual(badPick);
    expect(parseTelegramCommand("/idea pick x")).toEqual(badPick);
    expect(parseTelegramCommand("/idea pick 2 3")).toEqual(badPick);
    expect(parseTelegramCommand("/idea junk")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/idea takes no arguments, or: /idea pick <编号>" }
    });
  });

  it("routes a clean but unknown /command to unknown_command, not a hallucinated turn", () => {
    // A command-shaped first token (removed/typo'd command) → guide with the command list.
    expect(parseTelegramCommand("/nonsense")).toEqual({
      ok: true,
      command: { type: "unknown_command", attempted: "/nonsense" }
    });
    expect(parseTelegramCommand("/foo bar")).toEqual({
      ok: true,
      command: { type: "unknown_command", attempted: "/foo" }
    });
    // Removed commands (ADR 0010) are now unknown commands, not verbatim turns.
    expect(parseTelegramCommand("/ask compare Pi and Hermes")).toEqual({
      ok: true,
      command: { type: "unknown_command", attempted: "/ask" }
    });
    expect(parseTelegramCommand("/research latest SpaceX news")).toEqual({
      ok: true,
      command: { type: "unknown_command", attempted: "/research" }
    });
  });

  it("keeps slashy natural text (file paths) as a verbatim turn, not a command", () => {
    // Inner slashes/dots mean it is NOT a clean command word — preserve the message.
    expect(parseTelegramCommand("/usr/bin/foo is slow")).toEqual({
      ok: true,
      command: { type: "turn", goal: "/usr/bin/foo is slow" }
    });
    expect(parseTelegramCommand("/etc/hosts got edited")).toEqual({
      ok: true,
      command: { type: "turn", goal: "/etc/hosts got edited" }
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

  it("parses /skills retire|restore <name> lifecycle verbs and /skills retired as a scope", () => {
    expect(parseTelegramCommand("/skills retire old-skill")).toEqual({
      ok: true,
      command: { type: "skills", action: "retire", name: "old-skill" }
    });
    // A scope-qualified name rides through intact — the gateway's resolver splits it.
    expect(parseTelegramCommand("/skills restore research/old-skill")).toEqual({
      ok: true,
      command: { type: "skills", action: "restore", name: "research/old-skill" }
    });
    expect(parseTelegramCommand("/skills retire")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/skills retire requires exactly one skill name" }
    });
    expect(parseTelegramCommand("/skills retire a b")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/skills retire requires exactly one skill name" }
    });
    // `/skills retired` rides the scope slot (graveyard view — handled by the gateway).
    expect(parseTelegramCommand("/skills retired")).toEqual({
      ok: true,
      command: { type: "skills", scope: "retired" }
    });
  });

  it("parses /schedule (bare = list) and /schedule cancel <编号或 id> (B10b)", () => {
    expect(parseTelegramCommand("/schedule")).toEqual({
      ok: true,
      command: { type: "schedule_admin", action: "list" }
    });
    // Full id — backward compat: the arg passes through as a string, gateway matches exactly.
    expect(parseTelegramCommand("/schedule cancel sch_abc")).toEqual({
      ok: true,
      command: { type: "schedule_admin", action: "cancel", schedule_id: "sch_abc" }
    });
    // A list number rides through the SAME string field — the gateway resolves #N.
    expect(parseTelegramCommand("/schedule cancel 1")).toEqual({
      ok: true,
      command: { type: "schedule_admin", action: "cancel", schedule_id: "1" }
    });
    expect(parseTelegramCommand("/schedule cancel")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/schedule cancel requires exactly one 编号或 id" }
    });
    expect(parseTelegramCommand("/schedule cancel sch_a sch_b")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/schedule cancel requires exactly one 编号或 id" }
    });
    expect(parseTelegramCommand("/schedule list")).toEqual({
      ok: false,
      error: { code: "TELEGRAM_COMMAND_INVALID", message: "/schedule takes no arguments, or: /schedule cancel <编号或 id>" }
    });
  });

  it("no longer parses /teach — its clean command word routes to unknown_command", () => {
    expect(parseTelegramCommand("/teach research: prefer filings")).toEqual({
      ok: true,
      command: { type: "unknown_command", attempted: "/teach" }
    });
  });

  it("keeps the kill-switch/disarm commands slash-only (regression: not unknown_command)", () => {
    expect(parseTelegramCommand("/kill")).toEqual({ ok: true, command: { type: "kill" } });
    expect(parseTelegramCommand("/kill runaway loop")).toEqual({
      ok: true,
      command: { type: "kill", reason: "runaway loop" }
    });
    expect(parseTelegramCommand("/disarm")).toEqual({ ok: true, command: { type: "disarm" } });
    expect(parseTelegramCommand("/rearm")).toEqual({ ok: true, command: { type: "rearm" } });
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
