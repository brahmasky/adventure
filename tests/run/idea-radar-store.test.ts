import { afterEach, describe, expect, it } from "vitest";
import { createLedgerEvent, validateLedgerEvent } from "../../src/run/run-ledger.js";
import type { IdeaSourceItem } from "../../src/run/run-store.js";
import { IDEA_CARD_ITEMS_PER_SOURCE_CAP, RunStore } from "../../src/run/run-store.js";

const NOW = "2026-07-24T12:00:00.000Z";

let stores: RunStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function openStore(): RunStore {
  const store = RunStore.openInMemory();
  stores.push(store);
  return store;
}

function item(id: string, title = `title ${id}`): IdeaSourceItem {
  return { id, url: `https://news.ycombinator.com/item?id=${id.split(":")[1]}`, title };
}

function insertCard(store: RunStore, overrides: { slug?: string; title?: string; sources?: Record<string, IdeaSourceItem[]>; now?: string } = {}) {
  return store.insertIdeaCard({
    slug: overrides.slug ?? "log-watcher",
    title: overrides.title ?? "Log watcher",
    summary: "problem: logs rot. demand: HN thread. monetization: SaaS.",
    sources: overrides.sources ?? { hn_front: [item("hn_front:1")] },
    now: overrides.now ?? NOW
  });
}

// --- state markers ----------------------------------------------------------------

describe("radar state markers", () => {
  it("seeds NULL (first tick runs immediately) and stamps on markRadarRan", () => {
    const store = openStore();
    expect(store.getRadarLastRun()).toBeNull();
    store.markRadarRan(NOW);
    expect(store.getRadarLastRun()).toBe(NOW);
  });
});

// --- insertIdeaCard ---------------------------------------------------------------

describe("insertIdeaCard", () => {
  it("computes distinct_items × distinct_sources from the sources map", () => {
    const store = openStore();
    const { id } = insertCard(store, {
      sources: {
        hn_front: [item("hn_front:1"), item("hn_front:2")],
        lobsters: [{ id: "lobsters:a", url: "https://lobste.rs/s/a", title: "t" }]
      }
    });
    const [card] = store.listActiveIdeas(10);
    expect(card!.id).toBe(id);
    expect(card!.distinct_items).toBe(3);
    expect(card!.distinct_sources).toBe(2);
    expect(card!.momentum).toBe(6);
    expect(card!.status).toBe("seen");
    expect(card!.first_seen).toBe(NOW);
    expect(card!.last_seen).toBe(NOW);
  });

  it("slug collision appends a deterministic -2/-3 suffix (slug is identity only)", () => {
    const store = openStore();
    insertCard(store, { slug: "log-watcher" });
    insertCard(store, { slug: "log-watcher", title: "Log watcher again" });
    insertCard(store, { slug: "log-watcher", title: "Log watcher thrice" });
    const slugs = store.listActiveIdeas(10).map((c) => c.slug).sort();
    expect(slugs).toEqual(["log-watcher", "log-watcher-2", "log-watcher-3"]);
  });
});

// --- touchIdeaCard ----------------------------------------------------------------

