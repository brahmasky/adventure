import { TOOL_POLICY } from "../../src/decisions/entries/tool-policy.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("tool.policy entry", () => {
  it("allows when allowed", () => {
    const r = decideSync(TOOL_POLICY, { allowed: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("allowed");
  });
  it("denies when denied", () => {
    const r = decideSync(TOOL_POLICY, { allowed: false }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("denied");
  });
});
