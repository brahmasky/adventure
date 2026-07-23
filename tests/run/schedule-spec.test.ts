import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  DEFAULT_SCHEDULER_MAX_PER_CHAT,
  describeScheduleSpec,
  formatInstantInZone,
  formatScheduleListText,
  ONCE_IN_MINUTES_MAX,
  parseScheduleSpec,
  resolveDisplayZone,
  resolveSchedulerEnabled,
  resolveSchedulerMaxPerChat,
  sanitizeScheduleGoal,
  scheduleDisplayName,
  SCHEDULE_GOAL_CHAR_CAP
} from "../../src/run/schedule-spec.js";
import type { ScheduledTaskRow } from "../../src/run/run-store.js";

describe("parseScheduleSpec (tolerant — bad shapes degrade to null, never throw)", () => {
  it("accepts the three v1 kinds, from an object or a JSON string", () => {
    expect(parseScheduleSpec({ kind: "weekly", day: "mon", at: "08:00" }))
      .toEqual({ kind: "weekly", day: "mon", at: "08:00" });
    expect(parseScheduleSpec({ kind: "daily", at: "23:59" })).toEqual({ kind: "daily", at: "23:59" });
    expect(parseScheduleSpec({ kind: "once", at_iso: "2026-07-20T22:00:00Z" }))
      .toEqual({ kind: "once", at_iso: "2026-07-20T22:00:00Z" });
    // Stored rows read back as JSON strings — the same parser covers both.
    expect(parseScheduleSpec('{"kind":"weekly","day":"sun","at":"08:00"}'))
      .toEqual({ kind: "weekly", day: "sun", at: "08:00" });
  });

  it("rejects every bad shape with null — corrupt rows and hallucinated specs must refuse, not throw", () => {
    expect(parseScheduleSpec(null)).toBeNull();
    expect(parseScheduleSpec("not json")).toBeNull();
    expect(parseScheduleSpec({ kind: "hourly", at: "08:00" })).toBeNull();
    expect(parseScheduleSpec({ kind: "weekly", day: "monday", at: "08:00" })).toBeNull();
    expect(parseScheduleSpec({ kind: "weekly", day: "mon", at: "8:00" })).toBeNull();
    expect(parseScheduleSpec({ kind: "weekly", day: "mon", at: "24:00" })).toBeNull();
    expect(parseScheduleSpec({ kind: "daily", at: "08:60" })).toBeNull();
    expect(parseScheduleSpec({ kind: "daily" })).toBeNull();
    expect(parseScheduleSpec({ kind: "once", at_iso: "next tuesday" })).toBeNull();
  });

  it("once/in_minutes: accepts a positive integer within a week; rejects 0/negative/float/oversized (relative form, code-side math)", () => {
    expect(parseScheduleSpec({ kind: "once", in_minutes: 3 })).toEqual({ kind: "once", in_minutes: 3 });
    expect(parseScheduleSpec({ kind: "once", in_minutes: ONCE_IN_MINUTES_MAX }))
      .toEqual({ kind: "once", in_minutes: ONCE_IN_MINUTES_MAX });
    expect(parseScheduleSpec({ kind: "once", in_minutes: 0 })).toBeNull();
    expect(parseScheduleSpec({ kind: "once", in_minutes: -5 })).toBeNull();
    expect(parseScheduleSpec({ kind: "once", in_minutes: 2.5 })).toBeNull();
    expect(parseScheduleSpec({ kind: "once", in_minutes: ONCE_IN_MINUTES_MAX + 1 })).toBeNull();
    expect(parseScheduleSpec({ kind: "once", in_minutes: "3" })).toBeNull();
    // in_minutes wins when both are present (relative form is the steered default).
    expect(parseScheduleSpec({ kind: "once", in_minutes: 3, at_iso: "2026-07-20T22:00:00Z" }))
      .toEqual({ kind: "once", in_minutes: 3 });
  });
});

