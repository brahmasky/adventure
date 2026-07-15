import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobToFloat32 } from "../../src/llm/embeddings.js";
import {
  DEFAULT_EPISODIC_FACT_CAP_PER_CHAT,
  resolveEpisodicFactCapPerChat,
  RunStore
} from "../../src/run/run-store.js";

// Hermetic (self-write test-gate rule): pin the episodic cap env var to its code
// default (delete) so a daemon .env override can never flip these assertions red.
const EPISODIC_ENV_VARS = ["HOUGE_EPISODIC_FACT_CAP_PER_CHAT"] as const;
let savedEnv: Record<string, string | undefined> = {};
let dirs: string[] = [];
beforeEach(() => {
  savedEnv = {};
  for (const key of EPISODIC_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of EPISODIC_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => {
    prepare(sql: string): { run(...values: Array<string | number>): unknown };
    close(): void;
  };
};

const NOW = "2026-07-15T12:00:00.000Z";
const CHAT = "222";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-episodic-"));
  dirs.push(dir);
  return join(dir, "houge.sqlite");
}

describe("episodic_facts migration (Phase M B1)", () => {
  it("is idempotent: reopening the same db re-runs migrate() without error or data loss", () => {
    const path = tempDbPath();
    const store = RunStore.open(path);
    const id = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", created_at: NOW });
    store.close();

    const reopened = RunStore.open(path);
    try {
      const row = reopened.getEpisodicFact(id);
      expect(row?.fact).toBe("Paco lives in Sydney");
      expect(row?.status).toBe("active");
    } finally {
      reopened.close();
    }
  });

  it("addEpisodicFact stores defaults + valid_from = created_at (bi-temporal, ADR 0005 §4)", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addEpisodicFact({
        chat_id: CHAT,
        fact: "  Paco cycles on weekends  ",
        participants: ["Paco"],
        source_turn_ids: ["turn_a", "turn_b"],
        occurred_at: "2026-07-14",
        salience: 0.8,
        created_at: NOW
      });
      const row = store.getEpisodicFact(id)!;
      expect(row.fact).toBe("Paco cycles on weekends");
      expect(JSON.parse(row.participants)).toEqual(["Paco"]);
      expect(JSON.parse(row.source_turn_ids)).toEqual(["turn_a", "turn_b"]);
      expect(row.occurred_at).toBe("2026-07-14");
      expect(row.valid_from).toBe(NOW);
      expect(row.valid_until).toBeNull();
      expect(row.salience).toBe(0.8);
      expect(row.status).toBe("active");
      expect(row.reuse_value).toBe(1.0);
      expect(row.embedding).toBeNull();
      expect(row.embedding_model).toBeNull();
    } finally {
      store.close();
    }
  });

  it("stores an embedding as BLOB bytes that round-trip via blobToFloat32", () => {
    const store = RunStore.openInMemory();
    try {
      const vector = Float32Array.from([0.5, -1.25, 3]);
      const id = store.addEpisodicFact({
        chat_id: CHAT,
        fact: "Paco prefers concise answers",
        embedding: vector,
        embedding_model: "embeddinggemma",
        created_at: NOW
      });
      const row = store.getEpisodicFact(id)!;
      expect(row.embedding_model).toBe("embeddinggemma");
      expect(Array.from(blobToFloat32(row.embedding!))).toEqual([0.5, -1.25, 3]);
    } finally {
      store.close();
    }
  });
});

