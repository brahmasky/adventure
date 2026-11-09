import { basename } from "node:path";
import { markdownToTelegramHtml } from "../telegram/markdown-to-telegram-html.js";
import type {
  TelegramInlineButton,
  TelegramInlineKeyboardMarkup,
  TelegramSendClient
} from "../telegram/telegram-client.js";
import type {
  NotificationAdapter,
  NotificationButton,
  NotificationDispatchRecord,
  NotificationPayload,
  NotificationUrlButton,
  NotificationSendResult
} from "./notification-types.js";
import { checkAttachment, MAX_ATTACHMENTS, overCount, REFUSAL_TEXT, type AttachCheck, type AttachmentRefusal } from "./attachment-check.js";
export { checkAttachment, inside, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, overCount, REFUSAL_TEXT, type AttachCheck, type AttachmentRefusal, type CheckRefusal } from "./attachment-check.js";

/** The one follow-up line per file that was not sent. Code-owned; exported so tests assert against it. */
export function attachmentRefusedLine(name: string, why: AttachmentRefusal): string {
  return `⚠ Not attached: ${name} (${REFUSAL_TEXT[why]})`;
}

type AnyButton = NotificationButton | NotificationUrlButton;

export interface TelegramNotificationAdapterOptions {
  /** The chat's omp workspace; an attachment must resolve (realpath) inside it. Absent → every attachment is refused. */
  workspaceFor?: (chat_id: string) => string;
  /** @internal Tests only: runs between opening the file and re-checking its path (simulates a swap in that window). */
  beforeRecheckForTest?: (path: string) => void;
}

export class TelegramNotificationAdapter implements NotificationAdapter {
  constructor(private readonly client: TelegramSendClient, private readonly options: TelegramNotificationAdapterOptions = {}) {}

  async send(notification: NotificationDispatchRecord): Promise<NotificationSendResult> {
    if (notification.target.kind !== "telegram") {
      throw new Error(`TelegramNotificationAdapter cannot send to target: ${notification.target.kind}`);
    }
    const chat_id = notification.target.chat_id;
    const sent = await this.sendText(chat_id, notification);
    const attachments = notification.payload.attachments;
    if (Array.isArray(attachments) && attachments.length > 0) {
      const attach_checks = await this.sendAttachments(chat_id, attachments.filter((a): a is string => typeof a === "string"));
      return { ...sent, attach_checks }; // spec R7 §4.2: the checks the loop already made, enums only; the dispatcher records them after markDelivered
    }
    return sent;
  }

  /**
   * Attachments go after the text. Each is re-checked NOW (the planner's workspace may have changed
   * since the reply): realpath inside the chat's workspace, a regular file, at most 20 MB, at most 5.
   * A failing file becomes one follow-up line, never a send. An upload failure never re-sends the text.
   * Returns each check (spec R7 §4.2): the first five, then one over_count for the overflow.
   */
  private async sendAttachments(chat_id: string, paths: string[]): Promise<AttachCheck[]> {
    const refused: string[] = [];
    const checks: AttachCheck[] = [];
    for (const [i, path] of paths.entries()) {
      const name = basename(path);
      const checked = overCount(i) ? "over_count" : this.readAttachment(chat_id, path);
      if (i <= MAX_ATTACHMENTS) checks.push(typeof checked === "string" ? checked : "ok");
      if (typeof checked === "string") { refused.push(attachmentRefusedLine(name, checked)); continue; }
      try {
        await this.client.sendDocument?.({ chat_id, filename: name, content: checked.bytes });
      } catch {
        refused.push(attachmentRefusedLine(name, "send_failed"));
      }
    }
    if (refused.length === 0) return checks;
    await this.sendText(chat_id, { payload: { text: refused.join("\n") } }).catch(() => undefined);
    return checks;
  }

  /** The protected predicate (attachment-check.ts) over this chat's configured workspace. */
  private readAttachment(chat_id: string, path: string): ReturnType<typeof checkAttachment> {
    return checkAttachment(path, { canUpload: Boolean(this.client.sendDocument), workspace: () => this.options.workspaceFor?.(chat_id),
      ...(this.options.beforeRecheckForTest ? { beforeRecheck: this.options.beforeRecheckForTest } : {}) });
  }

  private async sendText(chat_id: string, notification: Pick<NotificationDispatchRecord, "payload">): Promise<NotificationSendResult> {
    const raw = notification.payload.text;
    // Inline keyboard (Phase 3.3). Omitted entirely when no buttons → byte-identical
    // to a button-less send (no reply_markup field).
    const reply_markup = toReplyMarkup(notification.payload);
    const silent = notification.payload.silent === true ? { disable_notification: true as const } : {};

    // The model emits CommonMark; render it as Telegram HTML so `**bold**` etc. don't
    // show up literally (ADR 0010 fix). If Telegram rejects the HTML (entity parse
    // failure / HTTP 400), retry the ORIGINAL text with no parse_mode so a message is
    // never dropped. Buttons ride both attempts.
    try {
      const sent = await this.client.sendMessage({
        chat_id,
        text: markdownToTelegramHtml(raw),
        parse_mode: "HTML",
        ...(reply_markup ? { reply_markup } : {}),
        ...silent
      });
      return { provider_message_id: `telegram:${sent.message_id}` };
    } catch {
      // Plain text shows markup literally: drop inline-code backticks so an approval id reads and copies clean.
      const sent = await this.client.sendMessage({
        chat_id,
        text: raw.replace(/`([^`\n]+)`/g, "$1"),
        ...(reply_markup ? { reply_markup } : {}),
        ...silent
      });
      return { provider_message_id: `telegram:${sent.message_id}` };
    }
  }
}

/**
 * Render notification buttons as a Telegram inline keyboard: `button_rows` as one row each when present and well formed,
 * else `buttons` as one row. Returns `undefined` when there are no buttons so the caller omits `reply_markup` and a
 * button-less notification stays byte-identical to before.
 */
function toReplyMarkup(payload: NotificationPayload): TelegramInlineKeyboardMarkup | undefined {
  const rows: AnyButton[][] | null = buttonRowsOf(payload.button_rows) ?? (payload.buttons && payload.buttons.length > 0 ? [payload.buttons] : null);
  if (!rows) return undefined;
  return { inline_keyboard: rows.map((row) => row.map(toInlineButton)) };
}

/** A string `url` makes a link button; anything else is a callback button (same predicate as `isButton`). */
function toInlineButton(button: AnyButton): TelegramInlineButton {
  const { url, data } = button as { url?: unknown; data?: unknown };
  return typeof url === "string" ? { text: button.text, url } : { text: button.text, callback_data: data as string };
}

/** Rows only when every row is a non-empty list of {text, data} or {text, url}; anything else falls back to `buttons` (the payload is stored JSON). */
function buttonRowsOf(v: unknown): AnyButton[][] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const ok = v.every((row) => Array.isArray(row) && row.length > 0
    && row.every(isButton));
  return ok ? (v as AnyButton[][]) : null;
}

function isButton(b: unknown): b is AnyButton {
  const x = b as { text?: unknown; data?: unknown; url?: unknown } | null;
  return typeof x?.text === "string" && (typeof x.data === "string" || typeof x.url === "string");
}
