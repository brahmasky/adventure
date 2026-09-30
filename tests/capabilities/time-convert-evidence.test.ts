import { describe, expect, it } from "vitest";
import {
  createTimeConvertAdapter,
  resolveTzEvidenceEnabled,
  TIME_CONVERT_PRIOR_DIGESTS_FIELD,
  ZONE_EVIDENCE_ERROR
} from "../../src/capabilities/time-convert.js";

const NOW = new Date("2026-07-06T05:00:00Z"); // 2026-07-06 15:00 Australia/Sydney
const CONFIG = { now: NOW, localTz: "Australia/Sydney" };
const ET = "America/New_York";
const SOURCE_FRAGMENT = "Portugal vs Spain — Mon Jul 6, 2026 2:00 PM ET";

describe("resolveTzEvidenceEnabled (default OFF; explicit truthy arms it)", () => {
  it("defaults OFF and accepts the same truthy spellings as Dual-LLM", () => {
    expect(resolveTzEvidenceEnabled({})).toBe(false);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "1" })).toBe(true);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "true" })).toBe(true);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "yes" })).toBe(true);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "on" })).toBe(true);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "0" })).toBe(false);
    expect(resolveTzEvidenceEnabled({ HOUGE_TZ_EVIDENCE_ENABLED: "off" })).toBe(false);
  });
});

describe("createTimeConvertAdapter zone_evidence gate", () => {
  it("OFF preserves legacy conversion without zone_evidence", async () => {
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: false });
    const result = await adapter({ items: [{ when: "2026-07-06 14:00", tz: ET }] });
    expect(result).toEqual({
      ok: true,
      output: {
        local_tz: "Australia/Sydney",
        results: [{ when: "2026-07-06 14:00", tz: ET, local: "2026-07-07 04:00", relative_day: "tomorrow" }]
      }
    });
  });

  it("ON accepts evidence whose timezone label appears in a prior step digest", async () => {
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: true });
    const result = await adapter({
      items: [{ when: "2026-07-06 14:00", tz: ET, zone_evidence: SOURCE_FRAGMENT }],
      [TIME_CONVERT_PRIOR_DIGESTS_FIELD]: [`Schedule digest: ${SOURCE_FRAGMENT}`]
    });
    expect(result).toEqual({
      ok: true,
      output: {
        local_tz: "Australia/Sydney",
        results: [{ when: "2026-07-06 14:00", tz: ET, local: "2026-07-07 04:00", relative_day: "tomorrow" }]
      }
    });
  });

  it("ON rejects forged evidence that is not present in previous digests", async () => {
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: true });
    const result = await adapter({
      items: [{ when: "2026-07-06 14:00", tz: ET, zone_evidence: SOURCE_FRAGMENT }],
      [TIME_CONVERT_PRIOR_DIGESTS_FIELD]: ["Schedule digest: no matching fragment here"]
    });
    expect(result).toEqual({
      ok: true,
      output: {
        local_tz: "Australia/Sydney",
        results: [{ when: "2026-07-06 14:00", tz: ET, error: ZONE_EVIDENCE_ERROR }]
      }
    });
  });

  it("ON rejects evidence that does not state the timezone label", async () => {
    const adapter = createTimeConvertAdapter({ ...CONFIG, tzEvidenceEnabled: true });
    const fragment = "Portugal vs Spain — Mon Jul 6, 2026 2:00 PM";
    const result = await adapter({
      items: [{ when: "2026-07-06 14:00", tz: ET, zone_evidence: fragment }],
      [TIME_CONVERT_PRIOR_DIGESTS_FIELD]: [`Schedule digest: ${fragment}`]
    });
    expect(result).toEqual({
      ok: true,
      output: {
        local_tz: "Australia/Sydney",
        results: [{ when: "2026-07-06 14:00", tz: ET, error: ZONE_EVIDENCE_ERROR }]
      }
    });
  });
});
