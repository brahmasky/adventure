import { describe, expect, it } from "vitest";
import { TelegramNotificationAdapter } from "../../src/notifications/telegram-notification-adapter.js";
import type { TelegramSendMessageInput } from "../../src/telegram/telegram-client.js";

function dispatch(
  text: string,
  buttons?: Array<{ text: string; data: string }>
): Parameters<TelegramNotificationAdapter["send"]>[0] {
  return {
    notification_id: "ntf_1",
    target: { kind: "telegram", chat_id: "222" },
    intent_type: "final_report",
    idempotency_key: "run_1:final",
    payload: { text, ...(buttons ? { buttons } : {}) },
    state: "sending",
    attempt_count: 1,
    provider_message_id: null
  };
}

describe("TelegramNotificationAdapter", () => {
  it("sends converted text with parse_mode HTML through the client boundary", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        return { message_id: 88 };
      }
    });

    await expect(adapter.send(dispatch("Report **ready**"))).resolves.toEqual({
      provider_message_id: "telegram:88"
    });
    expect(sent).toEqual([{ chat_id: "222", text: "Report <b>ready</b>", parse_mode: "HTML" }]);
  });

  it("on a Telegram 400 (HTML parse failure), retries the original text as plain and still resolves", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        if (input.parse_mode === "HTML") {
          throw new Error("Telegram sendMessage failed: HTTP 400");
        }
        return { message_id: 99 };
      }
    });

    await expect(adapter.send(dispatch("Report **ready**"))).resolves.toEqual({
      provider_message_id: "telegram:99"
    });
    // First the HTML attempt, then the plain retry with the ORIGINAL (unconverted) text.
    expect(sent).toEqual([
      { chat_id: "222", text: "Report <b>ready</b>", parse_mode: "HTML" },
      { chat_id: "222", text: "Report **ready**" }
    ]);
  });

  it("renders an inline_keyboard reply_markup when buttons are present (Phase 3.3)", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        return { message_id: 5 };
      }
    });

    await adapter.send(
      dispatch("Self-write ready", [
        { text: "View diff", data: "selfwrite:view:run_x" },
        { text: "Merge & reload", data: "selfwrite:merge:run_x" },
        { text: "Discard", data: "selfwrite:discard:run_x" }
      ])
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "View diff", callback_data: "selfwrite:view:run_x" },
          { text: "Merge & reload", callback_data: "selfwrite:merge:run_x" },
          { text: "Discard", callback_data: "selfwrite:discard:run_x" }
        ]
      ]
    });
  });

  it("omits reply_markup entirely when no buttons (existing notifications unchanged)", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        return { message_id: 6 };
      }
    });

    await adapter.send(dispatch("plain report"));

    expect(sent).toHaveLength(1);
    expect("reply_markup" in (sent[0] ?? {})).toBe(false);
  });
});
