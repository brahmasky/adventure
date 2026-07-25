import { afterEach, describe, expect, it } from "vitest";
import { createLedgerEvent, validateLedgerEvent } from "../../src/run/run-ledger.js";
import type { IdeaSourceItem, ShortlistCard } from "../../src/run/run-store.js";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-07-24T12:00:00.000Z";
const LATER = "2026-07-25T12:00:00.000Z";

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

/** momentum = n items × 1 source; distinct slugs keep ids apart. */
function insertWithMomentum(store: RunStore, slug: string, itemCount: number, now = NOW) {
  const items = Array.from({ length: itemCount }, (_, i) => item(`hn_front:${slug}-${i}`));
  return insertCard(store, { slug, sources: { hn_front: items }, now });
}

function shortlistCard(rank: number, ideaId: number, slug: string): ShortlistCard {
  return {
    rank,
    idea_id: ideaId,
    slug,
    title: `Title ${slug}`,
    mean_score: 7 - rank,
    chair_rationale: rank === 1 ? "closest to money" : null
  };
}

// --- panel latch ---------------------------------------------------------------------

describe("panel state markers", () => {
  it("seeds NULL (first armed tick fires immediately) and stamps on markPanelRan", () => {
    const store = openStore();
    expect(store.getPanelLastRun()).toBeNull();
    store.markPanelRan(NOW);
    expect(store.getPanelLastRun()).toBe(NOW);
  });
});

// --- setIdeaStatus transition guard ----------------------------------------------------

describe("setIdeaStatus transition guard", () => {
  it("allows exactly the five panel/pick transitions", () => {
    const store = openStore();

    const a = insertCard(store, { slug: "a" });
    expect(store.setIdeaStatus({ id: a.id, status: "shortlisted", now: NOW })).toEqual({ updated: true });
    expect(getIdea(store, a.id).status).toBe("shortlisted");

    const b = insertCard(store, { slug: "b" });
    dbExec(store, `UPDATE ideas SET status = 'tracked' WHERE id = ${b.id}`);
    expect(store.setIdeaStatus({ id: b.id, status: "shortlisted", now: NOW })).toEqual({ updated: true });
    expect(getIdea(store, b.id).status).toBe("shortlisted");

    // shortlisted → tracked (weekly reversion).
    expect(store.setIdeaStatus({ id: b.id, status: "tracked", now: NOW })).toEqual({ updated: true });
    expect(getIdea(store, b.id).status).toBe("tracked");

    // shortlisted → picked (operator pick).
    expect(store.setIdeaStatus({ id: a.id, status: "picked", now: NOW })).toEqual({ updated: true });
    expect(getIdea(store, a.id).status).toBe("picked");

    // picked → shortlisted (pick revert).
    expect(store.setIdeaStatus({ id: a.id, status: "shortlisted", now: NOW })).toEqual({ updated: true });
    expect(getIdea(store, a.id).status).toBe("shortlisted");
  });

  it("refuses picked → tracked", () => {
    const store = openStore();
    const { id } = insertCard(store);
    store.setIdeaStatus({ id, status: "shortlisted", now: NOW });
    store.setIdeaStatus({ id, status: "picked", now: NOW });
    expect(store.setIdeaStatus({ id, status: "tracked", now: NOW })).toEqual({ updated: false });
    expect(getIdea(store, id).status).toBe("picked");
  });

  it("refuses the seen → picked leap", () => {
    const store = openStore();
    const { id } = insertCard(store);
    expect(store.setIdeaStatus({ id, status: "picked", now: NOW })).toEqual({ updated: false });
    expect(getIdea(store, id).status).toBe("seen");
  });

  it("refuses transitions out of archived and killed", () => {
    const store = openStore();
    const archived = insertCard(store, { slug: "archived" });
    dbExec(store, `UPDATE ideas SET status = 'archived' WHERE id = ${archived.id}`);
    expect(store.setIdeaStatus({ id: archived.id, status: "shortlisted", now: NOW })).toEqual({ updated: false });
    expect(getIdea(store, archived.id).status).toBe("archived");

    const killed = insertCard(store, { slug: "killed" });
    dbExec(store, `UPDATE ideas SET status = 'killed' WHERE id = ${killed.id}`);
    for (const status of ["seen", "tracked", "shortlisted", "picked"] as const) {
      expect(store.setIdeaStatus({ id: killed.id, status, now: NOW })).toEqual({ updated: false });
    }
    expect(getIdea(store, killed.id).status).toBe("killed");
  });

  it("refuses an unknown id and a same-status write, never throwing", () => {
    const store = openStore();
    expect(store.setIdeaStatus({ id: 999, status: "shortlisted", now: NOW })).toEqual({ updated: false });

    const { id } = insertCard(store);
    store.setIdeaStatus({ id, status: "shortlisted", now: NOW });
    expect(store.setIdeaStatus({ id, status: "shortlisted", now: NOW })).toEqual({ updated: false });
    expect(getIdea(store, id).status).toBe("shortlisted");
  });
});

