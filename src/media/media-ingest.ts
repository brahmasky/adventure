import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { daemonTmpRoot, registerDaemonTmpRoot } from "../run/daemon-tmp.js";
import path from "node:path";
import { buildReaderQuestion, parseReaderExtraction, renderExtractionDigest } from "../core/quarantine.js";
import { classifyLlmError } from "../llm/audit.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { answerWithChain, llmToolAdapter, oneShotAdapter } from "../llm/registry.js";
import { createAgyCliProvider } from "../llm/providers/agy-cli.js";
import type { LlmProvider } from "../llm/types.js";
import { resolveOmpConfig } from "../omp/omp-config.js";
import type { RunStore } from "../run/run-store.js";
import {
  MEDIA_BASENAME,
  MEDIA_DIGEST_MAX_CHARS,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_MAX_BYTES,
  MEDIA_MIME,
  MEDIA_STAGE_DEADLINE_MS,
  VOICE_MAX_SECONDS,
  echoLine,
  mediaFailureReply,
  resolveMediaLegTimeoutMs,
  resolveMediaProviders,
  type MediaIngestStatus,
  type MediaIngestedPayload,
  type MediaKind,
  type TelegramMediaRef
} from "./media-config.js";

/**
 * The ingest step (spec 2026-09-29): a Telegram voice note or photo → the turn's text, on the media
 * leg, inside one stage deadline. Pure over injected deps. NEVER rejects: every path resolves to a
 * status the worker turns into a reply and a `media_ingested` row. Bytes live in a temp dir for the
 * duration of one call and are removed in `finally`.
 */
export interface MediaIngestDeps {
  downloadFile(input: { file_id: string; maxBytes: number; signal?: AbortSignal }): Promise<{ bytes: Uint8Array }>;
  /** An llm_answer-shaped adapter already bound to the run and the right role (the worker builds it). */
  mediaCall(input: Record<string, unknown>): Promise<ToolAdapterResult>;
  /** The reader system prompt (composeSystemPrompt(memoryRoot, "reader")) — photos only. */
  readerSystem: string;
  now?: () => number;
  /** Default MEDIA_STAGE_DEADLINE_MS; tests shrink it. */
  stageDeadlineMs?: number;
  /** Default MEDIA_DOWNLOAD_TIMEOUT_MS; tests shrink it. */
  downloadTimeoutMs?: number;
  /** Default `<data>/tmp` (never os.tmpdir(), B13); tests use a per-file root so dir assertions never see other suites' dirs. */
  tmpRoot?: string;
}

export type MediaIngestResult =
  | { ok: true; text: string; modality: MediaKind; echo?: string; ledger: MediaIngestedPayload }
  | { ok: false; status: Exclude<MediaIngestStatus, "ok">; reply: string; ledger: MediaIngestedPayload };

export const VOICE_TRANSCRIBE_QUESTION =
  "Transcribe this voice message verbatim, in the speaker's language. Output the transcript only — no commentary, no translation.";
export const VOICE_TRANSCRIBE_SYSTEM = "You are a precise speech-to-text transcriber. Output only the transcript.";
export const PHOTO_BARE_OBJECTIVE = "Describe the image and any text in it.";
/** The reader's "raw content" slot for a photo: the bytes ride the attachment, not the prompt. */
const IMAGE_SOURCE_NOTE = "[the source is the attached image file — read it directly]";

const DEADLINE = Symbol("deadline");

type Attachment = { path: string; mime: string };

export async function ingestMedia(deps: MediaIngestDeps, ref: TelegramMediaRef, caption: string): Promise<MediaIngestResult> {
  const now = deps.now ?? Date.now;
  const base = counts(ref);
  const tooLarge =
    (typeof ref.file_size === "number" && ref.file_size > MEDIA_MAX_BYTES) ||
    (ref.kind === "voice" && (ref.duration ?? 0) > VOICE_MAX_SECONDS);
  if (tooLarge) return fail(ref.kind, "too_large", base);

  // The dir exists BEFORE the deadline starts (plan review B1): whichever way the race ends, there is
  // a known dir to remove, and nothing created later can leak.
  let dir: string;
  try {
    dir = await mkdtemp(path.join(mediaTmpRoot(deps.tmpRoot), "houge-media-"));
  } catch {
    return fail(ref.kind, "leg_failed", { ...base, detail: "mkdtemp" });
  }
  const stage = new AbortController();
  const t0 = now();
  const pending = run(dir, stage.signal).catch(
    (): MediaIngestResult => fail(ref.kind, "leg_failed", { ...base, latency_ms: now() - t0, detail: "threw" })
  );
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  // Remove the dir when the work settles — late or not — so a leg that outlives the deadline never leaves bytes behind.
  void pending.finally(cleanup);
  const outcome = await withDeadline(pending, deps.stageDeadlineMs ?? MEDIA_STAGE_DEADLINE_MS);
  if (outcome === DEADLINE) {
    stage.abort(); // cancels an in-flight download; a CLI leg settles on its own 45 s timeout and is discarded
    await cleanup();
    return fail(ref.kind, "timeout", { ...base, latency_ms: now() - t0, detail: "stage_deadline" });
  }
  await cleanup();
  return outcome;

  async function run(workdir: string, signal: AbortSignal): Promise<MediaIngestResult> {
    const downloaded = await download(deps, ref, signal);
    if (!downloaded.ok) return fail(ref.kind, downloaded.status, { ...base, detail: downloaded.detail });
    const filePath = path.join(workdir, MEDIA_BASENAME[ref.kind]);
    await writeFile(filePath, downloaded.bytes);
    const media = { path: filePath, mime: MEDIA_MIME[ref.kind] };
    const withBytes = { ...base, bytes: downloaded.bytes.byteLength };
    return ref.kind === "voice"
      ? transcribe(deps, media, caption, withBytes, t0, now)
      : describePhoto(deps, media, caption, withBytes, t0, now);
  }
}

