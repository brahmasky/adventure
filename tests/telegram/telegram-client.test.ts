import { describe, expect, it } from "vitest";
import { TelegramClient } from "../../src/telegram/telegram-client.js";

describe("TelegramClient", () => {
  it("uses fetch for sendMessage and getUpdates", async () => {
    const calls: string[] = [];
    const client = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async (url, init) => {
        calls.push(`${url} ${init?.body ?? ""}`);
        if (String(url).includes("getUpdates")) return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
      }
    });

    await expect(client.sendMessage({ chat_id: "222", text: "hello" })).resolves.toEqual({ message_id: 77 });
    await expect(client.getUpdates({ offset: 12, timeout_seconds: 1 })).resolves.toEqual([]);
    expect(calls.some((call) => call.includes("/sendMessage"))).toBe(true);
    expect(calls.some((call) => call.includes("/getUpdates?offset=12"))).toBe(true);
  });
});
