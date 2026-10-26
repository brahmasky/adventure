import { TOOL_POLICY } from "../../src/decisions/entries/tool-policy.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("tool.policy entry", () => {
  it("allows when allowed", () => {
    const r = decideSync(TOOL_POLICY, { decision: "allow", reason: "Capability allowed by task contract" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("allowed");
    expect(r.reason).toBe("allowed");
  });
  it("requires approval", () => {
    const r = decideSync(TOOL_POLICY, { decision: "requires_approval", reason: "Capability has gated side effects" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("requires_approval");
  });
  it("denies when denied", () => {
    const r = decideSync(TOOL_POLICY, { decision: "deny", reason: "Capability not allowed by task contract" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("denied");
  });
});