/** The daemon-owned root a media dir is made in; a caller's root is registered so the seat gate accepts its files. */
function mediaTmpRoot(root: string | undefined): string {
  if (root === undefined) return daemonTmpRoot();
  registerDaemonTmpRoot(root);
  return root;
}

/** Declared counts for the ledger row: never ids, names or paths. */
function counts(ref: TelegramMediaRef): MediaIngestedPayload {
  return {
    kind: ref.kind,
    status: "ok",
    source: "telegram",
    ...(typeof ref.file_size === "number" ? { bytes: ref.file_size } : {}),
    ...(typeof ref.duration === "number" ? { duration_s: ref.duration } : {}),
    ...(typeof ref.width === "number" ? { width: ref.width } : {}),
    ...(typeof ref.height === "number" ? { height: ref.height } : {})
  };
}

function fail(kind: MediaKind, status: Exclude<MediaIngestStatus, "ok">, ledger: MediaIngestedPayload): MediaIngestResult {
  return { ok: false, status, reply: mediaFailureReply(kind, status), ledger: { ...ledger, status } };
}

/**
 * One retry on a network/5xx failure only; each attempt aborted at 30 s or by the stage deadline,
 * and neither abort is retried. Every error string is code-owned or replaced; the code is kept as
 * the ledger `detail`.
 */
async function download(
  deps: MediaIngestDeps,
  ref: TelegramMediaRef,
  stage: AbortSignal
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: "download_failed" | "too_large"; detail: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (stage.aborted) return { ok: false, status: "download_failed", detail: "stage_deadline" };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deps.downloadTimeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS);
    timer.unref();
    const onStage = () => abort.abort();
    stage.addEventListener("abort", onStage, { once: true });
    try {
      const { bytes } = await deps.downloadFile({ file_id: ref.file_id, maxBytes: MEDIA_MAX_BYTES, signal: abort.signal });
      return { ok: true, bytes };
    } catch (error) {
      const code = abort.signal.aborted ? (stage.aborted ? "stage_deadline" : "download_timeout") : downloadCode(error);
      if (code === "too_large") return { ok: false, status: "too_large", detail: code };
      const retryable = code === "network" || code.startsWith("http_5");
      if (!retryable || attempt === 1) return { ok: false, status: "download_failed", detail: code };
    } finally {
      clearTimeout(timer);
      stage.removeEventListener("abort", onStage);
    }
  }
  return { ok: false, status: "download_failed", detail: "retries_exhausted" };
}

function downloadCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("download_failed: ") ? message.slice("download_failed: ".length) : "network";
}

async function transcribe(
  deps: MediaIngestDeps,
  media: Attachment,
  caption: string,
  ledger: MediaIngestedPayload,
  t0: number,
  now: () => number
): Promise<MediaIngestResult> {
  const r = await deps.mediaCall({ question: VOICE_TRANSCRIBE_QUESTION, system: VOICE_TRANSCRIBE_SYSTEM, media });
  const stamped = { ...ledger, latency_ms: now() - t0, ...legTags(r) };
  if (!r.ok) return fail("voice", "leg_failed", { ...stamped, detail: legDetail(r.error) });
  const transcript = typeof r.output.answer === "string" ? r.output.answer.trim() : "";
  if (transcript.length === 0) return fail("voice", "empty", stamped);
  const text = caption.length > 0 ? `${caption}\n\n${transcript}` : transcript;
  return { ok: true, text, modality: "voice", echo: echoLine(transcript), ledger: { ...stamped, chars_out: transcript.length } };
}

