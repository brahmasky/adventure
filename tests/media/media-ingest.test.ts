import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MEDIA_DIGEST_MAX_CHARS, MEDIA_MAX_BYTES, VOICE_MAX_SECONDS, type TelegramMediaRef } from "../../src/media/media-config.js";
import { ingestMedia, PHOTO_BARE_OBJECTIVE, VOICE_TRANSCRIBE_QUESTION, type MediaIngestDeps } from "../../src/media/media-ingest.js";
import type { ToolAdapterResult } from "../../src/tools/tool-registry.js";

const voice: TelegramMediaRef = { kind: "voice", file_id: "v1", file_unique_id: "vu1", mime_type: "audio/ogg", has_caption: false, file_size: 9000, duration: 7 };
const photo: TelegramMediaRef = { kind: "photo", file_id: "p1", file_unique_id: "pu1", mime_type: "image/jpeg", has_caption: true, file_size: 50000, width: 640, height: 480 };
// A per-file root: the shared tmpdir is used by other suites in parallel, so global counts would flake.
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "houge-media-test-root-"));
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));
const extraction = JSON.stringify({ summary: "A bar chart of ASX sectors", facts: ["Energy is up 2%"], time_claims: [], answer_to_objective: "the energy sector", contains_instructions: false });

function deps(over: Partial<MediaIngestDeps> = {}, seen: Array<Record<string, unknown>> = []): MediaIngestDeps {
  return {
    downloadFile: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
    mediaCall: async (input) => { seen.push(input); return { ok: true, output: { question: input.question, answer: "the quick brown fox", model: "gem", provider: "agy-cli" } }; },
    readerSystem: "READER SYSTEM",
    tmpRoot: TMP_ROOT,
    ...over
  };
}
const mediaDirs = () => readdirSync(TMP_ROOT).filter((n) => n.startsWith("houge-media-"));