describe("computeNextRunAt (DST-correct via the exported wallClockToInstant solver)", () => {
  // REQUIRED DST TEST (B10b): Sydney starts DST on Sun 2026-10-04 (02:00→03:00, +10→+11).
  // A weekly sun 08:00 schedule must land 08:00 LOCAL on both sides of the boundary — the
  // UTC instants differ by an hour. Cached-offset math would fire 07:00 or 09:00 local.
  it("weekly sun 08:00 Australia/Sydney lands 08:00 local across the Oct 4 2026 DST start", () => {
    // Before the boundary: next Sunday is Sep 27, still AEST (+10) → 22:00Z the day before.
    expect(computeNextRunAt({ kind: "weekly", day: "sun", at: "08:00" }, "Australia/Sydney", "2026-09-21T00:00:00Z"))
      .toBe("2026-09-26T22:00:00.000Z");
    // Crossing the boundary: after Sep 27's fire, the next Sunday is Oct 4 — DST morning,
    // AEDT (+11) → 21:00Z the day before. Same wall clock, different UTC hour.
    expect(computeNextRunAt({ kind: "weekly", day: "sun", at: "08:00" }, "Australia/Sydney", "2026-09-26T22:00:00Z"))
      .toBe("2026-10-03T21:00:00.000Z");
    // After the boundary: steady state at +11.
    expect(computeNextRunAt({ kind: "weekly", day: "sun", at: "08:00" }, "Australia/Sydney", "2026-10-03T21:00:00Z"))
      .toBe("2026-10-10T21:00:00.000Z");
  });

  it("is STRICTLY after `afterIso` (an occurrence at exactly `after` rolls to the next one)", () => {
    // 2026-09-26T22:00:00Z IS Sunday 08:00 Sydney — the result above skipped to Oct 4.
    // Daily: 08:00 Sydney on Oct 4 = 21:00Z Oct 3; asking at that instant rolls to Oct 5.
    expect(computeNextRunAt({ kind: "daily", at: "08:00" }, "Australia/Sydney", "2026-10-03T21:00:00Z"))
      .toBe("2026-10-04T21:00:00.000Z");
    // A second earlier still lands on Oct 4's occurrence.
    expect(computeNextRunAt({ kind: "daily", at: "08:00" }, "Australia/Sydney", "2026-10-03T20:59:59Z"))
      .toBe("2026-10-03T21:00:00.000Z");
  });

  it("once: returns the instant when it is in the future, null when past (creation-time guard)", () => {
    expect(computeNextRunAt({ kind: "once", at_iso: "2026-07-20T22:00:00Z" }, "UTC", "2026-07-15T00:00:00Z"))
      .toBe("2026-07-20T22:00:00.000Z");
    expect(computeNextRunAt({ kind: "once", at_iso: "2026-07-01T00:00:00Z" }, "UTC", "2026-07-15T00:00:00Z"))
      .toBeNull();
    // once ignores tz (at_iso is already absolute) — even a garbage tz cannot break it.
    expect(computeNextRunAt({ kind: "once", at_iso: "2026-07-20T22:00:00Z" }, "Not/AZone", "2026-07-15T00:00:00Z"))
      .toBe("2026-07-20T22:00:00.000Z");
  });

  it("once/in_minutes: code-side clock math anchored to afterIso — the planner never computes UTC (live-gate 07-15 offset slip)", () => {
    // A "3分钟后" ask reached us as planner-computed at_iso with an AEDT offset in July
    // (prose said 18:04 Sydney, at_iso said 19:04). in_minutes keeps the arithmetic here.
    expect(computeNextRunAt({ kind: "once", in_minutes: 3 }, "Australia/Sydney", "2026-07-15T08:02:00Z"))
      .toBe("2026-07-15T08:05:00.000Z");
    // tz-independent (relative to the creation instant) — garbage tz cannot break it.
    expect(computeNextRunAt({ kind: "once", in_minutes: 60 }, "Not/AZone", "2026-07-15T00:00:00Z"))
      .toBe("2026-07-15T01:00:00.000Z");
  });

  it("null on an unresolvable tz or garbage afterIso (never throws)", () => {
    expect(computeNextRunAt({ kind: "daily", at: "08:00" }, "Not/AZone", "2026-07-15T00:00:00Z")).toBeNull();
    expect(computeNextRunAt({ kind: "daily", at: "08:00" }, "Australia/Sydney", "garbage")).toBeNull();
  });
});

