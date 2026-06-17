import { describe, expect, it } from "vitest";
import { TelegramNotificationAdapter } from "../../src/notifications/telegram-notification-adapter.js";

describe("TelegramNotificationAdapter", () => {
  it("sends telegram notification text through the client boundary", async () => {
    const sent: unknown[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        return { message_id: 88 };
      }
    });

    await expect(adapter.send({
      notification_id: "ntf_1",
      target: { kind: "telegram", chat_id: "222" },
      intent_type: "final_report",
      idempotency_key: "run_1:final",
      payload: { text: "Report ready" },
      state: "sending",
      attempt_count: 1,
      provider_message_id: null
    })).resolves.toEqual({ provider_message_id: "telegram:88" });
    expect(sent).toEqual([{ chat_id: "222", text: "Report ready" }]);
  });
});
