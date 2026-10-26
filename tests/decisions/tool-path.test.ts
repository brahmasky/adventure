import { TOOL_PATH } from "../../src/decisions/entries/tool-path.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";
describe("tool.path entry", () => {
  it("allows a permitted path", () => {
    const r = decideSync(TOOL_PATH, { allowed: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("allowed");
  });
  it("blocks with the seam reason", () => {
    for (const reason of ["missing_path", "bad_path", "url_read", "protected_path"] as const) {
      const r = decideSync(TOOL_PATH, { allowed: false, reason }, { run_id: null, recorder: { record: () => null } });
      expect(r.verdict).toBe("blocked");
      expect(r.reason).toBe(reason);
    }
  });
});