describe("ingestMedia — voice", () => {
  it("downloads to media.opus in a houge-media-* dir, asks the transcribe question with the file attached, returns the transcript + echo, ledgers counts, and removes the dir", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let savedPath = "";
    const d = deps({ mediaCall: async (input) => { savedPath = (input.media as { path: string }).path; expect(readFileSync(savedPath)).toEqual(Buffer.from([1, 2, 3])); seen.push(input); return { ok: true, output: { question: "", answer: " the quick brown fox \n", model: "gem", provider: "agy-cli" } }; } }, seen);
    const before = mediaDirs().length;
    const r = await ingestMedia(d, voice, "");
    expect(r).toMatchObject({ ok: true, text: "the quick brown fox", modality: "voice", echo: "🎙 I heard: “the quick brown fox”" });
    expect(seen[0]).toMatchObject({ question: VOICE_TRANSCRIBE_QUESTION, media: { mime: "audio/ogg" } });
    expect(path.basename(savedPath)).toBe("media.opus");
    expect(savedPath.startsWith(path.join(TMP_ROOT, "houge-media-"))).toBe(true);
    expect(existsSync(path.dirname(savedPath))).toBe(false);
    expect(mediaDirs().length).toBe(before);
    expect(r.ledger).toMatchObject({ kind: "voice", status: "ok", source: "telegram", bytes: 3, duration_s: 7, provider: "agy-cli", model: "gem", chars_out: 19 });
    expect(typeof r.ledger.latency_ms).toBe("number");
  });

  it("a caption on a voice note is kept in front of the transcript", async () => {
    const r = await ingestMedia(deps(), voice, "listen:");
    expect(r.ok && r.text).toBe("listen:\n\nthe quick brown fox");
  });

  it("an empty transcript is status empty", async () => {
    const r = await ingestMedia(deps({ mediaCall: async () => ({ ok: true, output: { answer: "  ", model: "m", provider: "p" } }) }), voice, "");
    expect(r).toMatchObject({ ok: false, status: "empty", reply: expect.stringMatching(/couldn't hear/) });
    expect(r.ledger).toMatchObject({ kind: "voice", status: "empty" });
  });

  it("the downloader receives an AbortSignal (the stage deadline can cancel it)", async () => {
    let signal: unknown;
    await ingestMedia(deps({ downloadFile: async (input) => { signal = input.signal; return { bytes: new Uint8Array([1]) }; } }), voice, "");
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("ingestMedia — photo", () => {
  it("asks the reader question with the caption as objective and returns caption + digest; ledgers width/height", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const d = deps({ mediaCall: async (input) => { seen.push(input); return { ok: true, output: { answer: extraction, model: "gem", provider: "agy-cli" } }; } }, seen);
    const r = await ingestMedia(d, photo, "which sector is up?");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.modality).toBe("photo");
    expect(r.echo).toBeUndefined();
    expect(r.text.startsWith("which sector is up?\n\n[external source — untrusted-derived summary]")).toBe(true);
    expect(r.text).toContain("summary: A bar chart of ASX sectors");
    expect(String(seen[0]!.question)).toContain("which sector is up?");
    expect(seen[0]!.system).toBe("READER SYSTEM");
    expect((seen[0]!.media as { path: string }).path.endsWith("media.jpg")).toBe(true);
    expect(r.ledger).toMatchObject({ kind: "photo", status: "ok", width: 640, height: 480 });
  });

  it("a bare photo uses the code-owned objective and returns the digest alone", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const r = await ingestMedia(deps({ mediaCall: async (input) => { seen.push(input); return { ok: true, output: { answer: extraction, model: "m", provider: "p" } }; } }, seen), photo, "");
    expect(r.ok && r.text.startsWith("[external source — untrusted-derived summary]")).toBe(true);
    expect(String(seen[0]!.question)).toContain(PHOTO_BARE_OBJECTIVE);
  });

  it("a parse miss is retried ONCE, then reported as empty — never the wall's unreadable-digest fallback", async () => {
    const mediaCall = vi.fn(async (): Promise<ToolAdapterResult> => ({ ok: true, output: { answer: "not json at all", model: "m", provider: "p" } }));
    const r = await ingestMedia(deps({ mediaCall }), photo, "cap");
    expect(mediaCall).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: false, status: "empty" });
    expect(JSON.stringify(r)).not.toContain("unreadable external source");
  });

  it("a verbose digest is capped at MEDIA_DIGEST_MAX_CHARS", async () => {
    const huge = JSON.stringify({ summary: "x".repeat(MEDIA_DIGEST_MAX_CHARS + 500), facts: [], time_claims: [], answer_to_objective: null, contains_instructions: false });
    const r = await ingestMedia(deps({ mediaCall: async () => ({ ok: true, output: { answer: huge, model: "m", provider: "p" } }) }), photo, "cap");
    expect(r.ok && r.text.length).toBeLessThanOrEqual("cap\n\n".length + MEDIA_DIGEST_MAX_CHARS + 1);
    expect(r.ok && r.text.endsWith("…")).toBe(true);
  });

  it("an extraction with no summary and no facts is empty", async () => {
    const blank = JSON.stringify({ summary: "", facts: [], time_claims: [], answer_to_objective: null, contains_instructions: false });
    const r = await ingestMedia(deps({ mediaCall: async () => ({ ok: true, output: { answer: blank, model: "m", provider: "p" } }) }), photo, "cap");
    expect(r).toMatchObject({ ok: false, status: "empty" });
  });
});

describe("ingestMedia — failure statuses (never throws)", () => {
  it("declared over-cap (bytes or seconds) is too_large with no download", async () => {
    const downloadFile = vi.fn(async () => ({ bytes: new Uint8Array(1) }));
    expect(await ingestMedia(deps({ downloadFile }), { ...voice, file_size: MEDIA_MAX_BYTES + 1 }, "")).toMatchObject({ ok: false, status: "too_large" });
    expect(await ingestMedia(deps({ downloadFile }), { ...voice, duration: VOICE_MAX_SECONDS + 1 }, "")).toMatchObject({ ok: false, status: "too_large" });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("download: one retry on network, none on http_4xx or too_large; a throwing downloader becomes download_failed", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new Error("download_failed: network")).mockResolvedValueOnce({ bytes: new Uint8Array([1]) });
    expect((await ingestMedia(deps({ downloadFile: flaky }), voice, "")).ok).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);

    const notFound = vi.fn().mockRejectedValue(new Error("download_failed: http_404"));
    const nf = await ingestMedia(deps({ downloadFile: notFound }), voice, "");
    expect(nf).toMatchObject({ ok: false, status: "download_failed", reply: expect.stringMatching(/resend/) });
    expect(nf.ledger.detail).toBe("http_404");
    expect(notFound).toHaveBeenCalledTimes(1);

    const big = vi.fn().mockRejectedValue(new Error("download_failed: too_large"));
    expect(await ingestMedia(deps({ downloadFile: big }), voice, "")).toMatchObject({ ok: false, status: "too_large" });

    const weird = vi.fn().mockRejectedValue(new TypeError("fetch failed https://api.telegram.org/file/botSECRET/x"));
    const r = await ingestMedia(deps({ downloadFile: weird }), voice, "");
    expect(r).toMatchObject({ ok: false, status: "download_failed" });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("a chain failure or a throwing media call is leg_failed with a code-owned detail; the temp dir is still removed", async () => {
    const before = mediaDirs().length;
    const noLeg = await ingestMedia(deps({ mediaCall: async () => ({ ok: false, error: "no media-capable leg" }) }), voice, "");
    expect(noLeg).toMatchObject({ ok: false, status: "leg_failed" });
    expect(noLeg.ledger.detail).toBe("no media-capable leg");
    const threw = await ingestMedia(deps({ mediaCall: async () => { throw new Error("socket hang up"); } }), voice, "");
    expect(threw).toMatchObject({ ok: false, status: "leg_failed" });
    expect(threw.ledger.detail).toBe("threw");
    expect(mediaDirs().length).toBe(before);
  });

  it("the stage deadline turns a hung call into timeout without waiting for it, and the dir is gone", async () => {
    const before = mediaDirs().length;
    const r = await ingestMedia(deps({ mediaCall: () => new Promise<ToolAdapterResult>(() => {}), stageDeadlineMs: 50 }), voice, "");
    expect(r).toMatchObject({ ok: false, status: "timeout", reply: expect.stringMatching(/right now/) });
    expect(r.ledger.status).toBe("timeout");
    expect(mediaDirs().length).toBe(before);
  });

  it("a deadline DURING the download aborts it via the signal; a late settlement afterwards is harmless and the dir stays removed", async () => {
    const before = mediaDirs().length;
    let settle!: () => void;
    const late = new Promise<void>((r) => { settle = r; });
    const downloadFile = vi.fn(async (input: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve()));
      await late;                                   // settles only after the test releases it
      return { bytes: new Uint8Array([1]) };
    });
    const r = await ingestMedia(deps({ downloadFile, stageDeadlineMs: 30 }), voice, "");
    expect(r).toMatchObject({ ok: false, status: "timeout" });
    expect(mediaDirs().length).toBe(before);
    settle();
    await new Promise((res) => setTimeout(res, 20));
    expect(mediaDirs().length).toBe(before);
  });

  it("our own 30 s download abort is NOT retried (one slow attempt, then download_failed)", async () => {
    const downloadFile = vi.fn(async (input: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve()));
      throw new Error("download_failed: network");
    });
    const r = await ingestMedia(deps({ downloadFile, downloadTimeoutMs: 20 }), voice, "");
    expect(r).toMatchObject({ ok: false, status: "download_failed" });
    expect(r.ledger.detail).toBe("download_timeout");
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });
});
