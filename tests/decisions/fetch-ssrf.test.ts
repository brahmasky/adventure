import { FETCH_SSRF } from "../../src/decisions/entries/fetch-ssrf.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("fetch.ssrf entry", () => {
  it("allows permitted fetch", () => {
    const r = decideSync(FETCH_SSRF, { allowed: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("allowed");
  });
  it("blocks disallowed fetch", () => {
    const r = decideSync(FETCH_SSRF, { allowed: false }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("blocked");
  });
});
