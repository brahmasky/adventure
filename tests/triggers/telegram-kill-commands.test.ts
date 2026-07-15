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

  it("NEAR-MISS slash text still falls through to a natural-language turn — proving the stop commands exist only as explicit branches", () => {
    // WHY: an unknown slash command becomes a `turn` the MODEL interprets. If /kill were
    // not an explicit parser branch it would ride that path — a stop command re-interpreted
    // by an LLM is forgeable. The near-miss shows the fallthrough is alive right next to it.
    const nearMiss = parseTelegramCommand("/killl");
    expect(nearMiss).toEqual({ ok: true, command: { type: "turn", goal: "/killl" } });
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
