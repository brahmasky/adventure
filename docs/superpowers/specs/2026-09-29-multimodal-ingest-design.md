# Multimodal ingest — voice notes and photos become text inside the turn

Date: 2026-09-29
Status: **design approved in brainstorming (Paco + Claude, 2026-09-29); Codex spec review next, then the plan.**
Author: Paco + Claude
Roadmap: item 2 ("multimodal ingest"), queued behind the Jev intent shadow (shipped 2026-09-28).

## Problem

A Telegram voice note or a bare photo gets a canned "I can't read this yet" reply
(`TELEGRAM_UNSUPPORTED_MEDIA_REPLY`). A captioned photo is answered from the caption alone; the
picture is discarded. Paco wants to talk to Houge and to send it pictures, with the picture's
content actually read.

### Facts that shape the design (verified 2026-09-28/29)

- `normalizeTelegramUpdate` is synchronous and pure. It already reads `message.caption`, already
  declares `message.photo`, and already refuses forwarded messages at auth, before any media
  handling. Media work (a download, an LLM call) cannot live there.
- `executeTurn` takes its message from `claim.contract.objective` and writes the user chat turn
  from that same string. The classifier, the loop, thread reconstruction and the Jev shadow all
  read that text. Replacing it at one point makes every consumer media-aware for free.
- The dual-LLM wall already renders untrusted reads as a schema digest
  (`renderExtractionDigest`: summary, facts, time_claims, answer_to_objective,
  contains_instructions). A photo is an untrusted read with a different transport.
