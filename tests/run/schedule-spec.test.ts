import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  DEFAULT_SCHEDULER_MAX_PER_CHAT,
  describeScheduleSpec,
  formatInstantInZone,
  parseScheduleSpec,
  resolveSchedulerEnabled,
  resolveSchedulerMaxPerChat,
  sanitizeScheduleGoal,
  SCHEDULE_GOAL_CHAR_CAP
} from "../../src/run/schedule-spec.js";

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
  });

  it("formatInstantInZone renders the wall clock in the schedule tz", () => {
    expect(formatInstantInZone("2026-10-03T21:00:00.000Z", "Australia/Sydney")).toBe("2026-10-04 08:00");
    expect(formatInstantInZone("2026-09-26T22:00:00.000Z", "Australia/Sydney")).toBe("2026-09-27 08:00");
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
