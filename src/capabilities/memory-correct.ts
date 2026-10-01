import { blobToFloat32, cosineSimilarity } from "../llm/embeddings.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { MemoryChange, MemoryKind, RunStore } from "../run/run-store.js";
import { clipText } from "../status/houge-status.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";
import { escapeForTelegram } from "./text-hygiene.js";

/**
 * Self-service memory correction (2026-10-02). Live: episodic fact #108 put ASML in Paco's daily brief and Houge said
 * it had no tool to change it. Memory is high-value state and an injected edit would be persistent and quiet, so code
 * owns every limit: search first, write only ids that search offered in this turn, only on Paco's own Telegram turn,
 * never after an untrusted read in the same turn, capped, every change undoable, the ledger ids-only.
 */

export const MEMORY_SEARCH_MAX = 10;
export const MEMORY_SEARCH_TEXT_CHARS = 200;
export const MEMORY_IDS_PER_CALL_MAX = 5;
export const MEMORY_CHANGES_PER_TURN_MAX = 10;
export const MEMORY_CARD_TEXT_CHARS = 120;
export const MEMORY_UNDO_PREFIX = "memory:undo:";
/** Telegram's callback_data limit. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * H1 (review round 2): the only steps that may come before a write in the same turn. Anything else taints it — the
 * read tools of the wall, any bash (plain bash can curl a page, unquarantined under D12), a file read, an unknown call.
 * Earlier memory_correct steps (search, or a write Paco already approved) carry no outside text.
 */
export const MEMORY_CLEAN_PRIOR_STEPS: ReadonlySet<string> = new Set<string>(["memory_correct", "memory_correct_write", "houge_status", "to_local_time"]);

/** What this turn's searches offered, and how many rows it has changed. */
export interface MemoryTurnState { offered: Record<MemoryKind, Set<number>>; changed: number }
export const newMemoryTurnState = (): MemoryTurnState => ({ offered: { fact: new Set(), wiki: new Set() }, changed: 0 });

export const MEMORY_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  bad_input: "give action search with a query, or retire/correct with 1 to 5 ids.",
  correction_required: "correct needs `correction`: Paco's corrected wording.",
  wiki_correct_unsupported: "wiki pages can only be retired, not corrected.",
  not_operator_turn: "retire and correct run only on Paco's own Telegram message, never on a scheduled turn.",
  tainted_turn: "another tool (web, mail, bash, a file read) already ran in this turn. Ask Paco to repeat the request in a fresh message.",
  not_offered: "retire and correct take only ids a search in this turn returned. Search first.",
  too_many: `at most ${MEMORY_IDS_PER_CALL_MAX} ids per call and ${MEMORY_CHANGES_PER_TURN_MAX} changed rows per turn.`,
  not_active: "one of those ids is no longer active. Search again."
};

export type MemoryRequest =
  | { action: "search"; kind: MemoryKind; query: string }
  | { action: "retire"; kind: MemoryKind; ids: number[] }
  | { action: "correct"; kind: MemoryKind; ids: number[]; correction: string };

const refusalText = (reason: string): string => `${reason}: ${MEMORY_REFUSAL_TEXT[reason] ?? reason}`;
const refusal = (reason: string): ToolAdapterResult => ({ ok: false, error: refusalText(reason) });

function parseIds(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((x) => Number.isInteger(x) && (x as number) > 0)) return null;
  return [...new Set(v as number[])];
}

