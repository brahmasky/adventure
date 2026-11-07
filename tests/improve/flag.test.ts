import { describe, expect, it } from "vitest";
import { DEFAULT_IMPROVE_AT, resolveImproveAt, warnRetiredDigestAt } from "../../src/improve/flag.js";

// Spec 2026-11-07 §10: the tick's time is its own variable with no `off` (R13: HOUGE_IMPROVE_ENABLED=false is the one switch);
// the digest's variable is retired and named once at boot, never read.
describe("resolveImproveAt", () => {
  it("HH:MM is itself; unset, a typo, and `off` are all the 21:00 default", () => {
    expect(resolveImproveAt({ HOUGE_IMPROVE_AT: "20:30" })).toBe("20:30");
    expect(resolveImproveAt({})).toBe(DEFAULT_IMPROVE_AT);
    expect(resolveImproveAt({ HOUGE_IMPROVE_AT: "off" })).toBe("21:00");
    expect(resolveImproveAt({ HOUGE_IMPROVE_AT: "25:00" })).toBe("21:00");
    expect(resolveImproveAt({ HOUGE_DECISION_DIGEST_AT: "20:00" })).toBe("21:00"); // the retired name moves nothing
  });
});
describe("warnRetiredDigestAt", () => {
  it("names a still-set HOUGE_DECISION_DIGEST_AT once and says the digest is gone; silent when unset", () => {
    const lines: string[] = [];
    expect(warnRetiredDigestAt({ HOUGE_DECISION_DIGEST_AT: "ON" }, (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual(["improve: HOUGE_DECISION_DIGEST_AT is retired (ADR 0034 13.1: no digest) and ignored; the tick's time is HOUGE_IMPROVE_AT; remove it from .env"]);
    expect(warnRetiredDigestAt({}, (l) => lines.push(l))).toBe(false);
    expect(lines).toHaveLength(1);
  });
});
