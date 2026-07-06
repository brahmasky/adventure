import { describe, expect, it } from "vitest";
import { resolveLocalTimeZone, resolveTimeToolEnabled, toLocalTimes } from "../../src/prompt/tz-convert.js";

// THE REAL BUG (soak 07-06): `明天有哪几场？` across the dateline. `now` is an instant that is
// 2026-07-06 mid-afternoon in Australia/Sydney (the daemon's local tz). ESPN states fixtures in
// ET; Houge anchored today/tomorrow in Sydney but read the fixture dates in ET and never
// converted. Every assertion below reproduces one of Paco's own corrections.
const NOW_SYDNEY_AFTERNOON = new Date("2026-07-06T05:00:00Z"); // 2026-07-06 15:00 Australia/Sydney
const SYD = "Australia/Sydney";
const ET = "America/New_York";

describe("toLocalTimes — the World Cup dateline anchor (ET fixtures → Sydney)", () => {
  it("USA-Belgium (Jul 6 8pm ET) is Jul 7 10:00 Sydney → tomorrow", () => {
    const r = toLocalTimes([{ when: "2026-07-06 20:00", tz: ET }], NOW_SYDNEY_AFTERNOON, SYD)[0]!;
    expect(r).toEqual({ when: "2026-07-06 20:00", tz: ET, local: "2026-07-07 10:00", relative_day: "tomorrow" });
  });

  it("Portugal-Spain (Jul 6 3pm ET) is Jul 7 05:00 Sydney → tomorrow", () => {
    const r = toLocalTimes([{ when: "2026-07-06 15:00", tz: ET }], NOW_SYDNEY_AFTERNOON, SYD)[0]!;
    expect(r.local).toBe("2026-07-07 05:00");
    expect(r.relative_day).toBe("tomorrow");
  });

  it("Argentina-Egypt (Jul 7 noon ET) is Jul 8 02:00 Sydney → 'in 2 days', NOT tomorrow (the exact miss)", () => {
    const r = toLocalTimes([{ when: "2026-07-07 12:00", tz: ET }], NOW_SYDNEY_AFTERNOON, SYD)[0]!;
    expect(r.local).toBe("2026-07-08 02:00");
    expect(r.relative_day).toBe("in 2 days");
  });

  it("Mexico-England (Jul 5 8pm ET) is Jul 6 10:00 Sydney → today (this morning Sydney)", () => {
    const r = toLocalTimes([{ when: "2026-07-05 20:00", tz: ET }], NOW_SYDNEY_AFTERNOON, SYD)[0]!;
    expect(r.local).toBe("2026-07-06 10:00");
    expect(r.relative_day).toBe("today");
  });

  it("resolves the whole fixture batch in ONE call, order preserved (the batched-tool contract)", () => {
    const results = toLocalTimes(
      [
        { when: "2026-07-06 20:00", tz: ET },
        { when: "2026-07-07 12:00", tz: ET },
        { when: "2026-07-05 20:00", tz: ET }
      ],
      NOW_SYDNEY_AFTERNOON,
      SYD
    );
    expect(results.map((r) => r.relative_day)).toEqual(["tomorrow", "in 2 days", "today"]);
  });
});

describe("toLocalTimes — the dateline the OTHER way (Sydney source → ET local)", () => {
  it("a Sydney evening match reads as the SAME-day afternoon in ET (loses a day westward)", () => {
    // 2026-07-07 20:00 Sydney = 2026-07-07 10:00Z = 2026-07-07 06:00 ET. now = ~2026-07-07 in ET.
    const nowET = new Date("2026-07-07T12:00:00Z"); // 08:00 ET
    const r = toLocalTimes([{ when: "2026-07-07 20:00", tz: SYD }], nowET, ET)[0]!;
    expect(r.local).toBe("2026-07-07 06:00");
    expect(r.relative_day).toBe("today");
  });

  it("a Sydney 09:00 match is still the PREVIOUS evening in ET (yesterday)", () => {
    // 2026-07-08 09:00 Sydney = 2026-07-07 23:00Z = 2026-07-07 19:00 ET. now = 2026-07-08 20:00Z (16:00 ET).
    const nowET = new Date("2026-07-08T20:00:00Z");
    const r = toLocalTimes([{ when: "2026-07-08 09:00", tz: SYD }], nowET, ET)[0]!;
    expect(r.local).toBe("2026-07-07 19:00");
    expect(r.relative_day).toBe("yesterday");
  });
});

describe("toLocalTimes — DST correctness (the offset is measured AT the date, not assumed)", () => {
  it("a summer (EDT, UTC-4) and a winter (EST, UTC-5) ET time both land right in London", () => {
    const now = new Date("2026-07-01T00:00:00Z");
    const summer = toLocalTimes([{ when: "2026-07-06 12:00", tz: ET }], now, "Europe/London")[0]!;
    // EDT is UTC-4, London summer is BST UTC+1 → +5h.
    expect(summer.local).toBe("2026-07-06 17:00");
    const winter = toLocalTimes([{ when: "2026-01-06 12:00", tz: ET }], now, "Europe/London")[0]!;
    // EST is UTC-5, London winter is GMT → +5h as well, but via different offsets (proves per-date).
    expect(winter.local).toBe("2026-01-06 17:00");
  });

  it("converting INTO a zone across its own spring-forward keeps wall time coherent", () => {
    // US spring-forward 2026-03-08 02:00 EST→EDT. A UTC instant just after renders in EDT.
    const now = new Date("2026-03-08T00:00:00Z");
    // 2026-03-08 09:00 UTC expressed as a London time, converted to ET.
    const r = toLocalTimes([{ when: "2026-03-08 09:00", tz: "UTC" }], now, ET)[0]!;
    // 09:00Z on 03-08 is after the 07:00Z transition → EDT (UTC-4) → 05:00.
    expect(r.local).toBe("2026-03-08 05:00");
  });
});

