export interface TelegramSendMessageInput {
  chat_id: string;
  text: string;
}

export interface TelegramSendMessageResult {
  message_id: number;
}

/**
 * Minimal client boundary for sending Telegram messages. Production uses the
 * real Bot API over fetch; tests inject a fake `sendMessage` so no live network
 * is ever required.
 */
export interface TelegramSendClient {
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult>;
}

export interface TelegramClientOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class TelegramClient implements TelegramSendClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramClientOptions) {
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult> {
    if (!this.token) {
      throw new Error("Telegram bot token is not configured");
    }

    const response = await this.fetchImpl(`${this.apiBaseUrl}/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: input.chat_id, text: input.text })
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
}
