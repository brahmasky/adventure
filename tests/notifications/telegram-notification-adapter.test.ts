import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
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

  it("the plain-text fallback drops inline-code backticks, so an approval id reads (and copies) clean", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => {
        sent.push(input);
        if (input.parse_mode === "HTML") throw new Error("Telegram sendMessage failed: HTTP 400");
        return { message_id: 7 };
      }
    });
    await adapter.send(dispatch("Reply /approve `appr_1-a` to continue or /deny `appr_1-a` to stop."));
    expect(sent[1]).toEqual({ chat_id: "222", text: "Reply /approve appr_1-a to continue or /deny appr_1-a to stop." });
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

  // Decision digest (spec §8.1): up to 8 ✅/❌ pairs; Telegram allows 8 buttons per row, so rows are kept as given.
  it("renders button_rows as one keyboard row each, and prefers them over buttons", async () => {
    const sent: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({ sendMessage: async (input) => { sent.push(input); return { message_id: 6 }; } });
    const d = dispatch("Digest");
    d.payload = { text: "Digest", buttons: [{ text: "x", data: "x" }], button_rows: [[{ text: "✅ 1", data: "dec:rv:a:ok" }, { text: "❌ 1", data: "dec:rv:a:bad" }],
      [{ text: "✅ 2", data: "dec:rv:b:ok" }, { text: "❌ 2", data: "dec:rv:b:bad" }]] };
    await adapter.send(d);
    expect(sent[0]?.reply_markup).toEqual({ inline_keyboard: [
      [{ text: "✅ 1", callback_data: "dec:rv:a:ok" }, { text: "❌ 1", callback_data: "dec:rv:a:bad" }],
      [{ text: "✅ 2", callback_data: "dec:rv:b:ok" }, { text: "❌ 2", callback_data: "dec:rv:b:bad" }]] });
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
  function setup(beforeRecheckForTest?: (path: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "hna-")); dirs.push(root);
    const ws = join(root, "workspace", "chat-222"); mkdirSync(ws, { recursive: true });
    const log: string[] = []; const docs: TelegramSendDocumentInput[] = []; const texts: TelegramSendMessageInput[] = [];
    const adapter = new TelegramNotificationAdapter({
      sendMessage: async (input) => { log.push("message"); texts.push(input); return { message_id: texts.length }; },
      sendDocument: async (input) => { log.push(`document:${input.filename}`); docs.push(input); }
    }, { workspaceFor: (chat) => join(root, "workspace", `chat-${chat}`), ...(beforeRecheckForTest ? { beforeRecheckForTest } : {}) });
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
    expect(sent[1]).toContain(attachmentRefusedLine("whatever.txt", "outside_workspace"));
  });

  it("a directory swapped for a symlink between the check and the read never redirects the upload (fix round 1, I-3)", async () => {
    // The swap lands after the file is opened: ws/sub (a real dir) becomes a symlink to a dir outside.
    let root = "";
    const ctx = setup((path) => {
      if (!path.includes(`${join("sub", "report.txt")}`)) return;
      renameSync(join(ctx.ws, "sub"), join(root, "moved-sub"));
      symlinkSync(join(root, "outside"), join(ctx.ws, "sub"));
    });
    root = ctx.root;
    mkdirSync(join(root, "outside")); writeFileSync(join(root, "outside", "report.txt"), "SECRET outside the workspace");
    mkdirSync(join(ctx.ws, "sub")); writeFileSync(join(ctx.ws, "sub", "report.txt"), "fine");
    await ctx.send([join(ctx.ws, "sub", "report.txt")]);
    expect(ctx.docs).toEqual([]);
    expect(ctx.texts[1]!.text).toContain(attachmentRefusedLine("report.txt", "outside_workspace"));
  });

  it("refuses a hard-linked file (nlink > 1): a link inside the workspace can name a file outside it", async () => {
    const { root, ws, docs, texts, send } = setup();
    writeFileSync(join(root, "secret.txt"), "SECRET outside the workspace");
    linkSync(join(root, "secret.txt"), join(ws, "notes.txt"));
    await send([join(ws, "notes.txt")]);
    expect(docs).toEqual([]);
    expect(texts[1]!.text).toContain(attachmentRefusedLine("notes.txt", "linked"));
  });

  it("a FIFO is refused as not_a_file at once: opening it never blocks the daemon's only thread (fix round 2, N-1)", async () => {
    const { ws, docs, texts, send } = setup();
    execFileSync("mkfifo", [join(ws, "x.pdf")]);
    await send([join(ws, "x.pdf")]);
    expect(docs).toEqual([]);
    expect(texts[1]!.text).toContain(attachmentRefusedLine("x.pdf", "not_a_file"));
  }, 2_000);

  it("R7 §4.2: send() returns attach_checks — the first five checks, then ONE over_count for the whole overflow; a line per overflow path as today", async () => {
    const seen: string[] = [];
    const { ws, docs, texts, send } = setup((p) => { seen.push(p); });
    const files = Array.from({ length: 9 }, (_, i) => { const p = join(ws, `f${i}.txt`); writeFileSync(p, `c${i}`); return p; });
    const r = await send(files);
    expect(r).toEqual({ provider_message_id: "telegram:1", attach_checks: ["ok", "ok", "ok", "ok", "ok", "over_count"] });
    expect(docs.map((d) => d.filename)).toEqual(["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
    expect(seen).toEqual(files.slice(0, 5)); // paths past the fifth are never opened
    expect(texts[1]!.text).toBe(["f5.txt", "f6.txt", "f7.txt", "f8.txt"].map((n) => `⚠ Not attached: ${n} (more than 5 files)`).join("\n"));
  });
  it("R7 §4.2: line bytes are today's for the split reasons; a refused file never reaches sendDocument", async () => {
    const { ws, docs, texts, send } = setup();
    writeFileSync(join(ws, "big.bin"), ""); truncateSync(join(ws, "big.bin"), MAX_ATTACHMENT_BYTES + 1);
    const r = await send([join(ws, "big.bin"), join(ws, "gone.txt")]);
    expect(r).toEqual({ provider_message_id: "telegram:1", attach_checks: ["too_large", "not_found"] });
    expect(docs).toEqual([]);
    expect(texts[1]!.text).toBe("⚠ Not attached: big.bin (over 20 MB)\n⚠ Not attached: gone.txt (could not be read)");
  });
  it("R7 §4.2: no workspace resolver → workspace_unverified, line text 'outside my workspace' byte for byte", async () => {
    const sent: string[] = [];
    const adapter = new TelegramNotificationAdapter({ sendMessage: async (i) => { sent.push(i.text); return { message_id: 3 }; }, sendDocument: async () => { throw new Error("must not send"); } });
    const r = await adapter.send({ ...dispatch("x"), payload: { text: "x", attachments: ["/tmp/whatever.txt"] } });
    expect(r).toEqual({ provider_message_id: "telegram:3", attach_checks: ["workspace_unverified"] });
    expect(sent[1]).toBe("⚠ Not attached: whatever.txt (outside my workspace)");
  });
  it("R7 §2: send_failed is execution — the check was ok; a client without sendDocument is unsupported", async () => {
    const root = mkdtempSync(join(tmpdir(), "hna-")); dirs.push(root);
    const ws = join(root, "workspace", "chat-222"); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, "a.txt"), "a");
    const texts: string[] = [];
    const failing = new TelegramNotificationAdapter({ sendMessage: async (i) => { texts.push(i.text); return { message_id: 4 }; }, sendDocument: async () => { throw new Error("400"); } }, { workspaceFor: () => ws });
    expect(await failing.send({ ...dispatch("x"), payload: { text: "x", attachments: [join(ws, "a.txt")] } })).toEqual({ provider_message_id: "telegram:4", attach_checks: ["ok"] });
    expect(texts[1]).toBe("⚠ Not attached: a.txt (Telegram refused the upload)");
    const noDocs = new TelegramNotificationAdapter({ sendMessage: async () => ({ message_id: 5 }) }, { workspaceFor: () => ws });
    expect(await noDocs.send({ ...dispatch("x"), payload: { text: "x", attachments: [join(ws, "a.txt")] } })).toEqual({ provider_message_id: "telegram:5", attach_checks: ["unsupported"] });
  });
  it("R7 Rev 1.1 (codex B1): without sendDocument the workspace resolver is never called — a throwing resolver still yields unsupported and the delivery resolves", async () => {
    let calls = 0;
    const adapter = new TelegramNotificationAdapter({ sendMessage: async () => ({ message_id: 6 }) }, { workspaceFor: () => { calls += 1; throw new Error("resolver down"); } });
    await expect(adapter.send({ ...dispatch("x"), payload: { text: "x", attachments: ["/tmp/a.txt", "/tmp/b.txt"] } }))
      .resolves.toEqual({ provider_message_id: "telegram:6", attach_checks: ["unsupported", "unsupported"] });
    expect(calls).toBe(0);
  });
  it("R7 §4.2: an all-accepted payload returns its checks although no follow-up line is sent", async () => {
    const { ws, texts, send } = setup(); writeFileSync(join(ws, "a.txt"), "a");
    expect(await send([join(ws, "a.txt")])).toEqual({ provider_message_id: "telegram:1", attach_checks: ["ok"] });
    expect(texts).toHaveLength(1);
  });
});
