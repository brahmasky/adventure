import { describe, expect, it } from "vitest";
import { parseTelegramCommand } from "../../src/triggers/telegram-command-parser.js";
import { isSelfWriteActionEvent, normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import type { TelegramAllowlist } from "../../src/domain/types.js";

const allowlist: TelegramAllowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};

describe("parser: /kill /disarm /rearm (ADR 0018)", () => {
  it("/kill parses as an explicit control command, with an optional free-text reason", () => {
    expect(parseTelegramCommand("/kill")).toEqual({ ok: true, command: { type: "kill" } });
    expect(parseTelegramCommand("/kill it went rogue")).toEqual({
      ok: true,
      command: { type: "kill", reason: "it went rogue" }
    });
    // @botname suffix strips like every other command
    expect(parseTelegramCommand("/kill@houge_bot")).toEqual({ ok: true, command: { type: "kill" } });
  });

  it("/disarm and /rearm take no arguments — extras are rejected, never half-applied", () => {
    expect(parseTelegramCommand("/disarm")).toEqual({ ok: true, command: { type: "disarm" } });
    expect(parseTelegramCommand("/rearm")).toEqual({ ok: true, command: { type: "rearm" } });
    expect(parseTelegramCommand("/disarm scheduler").ok).toBe(false);
    expect(parseTelegramCommand("/rearm now").ok).toBe(false);
  });

  it("NEAR-MISS slash text does NOT trigger a stop command — it routes to unknown_command, never kill", () => {
    // WHY: a typo'd stop command must NEVER be treated as `/kill`. Because /kill is an
    // explicit parser branch, `/killl` misses it and falls through — now to unknown_command
    // (the command-list reply), never to a `kill`. It is also never a model-interpreted turn
    // that could be coaxed into stopping the daemon: a stop command stays unforgeable.
    const nearMiss = parseTelegramCommand("/killl");
    expect(nearMiss).toEqual({ ok: true, command: { type: "unknown_command", attempted: "/killl" } });
  });
});

describe("adapter: unforgeability chain (auth precedes the kill event)", () => {
  function update(overrides: Record<string, unknown>) {
    return {
      update_id: 7,
      message: {
        message_id: 1,
        text: "/kill stop now",
        from: { id: 111 },
        chat: { id: 222 },
        ...overrides
      }
    };
  }

  it("an allowlisted /kill normalizes to a type:'kill' event with the reason riding goal", () => {
    const normalized = normalizeTelegramUpdate(update({}), allowlist);
    if (!normalized.ok) throw new Error("expected ok");
    if (isSelfWriteActionEvent(normalized.event)) throw new Error("expected a task event");
    expect(normalized.event.type).toBe("kill");
    expect(normalized.event.goal).toBe("stop now");
    expect(normalized.event.requested_by).toEqual({ kind: "user", id: "paco" });
  });

  it("a FORWARDED /kill is denied — a forward could smuggle someone else's kill into the chat", () => {
    const normalized = normalizeTelegramUpdate(update({ forward_date: 1234567 }), allowlist);
    expect(normalized).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });

  it("a non-allowlisted sender's /kill is denied", () => {
    const normalized = normalizeTelegramUpdate(update({ from: { id: 999 } }), allowlist);
    expect(normalized).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });
});
