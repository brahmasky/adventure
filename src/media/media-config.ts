import os from "node:os";
import path from "node:path";

/**
 * Multimodal ingest (spec 2026-09-29): the pure facts every other media module shares — the flag,
 * the caps, the code-owned file names, and every user-facing string. Nothing here does I/O.
 */
export type MediaKind = "voice" | "photo";
export type TurnModality = "text" | MediaKind;

/** What the adapter carries on `event.metadata.media`; counts and Telegram ids only. */
export interface TelegramMediaRef {
  kind: MediaKind;
  file_id: string;
  file_unique_id: string;
  mime_type: string;
  /** Explicit, so a caption that happens to read `[photo]` is never mistaken for the placeholder. */
  has_caption: boolean;
  file_size?: number;
  duration?: number;
  width?: number;
  height?: number;
}

export type MediaIngestStatus = "ok" | "too_large" | "download_failed" | "leg_failed" | "empty" | "timeout" | "disabled";

/** The `media_ingested` ledger payload: counts, tags and code-owned strings ONLY (`detail` is a code, never prose). */
export type MediaIngestedPayload = {
  kind: MediaKind;
  status: MediaIngestStatus;
  source: "telegram";
  bytes?: number;
  duration_s?: number;
  width?: number;
  height?: number;
  provider?: string;
  model?: string;
  latency_ms?: number;
  chars_out?: number;
  detail?: string;
};

export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 300;
export const MEDIA_LEG_TIMEOUT_MS = 45_000;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
export const MEDIA_STAGE_DEADLINE_MS = 150_000;
export const MEDIA_ECHO_MAX_CHARS = 200;
/** A verbose reader must not bloat the message, the stored turn, or push Jev past its cap. */
export const MEDIA_DIGEST_MAX_CHARS = 4_000;
export const DEFAULT_MEDIA_PROVIDERS = "agy-cli,pi";

/** Code-owned file names: the ONLY `@` tokens a CLI ever sees (Codex spec review R6). */
export const MEDIA_BASENAME: Record<MediaKind, string> = { voice: "media.ogg", photo: "media.jpg" };
export const MEDIA_MIME: Record<MediaKind, string> = { voice: "audio/ogg", photo: "image/jpeg" };
/** The contract objective when there is no caption; replaced by the ingest step, never shown. */
export const MEDIA_PLACEHOLDER: Record<MediaKind, string> = { voice: "[voice message]", photo: "[photo]" };

/** basename → the one mime it may carry (Codex plan review R8: the pair, not two independent sets). */
const BASENAME_MIME: ReadonlyMap<string, string> = new Map(
  (Object.keys(MEDIA_BASENAME) as MediaKind[]).map((kind) => [MEDIA_BASENAME[kind], MEDIA_MIME[kind]])
);

/** HOUGE_MEDIA_INGEST_ENABLED — default OFF; 1/true/yes/on. Read per poll: `/disarm` flips it. */
export function resolveMediaIngestEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_MEDIA_INGEST_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function resolveMediaProviders(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_LLM_MEDIA_PROVIDERS?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_MEDIA_PROVIDERS;
}

export function resolveMediaLegTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_LLM_TIMEOUT_MS_MEDIA);
  return Number.isFinite(n) && n > 0 ? n : MEDIA_LEG_TIMEOUT_MS;
}

/**
 * The answer adapter's gate: an absolute, normalised path (no `..`) to a code-owned basename inside a
 * `houge-media-*` directory that sits DIRECTLY under `tmpdir()`, carrying that basename's one mime.
 */
export function isAllowedMediaFile(input: { path: string; mime: string }): boolean {
  if (!path.isAbsolute(input.path) || path.normalize(input.path) !== input.path) return false;
  const dir = path.dirname(input.path);
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("houge-media-")) return false;
  return BASENAME_MIME.get(path.basename(input.path)) === input.mime;
}

const NOUN: Record<MediaKind, string> = { voice: "voice note", photo: "photo" };

export function mediaFailureReply(kind: MediaKind, status: Exclude<MediaIngestStatus, "ok">): string {
  switch (status) {
    case "too_large":
      return kind === "voice" ? "voice note too long or too large (max 5 min / 10 MB)" : "photo too large (max 10 MB)";
    case "download_failed":
      return `couldn't fetch your ${NOUN[kind]}, please resend`;
    case "leg_failed":
    case "timeout":
      return kind === "voice" ? "couldn't transcribe that right now" : "couldn't read that image right now";
    case "empty":
      return kind === "voice" ? "I couldn't hear anything in that voice note" : "I couldn't make out the image";
    case "disabled":
      return "media ingest is off — please type it";
  }
}

/** The one-line transcript echo that opens a voice reply (truncated, never the whole note). */
export function echoLine(transcript: string): string {
  const body = transcript.length > MEDIA_ECHO_MAX_CHARS ? `${transcript.slice(0, MEDIA_ECHO_MAX_CHARS)}…` : transcript;
  return `🎙 I heard: “${body}”`;
}