describe("FTS5 mirror stays in sync via triggers", () => {
  it("insert is indexed; a superseded row stays indexed but is filtered by status", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", created_at: NOW });
      expect(store.getEpisodicFactsForReconcile(CHAT, "Sydney", 5).map((f) => f.id)).toEqual([id]);

      const newId = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Melbourne", created_at: NOW });
      store.supersedeEpisodicFact(id, newId, NOW);
      expect(store.getEpisodicFactsForReconcile(CHAT, "Melbourne", 5).map((f) => f.id)).toEqual([newId]);
      // "Sydney" now matches only the superseded row → no ACTIVE FTS hit → the recent-N
      // fallback returns the active row instead (the recall floor is never empty).
      expect(store.getEpisodicFactsForReconcile(CHAT, "Sydney", 5).map((f) => f.id)).toEqual([newId]);
    } finally {
      store.close();
    }
  });

  it("raw UPDATE/DELETE on the content table keep the index in sync (the au/ad triggers)", () => {
    // The store itself never rewrites or deletes fact rows (invalidate-don't-delete),
    // but the triggers must hold for ANY writer (manual surgery, future consolidation) —
    // a drifted external-content FTS index silently corrupts every MATCH.
    const path = tempDbPath();
    const store = RunStore.open(path);
    try {
      const id = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", created_at: NOW });

      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE episodic_facts SET fact = ? WHERE id = ?").run("Paco lives in Melbourne", id);
      expect(store.getEpisodicFactsForReconcile(CHAT, "Melbourne", 5).map((f) => f.id)).toEqual([id]);

      raw.prepare("DELETE FROM episodic_facts WHERE id = ?").run(id);
      raw.close();
      expect(store.getEpisodicFactsForReconcile(CHAT, "Melbourne", 5)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("getEpisodicFactsForReconcile (FTS candidates + recent-N fallback)", () => {
  it("ranks FTS keyword matches and scopes them to the chat + active status", () => {
    const store = RunStore.openInMemory();
    try {
      const sydney = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", created_at: NOW });
      store.addEpisodicFact({ chat_id: CHAT, fact: "Paco prefers concise answers", created_at: NOW });
      store.addEpisodicFact({ chat_id: "999", fact: "Sydney is another chat's fact", created_at: NOW });

      const hits = store.getEpisodicFactsForReconcile(CHAT, "moving away from Sydney next year", 5);
      expect(hits.map((f) => f.id)).toEqual([sydney]);
    } finally {
      store.close();
    }
  });

  it("falls back to the chat's recent active facts when FTS has no hit (e.g. unsegmented CJK)", () => {
    const store = RunStore.openInMemory();
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "他住在悉尼", created_at: "2026-07-14T00:00:00.000Z" });
      const newest = store.addEpisodicFact({ chat_id: CHAT, fact: "他周末骑车", created_at: NOW });

      // unicode61 indexes a CJK run as ONE token, so no keyword overlap ⇒ zero FTS hits.
      const hits = store.getEpisodicFactsForReconcile(CHAT, "喜欢简洁的回答", 1);
      expect(hits.map((f) => f.id)).toEqual([newest]); // recent-first fallback, capped at k
    } finally {
      store.close();
    }
  });

  it("a hostile candidate full of MATCH syntax never throws (tokens are extracted + quoted)", () => {
    const store = RunStore.openInMemory();
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", created_at: NOW });
      expect(() =>
        store.getEpisodicFactsForReconcile(CHAT, 'NEAR( "x" OR *) AND fact:^ -"', 5)
      ).not.toThrow();
    } finally {
      store.close();
    }
  });
});