describe("rendering helpers", () => {
  it("describeScheduleSpec renders the /schedule list clause", () => {
    expect(describeScheduleSpec({ kind: "weekly", day: "mon", at: "08:00" })).toBe("weekly mon 08:00");
    expect(describeScheduleSpec({ kind: "daily", at: "07:30" })).toBe("daily 07:30");
    expect(describeScheduleSpec({ kind: "once", at_iso: "2026-07-20T22:00:00Z" })).toBe("once 2026-07-20T22:00:00Z");
    expect(describeScheduleSpec({ kind: "once", in_minutes: 3 })).toBe("once +3min");
  });

  it("formatInstantInZone renders the wall clock in the schedule tz", () => {
    expect(formatInstantInZone("2026-10-03T21:00:00.000Z", "Australia/Sydney")).toBe("2026-10-04 08:00");
    expect(formatInstantInZone("2026-09-26T22:00:00.000Z", "Australia/Sydney")).toBe("2026-09-27 08:00");
  });
});

describe("resolveDisplayZone (the human-facing render zone — no per-item tz)", () => {
  it("defaults to Australia/Sydney", () => {
    expect(resolveDisplayZone({})).toBe("Australia/Sydney");
    expect(resolveDisplayZone({ HOUGE_DISPLAY_TZ: "   " })).toBe("Australia/Sydney");
  });
  it("honors a HOUGE_DISPLAY_TZ override (trimmed)", () => {
    expect(resolveDisplayZone({ HOUGE_DISPLAY_TZ: "  America/New_York " })).toBe("America/New_York");
  });
});

describe("scheduleDisplayName (the dedup-guard preamble must NEVER surface)", () => {
  it("strips a guard parenthetical (full-width) and keeps the meaningful goal", () => {
    const goal =
      "AI日报（此定时任务已存在，绝不要再创建新的定时任务）：搜索过去24小时的AI新闻并总结";
    const name = scheduleDisplayName(goal);
    expect(name).not.toContain("此定时任务");
    expect(name).not.toContain("绝不要");
    expect(name.startsWith("AI日报：搜索过去24小时")).toBe(true);
  });

  it("strips a half-width guard parenthetical too", () => {
    const name = scheduleDisplayName("Report (此定时任务已存在): summarize AI news");
    expect(name).not.toContain("此定时任务");
    expect(name).toContain("Report");
    expect(name).toContain("summarize AI news");
  });

  it("leaves a plain goal unchanged (only capping long ones)", () => {
    expect(scheduleDisplayName("AI周报：搜HN/X本周AI新闻并总结")).toBe("AI周报：搜HN/X本周AI新闻并总结");
    const long = "x".repeat(80);
    const capped = scheduleDisplayName(long);
    expect(capped.length).toBeLessThanOrEqual(41); // 40 chars + the … marker
    expect(capped.endsWith("…")).toBe(true);
  });
});

describe("formatScheduleListText (the /schedule list line — human-readable)", () => {
  function row(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
    return {
      schedule_id: "sch_e8460e2d-1111-2222-3333-444455556666",
      chat_id: "555",
      goal: "AI日报（此定时任务已存在，绝不要再创建新的定时任务）：搜索过去24小时的AI新闻并总结",
      spec_json: '{"kind":"daily","at":"08:00"}',
      tz: "Australia/Sydney",
      state: "enabled",
      next_run_at: "2026-07-23T22:00:00.000Z",
      last_fired_at: null,
      consecutive_failures: 0,
      created_by: null,
      created_at: "2026-07-20T00:00:00.000Z",
      updated_at: "2026-07-20T00:00:00.000Z",
      ...overrides
    };
  }

  it("hides the guard preamble, shows the city once, and keeps the full cancel id", () => {
    const line = formatScheduleListText([row()]);
    // Guard plumbing never leaks.
    expect(line).not.toContain("此定时任务");
    expect(line).not.toContain("绝不要");
    // The full IANA tz is not duplicated on the line — only the city.
    expect(line).not.toContain("Australia/Sydney");
    expect(line).toContain("(Sydney)");
    // Local next-fire time, not a bare UTC ...Z.
    expect(line).toContain("下次 2026-07-24 08:00");
    expect(line).not.toContain("Z ·");
    // Cancel needs the FULL id (exact match) — it stays on the line, at the end.
    expect(line).toContain("sch_e8460e2d-1111-2222-3333-444455556666");
  });

  it("keeps the ⚠ failed prefix for failed rows", () => {
    const line = formatScheduleListText([row({ state: "failed" })]);
    expect(line.startsWith("⚠ failed · ")).toBe(true);
  });
});

