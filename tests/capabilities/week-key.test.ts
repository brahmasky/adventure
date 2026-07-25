import { describe, expect, it } from "vitest";
import {
  computeWeekKey,
  PANEL_DEFAULT_SCHEDULE,
  resolvePanelAt
} from "../../src/capabilities/week-key.js";

describe("computeWeekKey — ISO week of the LOCAL calendar date in tz", () => {
  it("2026-07-25T23:00:00Z in Australia/Sydney (= Sunday 2026-07-26 09:00 local) → 2026-W30", () => {
    // Sydney local date is Sunday 2026-07-26. ISO weeks run Mon–Sun, so that Sunday closes the
    // week Mon 2026-07-20 … Sun 2026-07-26, whose Thursday is 2026-07-23. 2026-01-01 is itself
    // a Thursday (week 1's Thursday), and 2026-07-23 is 203 days later = exactly 29 weeks,
    // so the week number is 29 + 1 = 30.
    expect(computeWeekKey("2026-07-25T23:00:00Z", "Australia/Sydney")).toBe("2026-W30");
  });

  it("Monday 08:00 AEST whose UTC instant is still Sunday → labels the NEW ISO week", () => {
    // 2026-07-26T22:00:00Z is Monday 2026-07-27 08:00 in Sydney (AEST +10) but still Sunday
    // 2026-07-26 in UTC. The local Monday opens ISO week 31; the UTC Sunday still closes week 30.
    // A UTC-based week key would mislabel every mon-08:00 Sydney panel run — this is the spec §4
    // rationale, asserted.
    expect(computeWeekKey("2026-07-26T22:00:00Z", "Australia/Sydney")).toBe("2026-W31");
    expect(computeWeekKey("2026-07-26T22:00:00Z", "UTC")).toBe("2026-W30");
  });

  it("2027-01-01 belongs to the PREVIOUS ISO year's week 53 (2026-W53)", () => {
    // 2026-01-01 is a Thursday, so 2026 is a 53-week ISO year. 2027-01-01 is a Friday; its
    // week's Thursday is 2026-12-31, so the ISO year is 2026 and the week is 53 — the January
    // date carries LAST year's label.
    expect(computeWeekKey("2027-01-01T12:00:00Z", "UTC")).toBe("2026-W53");
  });

  it("a late-December date that belongs to NEXT year's W01 (2024-12-30 → 2025-W01)", () => {
    // 2024-12-30 is a Monday; its week runs Mon 2024-12-30 … Sun 2025-01-05 and its Thursday is
    // 2025-01-02 — so the ISO year is 2025 and the week is W01 even though the calendar date is
    // still December 2024.
    expect(computeWeekKey("2024-12-30T12:00:00Z", "UTC")).toBe("2025-W01");
  });

  it("zero-pads single-digit weeks (YYYY-W0w)", () => {
    // 2026-01-05 is the Monday of ISO week 2 of 2026.
    expect(computeWeekKey("2026-01-05T12:00:00Z", "UTC")).toBe("2026-W02");
  });

  it("invalid tz falls back to UTC parts and never throws", () => {
    expect(computeWeekKey("2026-07-26T22:00:00Z", "Not/AZone")).toBe("2026-W30");
    // Same instant, valid Sydney zone → W31; the fallback is observably the UTC labeling.
    expect(computeWeekKey("2026-07-26T22:00:00Z", "Australia/Sydney")).toBe("2026-W31");
  });

  it("never throws on an unparseable instant (degrades to the epoch label)", () => {
    expect(computeWeekKey("not-a-date", "UTC")).toBe("1970-W01");
  });
});

describe("resolvePanelAt — HOUGE_RADAR_PANEL_AT grammar (spec §4, exact)", () => {
  const env = (v?: string): NodeJS.ProcessEnv =>
    v === undefined ? ({} as NodeJS.ProcessEnv) : ({ HOUGE_RADAR_PANEL_AT: v } as NodeJS.ProcessEnv);

  it("unset → default sun 09:00", () => {
    expect(resolvePanelAt(env())).toEqual({ day: "sun", at: "09:00" });
    expect(resolvePanelAt(env())).toEqual(PANEL_DEFAULT_SCHEDULE);
  });

  it("well-formed values parse (case-folded, whitespace-tolerant)", () => {
    expect(resolvePanelAt(env("sun 09:00"))).toEqual({ day: "sun", at: "09:00" });
    expect(resolvePanelAt(env("SUN 09:00"))).toEqual({ day: "sun", at: "09:00" });
    expect(resolvePanelAt(env(" mon  18:30 "))).toEqual({ day: "mon", at: "18:30" });
  });

  it("off / OFF → null (panel never fires)", () => {
    expect(resolvePanelAt(env("off"))).toBeNull();
    expect(resolvePanelAt(env("OFF"))).toBeNull();
    expect(resolvePanelAt(env("  off  "))).toBeNull();
  });

  it("malformed values fall back to the default, never throw", () => {
    expect(resolvePanelAt(env("sun 9:00"))).toEqual(PANEL_DEFAULT_SCHEDULE); // not zero-padded
    expect(resolvePanelAt(env("saturday 08:00"))).toEqual(PANEL_DEFAULT_SCHEDULE); // long day name
    expect(resolvePanelAt(env(""))).toEqual(PANEL_DEFAULT_SCHEDULE);
    expect(resolvePanelAt(env("sun"))).toEqual(PANEL_DEFAULT_SCHEDULE); // one token
    expect(resolvePanelAt(env("sun 09:00 extra"))).toEqual(PANEL_DEFAULT_SCHEDULE); // three tokens
    expect(resolvePanelAt(env("sun 24:00"))).toEqual(PANEL_DEFAULT_SCHEDULE); // out-of-range hour
  });

  it("returns a fresh object each call (no shared mutable default)", () => {
    const a = resolvePanelAt(env());
    const b = resolvePanelAt(env());
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });
});
