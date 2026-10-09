import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { RunStore } from "../../src/run/run-store.js";

/**
 * Spec §2.2.1: a Telegram reply anchors the turn to the STORED message it quotes. A wrong resolution would hand Jev and
 * the planner words nobody said in this thread, so anything not provably that one turn resolves to nothing.
 */
let store: RunStore;
beforeEach(() => { store = RunStore.openInMemory(); });
afterEach(() => { store.close(); });

let seq = 0;
/** A Telegram turn run born from message `messageId` in `chat` (the adapter's source_reference, telegram-trigger-adapter.ts:372), with Paco's chat turn. */
function telegramRun(chat: string, messageId: number, text = "以后回复短一点"): string {
  seq += 1;
  const created = store.createOrGet(buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: text, requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: chat }, idempotency_key: `telegram:${seq}:${messageId}`,
    source_reference: `telegram:update:${seq}:message:${messageId}`
  }));
  if (created.status !== "created") throw new Error(`expected created, got ${created.status}`);
  store.recordChatTurn({ chat_id: chat, run_id: created.run_id, role: "user", text });
  return created.run_id;
}

/** Claim and deliver the oldest queued notification as Telegram message `id` (the adapter's provider id shape). */
function deliver(id: number): void {
  const claimed = store.claimNextNotification("w", 60);
  if (!claimed) throw new Error("nothing queued");
  store.markNotificationDelivered(claimed.notification_id, `telegram:${id}`);
}

/** Houge's reply to a run: its assistant chat turn, then its final_report delivered as message `id`. */
function hougeReply(run_id: string, chat: string, id: number, text = "要不要我查一下？", intent?: string): void {
  store.recordChatTurn({ chat_id: chat, run_id, role: "assistant", text, ...(intent ? { intent } : {}) });
  store.enqueueFinalReportNotification(run_id, { text, report_path: "r" });
  deliver(id);
}

describe("resolveQuotedTurn (spec §2.2.1)", () => {
  it("a quote of a delivered Houge reply resolves to that run's assistant turn — a NULL intent included", () => {
    // `intent <> 'evolution_report'` would drop a NULL-intent reply; the rule must be NULL-safe
    const run = telegramRun("555", 10);
    hougeReply(run, "555", 11);
    expect(store.resolveQuotedTurn("555", 11)).toMatchObject({ ok: true, role: "houge", turn: { run_id: run, role: "assistant", text: "要不要我查一下？", intent: null } });
  });

  it("a quote of Paco's own message resolves to that run's user turn; message 12 never matches message 123", () => {
    // a prefix match would anchor the turn to a different message of his
    const run = telegramRun("555", 12, "did you restart?");
    telegramRun("555", 123, "明天天气怎么样");
    expect(store.resolveQuotedTurn("555", 12)).toMatchObject({ ok: true, role: "user", turn: { run_id: run, text: "did you restart?" } });
    expect(store.resolveQuotedTurn("555", 1)).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("an unknown id resolves to nothing (a message from before the mapping, or never stored)", () => {
    telegramRun("555", 12);
    expect(store.resolveQuotedTurn("555", 999)).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("a quote from another chat never resolves: Telegram message ids are per chat", () => {
    const run = telegramRun("555", 12);
    hougeReply(run, "555", 13);
    expect(store.resolveQuotedTurn("777", 12)).toEqual({ ok: false, reason: "no_mapping" });
    expect(store.resolveQuotedTurn("777", 13)).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("an evolution report is never the quoted answer: its own message is not_final, and the run's reply skips its row", () => {
    // enqueueEvolutionReportNotification queues final_report too and records a later assistant row (run-store.ts:5648)
    const run = telegramRun("555", 20);
    hougeReply(run, "555", 21, "the answer", "loop");
    store.enqueueEvolutionReportNotification(run, "skill_author", { text: "🐒 report" });
    deliver(22);
    expect(store.resolveQuotedTurn("555", 21)).toMatchObject({ ok: true, role: "houge", turn: { text: "the answer" } });
    expect(store.resolveQuotedTurn("555", 22)).toEqual({ ok: false, reason: "not_final" });
  });

  it("a run with two assistant rows is ambiguous, never a guess", () => {
    const run = telegramRun("555", 30);
    store.recordChatTurn({ chat_id: "555", run_id: run, role: "assistant", text: "first part" });
    hougeReply(run, "555", 31, "second part");
    expect(store.resolveQuotedTurn("555", 31)).toEqual({ ok: false, reason: "ambiguous" });
  });
});

describe("chat_turns.quoted_turn_id (spec §2.2.1: the replay rebuilds the same state)", () => {
  it("records the quoted turn on the new message's row; a plain message reads null", () => {
    const run = telegramRun("555", 40);
    store.recordChatTurn({ chat_id: "555", run_id: run, role: "user", text: "好", quoted_turn_id: "turn_q" });
    expect(store.getRecentChatTurns("555", 10).map((t) => t.quoted_turn_id)).toEqual([null, "turn_q"]);
  });

  it("migrates an older file DB once and reopens idempotently (the ALTER is guarded by table_info)", () => {
    const sqlite = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const dir = mkdtempSync(join(tmpdir(), "hqt-"));
    try {
      const path = join(dir, "h.sqlite");
      RunStore.open(path).close();
      const raw = new sqlite.DatabaseSync(path); // an older DB: the column and its migration row not yet there
      raw.exec("ALTER TABLE chat_turns DROP COLUMN quoted_turn_id; DELETE FROM schema_migrations WHERE version = '2026-10-07-chat-turns-quoted'");
      raw.close();
      const migrated = RunStore.open(path);
      migrated.recordChatTurn({ chat_id: "555", run_id: "r", role: "user", text: "好", quoted_turn_id: "turn_q" });
      expect(migrated.getRecentChatTurns("555", 1)[0]?.quoted_turn_id).toBe("turn_q");
      migrated.close();
      expect(() => RunStore.open(path).close()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
