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

  it("routes removed /ask and /research to unknown_command events, not turns", () => {
    const ask = normalizeTelegramUpdate(
      { update_id: 1011, message: { message_id: 71, text: "/ask hi", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    const askEvent = taskEvent(ask);
    expect(askEvent.type).toBe("unknown_command");
    // The attempted command word rides `program` for the help reply.
    expect(askEvent.program).toBe("/ask");

    const research = normalizeTelegramUpdate(
      { update_id: 1012, message: { message_id: 72, text: "/research x", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    const researchEvent = taskEvent(research);
    expect(researchEvent.type).toBe("unknown_command");
    expect(researchEvent.program).toBe("/research");
  });

  it("round-trips /usage and /help through buildTelegramEvent", () => {
    const usage = normalizeTelegramUpdate(
      { update_id: 1013, message: { message_id: 73, text: "/usage", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    expect(taskEvent(usage).type).toBe("usage");

    const help = normalizeTelegramUpdate(
      { update_id: 1014, message: { message_id: 74, text: "/help", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    expect(taskEvent(help).type).toBe("help");

    const radar = normalizeTelegramUpdate(
      { update_id: 1015, message: { message_id: 75, text: "/radar", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    expect(taskEvent(radar).type).toBe("radar");

    // The merged shortlist surfaces ride the pre-merge `idea` event shape (silent alias).
    const week = normalizeTelegramUpdate(
      { update_id: 1016, message: { message_id: 76, text: "/radar week", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    expect(taskEvent(week).type).toBe("idea");
    expect(taskEvent(week).metadata).toMatchObject({ idea_action: "show" });

    const pick = normalizeTelegramUpdate(
      { update_id: 1017, message: { message_id: 77, text: "/radar pick 2", from: { id: 111 }, chat: { id: 222 } } },
      allowlist
    );
    expect(taskEvent(pick).type).toBe("idea");
    expect(taskEvent(pick).metadata).toMatchObject({ idea_action: "pick", idea_number: 2 });
  });

  it("normalizes a /skills lifecycle command with '<action> <name>' riding program", () => {
    const retire = normalizeTelegramUpdate(
      {
        update_id: 1018,
        message: { message_id: 78, text: "/skills retire old-skill", from: { id: 111 }, chat: { id: 222 } }
      },
      allowlist
    );
    const event = taskEvent(retire);
    expect(event.type).toBe("skills");
    expect(event.program).toBe("retire old-skill");
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

  it("normalizes /schedule into schedule_admin: action on program, cancel id in metadata (B10b)", () => {
    const list = taskEvent(
      normalizeTelegramUpdate(
        {
          update_id: 1010,
          message: { message_id: 70, text: "/schedule", from: { id: 111 }, chat: { id: 222 } }
        },
        allowlist
      )
    );
    expect(list.type).toBe("schedule_admin");
    expect(list.program).toBe("list");
    expect(list.metadata).toEqual({ telegram_update_id: 1010, telegram_message_id: 70 });

    const cancel = taskEvent(
      normalizeTelegramUpdate(
        {
          update_id: 1011,
          message: { message_id: 71, text: "/schedule cancel sch_abc", from: { id: 111 }, chat: { id: 222 } }
        },
        allowlist
      )
    );
    expect(cancel.type).toBe("schedule_admin");
    expect(cancel.program).toBe("cancel");
    expect(cancel.metadata).toEqual({
      telegram_update_id: 1011,
      telegram_message_id: 71,
      schedule_id: "sch_abc"
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

  it("normalizes a captioned photo into a turn event with goal = caption (no .text)", () => {
    // The operator sent a PHOTO with the question in the caption. Telegram puts it in
    // `.caption`, not `.text`. It must be answered exactly like a text message.
    const result = normalizeTelegramUpdate(
      {
        update_id: 1020,
        message: {
          message_id: 80,
          caption: "这是什么？",
          photo: [{ file_id: "f1", file_unique_id: "u1", width: 90, height: 90 }],
          from: { id: 111 },
          chat: { id: 222 }
        }
      },
      allowlist
    );

    const event = taskEvent(result);
    expect(event).toMatchObject({
      source: "telegram",
      type: "turn",
      program: "turn",
      goal: "这是什么？",
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "telegram", chat_id: "222" },
      idempotency_key: "telegram:1020:80"
    });
  });

  it("acknowledges (does not ghost) a truly text-less message: bare photo, no caption", () => {
    const result = normalizeTelegramUpdate(
      {
        update_id: 1021,
        message: {
          message_id: 81,
          photo: [{ file_id: "f2", file_unique_id: "u2", width: 90, height: 90 }],
          from: { id: 111 },
          chat: { id: 222 }
        }
      },
      allowlist
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a skip result");
    expect(result.error.code).toBe("TELEGRAM_UNSUPPORTED_MEDIA");
    // The sender gets a one-line reply instead of silence.
    expect(result.acknowledgement).toBeDefined();
    expect(result.acknowledgement?.chat_id).toBe("222");
    expect(result.acknowledgement?.text).toContain("非文字消息");
    expect(result.acknowledgement?.idempotency_key).toBe("telegram:1021:unsupported_media");
  });

  it("AUTH FLOOR: a non-allowlisted sender's text-less message is denied, with NO acknowledgement", () => {
    // Auth must run before the media check so we never reply to (or leak existence to) a
    // stranger who sends a bare photo.
    const result = normalizeTelegramUpdate(
      {
        update_id: 1022,
        message: {
          message_id: 82,
          photo: [{ file_id: "f3", file_unique_id: "u3", width: 90, height: 90 }],
          from: { id: 999 },
          chat: { id: 222 }
        }
      },
      allowlist
    );

    expect(result).toMatchObject({ ok: false, error: { code: "TELEGRAM_AUTH_DENIED" } });
    if (result.ok) throw new Error("expected a skip result");
    expect(result.acknowledgement).toBeUndefined();
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