describe("saveReconciledFact (verdict-driven, mirrors saveReconciledLesson)", () => {
  it("ADD inserts a fresh active row", () => {
    const store = RunStore.openInMemory();
    try {
      const result = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Sydney" },
        { verdict: "ADD" },
        NOW
      );
      expect(result.verb).toBe("add");
      expect(store.getEpisodicFact(result.id!)?.status).toBe("active");
    } finally {
      store.close();
    }
  });

  it("DROP writes nothing", () => {
    const store = RunStore.openInMemory();
    try {
      const result = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Sydney" },
        { verdict: "DROP" },
        NOW
      );
      expect(result).toEqual({ verb: "drop", fact: "Paco lives in Sydney", prunedIds: [] });
      expect(store.getActiveEpisodicFacts(CHAT)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("SUPERSEDE links BOTH directions, stamps valid_until, and pays the target's correction penalty", () => {
    const store = RunStore.openInMemory();
    try {
      const oldId = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", created_at: "2026-07-01T00:00:00.000Z" });
      const result = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Melbourne" },
        { verdict: "SUPERSEDE", id: oldId },
        NOW
      );
      expect(result.verb).toBe("supersede");
      expect(result.supersededId).toBe(oldId);

      const old = store.getEpisodicFact(oldId)!;
      expect(old.status).toBe("superseded"); // invalidated, NEVER deleted
      expect(old.superseded_by).toBe(result.id);
      expect(old.valid_until).toBe(NOW); // "true until NOW" stays answerable
      expect(old.corrected_count).toBe(1);
      expect(old.reuse_value).toBe(0.5);

      const fresh = store.getEpisodicFact(result.id!)!;
      expect(fresh.supersedes).toBe(oldId);
      expect(fresh.status).toBe("active");
    } finally {
      store.close();
    }
  });

  it("UPDATE stores the merged text as a NEW row superseding the prior (no in-place rewrite)", () => {
    const store = RunStore.openInMemory();
    try {
      const oldId = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco cycles", created_at: "2026-07-01T00:00:00.000Z" });
      const result = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco cycles on weekends" },
        { verdict: "UPDATE", id: oldId, text: "Paco cycles on weekends around Sydney" },
        NOW
      );
      expect(result.verb).toBe("update");
      expect(result.fact).toBe("Paco cycles on weekends around Sydney");
      expect(store.getEpisodicFact(oldId)?.status).toBe("superseded");
      // UPDATE supplements — no correction penalty against the target.
      expect(store.getEpisodicFact(oldId)?.corrected_count).toBe(0);
      expect(store.getEpisodicFact(result.id!)?.fact).toBe("Paco cycles on weekends around Sydney");
    } finally {
      store.close();
    }
  });

  it("a SUPERSEDE naming another CHAT's fact degrades to ADD (defense-in-depth)", () => {
    const store = RunStore.openInMemory();
    try {
      const foreign = store.addEpisodicFact({ chat_id: "999", fact: "someone else's fact", created_at: NOW });
      const result = store.saveReconciledFact(
        { chat_id: CHAT, fact: "Paco lives in Sydney" },
        { verdict: "SUPERSEDE", id: foreign },
        NOW
      );
      expect(result.verb).toBe("add");
      expect(store.getEpisodicFact(foreign)?.status).toBe("active"); // untouched
    } finally {
      store.close();
    }
  });

  it("overflow beyond the per-chat cap prunes the lowest reuse_value rows, sparing the new row", () => {
    const store = RunStore.openInMemory();
    try {
      const low = store.addEpisodicFact({ chat_id: CHAT, fact: "low value", created_at: NOW });
      store.saveReconciledFact({ chat_id: CHAT, fact: "kept" }, { verdict: "ADD" }, NOW, 2);
      // Sink the first row's value, then overflow the cap of 2.
      store.saveReconciledFact({ chat_id: CHAT, fact: "replacement" }, { verdict: "SUPERSEDE", id: low }, NOW, 2);
      const replacement = store.getActiveEpisodicFacts(CHAT).find((f) => f.fact === "replacement")!;
      // reuse penalty already landed on `low` before it was superseded; now overflow a cap of 2:
      const result = store.saveReconciledFact({ chat_id: CHAT, fact: "newest" }, { verdict: "ADD" }, NOW, 2);
      expect(result.prunedIds.length).toBe(1);
      expect(result.prunedIds).not.toContain(result.id);
      expect(store.getEpisodicFact(result.id!)?.status).toBe("active");
      expect(store.getActiveEpisodicFacts(CHAT).length).toBe(2);
      expect(store.getEpisodicFact(replacement.id)?.status).toBe("active");
    } finally {
      store.close();
    }
  });
});