describe("touchIdeaCard", () => {
  it("unions new items per source and recomputes distinct counts", () => {
    const store = openStore();
    const { id } = insertCard(store);
    const later = "2026-07-25T12:00:00.000Z";
    store.touchIdeaCard({
      id,
      newItems: {
        hn_front: [item("hn_front:2")],
        gh_new: [{ id: "gh_new:a/b", url: "https://github.com/a/b", title: "a/b" }]
      },
      summaryUpdate: null,
      now: later
    });
    const [card] = store.listActiveIdeas(10);
    expect(card!.distinct_items).toBe(3);
    expect(card!.distinct_sources).toBe(2);
    expect(card!.last_seen).toBe(later);
    // summaryUpdate null keeps the summary.
    expect(card!.summary).toContain("logs rot");
  });

  it("re-sighting an already-known item id bumps last_seen ONLY (no count inflation)", () => {
    const store = openStore();
    const { id } = insertCard(store);
    const later = "2026-07-25T12:00:00.000Z";
    store.touchIdeaCard({ id, newItems: { hn_front: [item("hn_front:1")] }, summaryUpdate: null, now: later });
    const [card] = store.listActiveIdeas(10);
    expect(card!.distinct_items).toBe(1);
    expect(card!.distinct_sources).toBe(1);
    expect(card!.last_seen).toBe(later);
    expect(card!.sources.hn_front).toHaveLength(1);
  });

  it("caps each source's item list at IDEA_CARD_ITEMS_PER_SOURCE_CAP, dropping oldest first", () => {
    const store = openStore();
    const { id } = insertCard(store);
    const extra = Array.from({ length: IDEA_CARD_ITEMS_PER_SOURCE_CAP + 4 }, (_, i) => item(`hn_front:${i + 100}`));
    store.touchIdeaCard({ id, newItems: { hn_front: extra }, summaryUpdate: null, now: NOW });
    const [card] = store.listActiveIdeas(10);
    expect(card!.sources.hn_front).toHaveLength(IDEA_CARD_ITEMS_PER_SOURCE_CAP);
    // The seed item hn_front:1 and the earliest extras fell off the front (oldest-first drop).
    expect(card!.sources.hn_front!.map((i) => i.id)).not.toContain("hn_front:1");
    expect(card!.sources.hn_front!.at(-1)!.id).toBe(`hn_front:${99 + IDEA_CARD_ITEMS_PER_SOURCE_CAP + 4}`);
    expect(card!.distinct_items).toBe(IDEA_CARD_ITEMS_PER_SOURCE_CAP);
  });

  it("applies a non-null summaryUpdate", () => {
    const store = openStore();
    const { id } = insertCard(store);
    store.touchIdeaCard({ id, newItems: {}, summaryUpdate: "sharper summary", now: NOW });
    expect(store.listActiveIdeas(10)[0]!.summary).toBe("sharper summary");
  });
});

// --- listActiveIdeas --------------------------------------------------------------

