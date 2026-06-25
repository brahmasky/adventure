import { describe, expect, it } from "vitest";
import type { TypedTaskEvent } from "../../src/domain/types.js";
import {
  isSelfWriteActionEvent,
  normalizeTelegramUpdate,
  type TelegramNormalizeResult
} from "../../src/triggers/telegram-trigger-adapter.js";

/** Narrow a normalize result to a message-path TypedTaskEvent (asserts ok + not a callback). */
function taskEvent(result: TelegramNormalizeResult): TypedTaskEvent {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok result");
  expect(isSelfWriteActionEvent(result.event)).toBe(false);
  if (isSelfWriteActionEvent(result.event)) throw new Error("expected a task event, got a selfwrite_action");
  return result.event;
}

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

    const event = taskEvent(result);
    expect(event).toMatchObject({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "what is Houge?",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:1000:55"
    });
    // No reply hint when the message was not a reply.
    expect((event.metadata as Record<string, unknown>).reply_to_message_id).toBeUndefined();
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

    const event = taskEvent(result);
    expect(event.type).toBe("turn");
    expect(event.metadata).toMatchObject({
      telegram_update_id: 1010,
      telegram_message_id: 70,
      reply_to_message_id: 42
    });
  });

  it("still no longer produces ask/research events from /ask or /research", () => {
    const ask = normalizeTelegramUpdate(
      { update_id: 1011, message: { message_id: 71, text: "/ask hi", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    const askEvent = taskEvent(ask);
    expect(askEvent.type).toBe("turn");
    expect(askEvent.goal).toBe("/ask hi");

    const research = normalizeTelegramUpdate(
      { update_id: 1012, message: { message_id: 72, text: "/research x", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    const researchEvent = taskEvent(research);
    expect(researchEvent.type).toBe("turn");
    expect(researchEvent.program).toBe("turn");
  });

  it("normalizes /approve without creating a program", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1001,
        message: { message_id: 56, text: "/approve appr_1", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );

    const event = taskEvent(result);
    expect(event.type).toBe("approve");
    expect(event.approval_id).toBe("appr_1");
    expect(event.program).toBeUndefined();
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

    const event = taskEvent(result);
    expect(event.type).toBe("status");
    expect(event.program).toBeUndefined();
    expect(event.metadata).toEqual({
      telegram_update_id: 1003,
      telegram_message_id: 58,
      run_id: "run_123"
    });
  });

  it("normalizes /deny without creating a program", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1004,
        message: { message_id: 59, text: "/deny appr_2", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );

    const event = taskEvent(result);
    expect(event.type).toBe("deny");
    expect(event.approval_id).toBe("appr_2");
    expect(event.program).toBeUndefined();
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

  it("normalizes an allowlisted callback_query into a selfwrite_action event (Phase 3.3)", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 2000,
        callback_query: {
          id: "cbq_1",
          from: { id: 111 },
          message: { message_id: 90, chat: { id: 222 } },
          data: "selfwrite:merge:run_x"
        }
      },
      allowlist
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isSelfWriteActionEvent(result.event)).toBe(true);
      expect(result.event).toMatchObject({
        type: "selfwrite_action",
        action: "merge",
        runId: "run_x",
        callback_id: "cbq_1",
        chat_id: "222",
        message_id: 90,
        from: { kind: "user", id: "paco" },
        source_reference: "telegram:update:2000:callback:cbq_1",
        idempotency_key: "telegram:2000:callback:cbq_1"
      });
    }
  });

  it("REJECTS a callback_query from a non-allowlisted user (no actionable event)", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 2001,
        callback_query: {
          id: "cbq_2",
          from: { id: 999 },
          message: { message_id: 91, chat: { id: 222 } },
          data: "selfwrite:merge:run_x"
        }
      },
      allowlist
    );

    expect(result).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
    expect(result.ok).toBe(false);
  });

  it("rejects a callback_query whose chat is not allowlisted", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 2002,
        callback_query: {
          id: "cbq_3",
          from: { id: 111 },
          message: { message_id: 92, chat: { id: 999 } },
          data: "selfwrite:merge:run_x"
        }
      },
      allowlist
    );
    expect(result).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
  });

  it("rejects an allowlisted callback_query with unrecognized callback data", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 2003,
        callback_query: {
          id: "cbq_4",
          from: { id: 111 },
          message: { message_id: 93, chat: { id: 222 } },
          data: "garbage"
        }
      },
      allowlist
    );
    expect(result).toMatchObject({ ok: false, error: { code: "TELEGRAM_COMMAND_INVALID" } });
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
