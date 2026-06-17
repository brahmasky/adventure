import { describe, expect, it } from "vitest";
import { authorizeTelegramUpdate } from "../../src/triggers/telegram-auth.js";

const allowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "paco-private", allowed_identity_ids: ["paco"] }]
};

describe("authorizeTelegramUpdate", () => {
  it("authorizes only matching user and chat", () => {
    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 222 }, allowlist)).toEqual({
      ok: true,
      identity: { kind: "user", id: "paco" }
    });
  });

  it("rejects unknown users, unknown chats, forwards, channels, and anonymous admins", () => {
    expect(authorizeTelegramUpdate({ from_id: 999, chat_id: 222 }, allowlist).ok).toBe(false);
    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 999 }, allowlist).ok).toBe(false);
    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 222, is_forwarded: true }, allowlist).ok).toBe(false);
    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 222, is_channel_post: true }, allowlist).ok).toBe(false);
    expect(authorizeTelegramUpdate({ from_id: undefined, chat_id: 222 }, allowlist).ok).toBe(false);
  });

  it("rejects a known user in a known chat when the pair is not allowlisted", () => {
    const splitAllowlist = {
      users: [{ telegram_user_id: 111, identity_id: "paco" }],
      chats: [{ telegram_chat_id: 333, label: "other-team", allowed_identity_ids: ["ada"] }]
    };

    expect(authorizeTelegramUpdate({ from_id: 111, chat_id: 333 }, splitAllowlist)).toEqual({
      ok: false,
      error: { code: "TELEGRAM_AUTH_DENIED", message: "Telegram identity is not allowlisted for this chat" }
    });
  });
});
