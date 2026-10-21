import { describe, expect, it } from "vitest";
import { computeAbandonment } from "../../src/improve/abandonment.js";
import { RunStore } from "../../src/run/run-store.js";
import { createTelegramTurn } from "../helpers/runs.js";

// Spec 2b-ii §3.4: B within 10 min of Houge's reply to A, same chat, ≥ 20 chars, B's run not on the memory lane, cosine
// (A's text, B's text) ≥ the gate → one `abandoned` row on A's run with A's lane, once per A (durable: the inbox, not a daily memo).
const T = (m: number) => new Date(Date.parse("2026-10-21T09:00:00.000Z") + m * 60_000).toISOString();
const verdict = (s: RunStore, run_id: string, lane: "lookup" | "memory" | "answer") => s.insertJevVerdict({ run_id, category: "lookup", breadth: null, reasoning: null, actions: null, sets_rule: null,
  rule_scope: null, lane, role: "default", effort: null, cascade: null, save_outcome: "none", route_outcome: "fallback", reason: "jev_skipped", skip_reason: null, quoted_turn_id: null });
function turn(s: RunStore, text: string, at: number, reply: string | null, lane: "lookup" | "memory" | "answer"): string {
  const { run_id } = createTelegramTurn(s, text, T(at));
  // intake caps queued runs (3) and accepted commands per minute (5) per actor; these turns are long past, so close the run and clear the audit (tests only, raw SQL)
  const db = (s as unknown as { db: { prepare(q: string): { run(...a: string[]): unknown } } }).db;
  db.prepare("UPDATE runs SET state = 'completed' WHERE run_id = ?").run(run_id);
  db.prepare("DELETE FROM telegram_command_audit").run();
  if (reply !== null) s.recordChatTurn({ chat_id: "555", run_id, role: "assistant", text: reply, created_at: T(at + 1) });
  verdict(s, run_id, lane);
  return run_id;
}

describe("computeAbandonment", () => {
  it("a re-ask within 10 min after the reply counts once with A's lane; an ack, a memory-lane turn, a late turn and a far text do not", async () => {
    const s = RunStore.openInMemory();
    const a = turn(s, "find the invoice from march for me", 0, "Here is what I found.", "lookup");
    turn(s, "no, the march invoice from the supplier please", 3, "Got it.", "lookup");        // B: re-ask → abandoned on A
    const c = turn(s, "find the receipt from april for me", 20, "Sure.", "lookup");
    turn(s, "ok", 22, "👍", "answer");                                                           // ack: < 20 chars
    const d = turn(s, "what did we decide about the venue?", 40, "The park.", "answer");
    turn(s, "记下来：场地定在公园，以后别再问我了", 42, "Saved.", "memory");                   // memory lane: a save, not a re-ask
    const e = turn(s, "book the table for friday at eight", 60, "Booked.", "lookup");
    turn(s, "book the table for friday at eight please", 75, "Done.", "lookup");                 // 14 min later: outside the window
    const embed = async (t: string) => (t.includes("invoice") ? Float32Array.from([1, 0]) : t.includes("receipt") ? Float32Array.from([0, 1]) : Float32Array.from([0.7, 0.7]));
    expect(await computeAbandonment({ store: s, now: T(90), gate: 0.6, embed, embedModel: "m", signal: new AbortController().signal })).toBe(1);
    expect(s.listUnconsumedSignals(10).map((r) => [r.signal, r.value, r.about_run_id])).toEqual([["abandoned", "lookup", a]]);
    expect(await computeAbandonment({ store: s, now: T(90), gate: 0.6, embed, embedModel: "m", signal: new AbortController().signal })).toBe(0); // once per A
    void c; void d; void e;
  });
  const run = (s: RunStore, embed: (t: string) => Promise<Float32Array>) => computeAbandonment({ store: s, now: T(90), gate: 0.6, embed, embedModel: "m", signal: new AbortController().signal });
  const invoiceOnly = async (t: string) => (t.includes("invoice") ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]));

  it("a B inside the window but far from A (cosine below the gate) is not a re-ask", async () => {
    const s = RunStore.openInMemory();
    turn(s, "find the invoice from march for me", 0, "Here is what I found.", "lookup");
    turn(s, "what did we decide about the venue?", 5, "The park.", "answer");
    expect(await run(s, invoiceOnly)).toBe(0);
    expect(s.listUnconsumedSignals(10)).toEqual([]);
  });
  it("the window is anchored on the reply, not on A: a late reply with A→B over 10 min but reply→B within it still counts", async () => {
    const s = RunStore.openInMemory();
    const a = turn(s, "find the invoice from march for me", 0, "Here is what I found.", "lookup");
    s.rewriteChatTurnTimeForTest(a, "assistant", T(20)); // the reply took 20 minutes
    turn(s, "no, the march invoice from the supplier please", 25, null, "lookup"); // reply→B 5 min, A→B 25 min
    expect(await run(s, invoiceOnly)).toBe(1);
    expect(s.listUnconsumedSignals(10).map((r) => [r.signal, r.value, r.about_run_id])).toEqual([["abandoned", "lookup", a]]);
  });
  it("a B at exactly reply + 600 000 ms counts (the bound is inclusive)", async () => {
    const s = RunStore.openInMemory();
    const a = turn(s, "find the invoice from march for me", 0, "Here is what I found.", "lookup"); // reply at T(1)
    turn(s, "no, the march invoice from the supplier please", 11, null, "lookup"); // T(11) = T(1) + 600 000 ms
    expect(await run(s, invoiceOnly)).toBe(1);
    expect(s.listUnconsumedSignals(10).map((r) => r.about_run_id)).toEqual([a]);
  });
});
