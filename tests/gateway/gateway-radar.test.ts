import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTypedTaskEvent } from "../../src/domain/types.js";
import { formatRadarText, Gateway, RADAR_OFF_TEXT } from "../../src/gateway/gateway.js";
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
      // Momentum order: the 3-item card first; markdown characters stripped inert.
      expect(text).toContain("• Big idea withmarkdown spice — momentum 3, seen 2h ago, seen");
      expect(text).not.toContain("[with](markdown)");
      expect(text).not.toContain("*spice*");
      expect(text).toContain("• Small idea — momentum 1, seen 2h ago, seen");
      expect(text).toContain("2 active · last tick 3h ago");
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
      expect(text).toContain("0 active · last tick never");
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
    expect(text).toContain("• code sneaky — momentum 4, seen 0m ago, seen");
    expect(text).toContain("1 active · last tick never");
  });
});
