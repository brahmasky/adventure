import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate } from "../../src/triggers/telegram-trigger-adapter.js";

const allowlist = {
  users: [{ telegram_user_id: 111, identity_id: "paco" }],
  chats: [{ telegram_chat_id: 222, label: "paco-private", allowed_identity_ids: ["paco"] }]
};

describe("normalizeTelegramUpdate", () => {
  it("normalizes plain-language text into a turn TypedTaskEvent (ADR 0010)", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1000,
        message: { message_id: 55, text: "what is Houge?", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({
        source: "telegram",
        type: "turn",
        program: "turn",
        goal: "what is Houge?",
        requested_by: { kind: "user", id: "paco" },
        notify: { kind: "telegram", chat_id: "222" },
        idempotency_key: "telegram:1000:55"
      });
      // No reply hint when the message was not a reply.
      expect((result.event.metadata as Record<string, unknown>).reply_to_message_id).toBeUndefined();
    }
  });

  it("carries the reply_to_message_id hint when the message is a reply", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1010,
        message: {
          message_id: 70,
          text: "too long",
          reply_to_message: { message_id: 42 },
          from: { id: 111 },
          chat: { id: 222 }
        }
      },
      allowlist
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("turn");
      expect(result.event.metadata).toMatchObject({
        telegram_update_id: 1010,
        telegram_message_id: 70,
        reply_to_message_id: 42
      });
    }
  });

  it("still no longer produces ask/research events from /ask or /research", () => {
    const ask = normalizeTelegramUpdate(
      { update_id: 1011, message: { message_id: 71, text: "/ask hi", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    expect(ask.ok).toBe(true);
    if (ask.ok) {
      expect(ask.event.type).toBe("turn");
      expect(ask.event.goal).toBe("/ask hi");
    }

    const research = normalizeTelegramUpdate(
      { update_id: 1012, message: { message_id: 72, text: "/research x", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    expect(research.ok).toBe(true);
    if (research.ok) {
      expect(research.event.type).toBe("turn");
      expect(research.event.program).toBe("turn");
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