describe("toLocalTimes — relative_day flips exactly at LOCAL midnight", () => {
  it("one minute before vs after local midnight are 'today' vs 'tomorrow'", () => {
    // now = 2026-07-06 23:59 Sydney (2026-07-06 13:59Z).
    const now = new Date("2026-07-06T13:59:00Z");
    const beforeMidnight = toLocalTimes([{ when: "2026-07-06 23:00", tz: SYD }], now, SYD)[0]!;
    expect(beforeMidnight.relative_day).toBe("today");
    const afterMidnight = toLocalTimes([{ when: "2026-07-07 00:05", tz: SYD }], now, SYD)[0]!;
    // Two minutes of wall-clock apart, but a calendar-date boundary → different label.
    expect(afterMidnight.relative_day).toBe("tomorrow");
  });

  it("labels the far past and future by day count", () => {
    const now = new Date("2026-07-06T05:00:00Z");
    const future = toLocalTimes([{ when: "2026-07-10 12:00", tz: SYD }], now, SYD)[0]!;
    expect(future.relative_day).toBe("in 4 days");
    const past = toLocalTimes([{ when: "2026-07-01 12:00", tz: SYD }], now, SYD)[0]!;
    expect(past.relative_day).toBe("5 days ago");
  });
});

describe("toLocalTimes — never throws; bad items carry an error and the rest resolve", () => {
  it("an invalid timezone sets error on that item only", () => {
    const results = toLocalTimes(
      [
        { when: "2026-07-06 20:00", tz: "Not/AZone" },
        { when: "2026-07-06 20:00", tz: ET }
      ],
      NOW_SYDNEY_AFTERNOON,
      SYD
    );
    expect(results[0]!.error).toContain("invalid timezone");
    expect(results[0]!.local).toBeUndefined();
    // The valid item still converts.
    expect(results[1]!).toEqual({ when: "2026-07-06 20:00", tz: ET, local: "2026-07-07 10:00", relative_day: "tomorrow" });
  });

  it("an unparseable datetime sets error on that item only", () => {
    const results = toLocalTimes(
      [
        { when: "next tuesday", tz: ET },
        { when: "2026-07-05 20:00", tz: ET }
      ],
      NOW_SYDNEY_AFTERNOON,
      SYD
    );
    expect(results[0]!.error).toContain("unparseable datetime");
    expect(results[0]!.local).toBeUndefined();
    expect(results[1]!.relative_day).toBe("today");
  });

  it("accepts an ISO 'T' separator and optional seconds", () => {
    const r = toLocalTimes([{ when: "2026-07-06T20:00:30", tz: ET }], NOW_SYDNEY_AFTERNOON, SYD)[0]!;
    expect(r.local).toBe("2026-07-07 10:00");
    expect(r.relative_day).toBe("tomorrow");
  });
});

describe("resolveTimeToolEnabled — default OFF (hermetic: reads only the passed env map)", () => {
  it("is OFF for unset/empty and ON only for 1/true/yes/on", () => {
    expect(resolveTimeToolEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    for (const v of ["1", "true", "yes", "on", "ON", "  True "]) {
      expect(resolveTimeToolEnabled({ HOUGE_TIME_TOOL_ENABLED: v } as NodeJS.ProcessEnv)).toBe(true);
    }
    expect(resolveTimeToolEnabled({ HOUGE_TIME_TOOL_ENABLED: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveTimeToolEnabled({ HOUGE_TIME_TOOL_ENABLED: "" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("resolveLocalTimeZone — HOUGE_TIMEZONE override else runtime tz", () => {
  it("uses the override when set", () => {
    expect(resolveLocalTimeZone({ HOUGE_TIMEZONE: "America/New_York" } as NodeJS.ProcessEnv)).toBe("America/New_York");
  });
  it("falls back to the runtime resolved tz when unset", () => {
    const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveLocalTimeZone({} as NodeJS.ProcessEnv)).toBe(runtime);
  });
  it("ignores a garbage override (falls back to runtime tz, never propagates it)", () => {
    const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveLocalTimeZone({ HOUGE_TIMEZONE: "Garbage/Zone" } as NodeJS.ProcessEnv)).toBe(runtime);
  });
});

describe("toLocalTimes — invalid localTz never throws (honors the never-throws contract)", () => {
  it("falls back to UTC rather than throwing on a garbage localTz", () => {
    const now = new Date("2026-07-06T05:00:00Z");
    const results = toLocalTimes([{ when: "2026-07-06 20:00", tz: "America/New_York" }], now, "Garbage/Zone");
    // 2026-07-06 20:00 EDT = 2026-07-07 00:00Z → in UTC that is 2026-07-07 00:00 (same day as now in UTC).
    expect(results[0]!.local).toBe("2026-07-07 00:00");
    expect(results[0]!.error).toBeUndefined();
  });
});