// --- writeIdeaScores -------------------------------------------------------------------

describe("writeIdeaScores", () => {
  it("overwrites scores_json and reports a missing card", () => {
    const store = openStore();
    const { id } = insertCard(store);
    const scores = JSON.stringify({ week_key: "2026-W30", kimi: 7 });
    expect(store.writeIdeaScores({ id, scoresJson: scores })).toEqual({ updated: true });
    expect(store.getIdeaById(id)?.scores_json).toBe(scores);
    expect(store.writeIdeaScores({ id: 999, scoresJson: scores })).toEqual({ updated: false });
  });
});

// --- prune exclusions (L4 + B1) --------------------------------------------------------

describe("pruneIdeaOverflow exclusions", () => {
  it("L4: a card created this tick survives the prune even as lowest momentum", () => {
    const store = openStore();
    const oldLow = insertWithMomentum(store, "old-low", 2);
    const oldHigh = insertWithMomentum(store, "old-high", 3);
    const fresh = insertWithMomentum(store, "fresh", 1, LATER); // momentum 1 — normal first victim.

    const archived = store.pruneIdeaOverflow({ cap: 2, now: LATER });
    expect(archived).toBe(1);
    expect(getIdea(store, fresh.id).status).toBe("seen");
    expect(getIdea(store, oldLow.id).status).toBe("archived");
    expect(getIdea(store, oldHigh.id).status).toBe("seen");
  });

  it("B1: shortlisted and picked cards survive the prune; a higher-momentum seen card is the victim", () => {
    const store = openStore();
    const shortlisted = insertWithMomentum(store, "starred", 1); // momentum 1 — lowest.
    store.setIdeaStatus({ id: shortlisted.id, status: "shortlisted", now: NOW });
    const picked = insertWithMomentum(store, "chosen", 1);
    store.setIdeaStatus({ id: picked.id, status: "shortlisted", now: NOW });
    store.setIdeaStatus({ id: picked.id, status: "picked", now: NOW });
    const seenLow = insertWithMomentum(store, "seen-low", 2);
    const seenHigh = insertWithMomentum(store, "seen-high", 3);

    // 4 active, cap 3 → overflow 1. Blessed cards still COUNT toward the cap but are
    // never victims: the lowest-momentum SEEN card goes, not the momentum-1 blessed pair.
    const archived = store.pruneIdeaOverflow({ cap: 3, now: LATER });
    expect(archived).toBe(1);
    expect(getIdea(store, seenLow.id).status).toBe("archived");
    expect(getIdea(store, shortlisted.id).status).toBe("shortlisted");
    expect(getIdea(store, picked.id).status).toBe("picked");
    expect(getIdea(store, seenHigh.id).status).toBe("seen");
  });
});

