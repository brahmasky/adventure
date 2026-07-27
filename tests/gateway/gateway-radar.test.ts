import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { formatRadarDetailText, formatRadarText, Gateway, RADAR_OFF_TEXT } from "../../src/gateway/gateway.js";
import { RunStore } from "../../src/run/run-store.js";

const NOW = "2026-07-24T12:00:00.000Z";

let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env.HOUGE_RADAR_ENABLED;
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.HOUGE_RADAR_ENABLED;
  else process.env.HOUGE_RADAR_ENABLED = savedFlag;
});

function radarEvent(key = "telegram:radar-1") {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "radar",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: key,
    source_reference: `telegram:update:${key}`
  });
}

function statusEvent(key = "telegram:status-radar") {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "status",
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: key,
    source_reference: `telegram:update:${key}`
  });
}

function seedCard(store: RunStore, slug: string, title: string, itemCount: number) {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    id: `hn_front:${slug}-${i}`,
    url: `https://news.ycombinator.com/item?id=${i}`,
    title: `item ${i}`
  }));
  return store.insertIdeaCard({
    slug,
    title,
    summary: "s",
    sources: { hn_front: items },
    now: "2026-07-24T10:00:00.000Z"
  });
}

describe("/radar", () => {
  it("renders the top active cards with momentum/age/status, Telegram-escaped, plus the footer", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      seedCard(store, "big", "Big idea [with](markdown) *spice*", 3);
      seedCard(store, "small", "Small idea", 1);
      store.markRadarRan("2026-07-24T09:00:00.000Z");

      const result = gateway.intake(radarEvent(), NOW);
      expect(result).toEqual({ ok: true, status: "radar_returned", run_id: "" });
      // A control command: no run row.
      expect(store.listRecentRunStatuses(10)).toHaveLength(0);

      const note = store.claimNextNotification("test", 30);
      const text = String(note?.payload.text);
      // Header line carries the identity + counts.
      expect(text).toContain("📡 **Idea Radar** — 2 active · last tick 3h ago");
      // Momentum order: the 3-item card first; rows NUMBERED (the /radar <n> address) with
      // the code-owned bold ordinal; hostile title markdown stripped inert BEFORE the
      // scaffolding wraps anything.
      expect(text).toContain("**1.** Big idea withmarkdown spice — 动量 3 · 2h ago");
      expect(text).not.toContain("[with](markdown)");
      expect(text).not.toContain("*spice*");
      expect(text).toContain("**2.** Small idea — 动量 1 · 2h ago");
      // Default `seen` status is hidden ("2h ago · seen" would read as a stutter).
      expect(text).not.toContain("· seen");
      // Footer teaches the family verbs (detail + week).
      expect(text).toContain("· /radar <n> 详情 · /radar week 本周评审");
      expect(text.indexOf("Big idea")).toBeLessThan(text.indexOf("Small idea"));
    } finally {
      store.close();
    }
  });

  it("empty state: no active cards yet, footer still shows tick state", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      gateway.intake(radarEvent(), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("还没有活跃的 idea 卡片");
      expect(text).toContain("📡 **Idea Radar** — 0 active · last tick never");
    } finally {
      store.close();
    }
  });

  it("flag off → the one-line radar-off notice (dark feature stays honest)", () => {
    delete process.env.HOUGE_RADAR_ENABLED;
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      seedCard(store, "hidden", "Hidden idea", 1);
      const result = gateway.intake(radarEvent(), NOW);
      expect(result).toEqual({ ok: true, status: "radar_returned", run_id: "" });
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toBe(RADAR_OFF_TEXT);
      expect(text).not.toContain("Hidden idea");
    } finally {
      store.close();
    }
  });

  it("deduplicates a redelivered /radar update (replayed, single notification)", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const event = radarEvent("telegram:radar-dup");
      const first = gateway.intake(event, NOW);
      const second = gateway.intake(event, NOW);
      expect(second).toEqual(first);
      expect(store.countNotificationsByIdempotencyKey("telegram:radar-dup:radar")).toBe(1);
    } finally {
      store.close();
    }
  });
});

function radarDetailEvent(n: number, key = `telegram:radar-detail-${n}`) {
  return buildTypedTaskEvent({
    source: "telegram",
    type: "radar",
    metadata: { radar_number: n },
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "telegram", chat_id: "222" },
    idempotency_key: key,
    source_reference: `telegram:update:${key}`
  });
}

