import type { TelegramSendClient } from "../telegram/telegram-client.js";
import type {
  NotificationAdapter,
  NotificationDispatchRecord,
  NotificationSendResult
} from "./notification-types.js";

export class TelegramNotificationAdapter implements NotificationAdapter {
  constructor(private readonly client: TelegramSendClient) {}

  async send(notification: NotificationDispatchRecord): Promise<NotificationSendResult> {
    if (notification.target.kind !== "telegram") {
      throw new Error(`TelegramNotificationAdapter cannot send to target: ${notification.target.kind}`);
    }

    const sent = await this.client.sendMessage({
      chat_id: notification.target.chat_id,
      text: notification.payload.text
    });

    return { provider_message_id: `telegram:${sent.message_id}` };
  }
}
