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

  it("disables link previews on sendMessage (cut the outbound exfil leg, ADR 0006)", async () => {
    let body = "";
    const client = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async (url, init) => {
        if (String(url).includes("/sendMessage")) body = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
    });
    await client.sendMessage({ chat_id: "222", text: "see https://untrusted.example" });
    expect(JSON.parse(body).disable_web_page_preview).toBe(true);
  });

  it("includes allowed_updates in the getUpdates query when supplied (Phase 3.3)", async () => {
    let requestedUrl = "";
    const client = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
    });

    await client.getUpdates({ offset: 1, timeout_seconds: 1, allowed_updates: ["message", "callback_query"] });
    const parsed = new URL(requestedUrl);
    expect(JSON.parse(parsed.searchParams.get("allowed_updates") ?? "[]")).toEqual([
      "message",
      "callback_query"
    ]);
  });

  it("sends reply_markup inline_keyboard on sendMessage when provided (Phase 3.3)", async () => {
    let body = "";
    const client = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async (url, init) => {
        if (String(url).includes("/sendMessage")) body = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
    });

    await client.sendMessage({
      chat_id: "222",
      text: "buttons",
      reply_markup: { inline_keyboard: [[{ text: "Merge", callback_data: "selfwrite:merge:run_x" }]] }
    });
    expect(JSON.parse(body).reply_markup).toEqual({
      inline_keyboard: [[{ text: "Merge", callback_data: "selfwrite:merge:run_x" }]]
    });
  });

  it("answerCallbackQuery POSTs the callback_query_id (Phase 3.3)", async () => {
    let calledUrl = "";
    let body = "";
    const client = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async (url, init) => {
        calledUrl = String(url);
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.answerCallbackQuery({ callback_query_id: "cbq_1", text: "Merging…" });
    expect(calledUrl).toContain("/answerCallbackQuery");
    expect(JSON.parse(body)).toEqual({ callback_query_id: "cbq_1", text: "Merging…" });
  });

  it("editMessageReplyMarkup clears the keyboard with an empty inline_keyboard when none given (Phase 3.3)", async () => {
    let calledUrl = "";
    let body = "";
    const client = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async (url, init) => {
        calledUrl = String(url);
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.editMessageReplyMarkup({ chat_id: "222", message_id: 90 });
    expect(calledUrl).toContain("/editMessageReplyMarkup");
    expect(JSON.parse(body)).toEqual({ chat_id: "222", message_id: 90, reply_markup: { inline_keyboard: [] } });
  });

  it("sendDocument POSTs multipart/form-data with the named file + caption (⓪·2c U1, zero-dep)", async () => {
    let calledUrl = "";
    let body: FormData | undefined;
    const client = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async (url, init) => {
        calledUrl = String(url);
        body = init?.body as FormData;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.sendDocument({
      chat_id: "222",
      filename: "run_42.patch",
      content: "diff --git a/x b/x\n+patched\n",
      caption: "Full diff for houge/selfwrite/run_42"
    });
    expect(calledUrl).toContain("/sendDocument");
    expect(body).toBeInstanceOf(FormData);
    expect(body!.get("chat_id")).toBe("222");
    expect(body!.get("caption")).toBe("Full diff for houge/selfwrite/run_42");
    const doc = body!.get("document") as File;
    expect(doc.name).toBe("run_42.patch");
    expect(await doc.text()).toBe("diff --git a/x b/x\n+patched\n");
  });

  it("sendDocument surfaces HTTP and API errors like the other methods", async () => {
    const httpFail = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async () => new Response("nope", { status: 413 })
    });
    await expect(
      httpFail.sendDocument({ chat_id: "222", filename: "x.patch", content: "d" })
    ).rejects.toThrow("Telegram sendDocument failed: HTTP 413");

    const apiFail = new TelegramClient({
      token: "token",
      apiBase: "https://example.test/bottoken",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, description: "file too large" }), { status: 200 })
    });
    await expect(
      apiFail.sendDocument({ chat_id: "222", filename: "x.patch", content: "d" })
    ).rejects.toThrow("Telegram sendDocument failed: file too large");
  });
});

