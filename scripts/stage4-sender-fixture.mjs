// The Slice R2 sender fixture (spec 2026-11-01 R2 §6; plan Task 7, Task 9 reuses it). Not a corpus. It drives a dist's own Telegram long-poll
// adapter (pollOnce) over synthetic updates on a fresh store. Synthetic ids only: 111 Paco / 999 stranger / 444 another allowlisted identity,
// chat 222 (allowlisted for Paco only) / 333 (not allowlisted). `emit` is a recording stub that never intakes (P3: a /kill must not reach a gateway).
import { NOW, withCountingClock, withPinnedEnv } from "./stage4-intake-fixture.mjs";

export const PACO = 111;
export const STRANGER = 999;
export const OTHER = 444;
export const CHAT = 222;
export const FOREIGN_CHAT = 333;
const ALLOWLIST = {
  users: [{ telegram_user_id: PACO, identity_id: "paco" }, { telegram_user_id: OTHER, identity_id: "other" }],
  chats: [{ telegram_chat_id: CHAT, label: "synthetic", allowed_identity_ids: ["paco"] }]
};
const TAP_DATA = "approval:approve:appr_synthetic";

/**
 * One Telegram update. kind: message | forward | channel_post | tap | photo | malformed.
 * opts: id (update_id, required), from (default PACO; null omits it), chat (default CHAT), text, forward ("date" | "origin"), nomessage (tap without its message).
 */
export function senderUpdate(kind, opts = {}) {
  const { id, from = PACO, chat = CHAT, text = "synthetic", forward, nomessage = false } = opts;
  if (typeof id !== "number") throw new Error("senderUpdate: id is required");
  const fromPart = from === null ? {} : { from: { id: from } };
  if (kind === "channel_post") return { update_id: id, channel_post: { message_id: id, chat: { id: chat }, text } };
  if (kind === "tap") {
    return { update_id: id, callback_query: { id: `cb${id}`, data: TAP_DATA, ...fromPart, ...(nomessage ? {} : { message: { message_id: id, chat: { id: chat } } }) } };
  }
  const base = { message_id: id, chat: { id: chat }, ...fromPart };
  if (kind === "forward") return { update_id: id, message: { ...base, text, ...(forward === "origin" ? { forward_origin: { type: "user" } } : { forward_date: 1_700_000_000 }) } };
  if (kind === "photo") return { update_id: id, message: { ...base, photo: [{ file_id: `f${id}`, file_unique_id: `u${id}`, width: 90, height: 90 }] } };
  if (kind === "malformed") return { update_id: id, message: { ...base, text: "/deny" } };
  if (kind === "message") return { update_id: id, message: { ...base, text } };
  throw new Error(`senderUpdate: unknown kind ${kind}`);
}

/** A recorder that counts `record` calls per entry id and forwards each to `inner` (P6). `calls` is the live tally. */
export function countingRecorder(inner) {
  const calls = {};
  return { calls, recorder: { ...inner, record: (entry, r, ctx) => { calls[entry.id] = (calls[entry.id] ?? 0) + 1; return inner.record(entry, r, ctx); } } };
}

/**
 * Runs `updates` through the dist's adapter once, on `store`, inside the caller's pinned env / clock. `recorder` is the new side's plain
 * store recorder (d.storeRecorder(store)), wrapped here in a counting one; the old side passes none (its adapter has no such option).
 * Returns { result, emitted, acks, offset, calls } where calls is the per-entry-id record tally ({} without a recorder).
 */
export async function pollItem(d, store, updates, { recorder = null, mediaIngest = false } = {}) {
  const emitted = [];
  const acks = [];
  const counting = recorder ? countingRecorder(recorder) : null;
  const adapter = d.createTelegramLongPollingAdapter({
    allowlist: ALLOWLIST, offsetStore: store, skippedUpdateStore: store,
    client: { getUpdates: async () => structuredClone(updates) },
    acknowledgeSink: (a) => { acks.push(a); },
    mediaIngestEnabled: () => mediaIngest,
    ...(counting ? { decisionRecorder: counting.recorder } : {})
  });
  const result = await adapter.pollOnce(async (event) => { emitted.push(structuredClone(event)); });
  return { result, emitted, acks, offset: store.getOffset("telegram"), calls: counting?.calls ?? {} };
}

/** Runs fn under the pinned env and the counting clock, the way every R1/R2 item does. */
export const underPins = (dir, fn) => withPinnedEnv(dir, () => withCountingClock(NOW, fn));
