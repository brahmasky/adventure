import { READER_FAMILY } from "../../src/decisions/entries/reader-family.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("reader.family entry", () => {
  it("primary when primary", () => {
    const r = decideSync(READER_FAMILY, { primary: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("primary");
  });
  it("fallback when not primary", () => {
    const r = decideSync(READER_FAMILY, { primary: false }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("fallback");
  });
});
