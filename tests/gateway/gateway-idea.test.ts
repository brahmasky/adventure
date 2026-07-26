import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import {
  formatIdeaText,
  Gateway,
  IDEA_EMPTY_TEXT,
  IDEA_OFF_TEXT,
  IDEA_PICK_CARD_ARCHIVED_TEXT
} from "../../src/gateway/gateway.js";
import { CHAIR_FALLBACK_RATIONALE } from "../../src/capabilities/idea-panel.js";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-07-25T12:00:00.000Z";
const WEEK = "2026-W30";

const SAVED_KEYS = ["HOUGE_RADAR_PANEL_ENABLED", "HOUGE_RADAR_PANEL_AT", "HOUGE_RADAR_ENABLED"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const key of SAVED_KEYS) saved[key] = process.env[key];
});
afterEach(() => {
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function ideaShowEvent(key = "telegram:idea-show-1") {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "idea",
    metadata: { idea_action: "show" },
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: key,
    source_reference: `telegram:update:${key}`
  });
}

function ideaPickEvent(n: number, key = `telegram:idea-pick-${n}`) {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "idea",
    metadata: { idea_action: "pick", idea_number: n },
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: key,
    source_reference: `telegram:update:${key}`
  });
}

function statusEvent(key = "telegram:status-idea") {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "status",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: key,
    source_reference: `telegram:update:${key}`
  });
}

function helpEvent(key = "telegram:help-idea") {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "help",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: key,
    source_reference: `telegram:update:${key}`
  });
}

/** Seed a card and promote it to `shortlisted` (the only status a pick can flip). */
function seedShortlisted(store: RunStore, slug: string, title: string): number {
  const { id } = store.insertIdeaCard({
    slug,
    title,
    summary: "s",
    sources: { hn_front: [{ id: `hn_front:${slug}`, url: "https://news.ycombinator.com/item?id=1", title: "t" }] },
    now: "2026-07-25T09:00:00.000Z"
  });
  expect(store.setIdeaStatus({ id, status: "shortlisted", now: "2026-07-25T09:00:00.000Z" })).toEqual({
    updated: true
  });
  return id;
}

/** Seed the frozen weekly snapshot the /idea surfaces resolve against. */
function seedSnapshot(
  store: RunStore,
  cards: Array<{ rank: number; idea_id: number; slug: string; title: string; mean_score: number; chair_rationale: string | null }>
): number {
  const { id } = store.upsertShortlistSnapshot({
    weekKey: WEEK,
    cardsJson: JSON.stringify(cards),
    now: "2026-07-25T09:00:00.000Z"
  });
  return id;
}

interface TestDb {
  exec(sql: string): void;
}

function dbExec(store: RunStore, sql: string): void {
  (store as unknown as { db: TestDb }).db.exec(sql);
}