/** The tool input, re-checked in code (the declared schema cannot express 1–5 items or the per-action fields). */
export function parseMemoryRequest(input: Record<string, unknown>): MemoryRequest | { refusal: string } {
  const kind: MemoryKind = input.kind === "wiki" ? "wiki" : "fact";
  if (input.kind !== undefined && input.kind !== "fact" && input.kind !== "wiki") return { refusal: "bad_input" };
  if (input.action === "search") {
    const query = typeof input.query === "string" ? input.query.trim().slice(0, 200) : "";
    return query ? { action: "search", kind, query } : { refusal: "bad_input" };
  }
  if (input.action !== "retire" && input.action !== "correct") return { refusal: "bad_input" };
  const ids = parseIds(input.ids);
  if (!ids) return { refusal: "bad_input" };
  if (input.action === "retire") return { action: "retire", kind, ids };
  if (kind === "wiki") return { refusal: "wiki_correct_unsupported" };
  const correction = typeof input.correction === "string" ? input.correction.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  return correction ? { action: "correct", kind, ids, correction } : { refusal: "correction_required" };
}

export interface MemoryCandidate { id: number; text: string; created_at: string }

type Embedded = MemoryCandidate & { embedding: Uint8Array | null };

/** Keyword hits first, then substring hits (CJK, which FTS cannot segment), then nearest by embedding; unique, capped. */
function merge(legs: Embedded[][], embedding: Float32Array | null, all: Embedded[]): MemoryCandidate[] {
  const byCosine = embedding
    ? all.filter((r) => r.embedding).map((r) => ({ r, c: cosineSimilarity(embedding, blobToFloat32(r.embedding!)) }))
      .filter((x) => Number.isFinite(x.c)).sort((a, b) => b.c - a.c).map((x) => x.r)
    : [];
  const out = new Map<number, MemoryCandidate>();
  for (const r of [...legs.flat(), ...byCosine]) {
    if (out.size >= MEMORY_SEARCH_MAX) break;
    if (!out.has(r.id)) out.set(r.id, { id: r.id, text: r.text, created_at: r.created_at });
  }
  return [...out.values()];
}

const contains = (needle: string) => (r: Embedded) => r.text.toLowerCase().includes(needle.toLowerCase());

/** ACTIVE rows of `kind` matching `query` (facts: this chat's only). Read-only: no applied/used counters move. */
export function searchActiveMemory(
  store: RunStore, kind: MemoryKind, chat_id: string, query: string, embedding: Float32Array | null
): MemoryCandidate[] {
  if (kind === "fact") {
    const asRow = (f: { id: number; fact: string; created_at: string; embedding: Uint8Array | null }): Embedded =>
      ({ id: f.id, text: f.fact, created_at: f.created_at, embedding: f.embedding });
    const all = store.getActiveEpisodicFacts(chat_id).map(asRow);
    return merge([store.searchEpisodicFactsFts(chat_id, query, MEMORY_SEARCH_MAX).map(asRow), all.filter(contains(query))], embedding, all);
  }
  const asPage = (p: { id: number; title: string; summary: string; created_at: string; embedding: Uint8Array | null }): Embedded =>
    ({ id: p.id, text: p.summary ? `${p.title}: ${p.summary}` : p.title, created_at: p.created_at, embedding: p.embedding });
  const all = store.getActiveWikiPages().map(asPage);
  return merge([store.searchWikiPagesFts(query, MEMORY_SEARCH_MAX).map(asPage), all.filter(contains(query))], embedding, all);
}

/** `#id · text · since YYYY-MM-DD`, one per line. */
export function renderMemoryCandidates(rows: MemoryCandidate[], textChars: number): string[] {
  return rows.map((r) => `#${r.id} · ${clipText(r.text, textChars)} · since ${r.created_at.slice(0, 10)}`);
}

/** The single Undo button; its callback_data must fit Telegram's 64 bytes. */
export function memoryUndoButton(change_id: string): NotificationButton {
  const data = `${MEMORY_UNDO_PREFIX}${change_id}`;
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) throw new Error("memory undo callback_data exceeds 64 bytes");
  return { text: "↩️ Undo", data };
}

const quoted = (text: string) => `"${clipText(escapeForTelegram(text), MEMORY_CARD_TEXT_CHARS)}"`;
/** An old row's text on the approval card: markdown-inert, at most MEMORY_SEARCH_TEXT_CHARS. */
const quotedFull = (text: string) => `"${clipText(escapeForTelegram(text), MEMORY_SEARCH_TEXT_CHARS)}"`;

