export interface TelegramSendMessageInput {
  chat_id: string;
  text: string;
  /** Telegram parse mode (e.g. "HTML"). Omitted → plain text. */
  parse_mode?: string;
}

export interface TelegramSendMessageResult {
  message_id: number;
}

export interface TelegramGetUpdatesInput {
  offset: number;
  timeout_seconds: number;
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
        ...(input.parse_mode ? { parse_mode: input.parse_mode } : {})
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

    const url = `${this.botBaseUrl}/getUpdates?offset=${input.offset}&timeout=${input.timeout_seconds}`;
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
}