describe("downloadFile (multimodal ingest, spec 2026-09-29)", () => {
  const BASE = "https://example.test/botSECRET-TOKEN";
  const okGetFile = (file_size?: number) =>
    new Response(JSON.stringify({ ok: true, result: { file_id: "f", file_path: "voice/file_1.oga", ...(file_size !== undefined ? { file_size } : {}) } }), { status: 200 });

  it("calls getFile, then GETs the /file/bot<token>/<file_path> URL with redirects refused, and returns the bytes", async () => {
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    const client = new TelegramClient({
      token: "SECRET-TOKEN", apiBase: BASE,
      fetchImpl: async (url, init) => {
        urls.push(String(url)); inits.push(init ?? {});
        if (String(url).includes("/getFile")) return okGetFile(3);
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
    });
    const file = await client.downloadFile({ file_id: "f", maxBytes: 1000 });
    expect(Array.from(file.bytes)).toEqual([1, 2, 3]);
    expect(urls[0]).toBe(`${BASE}/getFile?file_id=f`);
    expect(urls[1]).toBe("https://example.test/file/botSECRET-TOKEN/voice/file_1.oga");
    expect(inits.every((i) => i.redirect === "error")).toBe(true);
  });

  it("rejects a declared over-cap size BEFORE fetching the body", async () => {
    const urls: string[] = [];
    const client = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async (url) => { urls.push(String(url)); return okGetFile(5000); } });
    await expect(client.downloadFile({ file_id: "f", maxBytes: 1000 })).rejects.toThrow("download_failed: too_large");
    expect(urls).toHaveLength(1);
  });

  it("rejects an actual over-cap body without returning bytes (content-length, then the body itself)", async () => {
    const byHeader = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async (url) =>
      String(url).includes("/getFile") ? okGetFile() : new Response(new Uint8Array(10), { status: 200, headers: { "content-length": "5000" } }) });
    await expect(byHeader.downloadFile({ file_id: "f", maxBytes: 1000 })).rejects.toThrow("download_failed: too_large");
    const byBody = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async (url) =>
      String(url).includes("/getFile") ? okGetFile() : new Response(new Uint8Array(2000), { status: 200 }) });
    await expect(byBody.downloadFile({ file_id: "f", maxBytes: 1000 })).rejects.toThrow("download_failed: too_large");
  });

  it("maps HTTP failures to code-owned strings and never echoes the token or URL", async () => {
    const client = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async () => new Response("nope", { status: 404 }) });
    const err = await client.downloadFile({ file_id: "f", maxBytes: 1000 }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("download_failed: http_404");
    expect((err as Error).message).not.toContain("SECRET-TOKEN");
  });

  it("a fetch that throws (with the URL in its message) surfaces as download_failed: network, token-free", async () => {
    const client = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async (url) => { throw new Error(`redirect refused for ${String(url)}`); } });
    const err = await client.downloadFile({ file_id: "f", maxBytes: 1000 }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe("download_failed: network");
  });

  it("a foreign error that MIMICS the prefix is still replaced — only the client's own failures keep their message (Codex plan review B4)", async () => {
    const client = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async () => { throw new Error("download_failed: https://example.test/file/botSECRET-TOKEN/x"); } });
    const err = await client.downloadFile({ file_id: "f", maxBytes: 1000 }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe("download_failed: network");
  });

  it("a file_path outside ^[\\w./-]+$ is refused before the token URL is built", async () => {
    const urls: string[] = [];
    const client = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ ok: true, result: { file_path: "../..?x=1#f" } }), { status: 200 }); } });
    await expect(client.downloadFile({ file_id: "f", maxBytes: 1000 })).rejects.toThrow("download_failed: no_file_path");
    expect(urls).toHaveLength(1);
  });

  it("streams the body and cancels past the cap when there is no content-length (no unbounded buffering)", async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(400)); } });
    const client = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async (url) =>
      String(url).includes("/getFile") ? okGetFile() : new Response(endless, { status: 200 }) });
    await expect(client.downloadFile({ file_id: "f", maxBytes: 1000 })).rejects.toThrow("download_failed: too_large");
    expect(pulls).toBeLessThan(10);
  });

  it("a getFile envelope without a file_path is download_failed: no_file_path", async () => {
    const client = new TelegramClient({ token: "SECRET-TOKEN", apiBase: BASE, fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 200 }) });
    await expect(client.downloadFile({ file_id: "f", maxBytes: 1000 })).rejects.toThrow("download_failed: no_file_path");
  });
});