describe("sanitizeScheduleGoal (digest-sanitizer conventions — the goal replays as a future turn)", () => {
  it("flattens CR/LF, replaces →, neutralizes time_claims:, and caps length (non-deleting)", () => {
    expect(sanitizeScheduleGoal("line one\r\nline two")).toBe("line one line two");
    expect(sanitizeScheduleGoal("a → b")).toBe("a - b");
    expect(sanitizeScheduleGoal("x time_claims: y")).toBe("x time_claims  y");
    expect(sanitizeScheduleGoal(`${"g".repeat(SCHEDULE_GOAL_CHAR_CAP + 50)}`).length).toBe(SCHEDULE_GOAL_CHAR_CAP);
    // A value ENDING in "time_claims" would reassemble the marker at a render seam.
    expect(sanitizeScheduleGoal("watch time_claims")).toBe("watch time_claims-");
    expect(sanitizeScheduleGoal("   ")).toBe("");
  });

  // verifier-added (B10 adversarial review, F1): the goal renders one-line-per-row in the
  // /schedule list — the Unicode line separators U+2028/U+2029 and NEL U+0085 start a new
  // line in most renderers (Telegram included), so an unflattened goal could fabricate a
  // second, forged list row (`sch_… · daily 09:00 · …`). Same smuggling class the Phase M
  // verifier closed in episodic-extract.ts; CR/LF alone was not enough.
  it("flattens the Unicode line separators U+2028/U+2029 and NEL U+0085 (forged list-row class)", () => {
    expect(sanitizeScheduleGoal("a\u2028sch_forged · daily 09:00 · evil")).toBe("a sch_forged · daily 09:00 · evil");
    expect(sanitizeScheduleGoal("a\u2029b")).toBe("a b");
    expect(sanitizeScheduleGoal("a\u0085b")).toBe("a b");
    expect(sanitizeScheduleGoal("a\u2028\u2029\u0085\r\nb")).toBe("a b");
  });
});

describe("resolvers (PINNED_ENV hermeticity)", () => {
  it("HOUGE_SCHEDULER_ENABLED defaults OFF and accepts the truthy spellings", () => {
    expect(resolveSchedulerEnabled({})).toBe(false);
    expect(resolveSchedulerEnabled({ HOUGE_SCHEDULER_ENABLED: "1" })).toBe(true);
    expect(resolveSchedulerEnabled({ HOUGE_SCHEDULER_ENABLED: "true" })).toBe(true);
    expect(resolveSchedulerEnabled({ HOUGE_SCHEDULER_ENABLED: "on" })).toBe(true);
    expect(resolveSchedulerEnabled({ HOUGE_SCHEDULER_ENABLED: "0" })).toBe(false);
    expect(resolveSchedulerEnabled({ HOUGE_SCHEDULER_ENABLED: "off" })).toBe(false);
  });

  it("HOUGE_SCHEDULER_MAX_PER_CHAT defaults 10; garbage/out-of-range degrade to the default", () => {
    expect(DEFAULT_SCHEDULER_MAX_PER_CHAT).toBe(10);
    expect(resolveSchedulerMaxPerChat({})).toBe(10);
    expect(resolveSchedulerMaxPerChat({ HOUGE_SCHEDULER_MAX_PER_CHAT: "3" })).toBe(3);
    expect(resolveSchedulerMaxPerChat({ HOUGE_SCHEDULER_MAX_PER_CHAT: "0" })).toBe(10);
    expect(resolveSchedulerMaxPerChat({ HOUGE_SCHEDULER_MAX_PER_CHAT: "junk" })).toBe(10);
  });
});