- **Spike (2026-09-28, four flat-rate CLI calls, synthetic media):** under Houge's exact
  invocation flags —
  - `agy` (Gemini 3.8 Flash, flat-rate): reads a PNG and transcribes an OGG/Opus voice note in one
    turn each, with no tool calls. The `@path` inclusion is client-side; the model receives the
    bytes inline. About 25 k input tokens per call, a few seconds.
  - `pi` (Kimi, tools off): reads the PNG (no tools); refuses audio ("no audio processing
    capabilities"). Its earlier audio "success" used tools, which Houge disables.
  - So the flat-rate legs cover the whole first slice. The metered Gemini API is not needed and
    is not wired in this slice.
- Telegram Bot API: `getFile` returns a `file_path`; bytes come from
  `https://api.telegram.org/file/bot<token>/<file_path>`; the ceiling is 20 MB. A voice note is
  `audio/ogg` (Opus); a photo arrives as an array of sizes, largest last.

## Decisions (from brainstorming)

1. **Scope: voice notes and photos.** Video, documents, stickers stay unsupported (the
   acknowledgement text says what is supported now).
2. **Placement: an ingest step inside the run**, after intake and before the classifier. Not in
   the poll loop (serialized, no run to audit against, no retry), not a loop tool (that is the
   roadmap's later `look_at_media`).
3. **Backend: the flat-rate CLI legs**, agy first, pi for photos only. Every other leg rejects
   media so the chain falls through. No metered leg in this slice.
4. **Voice transcripts are trusted** (Paco spoke them; forwards are refused at auth). The
   transcript becomes the turn's message. The reply opens with one echo line so a mis-hearing is
   visible: `🎙 I heard: <transcript, truncated at 200 chars>`.
5. **Photo content is untrusted-derived.** The caption stays the trusted objective; the image goes
   through the existing quarantine read and reaches the planner only as the schema digest.
6. **Flag `HOUGE_MEDIA_INGEST_ENABLED`**, default OFF, in `DISARM_FLAGS`, read per turn.
7. **Bytes never persist.** A temp dir for the duration of one call, removed in `finally`.
   Ledger rows carry counts only.

## Components

### `src/triggers/telegram-trigger-adapter.ts` — media-aware, still pure

- Declares `message.voice` (`file_id`, `file_unique_id`, `duration`, `mime_type?`, `file_size?`).
- After auth, the media branch: a `voice` or a `photo` (largest size) becomes a **turn** event.
  - `goal` = the caption, or the placeholder `[voice message]` / `[photo]` when there is none,
    so the contract objective stays non-empty. The placeholder is never shown to the user; the
    ingest step replaces it.
  - `metadata.media` = `{ kind: "voice" | "photo", file_id, file_unique_id, mime_type,
    file_size?, duration? (voice), width?, height? (photo) }`.
  - The idempotency key, `source_reference`, `requested_by` and `notify` are unchanged.
- The command parser is NOT run on a caption (a caption is never a `/command`).
- Flag OFF → today's `TELEGRAM_UNSUPPORTED_MEDIA` path, unchanged. The flag is read by the
  poll runner and passed in, so the adapter stays pure.
- Anything else text-less (sticker, document, video) → today's acknowledgement, with the text
  updated: "I can read text, voice notes and photos; videos and files not yet."

### `src/telegram/telegram-client.ts` — `downloadFile`

`downloadFile(file_id, maxBytes): Promise<{ bytes: Uint8Array; file_path: string }>`:
`getFile`, then a GET on the file URL. Rejects (no partial read) when `file_size` from
`getFile` or the actual body exceeds `maxBytes`. The URL contains the bot token: it is never
logged and never returned; errors carry the HTTP status only.

### `src/llm/types.ts` — `LlmRequest.media`

```ts
media?: { path: string; mime: string };   // absolute path inside the media temp dir
```

- `agy-cli.ts`: when `media` is present, the prompt becomes `<system>\n\n<question>\n\n@<basename>`
  and the spawn cwd is `dirname(path)` (the media temp dir), so the `@` reference is relative and
  cannot escape it. The existing `--disable-slash-commands` stays.
- `pi.ts`: `image/*` only, as the `@path` argv token before the message; any other mime returns
  `{ ok: false, error: "media unsupported: <mime>" }`.
- `kimi.ts`, `gemini.ts`, `openai-compat.ts`: `media` present → `{ ok: false, error: "media
  unsupported" }`. The chain treats that like any other leg failure and falls through.
- `resolveMediaProviders(env)`: `HOUGE_LLM_MEDIA_PROVIDERS`, default `agy-cli,pi`.
- New `LlmCallRole`: `media_transcribe`. Photos use the existing `reader` role.

### `src/core/core-worker.ts` — the ingest step

`resolveTurnMessage(claim): Promise<ResolvedTurnMessage>` runs at the top of `executeTurn`:

- No `metadata.media`, or flag off → `{ text: objective, modality: "text" }`.
- Otherwise, in order: cap check on the declared size/duration → `downloadFile` into
  `mkdtemp("houge-media-")` → the media call → `rmSync` the dir in `finally`.
- **Voice** (`media_transcribe`): question "Transcribe this voice message verbatim, in the
  speaker's language. Output the transcript only — no commentary, no translation."
  `{ text: transcript, modality: "voice", echo: transcript.slice(0, 200) }`. The transcript is
  the classifier's message, the loop's message and the stored user turn.
- **Photo** (`reader`): the existing `quarantineRead` with the image attached and the objective
  = caption, or "Describe the image and any text in it." when bare. Result:
  `{ text: caption + "\n\n" + digest, modality: "photo" }` (bare: the digest alone, headed by the
  same `[external source — untrusted-derived summary]` line). No echo line.
- The reply builder prepends `🎙 I heard: …\n\n` when `echo` is set.
- The Jev shadow payload's `modality` becomes the resolved modality (`text | voice | photo`); the
  shadow question uses the resolved text, as the classifier does. A long transcript can exceed the
  shadow's `MAX_LATEST_MESSAGE_CHARS`; the shadow then records `skipped_state_too_large` as it
  would for a long typed message. The classifier itself has no such cap.
- On any ingest failure the run fails before the user chat turn is written, so no turn carrying
  the placeholder is ever stored; the thread stays as it was.
- The media call is not charged to `max_tool_calls` (same as the reader) and runs under the
  run's `llmAuditSink` with its role, so it is one `llm_attempt` row, priced as CLI transport.

### Ledger — `media_ingested`

Required fields `["kind", "status", "source"]`. Payload:
`kind: voice | photo`, `status: ok | too_large | download_failed | leg_failed | empty | disabled`,
`source: "telegram"`, `bytes`, `duration_s` (voice) or `width`/`height` (photo), `provider`,
`model`, `latency_ms`, `chars_out`. Counts, tags and code-owned strings only. Never a transcript,
caption, file name, file id or path. Written once per media turn, whatever happened.

### Caps and timeouts

| | Voice | Photo |
|---|---|---|
| Size | ≤ 10 MB | ≤ 10 MB |
| Length | ≤ 300 s (`duration`) | largest size only |
| Media call timeout | 120 s | 120 s |
| Retries | download: 1 retry; leg: chain fallthrough only | same |

Telegram's own ceiling is 20 MB; the caps are Houge's and are checked from the declared
`file_size`/`duration` before any download, then re-checked on the body.

## Error handling

Every failure is user-facing, run-failing and ledgered. No silent text-less turn.

| Case | Status | Reply | Run |
|---|---|---|---|
| Flag off | `disabled` (no row; the adapter never made a media event) | today's acknowledgement | none |
| Over cap (declared or actual) | `too_large` | "voice note too long (max 5 min)" / "photo too large (max 10 MB)" | fails |
| `getFile`/download error after one retry | `download_failed` | "couldn't fetch your voice note / photo, please resend" | fails |
| Every media leg fell through | `leg_failed` | "couldn't transcribe / read that right now" | fails |
| Empty transcript / empty digest | `empty` | "I couldn't hear anything" / "I couldn't make out the image" | fails |
| Media call ok | `ok` | normal answer (voice: with the echo line) | continues |

The run's failure path is the existing one (`failed` state, notification through the outbox), so
the invariant sweep and `/usage` see it like any other failed turn.

**Security.**
- Photo content can steer only through the reader digest, and the digest carries
  `contains_instructions` exactly as web reads do. The raw image never reaches the planner.
- A voice note is trusted because the sender is allowlisted and forwards are refused at auth. A
  future "forwarded voice note" feature would have to re-classify it as untrusted; note it here so
  nobody relaxes the forward check casually.
- The bot-token file URL never appears in logs, errors or the ledger.
- Egress: media bytes go to the same party the text already goes to on the agy leg (Google,
  flat-rate) and, for photos, possibly to pi's provider (Kimi). No new party.
- `/disarm` covers it (`DISARM_FLAGS`), and the kill switch stops the daemon as before.

## Testing

Hermetic by construction: the downloader and the media call are injected into `CoreWorker`; the
real legs are built only beside the production adapters (the Jev pattern). The flag joins
`PINNED_ENV` in every core-worker suite.

- **Adapter** (`tests/triggers/telegram-trigger-adapter.test.ts`): voice with and without caption
  → turn event with `metadata.media` and the right `goal`; captioned photo → same, largest size
  chosen, caption never parsed as a command; forwarded voice → refused at auth (no
  acknowledgement); sticker/document/video → unsupported acknowledgement with the new text;
  flag off → unsupported acknowledgement for voice and photo.
- **Client** (`tests/telegram/telegram-client.test.ts`, mocked fetch): `getFile` + body; declared
  over-cap rejects before the GET; actual over-cap rejects without returning bytes; the token never
  appears in the thrown error.
- **Providers**: agy builds `@<basename>` with cwd = the media dir; pi accepts `image/*` and
  rejects `audio/*`; the API legs reject any media; the chain falls through in the configured
  order and reports `leg_failed` when every leg rejects.
- **Ingest** (`tests/core/core-worker-media.test.ts`): transcript becomes the message, the stored
  user turn and the classifier's input; photo digest is appended to the caption and the raw image
  never appears in any prompt; each failure status writes its row, fails the run, and sends its
  reply; the temp dir is gone after success and after failure; the shadow row carries the
  modality; the echo line is present, truncated at 200 chars, and absent for photos.
- **Ledger**: the `media_ingested` no-bodies key list.
- **Live gate** `scripts/live-gate-media.mjs` (opt-in, real agy leg, in-memory store): synthetic
  media built the way the spike did (`say` → ffmpeg → OGG/Opus; ffmpeg `drawtext` → PNG with a
  probe code), a local-file downloader injected. PASS = transcript contains the probe words, the
  photo digest contains the rendered code, one `media_ingested` row per turn with `status: ok`,
  one `llm_attempt` per media call with the right role, and no `houge-media-*` dir left in
  `tmpdir()`.
- **Cardinal rule**: after arming, one real voice note and one real photo from Paco over
  Telegram, and the ledger rows checked by hand.

## Rollout

1. Build TDD on `feat/media-ingest`; per-task reviews; final whole-branch + Codex whole-diff.
2. Live gate PASS from the worktree (`HOUGE_ENV_FILE` → the main `.env`).
3. PR, merge, `npm run build`, kickstart.
4. Paco adds `HOUGE_MEDIA_INGEST_ENABLED=true` to the mini's `.env` and sends a voice note and a
   photo. Check: `SELECT occurred_at, json_extract(payload_json,'$.kind'),
   json_extract(payload_json,'$.status') FROM ledger_events WHERE event_type='media_ingested'
   ORDER BY occurred_at DESC LIMIT 5`.

## Out of scope

- Video, documents, stickers, albums (media groups), voice replies from Houge.
- The metered Gemini API as a media leg (documented fallback; not wired).
- `look_at_media` as a loop tool, and Jev `needs_media` / `actionable` nouls (roadmap, later).
- Any change to `parseIntent`, the loop, or the reader schema.
- Storing media bytes or transcripts anywhere new beyond the existing chat turn text.

## Docs to update on ship

- `docs/reference/configuration.md` (`HOUGE_MEDIA_INGEST_ENABLED`, `HOUGE_LLM_MEDIA_PROVIDERS`).
- README (the Telegram section: voice and photos).
- `docs/ROADMAP.md` item 2; `tasks/todo.md`; `sessions.md`.
- An ADR only if the reader schema or the wall changes (it does not in this slice).