describe("/idea", () => {
  it("flag off → the one-line panel-off notice (dark feature stays honest)", () => {
    delete process.env.HOUGE_RADAR_PANEL_ENABLED;
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Hidden A");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Hidden A", mean_score: 7, chair_rationale: null }
      ]);
      const result = gateway.intake(ideaShowEvent(), NOW);
      expect(result).toEqual({ ok: true, status: "idea_returned", run_id: "" });
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toBe(IDEA_OFF_TEXT);
      expect(text).not.toContain("Hidden A");
    } finally {
      store.close();
    }
  });

  it("show with no snapshot yet → 'panel 未跑过' (and no run row — a control command)", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const result = gateway.intake(ideaShowEvent("telegram:idea-show-empty"), NOW);
      expect(result).toEqual({ ok: true, status: "idea_returned", run_id: "" });
      expect(store.listRecentRunStatuses(10)).toHaveLength(0);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toBe(IDEA_EMPTY_TEXT);
      expect(text).toContain("panel 未跑过 — 周日 09:00");
    } finally {
      store.close();
    }
  });

  it("show renders the week_key header, ranked rows (escaped), the picked marker, and the footer", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha *idea*");
      const b = seedShortlisted(store, "b", "Beta idea");
      const snapshotId = seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha *idea*", mean_score: 7.5, chair_rationale: "clear [wedge]" },
        { rank: 2, idea_id: b, slug: "b", title: "Beta idea", mean_score: 6, chair_rationale: null }
      ]);
      expect(store.setIdeaStatus({ id: b, status: "picked", now: NOW })).toEqual({ updated: true });
      store.setShortlistPick({ snapshotId, ideaId: b });

      gateway.intake(ideaShowEvent("telegram:idea-show-full"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain(`📋 ${WEEK} shortlist`);
      // Frozen snapshot text renders escaped (card/chair prose is stored LLM/feed output).
      expect(text).toContain("1. Alpha idea — mean 7.5, clear wedge");
      expect(text).not.toContain("*idea*");
      expect(text).not.toContain("[wedge]");
      expect(text).toContain("2. Beta idea — mean 6 ✅ picked");
      expect(text).toContain("· /idea pick <n>");
    } finally {
      store.close();
    }
  });

  it("pick happy path: flips the singleton, stamps the snapshot pointer, confirms with week_key", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: null }
      ]);
      const result = gateway.intake(ideaPickEvent(1), NOW);
      expect(result).toEqual({ ok: true, status: "idea_returned", run_id: "" });
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toBe(`picked #1 from ${WEEK}: Alpha`);
      expect(store.getIdeaById(a)?.status).toBe("picked");
      expect(store.getLatestShortlist()?.picked_idea_id).toBe(a);
      expect(store.getPickedIdea()?.id).toBe(a);
    } finally {
      store.close();
    }
  });

  it("pick out-of-range → distinct not-found; pick with no snapshot → the empty notice", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      // No snapshot at all.
      gateway.intake(ideaPickEvent(1, "telegram:idea-pick-nosnap"), NOW);
      expect(String(store.claimNextNotification("test", 30)?.payload.text)).toBe(IDEA_EMPTY_TEXT);

      const a = seedShortlisted(store, "a", "Alpha");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: null }
      ]);
      gateway.intake(ideaPickEvent(9, "telegram:idea-pick-oob"), NOW);
      expect(String(store.claimNextNotification("test", 30)?.payload.text)).toBe(
        "没有第 9 个 shortlist 项 (no shortlist #9) — see /idea for the list."
      );
      // Nothing flipped.
      expect(store.getPickedIdea()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("re-pick reverts the prior pick to shortlisted (global singleton holds)", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      const b = seedShortlisted(store, "b", "Beta");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: null },
        { rank: 2, idea_id: b, slug: "b", title: "Beta", mean_score: 6, chair_rationale: null }
      ]);
      gateway.intake(ideaPickEvent(1, "telegram:idea-pick-first"), NOW);
      store.claimNextNotification("test", 30);
      gateway.intake(ideaPickEvent(2, "telegram:idea-pick-second"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toBe(`picked #2 from ${WEEK}: Beta`);
      expect(text).not.toContain("已归档");
      expect(store.getIdeaById(a)?.status).toBe("shortlisted");
      expect(store.getIdeaById(b)?.status).toBe("picked");
      expect(store.getLatestShortlist()?.picked_idea_id).toBe(b);
    } finally {
      store.close();
    }
  });

  it("prior pick archived before re-pick → note line, new pick still proceeds (§11)", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      const b = seedShortlisted(store, "b", "Beta");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: null },
        { rank: 2, idea_id: b, slug: "b", title: "Beta", mean_score: 6, chair_rationale: null }
      ]);
      gateway.intake(ideaPickEvent(1, "telegram:idea-pick-doomed"), NOW);
      store.claimNextNotification("test", 30);
      // The picked card is archived out from under the snapshot (no public path does
      // this today — seeded directly to exercise the §11 row).
      dbExec(store, `UPDATE ideas SET status = 'archived', archived_at = '${NOW}' WHERE id = ${a}`);

      gateway.intake(ideaPickEvent(2, "telegram:idea-pick-after-archive"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain(`picked #2 from ${WEEK}: Beta`);
      expect(text).toContain("上一个 pick 已归档");
      expect(store.getIdeaById(b)?.status).toBe("picked");
      // The archived prior stays archived — the revert no-oped.
      expect(store.getIdeaById(a)?.status).toBe("archived");
    } finally {
      store.close();
    }
  });

  it("picked card itself archived since the snapshot → failure line, nothing else changes", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: null }
      ]);
      dbExec(store, `UPDATE ideas SET status = 'archived', archived_at = '${NOW}' WHERE id = ${a}`);
      gateway.intake(ideaPickEvent(1, "telegram:idea-pick-archived-target"), NOW);
      expect(String(store.claimNextNotification("test", 30)?.payload.text)).toBe(
        IDEA_PICK_CARD_ARCHIVED_TEXT
      );
      expect(store.getPickedIdea()).toBeNull();
      expect(store.getLatestShortlist()?.picked_idea_id).toBeNull();
    } finally {
      store.close();
    }
  });

  it("pick of an archived card leaves the prior pick INTACT (set-before-revert — zero-picked unreachable)", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      const b = seedShortlisted(store, "b", "Beta");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: null },
        { rank: 2, idea_id: b, slug: "b", title: "Beta", mean_score: 6, chair_rationale: null }
      ]);
      gateway.intake(ideaPickEvent(1, "telegram:idea-pick-keeper"), NOW);
      store.claimNextNotification("test", 30);
      // The NEW target is archived out from under the frozen snapshot; the pick must
      // refuse BEFORE touching the prior — the singleton never drops to zero.
      dbExec(store, `UPDATE ideas SET status = 'archived', archived_at = '${NOW}' WHERE id = ${b}`);

      gateway.intake(ideaPickEvent(2, "telegram:idea-pick-archived-new"), NOW);
      expect(String(store.claimNextNotification("test", 30)?.payload.text)).toBe(
        IDEA_PICK_CARD_ARCHIVED_TEXT
      );
      expect(store.getIdeaById(a)?.status).toBe("picked");
      expect(store.getPickedIdea()?.id).toBe(a);
      expect(store.getLatestShortlist()?.picked_idea_id).toBe(a);
    } finally {
      store.close();
    }
  });

  it("deduplicates a redelivered pick (replayed verdict, single notification, no double flip)", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: null }
      ]);
      const event = ideaPickEvent(1, "telegram:idea-pick-dup");
      const first = gateway.intake(event, NOW);
      const second = gateway.intake(event, NOW);
      expect(second).toEqual(first);
      expect(store.countNotificationsByIdempotencyKey("telegram:idea-pick-dup:idea:pick:1")).toBe(1);
      expect(store.getIdeaById(a)?.status).toBe("picked");
    } finally {
      store.close();
    }
  });
});