// --- touchIdeaCard L7 ------------------------------------------------------------------

describe("touchIdeaCard L7 summary guard", () => {
  it("shortlisted summary is immune to summaryUpdate but items still union", () => {
    const store = openStore();
    const { id } = insertCard(store);
    store.setIdeaStatus({ id, status: "shortlisted", now: NOW });

    store.touchIdeaCard({
      id,
      newItems: { hn_front: [item("hn_front:2")] },
      summaryUpdate: "LLM drift attempt",
      now: LATER
    });

    const card = store.getIdeaById(id)!;
    expect(card.summary).toContain("logs rot");
    expect(card.distinct_items).toBe(2);
    expect(card.last_seen).toBe(LATER);
  });

  it("seen card summary still updates", () => {
    const store = openStore();
    const { id } = insertCard(store);
    store.touchIdeaCard({ id, newItems: {}, summaryUpdate: "sharper summary", now: LATER });
    expect(store.getIdeaById(id)!.summary).toBe("sharper summary");
  });
});

// --- listActiveIdeas ordering pin -------------------------------------------------------

describe("listActiveIdeas status-priority ordering", () => {
  it("pins picked first, shortlisted second, then momentum DESC for the rest", () => {
    const store = openStore();
    const seenHigh = insertWithMomentum(store, "seen-high", 4);
    const seenLow = insertWithMomentum(store, "seen-low", 2);
    const shortlisted = insertWithMomentum(store, "starred", 1); // lowest momentum — still #2.
    store.setIdeaStatus({ id: shortlisted.id, status: "shortlisted", now: NOW });
    const picked = insertWithMomentum(store, "chosen", 1); // lowest momentum — still #1.
    store.setIdeaStatus({ id: picked.id, status: "shortlisted", now: NOW });
    store.setIdeaStatus({ id: picked.id, status: "picked", now: NOW });

    expect(store.listActiveIdeas(10).map((c) => c.id)).toEqual([
      picked.id,
      shortlisted.id,
      seenHigh.id,
      seenLow.id
    ]);
  });
});

// --- shortlist snapshots ----------------------------------------------------------------

describe("shortlist snapshots", () => {
  it("upsert + setShortlistPick + getLatestShortlist round-trip", () => {
    const store = openStore();
    const a = insertCard(store, { slug: "a" });
    const cards = [shortlistCard(1, a.id, "a")];
    const { id } = store.upsertShortlistSnapshot({
      weekKey: "2026-W30",
      cardsJson: JSON.stringify(cards),
      now: NOW
    });

    store.setShortlistPick({ snapshotId: id, ideaId: a.id });

    const latest = store.getLatestShortlist();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(id);
    expect(latest!.week_key).toBe("2026-W30");
    expect(latest!.created_at).toBe(NOW);
    expect(latest!.cards).toEqual(cards);
    expect(latest!.picked_idea_id).toBe(a.id);
  });

  it("re-firing the same week replaces cards_json and RESETS the pick to NULL", () => {
    const store = openStore();
    const a = insertCard(store, { slug: "a" });
    const b = insertCard(store, { slug: "b" });
    const first = store.upsertShortlistSnapshot({
      weekKey: "2026-W30",
      cardsJson: JSON.stringify([shortlistCard(1, a.id, "a")]),
      now: NOW
    });
    store.setShortlistPick({ snapshotId: first.id, ideaId: a.id });

    const replacedCards = [shortlistCard(1, b.id, "b")];
    const second = store.upsertShortlistSnapshot({
      weekKey: "2026-W30",
      cardsJson: JSON.stringify(replacedCards),
      now: LATER
    });
    expect(second.id).toBe(first.id); // same UNIQUE week row, replaced in place.

    const latest = store.getLatestShortlist()!;
    expect(latest.cards).toEqual(replacedCards);
    expect(latest.created_at).toBe(LATER);
    expect(latest.picked_idea_id).toBeNull(); // old pick pointed at dead ranks.
  });

  it("getLatestShortlist returns the max-id snapshot across weeks, and null on empty", () => {
    const store = openStore();
    expect(store.getLatestShortlist()).toBeNull();
    const a = insertCard(store, { slug: "a" });
    store.upsertShortlistSnapshot({ weekKey: "2026-W30", cardsJson: JSON.stringify([shortlistCard(1, a.id, "a")]), now: NOW });
    store.upsertShortlistSnapshot({ weekKey: "2026-W31", cardsJson: JSON.stringify([shortlistCard(1, a.id, "a")]), now: LATER });
    expect(store.getLatestShortlist()!.week_key).toBe("2026-W31");
  });
});

