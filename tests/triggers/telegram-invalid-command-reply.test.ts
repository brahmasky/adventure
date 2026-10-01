// tests/triggers/telegram-invalid-command-reply.test.ts
import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate, type TelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

// Live gate 2026-10-01: `/deny` with no id was recorded in skipped_telegram_updates and nothing came back, so the
// operator could not tell a malformed command from a lost one. An allowlisted sender's invalid command gets one
// code-owned reply (the parser's own message, never the user's text); a stranger gets nothing.
const ALLOWLIST = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "private", allowed_identity_ids: ["paco"] }]
};
const msg = (update_id: number, text: string, from = 111): TelegramUpdate =>
  ({ update_id, message: { message_id: update_id, text, from: { id: from }, chat: { id: 222 } } });

describe("an invalid command is answered, not ghosted", () => {
  it("`/deny` with no id: skipped as TELEGRAM_COMMAND_INVALID with a reply naming the problem", () => {
    const r = normalizeTelegramUpdate(msg(5, "/deny"), ALLOWLIST);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.error.code).toBe("TELEGRAM_COMMAND_INVALID");
    expect(r.acknowledgement).toEqual({ chat_id: "222", idempotency_key: "telegram:5:invalid_command",
      text: expect.stringContaining("/deny requires an approval id") });
    expect(r.acknowledgement?.text).toContain("/help");
  });

  it("never echoes the user's own words back", () => {
    const r = normalizeTelegramUpdate(msg(6, "/status run_1 my-private-words"), ALLOWLIST);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.acknowledgement?.text).toBeDefined();
    expect(r.acknowledgement?.text).not.toContain("my-private-words");
  });

  it("a non-allowlisted sender's invalid command gets no reply", () => {
    const r = normalizeTelegramUpdate(msg(7, "/deny", 999), ALLOWLIST);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.acknowledgement).toBeUndefined();
  });

  it("an unrecognized button callback is not a command and gets no reply", () => {
    const r = normalizeTelegramUpdate({ update_id: 8, callback_query: { id: "c", from: { id: 111 }, message: { message_id: 1, chat: { id: 222 } }, data: "junk" } }, ALLOWLIST);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.acknowledgement).toBeUndefined();
  });
});
