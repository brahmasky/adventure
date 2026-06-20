import { markdownToTelegramHtml } from "../telegram/markdown-to-telegram-html.js";
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

    const chat_id = notification.target.chat_id;
    const raw = notification.payload.text;

    // The model emits CommonMark; render it as Telegram HTML so `**bold**` etc. don't
    // show up literally (ADR 0010 fix). If Telegram rejects the HTML (entity parse
    // failure / HTTP 400), retry the ORIGINAL text with no parse_mode so a message is
    // never dropped.
    try {
      const sent = await this.client.sendMessage({
        chat_id,
        text: markdownToTelegramHtml(raw),
        parse_mode: "HTML"
      });
      return { provider_message_id: `telegram:${sent.message_id}` };
    } catch {
      const sent = await this.client.sendMessage({ chat_id, text: raw });
      return { provider_message_id: `telegram:${sent.message_id}` };
    }
  }
}
