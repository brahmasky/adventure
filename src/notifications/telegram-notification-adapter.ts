import { markdownToTelegramHtml } from "../telegram/markdown-to-telegram-html.js";
import type {
  TelegramInlineKeyboardMarkup,
  TelegramSendClient
} from "../telegram/telegram-client.js";
import type {
  NotificationAdapter,
  NotificationButton,
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
    // Inline keyboard (Phase 3.3). Omitted entirely when no buttons → byte-identical
    // to a button-less send (no reply_markup field).
    const reply_markup = toReplyMarkup(notification.payload.buttons);

    // The model emits CommonMark; render it as Telegram HTML so `**bold**` etc. don't
    // show up literally (ADR 0010 fix). If Telegram rejects the HTML (entity parse
    // failure / HTTP 400), retry the ORIGINAL text with no parse_mode so a message is
    // never dropped. Buttons ride both attempts.
    try {
      const sent = await this.client.sendMessage({
        chat_id,
        text: markdownToTelegramHtml(raw),
        parse_mode: "HTML",
        ...(reply_markup ? { reply_markup } : {})
      });
      return { provider_message_id: `telegram:${sent.message_id}` };
    } catch {
      const sent = await this.client.sendMessage({
        chat_id,
        text: raw,
        ...(reply_markup ? { reply_markup } : {})
      });
      return { provider_message_id: `telegram:${sent.message_id}` };
    }
  }
}

/**
 * Render notification buttons as a Telegram inline keyboard (one row). Returns
 * `undefined` when there are no buttons so the caller omits `reply_markup` and a
 * button-less notification stays byte-identical to before.
 */
function toReplyMarkup(buttons?: NotificationButton[]): TelegramInlineKeyboardMarkup | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: [buttons.map((button) => ({ text: button.text, callback_data: button.data }))]
  };
}
