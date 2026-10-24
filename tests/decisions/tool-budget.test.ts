import { TOOL_BUDGET } from "../../src/decisions/entries/tool-budget.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("tool.budget entry", () => {
  it("ok when ok", () => {
    const r = decideSync(TOOL_BUDGET, { ok: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("ok");
  });
  it("exceeded when not ok", () => {
    const r = decideSync(TOOL_BUDGET, { ok: false }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("exceeded");
  });
});
