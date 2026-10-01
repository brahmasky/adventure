import os from "node:os";
import path from "node:path";
import { daemonTmpRoot } from "../../src/run/daemon-tmp.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEDIA_PROVIDERS,
  MEDIA_BASENAME,
  MEDIA_ECHO_MAX_CHARS,
  MEDIA_LEG_TIMEOUT_MS,
  MEDIA_MIME,
  MEDIA_PLACEHOLDER,
  echoLine,
  isAllowedMediaFile,
  mediaFailureReply,
  resolveMediaIngestEnabled,
  resolveMediaLegTimeoutMs,
  resolveMediaProviders
} from "../../src/media/media-config.js";

describe("resolveMediaIngestEnabled", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["no", false],
    ["1", true],
    ["true", true],
    [" YES ", true],
    ["on", true]
  ])("%j → %s (default OFF — media bytes leave the mini only by opt-in)", (raw, want) => {
    expect(resolveMediaIngestEnabled(raw === undefined ? {} : { HOUGE_MEDIA_INGEST_ENABLED: raw })).toBe(want);
  });
});

describe("resolveMediaProviders / resolveMediaLegTimeoutMs", () => {
  it("defaults the VOICE chain to agy-cli alone (ruling 2: omp cannot hear audio, pi is gone) and honours the env override", () => {
    expect(resolveMediaProviders({})).toBe(DEFAULT_MEDIA_PROVIDERS);
    expect(DEFAULT_MEDIA_PROVIDERS).toBe("agy-cli");
    expect(resolveMediaProviders({ HOUGE_LLM_MEDIA_PROVIDERS: " agy-cli " })).toBe("agy-cli");
  });

  it("per-leg timeout: 45 s by default, HOUGE_LLM_TIMEOUT_MS_MEDIA when numeric", () => {
    expect(resolveMediaLegTimeoutMs({})).toBe(MEDIA_LEG_TIMEOUT_MS);
    expect(MEDIA_LEG_TIMEOUT_MS).toBe(45_000);
    expect(resolveMediaLegTimeoutMs({ HOUGE_LLM_TIMEOUT_MS_MEDIA: "9000" })).toBe(9000);
    expect(resolveMediaLegTimeoutMs({ HOUGE_LLM_TIMEOUT_MS_MEDIA: "soon" })).toBe(MEDIA_LEG_TIMEOUT_MS);
  });
});

describe("isAllowedMediaFile — the only files a leg may ever be handed", () => {
  const dir = path.join(daemonTmpRoot(), "houge-media-abc123");
  it("accepts the code-owned basename/mime PAIRS in a houge-media-* dir directly under the daemon temp root", () => {
    expect(isAllowedMediaFile({ path: path.join(dir, MEDIA_BASENAME.voice), mime: MEDIA_MIME.voice })).toBe(true);
    expect(isAllowedMediaFile({ path: path.join(dir, MEDIA_BASENAME.photo), mime: MEDIA_MIME.photo })).toBe(true);
  });
  it("rejects a foreign basename, a foreign mime, a MISMATCHED pair, a relative path, a non-media dir, a nested dir, `..` traversal, a path outside the daemon temp root, and os.tmpdir() itself (B13: the sandbox could write there)", () => {
    expect(isAllowedMediaFile({ path: path.join(dir, "voice_1234.ogg"), mime: "audio/ogg" })).toBe(false);
    // agy attaches by extension: `.ogg` is not attached, `.opus` is (probe 2026-09-29) — the old name must not pass.
    expect(isAllowedMediaFile({ path: path.join(dir, "media.ogg"), mime: "audio/ogg" })).toBe(false);
    expect(MEDIA_BASENAME.voice).toBe("media.opus");
    expect(MEDIA_MIME.voice).toBe("audio/ogg");
    expect(isAllowedMediaFile({ path: path.join(dir, "media.opus"), mime: "text/plain" })).toBe(false);
    expect(isAllowedMediaFile({ path: path.join(dir, "media.opus"), mime: "image/jpeg" })).toBe(false);
    expect(isAllowedMediaFile({ path: "media.opus", mime: "audio/ogg" })).toBe(false);
    expect(isAllowedMediaFile({ path: path.join(os.tmpdir(), "houge-agy-xyz", "media.opus"), mime: "audio/ogg" })).toBe(false);
    expect(isAllowedMediaFile({ path: path.join(dir, "sub", "media.opus"), mime: "audio/ogg" })).toBe(false);
    expect(isAllowedMediaFile({ path: `${dir}/../houge-media-other/media.opus`, mime: "audio/ogg" })).toBe(false);
    expect(isAllowedMediaFile({ path: "/etc/media.opus", mime: "audio/ogg" })).toBe(false);
    expect(isAllowedMediaFile({ path: path.join(os.tmpdir(), "houge-media-abc123", MEDIA_BASENAME.voice), mime: MEDIA_MIME.voice })).toBe(false);
  });
});

describe("user-facing strings are code-owned", () => {
  it("placeholders and replies exist for every kind and status", () => {
    expect(MEDIA_PLACEHOLDER).toEqual({ voice: "[voice message]", photo: "[photo]" });
    expect(mediaFailureReply("voice", "too_large")).toMatch(/max 5 min/);
    expect(mediaFailureReply("photo", "too_large")).toMatch(/max 10 MB/);
    expect(mediaFailureReply("voice", "disabled")).toMatch(/off/);
    for (const status of ["download_failed", "leg_failed", "empty", "timeout", "disabled"] as const) {
      expect(mediaFailureReply("voice", status).length).toBeGreaterThan(0);
      expect(mediaFailureReply("photo", status).length).toBeGreaterThan(0);
    }
  });

  it("echoLine quotes the transcript and truncates past the cap", () => {
    expect(echoLine("hello there")).toBe("🎙 I heard: “hello there”");
    const long = "x".repeat(MEDIA_ECHO_MAX_CHARS + 50);
    const line = echoLine(long);
    expect(line).toBe(`🎙 I heard: “${"x".repeat(MEDIA_ECHO_MAX_CHARS)}…”`);
  });
});
