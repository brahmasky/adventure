import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachmentRefusedLine, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, TelegramNotificationAdapter
} from "../../src/notifications/telegram-notification-adapter.js";
import type { TelegramSendDocumentInput, TelegramSendMessageInput } from "../../src/telegram/telegram-client.js";

function dispatch(
  text: string,
  buttons?: Array<{ text: string; data: string }>
): Parameters<TelegramNotificationAdapter["send"]>[0] {
  return {
    notification_id: "ntf_1",
    target: { kind: "telegram", chat_id: "222" },
    intent_type: "final_report",
    idempotency_key: "run_1:final",
    payload: { text, ...(buttons ? { buttons } : {}) },
    state: "sending",
    attempt_count: 1,
    provider_message_id: null
  };
}

describe("TelegramNotificationAdapter", () => {
  it("sends converted text with parse_mode HTML through the client boundary", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        return { message_id: 88 };
      }
    });

    await expect(adapter.send(dispatch("Report **ready**"))).resolves.toEqual({
      provider_message_id: "telegram:88"
    });
    expect(sent).toEqual([{ chat_id: "222", text: "Report <b>ready</b>", parse_mode: "HTML" }]);
  });

  it("on a Telegram 400 (HTML parse failure), retries the original text as plain and still resolves", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        if (input.parse_mode === "HTML") {
          throw new Error("Telegram sendMessage failed: HTTP 400");
        }
        return { message_id: 99 };
      }
    });

    await expect(adapter.send(dispatch("Report **ready**"))).resolves.toEqual({
      provider_message_id: "telegram:99"
    });
    // First the HTML attempt, then the plain retry with the ORIGINAL (unconverted) text.
    expect(sent).toEqual([
      { chat_id: "222", text: "Report <b>ready</b>", parse_mode: "HTML" },
      { chat_id: "222", text: "Report **ready**" }
    ]);
  });

  it("renders an inline_keyboard reply_markup when buttons are present (Phase 3.3)", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        return { message_id: 5 };
      }
    });

    await adapter.send(
      dispatch("Self-write ready", [
        { text: "View diff", data: "selfwrite:view:run_x" },
        { text: "Merge & reload", data: "selfwrite:merge:run_x" },
        { text: "Discard", data: "selfwrite:discard:run_x" }
      ])
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "View diff", callback_data: "selfwrite:view:run_x" },
          { text: "Merge & reload", callback_data: "selfwrite:merge:run_x" },
          { text: "Discard", callback_data: "selfwrite:discard:run_x" }
        ]
      ]
    });
  });

  it("omits reply_markup entirely when no buttons (existing notifications unchanged)", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        return { message_id: 6 };
      }
    });

    await adapter.send(dispatch("plain report"));

    expect(sent).toHaveLength(1);
    expect("reply_markup" in (sent[0] ?? {})).toBe(false);
  });
});

describe("TelegramNotificationAdapter — omp turn attachments (Task 13, ruling 8)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "hna-")); dirs.push(root);
    const ws = join(root, "workspace", "chat-222"); mkdirSync(ws, { recursive: true });
    const log: string[] = []; const docs: TelegramSendDocumentInput[] = []; const texts: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => { log.push("message"); texts.push(input); return { message_id: texts.length }; },
      sendDocument: async (input) => { log.push(`document:${input.filename}`); docs.push(input); }
    }, { workspaceFor: (chat) => join(root, "workspace", `chat-${chat}`) });
    const send = (attachments: string[]) => adapter.send({ ...dispatch("here you go"), payload: { text: "here you go", attachments } });
    return { root, ws, log, docs, texts, send };
  }

  it("sends each attachment as a document AFTER the one text message", async () => {
    const { ws, log, docs, send } = setup();
    writeFileSync(join(ws, "a.csv"), "x,y\n1,2\n"); writeFileSync(join(ws, "b.png"), Buffer.from([137, 80, 78, 71]));
    await send([join(ws, "a.csv"), join(ws, "b.png")]);
    expect(log).toEqual(["message", "document:a.csv", "document:b.png"]);
    expect(Buffer.from(docs[1]!.content as Uint8Array)).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it("a symlink swapped in after the reply was composed is NOT sent: realpath is re-checked at send time", async () => {
    const { root, ws, log, texts, send } = setup();
    writeFileSync(join(root, "secret.txt"), "outside the workspace");
    writeFileSync(join(ws, "report.txt"), "fine");
    unlinkSync(join(ws, "report.txt")); symlinkSync(join(root, "secret.txt"), join(ws, "report.txt"));
    await send([join(ws, "report.txt")]);
    expect(log).toEqual(["message", "message"]);
    expect(texts[1]!.text).toContain(attachmentRefusedLine("report.txt", "outside_workspace"));
  });

  it("refuses oversize files, non-regular files and anything past the count cap as one follow-up text, never a send", async () => {
    const { ws, log, texts, send } = setup();
    writeFileSync(join(ws, "big.bin"), ""); truncateSync(join(ws, "big.bin"), MAX_ATTACHMENT_BYTES + 1);
    mkdirSync(join(ws, "folder"));
    const small = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => { const p = join(ws, `f${i}.txt`); writeFileSync(p, "ok"); return p; });
    await send([join(ws, "big.bin"), join(ws, "folder"), ...small]);
    expect(log.filter((l) => l.startsWith("document:"))).toHaveLength(MAX_ATTACHMENTS - 2);
    expect(log.filter((l) => l === "message")).toHaveLength(2);
    const follow = texts[1]!.text;
    for (const line of [attachmentRefusedLine("big.bin", "too_large"), attachmentRefusedLine("folder", "not_a_file"), attachmentRefusedLine(`f${MAX_ATTACHMENTS - 1}.txt`, "over_count")]) {
      expect(follow).toContain(line);
    }
  });

  it("without a workspace resolver every attachment is refused (fail closed)", async () => {
    const sent: string[] = [];
    const adapter = new TelegramNotificationAdapter({ sendMessage: async (i) => { sent.push(i.text); return { message_id: 1 }; }, sendDocument: async () => { throw new Error("must not send"); } });
    await adapter.send({ ...dispatch("x"), payload: { text: "x", attachments: ["/tmp/whatever.txt"] } });
    expect(sent).toHaveLength(2);
  });
});
