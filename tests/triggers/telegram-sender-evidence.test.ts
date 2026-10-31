import { describe, expect, it } from "vitest";
import { authorizeTelegramUpdate } from "../../src/triggers/telegram-auth.js";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";
import type { TelegramAllowlist } from "../../src/domain/types.js";

// Spec 2026-11-01 R2 §3.1 / Decision 3-A: telegram-auth.ts is protected, but the evidence it reads is built in the
// self-writable adapter. These pins fail if a self-write loosens how a forward, a channel post or a tap is derived.
const ALLOW: TelegramAllowlist = { users: [{ telegram_user_id: 111, identity_id: "paco" }, { telegram_user_id: 444, identity_id: "other" }],
  chats: [{ telegram_chat_id: 222, label: "p", allowed_identity_ids: ["paco"] }] };
const msg = (over: Record<string, unknown>) => ({ update_id: 1, message: { message_id: 1, text: "hi", from: { id: 111 }, chat: { id: 222 }, ...over } });
const tap = (from: number | undefined, chat = 222) => ({ update_id: 2, callback_query: { id: "c", data: "x", ...(from === undefined ? {} : { from: { id: from } }), message: { message_id: 3, chat: { id: chat } } } });
const denied = (reason: string, message: string) => ({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED", message }, reason });

describe("every sender denial carries its reason; messages unchanged", () => {
  it.each([
    ["channel post", { update_id: 5, channel_post: { message_id: 1, chat: { id: 222 } } }, denied("channel_post", "Channel posts are not accepted")],
    ["forward (forward_date)", msg({ forward_date: 1 }), denied("forwarded", "Forwarded commands are not accepted")],
    ["forward (forward_origin)", msg({ forward_origin: { type: "user" } }), denied("forwarded", "Forwarded commands are not accepted")],
    ["forward with a zero forward_date", msg({ forward_date: 0 }), denied("forwarded", "Forwarded commands are not accepted")],
    ["forward from a non-user origin (channel)", msg({ forward_origin: { type: "channel" } }), denied("forwarded", "Forwarded commands are not accepted")],
    ["channel post alongside a callback query (channel check precedes the tap branch)", { update_id: 6, channel_post: { message_id: 1, chat: { id: 222 } }, callback_query: { id: "c", data: "x", from: { id: 111 }, message: { message_id: 3, chat: { id: 222 } } } }, denied("channel_post", "Channel posts are not accepted")],
    ["a stranger's forward (precedence: forwarded)", msg({ from: { id: 999 }, forward_date: 1 }), denied("forwarded", "Forwarded commands are not accepted")],
    ["anonymous sender", msg({ from: undefined }), denied("anonymous", "Anonymous Telegram senders are not accepted")],
    ["stranger", msg({ from: { id: 999 } }), denied("user_not_allowlisted", "Telegram user is not allowlisted")],
    ["foreign chat", msg({ chat: { id: 333 } }), denied("chat_not_allowlisted", "Telegram chat is not allowlisted")],
    ["allowlisted user, wrong chat identity", msg({ from: { id: 444 } }), denied("identity_not_for_chat", "Telegram identity is not allowlisted for this chat")],
    ["stranger's tap", tap(999), denied("user_not_allowlisted", "Telegram user is not allowlisted")],
    ["anonymous tap", tap(undefined), denied("anonymous", "Anonymous Telegram senders are not accepted")],
    ["tap from a foreign chat", tap(111, 333), denied("chat_not_allowlisted", "Telegram chat is not allowlisted")],
    ["tap, wrong chat identity", tap(444), denied("identity_not_for_chat", "Telegram identity is not allowlisted for this chat")]
  ])("%s", (_label, update, expected) => {
    expect(normalizeTelegramUpdate(update as never, ALLOW)).toEqual(expected);
  });
  it("no_chat is reachable only at the auth seam (a real update always has message.chat)", () => {
    expect(authorizeTelegramUpdate({ from_id: 111 }, ALLOW)).toEqual(denied("no_chat", "Telegram chat id is required"));
  });
  it("an allowed sender carries no reason; a non-auth failure carries none", () => {
    expect(normalizeTelegramUpdate(msg({}) as never, ALLOW)).toMatchObject({ ok: true });
    const noMessage = normalizeTelegramUpdate({ update_id: 9, callback_query: { id: "c", data: "x", from: { id: 111 } } } as never, ALLOW);
    expect(noMessage).toEqual({ ok: false, error: { code: "TELEGRAM_COMMAND_INVALID", message: "Callback query is missing its message" } });
  });
});
