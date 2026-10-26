import { TOOL_WALL } from "../../src/decisions/entries/tool-wall.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("tool.wall entry", () => {
  it("crosses when crosses", () => {
    const r = decideSync(TOOL_WALL, { crosses: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("crosses");
  });
  it("stays when not crosses", () => {
    const r = decideSync(TOOL_WALL, { crosses: false }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("stays");
  });
});
