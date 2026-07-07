import { describe, expect, it } from "vitest";
import { createTimeConvertAdapter } from "../../src/capabilities/time-convert.js";

// Injected clock + local tz + empty env so the adapter is hermetic against the host tz /
// HOUGE_TIMEZONE / an ambient HOUGE_TZ_EVIDENCE_ENABLED (the daemon-env sweep exports it).
const NOW = new Date("2026-07-06T05:00:00Z"); // 2026-07-06 15:00 Australia/Sydney
const CONFIG = { now: NOW, localTz: "Australia/Sydney", env: {} };
const ET = "America/New_York";

describe("createTimeConvertAdapter", () => {
  it("batches the World Cup fixtures in one call and returns code-computed labels", async () => {
    const adapter = createTimeConvertAdapter(CONFIG);
    const result = await adapter({
      items: [
        { when: "2026-07-06 20:00", tz: ET },
        { when: "2026-07-07 12:00", tz: ET }
      ]
    });
    expect(result).toEqual({
      ok: true,
      output: {
        results: [
          { when: "2026-07-06 20:00", tz: ET, local: "2026-07-07 10:00", relative_day: "tomorrow" },
          { when: "2026-07-07 12:00", tz: ET, local: "2026-07-08 02:00", relative_day: "in 2 days" }
        ]
      }
    });
  });

  it("rejects a missing/empty items array without converting", async () => {
    const adapter = createTimeConvertAdapter(CONFIG);
    expect(await adapter({})).toEqual({ ok: false, error: "items must be a non-empty array of {when, tz}" });
    expect(await adapter({ items: [] })).toEqual({ ok: false, error: "items must be a non-empty array of {when, tz}" });
    expect(await adapter({ items: "2026-07-06 20:00" })).toEqual({
      ok: false,
      error: "items must be a non-empty array of {when, tz}"
    });
  });

  it("isolates a malformed item as a per-item error without dropping good conversions", async () => {
    const adapter = createTimeConvertAdapter(CONFIG);
    const result = await adapter({
      items: [
        { when: "2026-07-06 20:00" }, // missing tz
        { tz: ET }, // missing when
        { when: "  ", tz: ET }, // blank when
        { when: "2026-07-05 20:00", tz: ET } // good — must still resolve
      ]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const results = result.output.results as Array<Record<string, unknown>>;
      expect(String(results[0]!.error)).toContain("invalid timezone");
      expect(String(results[1]!.error)).toContain("unparseable datetime");
      expect(String(results[2]!.error)).toContain("unparseable datetime");
      expect(results[3]).toEqual({ when: "2026-07-05 20:00", tz: ET, local: "2026-07-06 10:00", relative_day: "today" });
    }
  });

  it("passes per-item conversion errors through in the output (bad tz among good items)", async () => {
    const adapter = createTimeConvertAdapter(CONFIG);
    const result = await adapter({
      items: [
        { when: "2026-07-06 20:00", tz: "Not/AZone" },
        { when: "2026-07-05 20:00", tz: ET }
      ]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const results = result.output.results as Array<Record<string, unknown>>;
      expect(String(results[0]!.error)).toContain("invalid timezone");
      expect(results[1]).toEqual({ when: "2026-07-05 20:00", tz: ET, local: "2026-07-06 10:00", relative_day: "today" });
    }
  });
});
