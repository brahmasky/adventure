import { SELF_WRITE_GUARD } from "../../src/decisions/entries/selfwrite-guard.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("selfwrite.guard entry", () => {
  it("allows an allowed self-write", () => {
    const r = decideSync(SELF_WRITE_GUARD, { allowed: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("allowed");
  });
  it("blocks a disallowed self-write", () => {
    const r = decideSync(SELF_WRITE_GUARD, { allowed: false }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("blocked");
  });
});