describe("listActiveIdeas", () => {
  it("orders by momentum (distinct_items × distinct_sources) DESC then last_seen DESC, excluding archived/killed", () => {
    const store = openStore();
    const low = insertCard(store, { slug: "low", sources: { hn_front: [item("hn_front:1")] } });
    const high = insertCard(store, {
      slug: "high",
      sources: { hn_front: [item("hn_front:2"), item("hn_front:3")], lobsters: [{ id: "lobsters:z", url: "https://lobste.rs/s/z", title: "z" }] }
    });
    const archived = insertCard(store, { slug: "gone" });
    store.archiveStaleIdeas({ now: "2026-09-01T00:00:00.000Z", afterDays: 30 });
    // Everything is stale by September — re-insert the two we want active.
    void low;
    void high;
    void archived;
    const a = insertCard(store, { slug: "fresh-low", sources: { hn_front: [item("hn_front:4")] }, now: "2026-09-01T00:00:00.000Z" });
    const b = insertCard(store, {
      slug: "fresh-high",
      sources: { hn_front: [item("hn_front:5"), item("hn_front:6")], gh_new: [{ id: "gh_new:x/y", url: "https://github.com/x/y", title: "x/y" }] },
      now: "2026-09-01T00:00:00.000Z"
    });
    const listed = store.listActiveIdeas(10);
    expect(listed.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(store.countActiveIdeas()).toBe(2);
  });
});

// --- archive + prune ---------------------------------------------------------------

describe("archiveStaleIdeas / pruneIdeaOverflow", () => {
  it("archives only stale seen/tracked cards (shortlisted/picked never auto-archive) and is reversible", () => {
    const store = openStore();
    const stale = insertCard(store, { slug: "stale" });
    const shortlisted = insertCard(store, { slug: "starred" });
    dbExec(store, `UPDATE ideas SET status = 'shortlisted' WHERE id = ${shortlisted.id}`);

    const later = "2026-08-30T12:00:00.000Z"; // 37 days after NOW
    const archived = store.archiveStaleIdeas({ now: later, afterDays: 30 });
    expect(archived).toBe(1);

    const row = getIdea(store, stale.id);
    expect(row.status).toBe("archived");
    expect(row.archived_at).toBe(later);
    expect(getIdea(store, shortlisted.id).status).toBe("shortlisted");

    // Reversible: flipping the status back re-activates the card; archived_at is bookkeeping.
    dbExec(store, `UPDATE ideas SET status = 'seen' WHERE id = ${stale.id}`);
    expect(store.listActiveIdeas(10).map((c) => c.id)).toContain(stale.id);
  });

  it("does not archive a fresh card", () => {
    const store = openStore();
    insertCard(store);
    expect(store.archiveStaleIdeas({ now: "2026-07-25T12:00:00.000Z", afterDays: 30 })).toBe(0);
  });

  it("pruneIdeaOverflow archives the lowest-momentum cards beyond the cap", () => {
    const store = openStore();
    const weak = insertCard(store, { slug: "weak", sources: { hn_front: [item("hn_front:1")] } });
    const mid = insertCard(store, { slug: "mid", sources: { hn_front: [item("hn_front:2"), item("hn_front:3")] } });
    const strong = insertCard(store, {
      slug: "strong",
      sources: { hn_front: [item("hn_front:4"), item("hn_front:5")], gh_new: [{ id: "gh_new:s/s", url: "https://github.com/s/s", title: "s" }] }
    });

    // Prune on a LATER tick: R2's L4 rule exempts cards with first_seen == now.
    const archived = store.pruneIdeaOverflow({ cap: 2, now: "2026-07-25T12:00:00.000Z" });
    expect(archived).toBe(1);
    expect(getIdea(store, weak.id).status).toBe("archived");
    expect(getIdea(store, mid.id).status).not.toBe("archived");
    expect(getIdea(store, strong.id).status).not.toBe("archived");
    expect(store.countActiveIdeas()).toBe(2);
  });

  it("pruneIdeaOverflow under the cap is a no-op", () => {
    const store = openStore();
    insertCard(store);
    expect(store.pruneIdeaOverflow({ cap: 100, now: NOW })).toBe(0);
  });
});

// --- ledger -------------------------------------------------------------------------

describe("idea_radar_tick ledger event", () => {
  it("recordIdeaRadarTick appends one system event with the full payload", () => {
    const store = openStore();
    store.recordIdeaRadarTick({
      sources_ok: ["hn_front"],
      sources_failed: ["gh_new"],
      cards_new: 2,
      cards_updated: 1,
      cards_archived: 0
    });
    const events = store.getLedgerEvents().filter((e) => e.event_type === "idea_radar_tick");
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe("system");
    expect(events[0]!.payload).toEqual({
      sources_ok: ["hn_front"],
      sources_failed: ["gh_new"],
      cards_new: 2,
      cards_updated: 1,
      cards_archived: 0
    });
  });

  it("a payload missing a required field fails validation", () => {
    const event = createLedgerEvent({
      correlation_id: "idea-radar",
      event_type: "idea_radar_tick",
      actor: "system",
      sequence: 1,
      payload: { sources_ok: [], sources_failed: [], cards_new: 0, cards_updated: 0 } // cards_archived missing
    });
    expect(validateLedgerEvent(event)).toEqual({
      ok: false,
      error: "idea_radar_tick missing required payload field: cards_archived"
    });
  });
});

// --- helpers -------------------------------------------------------------------------

interface TestDb {
  prepare(sql: string): { get<T>(...v: Array<string | number>): T | undefined };
  exec(sql: string): void;
}

function dbExec(store: RunStore, sql: string): void {
  (store as unknown as { db: TestDb }).db.exec(sql);
}

function getIdea(store: RunStore, id: number): { status: string; archived_at: string | null } {
  const row = (store as unknown as { db: TestDb }).db
    .prepare("SELECT status, archived_at FROM ideas WHERE id = ?")
    .get<{ status: string; archived_at: string | null }>(id);
  if (!row) throw new Error("idea row missing");
  return row;
}