// --- pick singleton reads ----------------------------------------------------------------

describe("getPickedIdea / getIdeaById", () => {
  it("getPickedIdea returns the single picked card (singleton by construction)", () => {
    const store = openStore();
    expect(store.getPickedIdea()).toBeNull();

    const first = insertCard(store, { slug: "first" });
    const next = insertCard(store, { slug: "next" });
    store.setIdeaStatus({ id: first.id, status: "shortlisted", now: NOW });
    store.setIdeaStatus({ id: next.id, status: "shortlisted", now: NOW });
    store.setIdeaStatus({ id: first.id, status: "picked", now: NOW });
    expect(store.getPickedIdea()!.id).toBe(first.id);

    // Re-pick the pick-handler way: revert previous, then set the next.
    store.setIdeaStatus({ id: first.id, status: "shortlisted", now: LATER });
    store.setIdeaStatus({ id: next.id, status: "picked", now: LATER });
    expect(store.getPickedIdea()!.id).toBe(next.id);
    expect(countByStatus(store, "picked")).toBe(1);
  });

  it("getIdeaById returns the card with computed momentum; unknown id is null", () => {
    const store = openStore();
    const { id } = insertCard(store, {
      sources: {
        hn_front: [item("hn_front:1"), item("hn_front:2")],
        lobsters: [{ id: "lobsters:a", url: "https://lobste.rs/s/a", title: "t" }]
      }
    });
    const card = store.getIdeaById(id)!;
    expect(card.momentum).toBe(6);
    expect(card.slug).toBe("log-watcher");
    expect(card.sources.hn_front).toHaveLength(2);
    expect(store.getIdeaById(999)).toBeNull();
  });
});

// --- ledger --------------------------------------------------------------------------------

describe("idea_panel_tick ledger event", () => {
  const fullPayload = {
    result: "ok",
    judges_ok: ["kimi", "gemini", "codex"],
    judges_failed: [],
    chair_used: true,
    cards_scored: 8,
    shortlist_ids: [3, 7, 11],
    week_key: "2026-W30",
    brief_written: true
  };

  it("a full payload validates", () => {
    const event = createLedgerEvent({
      correlation_id: "idea-panel",
      event_type: "idea_panel_tick",
      actor: "system",
      sequence: 1,
      payload: fullPayload
    });
    expect(validateLedgerEvent(event)).toEqual({ ok: true });
  });

  it("a payload missing a required field fails validation", () => {
    const { brief_written, ...incomplete } = fullPayload;
    void brief_written;
    const event = createLedgerEvent({
      correlation_id: "idea-panel",
      event_type: "idea_panel_tick",
      actor: "system",
      sequence: 1,
      payload: incomplete
    });
    expect(validateLedgerEvent(event)).toEqual({
      ok: false,
      error: "idea_panel_tick missing required payload field: brief_written"
    });
  });
});

// --- helpers -------------------------------------------------------------------------------

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

function countByStatus(store: RunStore, status: string): number {
  const row = (store as unknown as { db: TestDb }).db
    .prepare("SELECT COUNT(*) AS count FROM ideas WHERE status = ?")
    .get<{ count: number }>(status);
  return row?.count ?? 0;
}
