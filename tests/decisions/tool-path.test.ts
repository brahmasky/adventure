import { TOOL_PATH } from "../../src/decisions/entries/tool-path.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";
describe("tool.path entry", () => {
  it("allows a plain relative path", () => {
    const r = decideSync(TOOL_PATH, { raw: "src/foo.ts", home: "/h", cwd: "/w" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("allowed");
  });
  it("blocks a bad path", () => {
    const r = decideSync(TOOL_PATH, { raw: "a\0b", home: "/h", cwd: "/w" }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("blocked");
  });
});