/** The current text of a memory row (status flips never change it); "" when the row is gone. */
export function memoryRowText(store: RunStore, kind: MemoryKind, id: number): string {
  if (kind === "fact") return store.getEpisodicFact(id)?.fact ?? "";
  const p = store.getWikiPage(id);
  return p ? p.title : "";
}

/** `🧠 Retired #108: "<text>"` per row, or `🧠 Corrected #108 → #170: "<correction>"`. Code-rendered, text escaped. */
export function memoryChangeCardText(store: RunStore, change: MemoryChange): string {
  const tag = change.kind === "wiki" ? "wiki #" : "#";
  if (change.action === "correct" && change.new_id !== null) {
    const olds = change.old_ids.map((id) => `#${id}`).join(", ");
    return `🧠 Corrected ${olds} → #${change.new_id}: ${quoted(memoryRowText(store, "fact", change.new_id))}`;
  }
  return change.old_ids.map((id) => `🧠 Retired ${tag}${id}: ${quoted(memoryRowText(store, change.kind, id))}`).join("\n");
}

/** Queue the Undo card through the outbox (rendered by the Telegram adapter's rich renderer). */
export function enqueueMemoryChangeCard(
  store: RunStore, change: MemoryChange, o: { target: Parameters<RunStore["enqueueNotification"]>[0]["target"]; idempotency_key: string; correlation_id: string; run_id?: string }
): void {
  const queued = store.enqueueNotification({
    target: o.target, intent_type: "progress", idempotency_key: o.idempotency_key, correlation_id: o.correlation_id,
    ...(o.run_id ? { run_id: o.run_id } : {}),
    payload: { text: memoryChangeCardText(store, change), buttons: [memoryUndoButton(change.change_id)] }
  });
  // never silent: the change stands either way, but a card that did not queue leaves Paco without his Undo
  if (queued.status === "conflict") console.error(`[memory] undo card for ${change.change_id} was not queued: ${queued.error}`);
}

export interface MemoryToolDeps {
  store: RunStore; run_id: string; chat_id: string; state: MemoryTurnState;
  embed: (query: string) => Promise<Float32Array | null>;
  /** True only on the approval-gated memory_correct_write entry: a write never runs through the ungated search entry. */
  gated: boolean;
}

/**
 * Before the approval card (bridge preflight): every trust limit refuses here, so Paco never sees a card for a write
 * code would refuse; otherwise the card's detail says exactly what changes — each id with its current text, and for
 * correct the full new text.
 */
export function memoryWritePreflight(
  d: Omit<MemoryToolDeps, "embed" | "gated">, input: Record<string, unknown>
): { refused: { reason: string; text: string } } | { card_detail: string } {
  const req = parseMemoryRequest(input);
  const reason = "refusal" in req ? req.refusal : req.action === "search" ? "bad_input" : writeRefusal(d, req);
  if (reason !== null) return { refused: { reason, text: refusalText(reason) } };
  const w = req as Exclude<MemoryRequest, { action: "search" }>;
  const olds = w.ids.map((id) => `${w.kind === "wiki" ? "wiki " : ""}#${id}: ${quotedFull(memoryRowText(d.store, w.kind, id))}`);
  const head = w.action === "retire" ? `retire ${w.ids.length} ${w.kind === "wiki" ? "wiki page(s)" : "fact(s)"}:` : `correct ${w.ids.length} fact(s) into one new fact:`;
  return { card_detail: [head, ...olds, ...(w.action === "correct" ? [`New text: "${w.correction}"`] : [])].join("\n") };
}