describe("/radar <n> detail view", () => {
  it("renders title/summary/momentum/status + panel line + source items (happy path)", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      const { id } = seedCard(store, "big", "Big idea", 3);
      store.writeIdeaScores({
        id,
        scoresJson: JSON.stringify({
          panel: {
            week: "2026-W30",
            judges: {
              kimi: { score: 7, reason: "r" },
              gemini: { score: 8, reason: "r" },
              codex: { score: 5, reason: "r" }
            },
            chair_rank: 2
          }
        })
      });

      const result = gateway.intake(radarDetailEvent(1), NOW);
      expect(result).toEqual({ ok: true, status: "radar_returned", run_id: "" });
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      // Bold title line ALWAYS shows the status — even the default `seen` the board hides.
      expect(text).toContain("**1. Big idea** — seen");
      expect(text).toContain("\n\ns\n\n"); // the summary paragraph, blank-line separated
      expect(text).toContain(
        "📊 momentum 3（3 items × 1 sources）· 首见 2h ago · 最近 2h ago"
      );
      expect(text).toContain("🗳 panel 2026-W30: kimi 7 · gemini 8 · codex 5 · chair #2");
      // One reason sub-bullet per judge (lens emoji: kimi 📈 · gemini ✨ · codex 🔧).
      expect(text).toContain("  📈 r");
      expect(text).toContain("  ✨ r");
      expect(text).toContain("  🔧 r");
      expect(text).toContain("🔗 sources:");
      // Up to 3 items per source; item title bullet + its URL bare on the next line.
      expect(text).toContain("• hn_front: item 0\n  https://news.ycombinator.com/item?id=0");
      expect(text).toContain("item 2");
      expect(text).not.toContain("item 3");
    } finally {
      store.close();
    }
  });

  it("omits the panel line when the card has no scores, absent judges, and a null chair", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      seedCard(store, "plain", "Plain idea", 1);
      gateway.intake(radarDetailEvent(1, "telegram:radar-detail-noscores"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("1. Plain idea");
      expect(text).not.toContain("panel ");

      // Pure render: a missing judge omits its segment; chair_rank null omits the chair.
      const card = store.listActiveIdeas(10)[0]!;
      const partial = formatRadarDetailText(
        1,
        {
          ...card,
          scores_json: JSON.stringify({
            panel: { week: "2026-W30", judges: { kimi: { score: 7, reason: "r" } }, chair_rank: null }
          })
        },
        NOW
      );
      expect(partial).toContain("panel 2026-W30: kimi 7");
      expect(partial).not.toContain("gemini");
      expect(partial).not.toContain("chair #");
      // Hostile scores_json parses to "no panel line", never a throw.
      expect(formatRadarDetailText(1, { ...card, scores_json: "{not json" }, NOW)).not.toContain("panel");
    } finally {
      store.close();
    }
  });

  it("out-of-range ordinal → the distinct not-found line (numbered-list idiom)", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      seedCard(store, "only", "Only idea", 1);
      gateway.intake(radarDetailEvent(5, "telegram:radar-detail-oob"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toBe("没有第 5 个 idea 卡片 (no idea #5) — see /radar for the list.");
    } finally {
      store.close();
    }
  });

  it("escapes hostile card title, item titles, and URLs (everything renders inert)", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      store.insertIdeaCard({
        slug: "hostile",
        title: "Sneaky [link](https://evil.example) *bold*",
        summary: "_underscored_ `code`",
        sources: {
          hn_front: [
            {
              id: "hn_front:h1",
              url: "https://news.ycombinator.com/item?id=1_2(3)",
              title: "item [x](y)"
            }
          ]
        },
        now: "2026-07-24T10:00:00.000Z"
      });
      gateway.intake(radarDetailEvent(1, "telegram:radar-detail-hostile"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("**1. Sneaky linkhttps://evil.example bold** — seen");
      expect(text).toContain("underscored code");
      expect(text).toContain("• hn_front: item xy\n  https://news.ycombinator.com/item?id=123");
      expect(text).not.toContain("[link]");
      expect(text).not.toContain("*bold*");
      expect(text).not.toContain("(y)");
    } finally {
      store.close();
    }
  });

  it("deduplicates a redelivered detail request on its ordinal-scoped key", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      seedCard(store, "dup", "Dup idea", 1);
      const event = radarDetailEvent(1, "telegram:radar-detail-dup");
      const first = gateway.intake(event, NOW);
      const second = gateway.intake(event, NOW);
      expect(second).toEqual(first);
      expect(store.countNotificationsByIdempotencyKey("telegram:radar-detail-dup:radar:1")).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("/status radar line", () => {
  it("shows last tick + active count in the sweeps section when the flag is on", () => {
    process.env.HOUGE_RADAR_ENABLED = "1";
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      seedCard(store, "one", "One", 1);
      store.markRadarRan("2026-07-24T09:00:00.000Z");
      gateway.intake(statusEvent(), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).toContain("Radar: last tick 3h ago · 1 active cards");
    } finally {
      store.close();
    }
  });

  it("is absent when the flag is off", () => {
    delete process.env.HOUGE_RADAR_ENABLED;
    const store = RunStore.openInMemory();
    try {
      const gateway = new Gateway(store);
      gateway.intake(statusEvent("telegram:status-radar-off"), NOW);
      const text = String(store.claimNextNotification("test", 30)?.payload.text);
      expect(text).not.toContain("Radar:");
    } finally {
      store.close();
    }
  });
});

describe("formatRadarText", () => {
  it("never leaks raw card markdown and reads 'never' before the first tick", () => {
    const text = formatRadarText(
      [
        {
          id: 1,
          slug: "x",
          title: "`code` _sneaky_",
          summary: "s",
          status: "seen",
          sources: {},
          distinct_items: 2,
          distinct_sources: 2,
          scores_json: null,
          first_seen: NOW,
          last_seen: NOW,
          archived_at: null,
          momentum: 4
        }
      ],
      1,
      null,
      NOW
    );
    expect(text).toContain("**1.** code sneaky — 动量 4 · 0m ago");
    expect(text).toContain("📡 **Idea Radar** — 1 active · last tick never");
  });

  it("renders a non-default lifecycle status (R2 verbs) while hiding the default `seen`", () => {
    const card = {
      id: 1,
      slug: "picked-idea",
      title: "Picked idea",
      summary: "s",
      status: "shortlisted",
      sources: {},
      distinct_items: 2,
      distinct_sources: 2,
      momentum: 4,
      first_seen: "2026-07-24T09:00:00.000Z",
      last_seen: "2026-07-24T11:00:00.000Z"
    } as Parameters<typeof formatRadarText>[0][number];
    const text = formatRadarText([card], 1, null, NOW);
    expect(text).toContain("**1.** Picked idea — 动量 4 · 1h ago · shortlisted");
  });
});
