import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { verifiedWorkspace } from "../omp/workspace.js";
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

/** omp turn attachments (spec §7): at most 5 files, each at most 20 MB, re-checked at send time. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export type AttachmentRefusal =
  | "outside_workspace" | "not_a_file" | "too_large" | "over_count" | "unreadable" | "send_failed" | "unsupported" | "linked" | "changed";
const REFUSAL_TEXT: Record<AttachmentRefusal, string> = {
  outside_workspace: "outside my workspace", not_a_file: "not a regular file", too_large: "over 20 MB",
  over_count: "more than 5 files", unreadable: "could not be read", send_failed: "Telegram refused the upload", unsupported: "this chat cannot take files",
  linked: "a hard-linked file", changed: "it changed while I was sending it"
};
/** The one follow-up line per file that was not sent. Code-owned; exported so tests assert against it. */
export function attachmentRefusedLine(name: string, why: AttachmentRefusal): string {
  return `⚠ Not attached: ${name} (${REFUSAL_TEXT[why]})`;
}

export interface TelegramNotificationAdapterOptions {
  /** The chat's omp workspace; an attachment must resolve (realpath) inside it. Absent → every attachment is refused. */
  workspaceFor?: (chat_id: string) => string;
  /** @internal Tests only: runs between opening the file and re-checking its path (simulates a swap in that window). */
  beforeRecheckForTest?: (path: string) => void;
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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
      await this.sendAttachments(chat_id, attachments.filter((a): a is string => typeof a === "string"));
    }
    return sent;
  }

  /**
   * Attachments go after the text. Each is re-checked NOW (the planner's workspace may have changed
   * since the reply): realpath inside the chat's workspace, a regular file, at most 20 MB, at most 5.
   * A failing file becomes one follow-up line, never a send. An upload failure never re-sends the text.
   */
  private async sendAttachments(chat_id: string, paths: string[]): Promise<void> {
    const refused: string[] = [];
    for (const [i, path] of paths.entries()) {
      const name = basename(path);
      const checked = i >= MAX_ATTACHMENTS ? "over_count" : this.readAttachment(chat_id, path);
      if (typeof checked === "string") { refused.push(attachmentRefusedLine(name, checked)); continue; }
      try {
        await this.client.sendDocument?.({ chat_id, filename: name, content: checked.bytes });
      } catch {
        refused.push(attachmentRefusedLine(name, "send_failed"));
      }
    }
    if (refused.length === 0) return;
    await this.sendText(chat_id, { payload: { text: refused.join("\n") } }).catch(() => undefined);
  }

  /**
   * Open once, then prove the open file is the one the path names inside the workspace: fstat the fd
   * (regular, ≤ 20 MB, a single link), re-resolve the path and require the same dev+ino with the
   * realpath inside the workspace, then read exactly the checked size from that fd. A swap anywhere
   * in the path between the open and the read can only make the check fail, never redirect the upload.
   */
  private readAttachment(chat_id: string, path: string): AttachmentRefusal | { bytes: Uint8Array } {
    if (!this.client.sendDocument) return "unsupported";
    const configured = this.options.workspaceFor?.(chat_id);
    const workspace = configured ? verifiedWorkspace(configured) : null; // a swapped workspace is no workspace (C2)
    if (!workspace) return "outside_workspace";
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); // a FIFO must never block the daemon's only thread
      const st = fstatSync(fd);
      if (!st.isFile()) return "not_a_file";
      if (st.size > MAX_ATTACHMENT_BYTES) return "too_large";
      if (st.nlink > 1) return "linked";
      this.options.beforeRecheckForTest?.(path);
      const real = realpathSync(path);
      if (!inside(workspace, real)) return "outside_workspace";
      const again = statSync(real);
      if (again.dev !== st.dev || again.ino !== st.ino) return "changed";
      return { bytes: readExactly(fd, st.size) };
    } catch {
      return "unreadable";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private async sendText(chat_id: string, notification: Pick<NotificationDispatchRecord, "payload">): Promise<NotificationSendResult> {
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

/** Read exactly `size` bytes from the start of `fd` (a short read means the file changed: refuse). */
function readExactly(fd: number, size: number): Uint8Array {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) throw new Error("short read");
    off += n;
  }
  return buf;
}
