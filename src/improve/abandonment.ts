import { recordImproveSignal } from "../decisions/improve-signals.js";
import { cosineSimilarity } from "../llm/embeddings.js";
import type { AbandonTurnRow, RunStore } from "../run/run-store.js";
import { ensureEmbeddings, type Embedder } from "./recurrence.js";

/** Abandonment (2b-ii §3.4, W2): Paco's turn B within 10 minutes of Houge's reply to A, ≥ 20 chars, not a memory-lane turn, near A's text. Once per A, durably (the inbox). */
export const ABANDON_WINDOW_MS = 600_000;
export const ABANDON_MIN_CHARS = 20;
interface Pair { a: AbandonTurnRow; reply: AbandonTurnRow; b: AbandonTurnRow }

/** For each reply, the next user turn of the same chat inside the window that is a re-ask candidate. */
function candidatePairs(turns: readonly AbandonTurnRow[]): Pair[] {
  const byChat = new Map<string, AbandonTurnRow[]>();
  for (const t of turns) byChat.set(t.chat_id, [...(byChat.get(t.chat_id) ?? []), t]);
  const pairs: Pair[] = [];
  for (const rows of byChat.values()) {
    for (let i = 0; i < rows.length; i++) {
      const reply = rows[i]!;
      if (reply.role !== "assistant") continue;
      const a = rows.slice(0, i).reverse().find((t) => t.role === "user" && t.run_id === reply.run_id);
      const b = rows.slice(i + 1).find((t) => t.role === "user");
      if (!a || !b || b.run_id === reply.run_id || Date.parse(b.created_at) - Date.parse(reply.created_at) > ABANDON_WINDOW_MS) continue;
      if (Array.from(b.text).length < ABANDON_MIN_CHARS || b.lane === "memory" || a.lane === null) continue;
      pairs.push({ a, reply, b });
    }
  }
  return pairs;
}

export async function computeAbandonment(d: { store: RunStore; now: string; gate: number; embed: Embedder; embedModel: string; signal: AbortSignal }): Promise<number> {
  const since = new Date(Date.parse(d.now) - 24 * 60 * 60 * 1000 - ABANDON_WINDOW_MS).toISOString();
  const pairs = candidatePairs(d.store.listAbandonTurns(since)).filter((p) => !d.store.hasImproveSignal("abandoned", p.a.run_id));
  const turns = [...new Map(pairs.flatMap((p) => [[p.a.turn_id, p.a], [p.b.turn_id, p.b]] as const)).values()];
  const { vectors } = await ensureEmbeddings(d.store, turns, d.embed, d.embedModel, d.now, d.signal);
  let n = 0;
  for (const p of pairs) {
    const va = vectors.get(p.a.turn_id), vb = vectors.get(p.b.turn_id);
    if (!va || !vb || cosineSimilarity(va, vb) < d.gate || p.a.lane === null) continue;
    if (recordImproveSignal(d.store, { signal: "abandoned", value: p.a.lane, run_id: p.b.run_id, chat_id: p.a.chat_id, about_run_id: p.a.run_id, source_outcome_id: `ab:${p.a.turn_id}`, created_at: d.now })) n += 1;
  }
  return n;
}