/** The memory_correct adapter: search offers ids; retire/correct pass every code-owned limit or change nothing. */
export async function executeMemoryCorrect(d: MemoryToolDeps, input: Record<string, unknown>): Promise<ToolAdapterResult> {
  const req = parseMemoryRequest(input);
  if ("refusal" in req) return refusal(req.refusal);
  if (req.action === "search") return memorySearch(d, req);
  if (!d.gated) return refusal("bad_input");
  const refused = writeRefusal(d, req);
  if (refused) return refusal(refused);
  const change = applyChange(d, req);
  if (!change) return refusal("not_active");
  d.state.changed += change.old_ids.length;
  for (const id of req.ids) d.state.offered[req.kind].delete(id);
  recordChange(d, change);
  const what = change.new_id !== null ? `Corrected ${change.old_ids.map((i) => `#${i}`).join(", ")} → #${change.new_id}.`
    : `Retired ${change.old_ids.map((i) => `#${i}`).join(", ")}.`;
  return { ok: true, output: { answer: `${what} Paco got an Undo button for this change.` } };
}

async function memorySearch(d: MemoryToolDeps, req: Extract<MemoryRequest, { action: "search" }>): Promise<ToolAdapterResult> {
  const rows = searchActiveMemory(d.store, req.kind, d.chat_id, req.query, await d.embed(req.query));
  for (const r of rows) d.state.offered[req.kind].add(r.id);
  const noun = req.kind === "wiki" ? "wiki pages" : "facts";
  if (rows.length === 0) return { ok: true, output: { answer: `No active ${noun} match. Try other words.` } };
  const lines = renderMemoryCandidates(rows, MEMORY_SEARCH_TEXT_CHARS);
  return { ok: true, output: { answer: [`Active ${noun} (retire or correct takes ids from this list only):`, ...lines].join("\n") } };
}

/** The trust limits, in order: Paco's own turn, no untrusted read earlier in it, caps, ids offered by this turn. */
function writeRefusal(d: Pick<MemoryToolDeps, "store" | "run_id" | "state">, req: Exclude<MemoryRequest, { action: "search" }>): string | null {
  if (d.store.runSource(d.run_id) !== "telegram") return "not_operator_turn";
  if (d.store.runLoopCapabilities(d.run_id).some((c) => !MEMORY_CLEAN_PRIOR_STEPS.has(c))) return "tainted_turn";
  if (req.ids.length > MEMORY_IDS_PER_CALL_MAX) return "too_many";
  if (req.ids.some((id) => !d.state.offered[req.kind].has(id))) return "not_offered";
  if (d.state.changed + req.ids.length > MEMORY_CHANGES_PER_TURN_MAX) return "too_many";
  return null;
}

function applyChange(d: MemoryToolDeps, req: Exclude<MemoryRequest, { action: "search" }>): MemoryChange | null {
  if (req.action === "retire") return d.store.retireMemoryRows({ kind: req.kind, ids: req.ids, chat_id: d.chat_id, run_id: d.run_id });
  const userTurn = [...d.store.getRecentChatTurns(d.chat_id, 20)].reverse().find((t) => t.role === "user" && t.run_id === d.run_id);
  return d.store.correctEpisodicFacts({ ids: req.ids, correction: req.correction, chat_id: d.chat_id, run_id: d.run_id,
    ...(userTurn ? { source_turn_id: userTurn.turn_id } : {}) });
}

/** The ledger row (ids, kind, action, counts only) and the Undo card to the run's chat. */
function recordChange(d: MemoryToolDeps, change: MemoryChange): void {
  d.store.appendRunLedgerEvent(d.run_id, "memory_corrected", "core", {
    action: change.action, kind: change.kind, old_ids: change.old_ids, new_id: change.new_id, change_id: change.change_id,
    count: change.old_ids.length
  });
  enqueueMemoryChangeCard(d.store, change, { target: d.store.getRunNotifyTarget(d.run_id), idempotency_key: `memory:${change.change_id}`,
    correlation_id: d.run_id, run_id: d.run_id });
}