describe("touchEpisodicApplied + watermark + trigger queries", () => {
  it("touchEpisodicApplied increments applied_count and stamps last_used (M2 attribution)", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", created_at: NOW });
      store.touchEpisodicApplied([id], NOW);
      const row = store.getEpisodicFact(id)!;
      expect(row.applied_count).toBe(1);
      expect(row.last_used).toBe(NOW);
    } finally {
      store.close();
    }
  });

  it("watermark upserts per chat and reads back", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.getEpisodicDistillWatermark(CHAT)).toBeNull();
      store.setEpisodicDistillWatermark({ chat_id: CHAT, last_turn_created_at: NOW, last_distilled_at: NOW });
      expect(store.getEpisodicDistillWatermark(CHAT)).toEqual({
        chat_id: CHAT,
        last_turn_created_at: NOW,
        last_distilled_at: NOW
      });
      const later = "2026-07-16T00:00:00.000Z";
      store.setEpisodicDistillWatermark({ chat_id: CHAT, last_turn_created_at: later, last_distilled_at: later });
      expect(store.getEpisodicDistillWatermark(CHAT)?.last_turn_created_at).toBe(later);
    } finally {
      store.close();
    }
  });

  it("listChatsWithUndistilledTurns: user turns past the watermark, oldest-starved first", () => {
    const store = RunStore.openInMemory();
    try {
      store.recordChatTurn({ chat_id: "a", run_id: "r1", role: "user", text: "hi", created_at: "2026-07-15T01:00:00.000Z" });
      store.recordChatTurn({ chat_id: "b", run_id: "r2", role: "user", text: "yo", created_at: "2026-07-15T02:00:00.000Z" });
      // assistant-only turns never count as undistilled work
      store.recordChatTurn({ chat_id: "c", run_id: "r3", role: "assistant", text: "…", created_at: "2026-07-15T00:30:00.000Z" });

      expect(store.listChatsWithUndistilledTurns().map((c) => c.chat_id)).toEqual(["a", "b"]);

      // Advancing a's watermark past its turn removes it from the queue.
      store.setEpisodicDistillWatermark({ chat_id: "a", last_turn_created_at: "2026-07-15T01:00:00.000Z", last_distilled_at: NOW });
      expect(store.listChatsWithUndistilledTurns().map((c) => c.chat_id)).toEqual(["b"]);
    } finally {
      store.close();
    }
  });

  it("recordEpisodicDistillPass appends one run-less ledger event with the counts", () => {
    const store = RunStore.openInMemory();
    try {
      store.recordEpisodicDistillPass(CHAT, { facts_added: 2, superseded: 1, dropped: 1, turns_read: 6 });
      const events = store.getLedgerEvents().filter((e) => e.event_type === "episodic_distill_pass");
      expect(events.length).toBe(1);
      expect(events[0]!.payload).toMatchObject({
        chat_id: CHAT,
        facts_added: 2,
        superseded: 1,
        dropped: 1,
        turns_read: 6
      });
    } finally {
      store.close();
    }
  });
});

