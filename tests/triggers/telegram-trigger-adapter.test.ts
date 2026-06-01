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

  it("normalizes /run with source reference and Telegram metadata", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1002,
        message: { message_id: 57, text: "/run research-brief compare gateways", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({
        source: "telegram",
        type: "run",
        program: "research-brief",
        goal: "compare gateways",
        source_reference: "telegram:update:1002:message:57",
        metadata: { telegram_update_id: 1002, telegram_message_id: 57 }
      });
    }
  });

  it("normalizes /status with a run id in metadata", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1003,
        message: { message_id: 58, text: "/status run_123", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("status");
      expect(result.event.program).toBeUndefined();
      expect(result.event.metadata).toEqual({
        telegram_update_id: 1003,
        telegram_message_id: 58,
        run_id: "run_123"
      });
    }
  });

  it("normalizes /deny without creating a program", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1004,
        message: { message_id: 59, text: "/deny appr_2", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("deny");
      expect(result.event.approval_id).toBe("appr_2");
      expect(result.event.program).toBeUndefined();
    }
  });

  it("rejects unauthorized Telegram messages before command normalization", () => {
    expect(
      normalizeTelegramUpdate(
        {
          update_id: 1005,
          message: { message_id: 60, text: "/approve appr_1", from: { id: 999 }, chat: { id: 222 } }
        },
        allowlist
      )
    ).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });

    expect(
      normalizeTelegramUpdate(
        {
          update_id: 1006,
          message: { message_id: 61, text: "/approve appr_1", from: { id: 111 }, chat: { id: 999 } }
        },
        allowlist
      )
    ).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });

  it("rejects Telegram messages with forward_origin as forwarded commands", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1007,
        message: {
          message_id: 62,
          text: "/approve appr_1",
          forward_origin: { type: "user" },
          from: { id: 111 },
          chat: { id: 222 }
        }
      },
      allowlist
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "TELEGRAM_AUTH_DENIED", message: "Forwarded commands are not accepted" }
    });
  });
});