/** The wall's reader schema over an image: one parse retry, then `empty` — never an unreadable-digest fallback. */
async function describePhoto(
  deps: MediaIngestDeps,
  media: Attachment,
  caption: string,
  ledger: MediaIngestedPayload,
  t0: number,
  now: () => number
): Promise<MediaIngestResult> {
  const objective = caption.length > 0 ? caption : PHOTO_BARE_OBJECTIVE;
  const question = buildReaderQuestion(objective, IMAGE_SOURCE_NOTE);
  let stamped = ledger;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const r = await deps.mediaCall({ question, system: deps.readerSystem, media });
    stamped = { ...ledger, latency_ms: now() - t0, ...legTags(r) };
    if (!r.ok) return fail("photo", "leg_failed", { ...stamped, detail: legDetail(r.error) });
    const extraction = parseReaderExtraction(typeof r.output.answer === "string" ? r.output.answer : "");
    if (!extraction) continue;
    if (extraction.summary.length === 0 && extraction.facts.length === 0) return fail("photo", "empty", stamped);
    const rendered = renderExtractionDigest(extraction);
    const digest = capDigest(rendered, extraction.contains_instructions);
    const text = caption.length > 0 ? `${caption}\n\n${digest}` : digest;
    return { ok: true, text, modality: "photo", ledger: { ...stamped, chars_out: digest.length } };
  }
  return fail("photo", "empty", stamped);
}

/** Cap the digest body but never the trailing injection note: it is the planner's only warning. */
function capDigest(rendered: string, flagged: boolean): string {
  if (rendered.length <= MEDIA_DIGEST_MAX_CHARS) return rendered;
  const noteAt = flagged ? rendered.lastIndexOf("\nnote: ") : -1;
  const note = noteAt >= 0 ? rendered.slice(noteAt) : "";
  const body = noteAt >= 0 ? rendered.slice(0, noteAt) : rendered;
  return `${body.slice(0, MEDIA_DIGEST_MAX_CHARS - note.length)}…${note}`;
}

/** The chain's error text can echo a prompt; keep only a code-owned classification for the ledger. */
function legDetail(error: string): string {
  if (error === "no media-capable leg" || error === "media rejected") return error;
  return classifyLlmError(error);
}

function legTags(r: ToolAdapterResult): Pick<MediaIngestedPayload, "provider" | "model"> {
  if (!r.ok) return {};
  return {
    ...(typeof r.output.provider === "string" ? { provider: r.output.provider } : {}),
    ...(typeof r.output.model === "string" ? { model: r.output.model } : {})
  };
}

/** The stage deadline (Codex spec review R8). Unref'd so a hung leg never holds the daemon open. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), ms);
    timer.unref();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

export interface MediaCallDeps {
  store: RunStore;
  run_id: string;
  kind: MediaKind;
  env: NodeJS.ProcessEnv;
  /** Tests only: the voice leg (default: the agy-cli provider with the media timeout). */
  voiceLeg?: LlmProvider;
}

/**
 * The media leg for one run (ruling 2, live probe 2026-09-30). A PHOTO is an omp one-shot on
 * `cfg.media` with the image as an `@path` argument (omp sends it as an image block), audited as
 * `reader`. A VOICE note NEVER reaches omp: omp inlines Ogg bytes as text and the model invents a
 * transcript, so voice stays on the agy-cli leg (`HOUGE_LLM_MEDIA_PROVIDERS`, agy-cli only),
 * audited as `media_transcribe`.
 */
export function buildMediaCall(d: MediaCallDeps): MediaIngestDeps["mediaCall"] {
  if (d.kind === "photo") {
    return llmToolAdapter(oneShotAdapter(d.store, resolveOmpConfig(d.env), { run_id: d.run_id, role: "reader" }));
  }
  const chain = d.voiceLeg ? [d.voiceLeg] : voiceChain(d.env);
  if (chain.length === 0) return async () => ({ ok: false, error: "no media-capable leg" });
  const audit = d.store.llmAuditSink({ run_id: d.run_id, role: "media_transcribe" });
  return llmToolAdapter({ answer: (req) => answerWithChain(chain, req, audit) });
}

/** Voice provider names that once existed and are known gone (the warning says "retired", not "unknown"). */
const RETIRED_VOICE_PROVIDERS: ReadonlySet<string> = new Set(["pi"]);
const warnedVoiceLists = new Set<string>();

/**
 * The voice chain: agy-cli is the only leg that hears audio (pi and the API legs are gone). NEVER
 * throws — a stale `HOUGE_LLM_MEDIA_PROVIDERS` would otherwise crash the turn's ingest step. Any
 * other name is dropped with ONE warning per configured list; an empty result is the caller's
 * normal media failure (leg_failed + its reply + a media_ingested row).
 */
export function voiceChain(env: NodeJS.ProcessEnv): LlmProvider[] {
  const timeoutMs = resolveMediaLegTimeoutMs(env);
  const names = resolveMediaProviders(env).split(",").map((n) => n.trim()).filter(Boolean);
  const dropped = names.filter((n) => n !== "agy-cli");
  const key = names.join(",");
  if (dropped.length > 0 && !warnedVoiceLists.has(key)) {
    warnedVoiceLists.add(key);
    const why = dropped.map((n) => `${n} (${RETIRED_VOICE_PROVIDERS.has(n) ? "retired" : "unknown"})`).join(", ");
    console.warn(`[media-ingest] HOUGE_LLM_MEDIA_PROVIDERS: dropped ${why}; only agy-cli transcribes voice`);
  }
  return names.filter((n) => n === "agy-cli").slice(0, 1).map(() => createAgyCliProvider({ timeoutMs }));
}
