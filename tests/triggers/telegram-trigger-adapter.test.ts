import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

const allowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "paco-private", allowed_identity_ids: ["paco"] }]
};

describe("normalizeTelegramUpdate", () => {
  it("normalizes /ask into a telegram TypedTaskEvent", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1000,
        message: { message_id: 55, text: "/ask what is Houge?", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({
        source: "telegram",
        type: "ask",
        program: "ask",
        goal: "what is Houge?",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:1000:55"
      });
    }
  });

  it("normalizes /approve without creating a program", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1001,
        message: { message_id: 56, text: "/approve appr_1", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("approve");
      expect(result.event.approval_id).toBe("appr_1");
      expect(result.event.program).toBeUndefined();
    }
  });
});
