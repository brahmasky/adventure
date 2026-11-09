import { describe, expect, it } from "vitest";
import { TelegramNotificationAdapter } from "../../src/notifications/telegram-notification-adapter.js";
import type { NotificationPayload } from "../../src/notifications/notification-types.js";
import { TOPIC_ROUTE } from "../../src/notifications/topics.js";
import { TelegramClient, type TelegramSendMessageInput } from "../../src/telegram/telegram-client.js";

const URL_BTN = { text: "Open", url: "https://mail.google.com/mail/u/?authuser=a%40example.com#inbox/abc" };
const CB_BTN = { text: "Wrong urgency", data: "mail:wu:mi_1" };

function record(payload: NotificationPayload): Parameters<TelegramNotificationAdapter["send"]>[0] {
  return { notification_id: "ntf_1", target: { kind: "telegram", chat_id: "222" }, intent_type: "final_report",
    idempotency_key: "k", payload, state: "sending", attempt_count: 1, provider_message_id: null };
}

async function run(payload: NotificationPayload, failFirst = false): Promise<TelegramSendMessageInput[]> {
  const sent: TelegramSendMessageInput[] = [];
  const adapter = new TelegramNotificationAdapter({
    sendMessage: async (input) => {
      sent.push(input);
      if (failFirst && sent.length === 1) throw new Error("400 entity parse");
      return { message_id: 1 };
    }
  });
  await adapter.send(record(payload));
  return sent;
}

describe("silent sends and URL buttons", () => {
  const row = [{ text: "Open", url: URL_BTN.url }, { text: "Wrong urgency", callback_data: "mail:wu:mi_1" }];

  it("button_rows with a URL button and a callback button both reach inline_keyboard, silent on both attempts", async () => {
    const sent = await run({ text: "x", silent: true, button_rows: [[URL_BTN, CB_BTN]] }, true);
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s.disable_notification).toBe(true);
      expect(s.reply_markup?.inline_keyboard[0]).toEqual(row);
    }
  });

  it("button_rows holding only a URL button renders it", async () => {
    const [s] = await run({ text: "x", button_rows: [[URL_BTN]] });
    expect(s?.reply_markup?.inline_keyboard).toEqual([[{ text: "Open", url: URL_BTN.url }]]);
  });

  it("a button with data and a null url is a callback button", async () => {
    const [s] = await run({ text: "x", buttons: [{ ...CB_BTN, url: null } as never] });
    expect(s?.reply_markup?.inline_keyboard).toEqual([[{ text: "Wrong urgency", callback_data: "mail:wu:mi_1" }]]);
  });

  // Runtime tolerance only: flat `buttons` is typed callback-only, but stored JSON may carry a URL button.
  it("flat buttons with a URL button also render", async () => {
    const [s] = await run({ text: "x", silent: true, buttons: [URL_BTN, CB_BTN] as never });
    expect(s?.disable_notification).toBe(true);
    expect(s?.reply_markup?.inline_keyboard).toEqual([row]);
  });

  it("a payload without silent and with callback-only buttons is exactly today's input", async () => {
    const [s] = await run({ text: "x", buttons: [CB_BTN] });
    expect(s).toEqual({ chat_id: "222", text: "x", parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Wrong urgency", callback_data: "mail:wu:mi_1" }]] } });
    expect("disable_notification" in (s as object)).toBe(false);
    const [f] = await run({ text: "x", silent: false });
    expect("disable_notification" in (f as object)).toBe(false);
  });

  it("the plain-text retry of a callback-only, non-silent payload is today's input too", async () => {
    const sent = await run({ text: "x", buttons: [CB_BTN] }, true);
    expect(sent[1]).toEqual({ chat_id: "222", text: "x",
      reply_markup: { inline_keyboard: [[{ text: "Wrong urgency", callback_data: "mail:wu:mi_1" }]] } });
    expect("disable_notification" in (sent[1] as object)).toBe(false);
  });

  it("a malformed button_rows entry still falls back to buttons", async () => {
    const [s] = await run({ text: "x", button_rows: [[{ text: "no target" } as never]], buttons: [CB_BTN] });
    expect(s?.reply_markup?.inline_keyboard).toEqual([[{ text: "Wrong urgency", callback_data: "mail:wu:mi_1" }]]);
  });

  it("the client puts disable_notification in the HTTP body only when set", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 5 } }) };
    }) as never;
    const client = new TelegramClient({ token: "t", fetchImpl });
    await client.sendMessage({ chat_id: "1", text: "a" });
    await client.sendMessage({ chat_id: "1", text: "a", disable_notification: true });
    expect("disable_notification" in bodies[0]!).toBe(false);
    expect(bodies[1]?.disable_notification).toBe(true);
  });

  it("mail topics route to chat and the log", () => {
    expect(TOPIC_ROUTE.mail_card).toBe("chat");
    expect(TOPIC_ROUTE.mail_log).toBe("log");
  });
});
