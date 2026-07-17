import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WIKI_DECAY_DAYS, resolveWikiDecayDays } from "../../src/capabilities/wiki.js";
import {
  DEFAULT_LESSON_PRUNE_THRESHOLD,
  parseRatingHistory,
  RunStore
} from "../../src/run/run-store.js";

// Hermetic (PINNED_ENV cardinal rule): the decay tick reads these two env knobs
// internally — pin them to their code defaults (delete) and restore.
const WIKI_ENV_VARS = ["HOUGE_WIKI_DECAY_DAYS", "HOUGE_LESSON_PRUNE_THRESHOLD"] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of WIKI_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of WIKI_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const NOW = "2026-07-17T12:00:00.000Z";
const CHAT = "222";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

function addPage(store: RunStore, overrides: Partial<Parameters<RunStore["addWikiPage"]>[0]> = {}): number {
  return store.addWikiPage({
    topic_slug: "asml-q2-2026",
    title: "ASML Q2 2026 earnings",
    summary: "Beat expectations.",
    created_at: NOW,
    ...overrides
  });
}

describe("touchWikiApplied — the per-turn reuse credit", () => {
  it("bumps applied_count and stamps last_used for each id", () => {
    const store = RunStore.openInMemory();
    try {
      const a = addPage(store);
      const b = addPage(store, { topic_slug: "other", title: "Other topic" });
      store.touchWikiApplied([a], NOW);
      store.touchWikiApplied([a], NOW);

      const rowA = store.getWikiPage(a)!;
      expect(rowA.applied_count).toBe(2);
      expect(rowA.last_used).toBe(NOW);
      const rowB = store.getWikiPage(b)!;
      expect(rowB.applied_count).toBe(0);
      expect(rowB.last_used).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("appliedWikiPageIdsForChat — the attribution union (appliedLessonIdsForChat twin)", () => {
  function seed(store: RunStore, run_id: string, at: string, wiki_page_ids: number[]): void {
    store.recordChatTurn({ chat_id: CHAT, run_id, role: "user", text: "q", created_at: at });
    store.recordLoopStarted(run_id, {
      manifest: ["llm_answer"],
      hint: "ask",
      applied_artifacts: { lesson_scopes: [], lesson_ids: [], skill_scopes: [], episodic_fact_ids: [], wiki_page_ids }
    });
  }

  it("unions loop_started.applied_artifacts.wiki_page_ids across the window's runs only", () => {
    const store = RunStore.openInMemory();
    try {
      seed(store, "run_in_1", daysAgo(0.2), [1, 2]);
      seed(store, "run_in_2", daysAgo(0.1), [2, 3]);
      seed(store, "run_out", daysAgo(3), [9]); // outside the window

      // A run in another chat never leaks in.
      store.recordChatTurn({ chat_id: "999", run_id: "run_other", role: "user", text: "q", created_at: NOW });
      store.recordLoopStarted("run_other", {
        manifest: [],
        hint: "ask",
        applied_artifacts: { lesson_scopes: [], lesson_ids: [], skill_scopes: [], wiki_page_ids: [42] }
      });

      expect(store.appliedWikiPageIdsForChat(CHAT, daysAgo(1))).toEqual([1, 2, 3]);
      // sinceIso omitted → every run of the chat.
      expect(store.appliedWikiPageIdsForChat(CHAT)).toEqual([1, 2, 3, 9]);
    } finally {
      store.close();
    }
  });

  it("a loop_started without wiki_page_ids (pre-W2 events) contributes nothing — never throws", () => {
    const store = RunStore.openInMemory();
    try {
      store.recordChatTurn({ chat_id: CHAT, run_id: "run_old", role: "user", text: "q", created_at: NOW });
      store.recordLoopStarted("run_old", {
        manifest: ["llm_answer"],
        hint: "ask",
        applied_artifacts: { lesson_scopes: [], lesson_ids: [1], skill_scopes: [] }
      });
      expect(store.appliedWikiPageIdsForChat(CHAT, daysAgo(1))).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("applyRatingToWikiPages — the human eval signal (applyRatingToLessons twin)", () => {
  it("appends {rating, at}; ≥2 earns +0.25 reuse, ≤1 appends only", () => {
    const store = RunStore.openInMemory();
    try {
      const good = addPage(store);
      const low = addPage(store, { topic_slug: "other", title: "Other topic" });

      store.applyRatingToWikiPages([good], 3, NOW);
      store.applyRatingToWikiPages([low], 1, NOW);

      const goodRow = store.getWikiPage(good)!;
      expect(goodRow.reuse_value).toBeCloseTo(1.25);
      expect(parseRatingHistory(goodRow.rating_history)).toEqual([{ rating: 3, at: NOW }]);

      const lowRow = store.getWikiPage(low)!;
      expect(lowRow.reuse_value).toBeCloseTo(1.0);
      expect(parseRatingHistory(lowRow.rating_history)).toEqual([{ rating: 1, at: NOW }]);
    } finally {
      store.close();
    }
  });

  it("rating exactly 2 is the credit boundary; a missing id is skipped without throwing", () => {
    const store = RunStore.openInMemory();
    try {
      const id = addPage(store);
      store.applyRatingToWikiPages([id, 9999], 2, NOW);
      expect(store.getWikiPage(id)!.reuse_value).toBeCloseTo(1.25);
    } finally {
      store.close();
    }
  });
});

describe("runWikiDecayTick — the daily forgetting pass (runLessonDecayTick twin)", () => {
  it("decays stale actives by 20% (last_used, or created_at when never used) and emits ONE ledger event", () => {
    const store = RunStore.openInMemory();
    try {
      const staleUsed = addPage(store, { created_at: daysAgo(90) });
      store.touchWikiApplied([staleUsed], daysAgo(50));
      const staleNeverUsed = addPage(store, { topic_slug: "b", title: "B", created_at: daysAgo(46) });
      const freshByUse = addPage(store, { topic_slug: "c", title: "C", created_at: daysAgo(90) });
      store.touchWikiApplied([freshByUse], daysAgo(2));

      const result = store.runWikiDecayTick(NOW);
      expect(result).toMatchObject({ ran: true, pages_decayed: 2, pruned_ids: [] });
      expect(store.getWikiPage(staleUsed)!.reuse_value).toBeCloseTo(0.8);
      expect(store.getWikiPage(staleNeverUsed)!.reuse_value).toBeCloseTo(0.8);
      expect(store.getWikiPage(freshByUse)!.reuse_value).toBeCloseTo(1.0); // inside the window

      const events = store.getLedgerEvents().filter((e) => e.event_type === "wiki_decay_tick");
      expect(events.length).toBe(1);
      expect(events[0]!.payload).toEqual({ pages_decayed: 2, pruned_ids: [] });
    } finally {
      store.close();
    }
  });

  it("is idempotent per 24h via the wiki_decay_state latch", () => {
    const store = RunStore.openInMemory();
    try {
      expect(store.runWikiDecayTick(NOW).ran).toBe(true);
      expect(store.runWikiDecayTick(NOW).ran).toBe(false);
      expect(store.runWikiDecayTick(new Date(Date.parse(NOW) + 3_600_000).toISOString()).ran).toBe(false);
      const nextDay = new Date(Date.parse(NOW) + 25 * 3_600_000).toISOString();
      expect(store.runWikiDecayTick(nextDay).ran).toBe(true);
    } finally {
      store.close();
    }
  });

  it("prunes REVERSIBLY below the lessons prune line — the row survives, status only", () => {
    const store = RunStore.openInMemory();
    try {
      const id = addPage(store, { created_at: daysAgo(90) });
      // Walk reuse under the line: 0.2 × 0.8 = 0.16 < 0.2 (the lessons threshold).
      // @ts-expect-error — reach the private db handle to shape reuse_value.
      store.db.prepare("UPDATE wiki_pages SET reuse_value = ? WHERE id = ?").run(0.2, id);

      const result = store.runWikiDecayTick(NOW);
      expect(result.pruned_ids).toEqual([id]);
      const row = store.getWikiPage(id)!;
      expect(row.status).toBe("pruned"); // reversible, never a DELETE
      expect(row.title).toBe("ASML Q2 2026 earnings"); // the row still reads back whole
      expect(row.reuse_value).toBeCloseTo(0.16);
      expect(DEFAULT_LESSON_PRUNE_THRESHOLD).toBe(0.2); // the shared prune line
    } finally {
      store.close();
    }
  });

  it("superseded rows are EXEMPT — inactive lineage never decays", () => {
    const store = RunStore.openInMemory();
    try {
      const oldId = addPage(store, { created_at: daysAgo(90) });
      const newId = addPage(store, { topic_slug: "b", title: "B", created_at: daysAgo(90) });
      store.supersedeWikiPage(oldId, newId, NOW);

      const result = store.runWikiDecayTick(NOW);
      // Only the ACTIVE stale row decayed; the superseded one kept its standing.
      expect(result.pages_decayed).toBe(1);
      expect(store.getWikiPage(oldId)!.reuse_value).toBeCloseTo(1.0);
      expect(store.getWikiPage(newId)!.reuse_value).toBeCloseTo(0.8);
    } finally {
      store.close();
    }
  });

  it("HOUGE_WIKI_DECAY_DAYS defaults to 45 and bounds the stale window", () => {
    expect(DEFAULT_WIKI_DECAY_DAYS).toBe(45);
    expect(resolveWikiDecayDays({})).toBe(45);
    expect(resolveWikiDecayDays({ HOUGE_WIKI_DECAY_DAYS: "10" })).toBe(10);
    expect(resolveWikiDecayDays({ HOUGE_WIKI_DECAY_DAYS: "garbage" })).toBe(45);

    const store = RunStore.openInMemory();
    try {
      const inside = addPage(store, { created_at: daysAgo(44) });
      const outside = addPage(store, { topic_slug: "b", title: "B", created_at: daysAgo(46) });
      store.runWikiDecayTick(NOW);
      expect(store.getWikiPage(inside)!.reuse_value).toBeCloseTo(1.0);
      expect(store.getWikiPage(outside)!.reuse_value).toBeCloseTo(0.8);
    } finally {
      store.close();
    }
  });
});

describe("F2 regression — the FTS identity leg demands FULL token coverage (W1 live residual)", () => {
  /** The live W1 shape: the real page's title, a distinct topic sharing q2+earnings. */
  function seedAsmlPage(store: RunStore): number {
    return store.addWikiPage({
      topic_slug: "asml-2026-q2-earnings-and-analyst-opinions",
      title: "ASML 2026 Q2 earnings and analyst opinions",
      summary: "Q2 beat; analyst targets split.",
      body_md: "## Earnings\nASML beat expectations.",
      created_at: NOW
    });
  }

  it("a token-overlapping DISTINCT topic (Tesla Q2 earnings) does NOT merge into the ASML page", () => {
    const store = RunStore.openInMemory();
    try {
      seedAsmlPage(store);
      // q2 + earnings overlap, tesla does not — identity must MISS (a new page, not a merge).
      expect(store.findWikiPageForTopic("Tesla Q2 earnings", "tesla-q2-earnings", null)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("TRUE recurrence still matches: a rephrase whose tokens all appear in the page", () => {
    const store = RunStore.openInMemory();
    try {
      const id = seedAsmlPage(store);
      const hit = store.findWikiPageForTopic("ASML Q2 earnings", "asml-q2-earnings", null);
      expect(hit?.id).toBe(id);
    } finally {
      store.close();
    }
  });

  it("W2 retrieval keeps OR breadth: the Tesla query still SEARCHES into the page pool (rank-only, never identity)", () => {
    const store = RunStore.openInMemory();
    try {
      const id = seedAsmlPage(store);
      // Default "any" mode is untouched — retrieval ranks by relevance and can still
      // surface partially-matching pages; only the IDENTITY leg demands full coverage.
      expect(store.searchWikiPagesFts("Tesla Q2 earnings", 5).map((r) => r.id)).toEqual([id]);
      expect(store.searchWikiPagesFts("Tesla Q2 earnings", 5, "all")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("exact-slug and cosine legs are unchanged", () => {
    const store = RunStore.openInMemory();
    try {
      const id = store.addWikiPage({
        topic_slug: "asml-2026-q2-earnings-and-analyst-opinions",
        title: "页面甲",
        embedding: Float32Array.from([1, 0]),
        created_at: NOW
      });
      // Leg 1: exact slug, any phrasing.
      expect(
        store.findWikiPageForTopic("whatever", "asml-2026-q2-earnings-and-analyst-opinions", null)?.id
      ).toBe(id);
      // Leg 3: cosine ≥ 0.75 catches a paraphrase the strict FTS leg now misses.
      expect(store.findWikiPageForTopic("某个话题", "某个话题", Float32Array.from([0.95, 0.05]))?.id).toBe(id);
    } finally {
      store.close();
    }
  });
});