describe("/status panel line", () => {
  it("shows last run, the RESOLVED slot, and the shortlist size when the panel flag is on", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    delete process.env.HOUGE_RADAR_PANEL_AT; // default → sun 09:00
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: null }
      ]);
      store.markPanelRan("2026-07-25T09:00:00.000Z");
      gateway.intake(statusEvent(), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("Panel: last 3h ago · sun 09:00 · shortlist 1");
    } finally {
      store.close();
    }
  });

  it("reads 'never'/'none' before the first run and renders `off` when the slot is off", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    process.env.HOUGE_RADAR_PANEL_AT = "off";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      gateway.intake(statusEvent("telegram:status-idea-never"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("Panel: last never · off · shortlist none");
    } finally {
      store.close();
    }
  });

  it("renders '· chair off' when EVERY rationale in the latest snapshot is the chair fallback", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    delete process.env.HOUGE_RADAR_PANEL_AT;
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      const b = seedShortlisted(store, "b", "Beta");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: CHAIR_FALLBACK_RATIONALE },
        { rank: 2, idea_id: b, slug: "b", title: "Beta", mean_score: 6, chair_rationale: CHAIR_FALLBACK_RATIONALE }
      ]);
      gateway.intake(statusEvent("telegram:status-chair-off"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("shortlist 2 · chair off");
    } finally {
      store.close();
    }
  });

  it("does NOT render 'chair off' when any rationale is real (mixed snapshot = chair ran)", () => {
    process.env.HOUGE_RADAR_PANEL_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const a = seedShortlisted(store, "a", "Alpha");
      const b = seedShortlisted(store, "b", "Beta");
      seedSnapshot(store, [
        { rank: 1, idea_id: a, slug: "a", title: "Alpha", mean_score: 7, chair_rationale: "clear wedge" },
        { rank: 2, idea_id: b, slug: "b", title: "Beta", mean_score: 6, chair_rationale: CHAIR_FALLBACK_RATIONALE }
      ]);
      gateway.intake(statusEvent("telegram:status-chair-on"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).not.toContain("chair off");
    } finally {
      store.close();
    }
  });

  it("is absent when the panel flag is off (dark feature must not advertise itself)", () => {
    delete process.env.HOUGE_RADAR_PANEL_ENABLED;
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      gateway.intake(statusEvent("telegram:status-idea-off"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).not.toContain("Panel:");
    } finally {
      store.close();
    }
  });
});

describe("/help R2 lines", () => {
  it("lists /radar <n> and /idea", () => {
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      gateway.intake(helpEvent(), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("/radar <n> — 查看第 n 个 idea 卡片详情");
      expect(text).toContain("/idea — 本周 shortlist（/idea pick <n> 选定）");
    } finally {
      store.close();
    }
  });
});

describe("formatIdeaText", () => {
  it("renders an empty snapshot's header + footer around the empty marker", () => {
    const text = formatIdeaText(
      { id: 1, created_at: NOW, week_key: WEEK, cards: [], picked_idea_id: null },
      null
    );
    expect(text).toContain(`📋 ${WEEK} shortlist`);
    expect(text).toContain("(空 shortlist)");
    expect(text).toContain("· /idea pick <n>");
  });
});
