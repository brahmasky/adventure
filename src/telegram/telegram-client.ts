/** A single inline button: visible `text` + the `callback_data` sent back on tap. */
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

/** Telegram `reply_markup` inline keyboard: rows of buttons. */
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramSendMessageInput {
  chat_id: string;
  text: string;
  /** Telegram parse mode (e.g. "HTML"). Omitted → plain text. */
  parse_mode?: string;
  /** Optional inline keyboard (Phase 3.3). Omitted → no buttons (byte-identical to before). */
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramSendMessageResult {
  message_id: number;
}

export interface TelegramSendDocumentInput {
  chat_id: string;
  /** Filename shown in the chat (e.g. `run_42.patch`). */
  filename: string;
  /** File content, uploaded as a text attachment. */
  content: string;
  caption?: string;
}

export interface TelegramAnswerCallbackQueryInput {
  callback_query_id: string;
  /** Optional toast shown to the user; omitted → just stops the spinner. */
  text?: string;
}

export interface TelegramEditMessageReplyMarkupInput {
  chat_id: string;
  message_id: number;
  /** New inline keyboard; omitted → removes the buttons entirely. */
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramGetUpdatesInput {
  offset: number;
  timeout_seconds: number;
  /**
   * Update types to receive (Phase 3.3). Telegram omits `callback_query` from the
   * default subscription, so it must be listed explicitly for inline-button taps to
   * be delivered. Serialized as a JSON array in the query string.
   */
  allowed_updates?: string[];
  /**
   * Optional abort signal. The daemon passes one so a graceful shutdown can
   * cancel an idle long-poll immediately instead of waiting out the timeout.
   */
  signal?: AbortSignal;
}

export interface TelegramRawUpdate {
  update_id: number;
  [key: string]: unknown;
}

/**
 * Minimal client boundary for sending Telegram messages. Production uses the
 * real Bot API over fetch; tests inject a fake `sendMessage` so no live network
 * is ever required.
 */
export interface TelegramSendClient {
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult>;
  /**
   * Stop the inline-button spinner (Phase 3.3). Optional on the boundary so existing
   * test fakes that only send messages still satisfy the interface; the real client
   * and the self-write action module (M3/M4) use it.
   */
  answerCallbackQuery?(input: TelegramAnswerCallbackQueryInput): Promise<void>;
  /** Replace/remove a message's inline keyboard (Phase 3.3) — e.g. to disable buttons after an action. */
  editMessageReplyMarkup?(input: TelegramEditMessageReplyMarkupInput): Promise<void>;
}

/**
 * Read side of the bot boundary used by the long-polling adapter. Tests inject
 * a fake `getUpdates`; production uses the real bot API.
 */
export interface TelegramPollClient {
  getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramRawUpdate[]>;
}

export interface TelegramClientOptions {
  token: string;
  /**
   * Host base for the Telegram API (e.g. `https://api.telegram.org`). The
   * client appends `/bot<token>` before the method name.
   */
  apiBaseUrl?: string;
  /**
   * Fully-qualified bot base URL (e.g. `https://host/bot<token>`). When
   * provided, the method name is appended directly with no `/bot<token>`
   * prefix. Takes precedence over `apiBaseUrl`.
   */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class TelegramClient implements TelegramSendClient, TelegramPollClient {
  private readonly token: string;
  private readonly botBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramClientOptions) {
    this.token = options.token;
    this.botBaseUrl = options.apiBase
      ? options.apiBase
      : `${options.apiBaseUrl ?? "https://api.telegram.org"}/bot${options.token}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult> {
    if (!this.token) {
      throw new Error("Telegram bot token is not configured");
    }

    const response = await this.fetchImpl(`${this.botBaseUrl}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // disable_web_page_preview cuts the outbound exfil leg (ADR 0006): a URL in
      // an answer (e.g. from untrusted web content) must not trigger an auto-fetch
      // link preview.
      body: JSON.stringify({
        chat_id: input.chat_id,
        text: input.text,
        disable_web_page_preview: true,
        ...(input.parse_mode ? { parse_mode: input.parse_mode } : {}),
        ...(input.reply_markup ? { reply_markup: input.reply_markup } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };
    if (!body.ok || !body.result) {
      throw new Error(`Telegram sendMessage failed: ${body.description ?? "unknown error"}`);
    }

    return { message_id: body.result.message_id };
  }

  async getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramRawUpdate[]> {
    if (!this.token) {
      throw new Error("Telegram bot token is not configured");
    }

    const allowedUpdatesParam = input.allowed_updates
      ? `&allowed_updates=${encodeURIComponent(JSON.stringify(input.allowed_updates))}`
      : "";
    const url = `${this.botBaseUrl}/getUpdates?offset=${input.offset}&timeout=${input.timeout_seconds}${allowedUpdatesParam}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      ...(input.signal ? { signal: input.signal } : {})
    });

    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      ok: boolean;
      result?: TelegramRawUpdate[];
      description?: string;
    };
    if (!body.ok || !body.result) {
      throw new Error(`Telegram getUpdates failed: ${body.description ?? "unknown error"}`);
    }

    return body.result;
  }

  async sendDocument(input: TelegramSendDocumentInput): Promise<void> {
    if (!this.token) {
      throw new Error("Telegram bot token is not configured");
    }

    // Bot API sendDocument requires multipart/form-data for an uploaded file — Node's
    // built-in FormData/Blob handle the encoding (fetch sets the boundary header).
    const form = new FormData();
    form.append("chat_id", input.chat_id);
    if (input.caption) form.append("caption", input.caption);
    form.append("document", new Blob([input.content], { type: "text/plain" }), input.filename);

    const response = await this.fetchImpl(`${this.botBaseUrl}/sendDocument`, {
      method: "POST",
      body: form
    });

    if (!response.ok) {
      throw new Error(`Telegram sendDocument failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as { ok: boolean; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram sendDocument failed: ${body.description ?? "unknown error"}`);
    }
  }

  async answerCallbackQuery(input: TelegramAnswerCallbackQueryInput): Promise<void> {
    if (!this.token) {
      throw new Error("Telegram bot token is not configured");
    }

    const response = await this.fetchImpl(`${this.botBaseUrl}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: input.callback_query_id,
        ...(input.text ? { text: input.text } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram answerCallbackQuery failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as { ok: boolean; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram answerCallbackQuery failed: ${body.description ?? "unknown error"}`);
    }
  }

  async editMessageReplyMarkup(input: TelegramEditMessageReplyMarkupInput): Promise<void> {
    if (!this.token) {
      throw new Error("Telegram bot token is not configured");
    }

    const response = await this.fetchImpl(`${this.botBaseUrl}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chat_id,
        message_id: input.message_id,
        // Telegram clears the keyboard when reply_markup is an empty inline_keyboard.
        reply_markup: input.reply_markup ?? { inline_keyboard: [] }
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram editMessageReplyMarkup failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as { ok: boolean; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram editMessageReplyMarkup failed: ${body.description ?? "unknown error"}`);
    }
  }
}
