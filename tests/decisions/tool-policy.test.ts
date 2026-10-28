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
  it("v3 names the standing codes: a standing allow and a lost CAS are legible on the decision row (an unknown reason is recorded as null)", () => {
    expect(TOOL_POLICY.version).toBe(3);
    const ok = decideSync(TOOL_POLICY, { decision: "allow", reason: "Standing approval authorised this call" }, { run_id: null, recorder: { record: () => null } });
    expect([ok.verdict, ok.reason]).toEqual(["allowed", "standing"]);
    const lost = decideSync(TOOL_POLICY, { decision: "requires_approval", reason: "Standing approval did not match" }, { run_id: null, recorder: { record: () => null } });
    expect([lost.verdict, lost.reason]).toEqual(["requires_approval", "standing_mismatch"]);
    expect(TOOL_POLICY.reasonCodes).toEqual(expect.arrayContaining(["standing", "standing_mismatch"]));
  });
});