describe("searchEpisodicFactsFts (M2 retrieval keyword leg)", () => {
  it("returns active chat-scoped rows with a bm25 rank (negative = a real match), best first", () => {
    const store = RunStore.openInMemory();
    try {
      const sydney = store.addEpisodicFact({ chat_id: CHAT, fact: "Paco lives in Sydney", created_at: NOW });
      store.addEpisodicFact({ chat_id: CHAT, fact: "Paco prefers concise answers", created_at: NOW });
      store.addEpisodicFact({ chat_id: "999", fact: "Sydney belongs to another chat", created_at: NOW });

      const hits = store.searchEpisodicFactsFts(CHAT, "visiting Sydney soon", 30);
      expect(hits.map((h) => h.id)).toEqual([sydney]);
      expect(hits[0]!.rank).toBeLessThan(0);
    } finally {
      store.close();
    }
  });

  it("returns [] (never the recent-N fallback) on zero hits — the caller's other legs carry relevance", () => {
    const store = RunStore.openInMemory();
    try {
      store.addEpisodicFact({ chat_id: CHAT, fact: "他住在悉尼", created_at: NOW });
      // Unsegmented CJK (the known unicode61 constraint) and hostile MATCH syntax both degrade to [].
      expect(store.searchEpisodicFactsFts(CHAT, "喜欢骑车", 30)).toEqual([]);
      expect(store.searchEpisodicFactsFts(CHAT, 'NEAR( "x" OR *) AND fact:^ -"', 30)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("mergeEpisodicFacts (B4 consolidation write)", () => {
  it("ADDs the merged row and supersedes EVERY source bidirectionally (invalidate, never delete)", () => {
    const store = RunStore.openInMemory();
    try {
      const a = store.addEpisodicFact({
        chat_id: CHAT,
        fact: "Paco cycles",
        salience: 0.5,
        participants: ["Paco"],
        source_turn_ids: ["t1"],
        created_at: "2026-07-01T00:00:00.000Z"
      });
      const b = store.addEpisodicFact({
        chat_id: CHAT,
        fact: "Paco rides his bike on weekends",
        salience: 0.9,
        participants: ["Paco"],
        source_turn_ids: ["t2"],
        created_at: "2026-07-10T00:00:00.000Z"
      });

      const merged = store.mergeEpisodicFacts([a, b], { fact: "Paco cycles on weekends" }, NOW)!;
      const row = store.getEpisodicFact(merged.id)!;
      expect(row.fact).toBe("Paco cycles on weekends");
      expect(row.salience).toBe(0.9); // max of the sources
      expect(row.reuse_value).toBe(2); // sum (1 + 1), under the cap
      expect(row.valid_from).toBe("2026-07-01T00:00:00.000Z"); // earliest — true since the FIRST source
      expect(JSON.parse(row.participants)).toEqual(["Paco"]); // union, deduped
      expect(JSON.parse(row.source_turn_ids).sort()).toEqual(["t1", "t2"]); // provenance union

      for (const id of [a, b]) {
        const source = store.getEpisodicFact(id)!;
        expect(source.status).toBe("superseded");
        expect(source.superseded_by).toBe(merged.id);
        expect(source.valid_until).toBe(NOW);
      }
      expect(store.getActiveEpisodicFacts(CHAT).map((f) => f.id)).toEqual([merged.id]);
    } finally {
      store.close();
    }
  });

  it("caps the inherited reuse_value sum at 5 (a merged duplicate must not become immortal)", () => {
    const store = RunStore.openInMemory();
    try {
      const ids = Array.from({ length: 6 }, (_, i) =>
        store.addEpisodicFact({ chat_id: CHAT, fact: `variant ${i}`, created_at: NOW })
      );
      const merged = store.mergeEpisodicFacts(ids, { fact: "the one fact" }, NOW)!;
      expect(store.getEpisodicFact(merged.id)!.reuse_value).toBe(5); // 6 × 1.0, capped
    } finally {
      store.close();
    }
  });

  it("REFUSES (undefined, nothing written) on <2 sources, mixed chats, or a non-active source", () => {
    // WHY: a bad cluster must never half-merge or retire another chat's facts —
    // refusal is the non-destructive failure mode.
    const store = RunStore.openInMemory();
    try {
      const a = store.addEpisodicFact({ chat_id: CHAT, fact: "a", created_at: NOW });
      const foreign = store.addEpisodicFact({ chat_id: "999", fact: "b", created_at: NOW });
      const pruned = store.addEpisodicFact({ chat_id: CHAT, fact: "c", created_at: NOW });
      const replacement = store.addEpisodicFact({ chat_id: CHAT, fact: "c2", created_at: NOW });
      store.supersedeEpisodicFact(pruned, replacement, NOW);

      expect(store.mergeEpisodicFacts([a], { fact: "solo" }, NOW)).toBeUndefined();
      expect(store.mergeEpisodicFacts([a, foreign], { fact: "cross-chat" }, NOW)).toBeUndefined();
      expect(store.mergeEpisodicFacts([a, pruned], { fact: "with dead row" }, NOW)).toBeUndefined();
      expect(store.getEpisodicFact(a)!.status).toBe("active"); // untouched by every refusal
      expect(store.getActiveEpisodicFacts(CHAT).some((f) => f.fact === "solo")).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("episodic_consolidate_state migration (Phase M B4)", () => {
  it("is idempotent across reopen and seeds a NULL last-run (first tick runs immediately)", () => {
    const path = tempDbPath();
    const store = RunStore.open(path);
    expect(store.getEpisodicConsolidateLastRun()).toBeNull();
    store.markEpisodicConsolidateRan(NOW);
    store.close();

    const reopened = RunStore.open(path); // re-runs migrate() — must not error or reset
    try {
      expect(reopened.getEpisodicConsolidateLastRun()).toBe(NOW);
    } finally {
      reopened.close();
    }
  });
});

describe("resolveEpisodicFactCapPerChat", () => {
  it("defaults to 200 and honors a positive-integer override", () => {
    expect(resolveEpisodicFactCapPerChat({})).toBe(DEFAULT_EPISODIC_FACT_CAP_PER_CHAT);
    expect(DEFAULT_EPISODIC_FACT_CAP_PER_CHAT).toBe(200);
    expect(resolveEpisodicFactCapPerChat({ HOUGE_EPISODIC_FACT_CAP_PER_CHAT: "50" })).toBe(50);
    expect(resolveEpisodicFactCapPerChat({ HOUGE_EPISODIC_FACT_CAP_PER_CHAT: "0" })).toBe(200);
    expect(resolveEpisodicFactCapPerChat({ HOUGE_EPISODIC_FACT_CAP_PER_CHAT: "garbage" })).toBe(200);
  });
});
