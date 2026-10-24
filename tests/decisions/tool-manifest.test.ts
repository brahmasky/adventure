import { TOOL_MANIFEST } from "../../src/decisions/entries/tool-manifest.js";
import { decideSync } from "../../src/decisions/decide.js";
import { describe, it, expect } from "vitest";

describe("tool.manifest entry", () => {
  it("includes when include", () => {
    const r = decideSync(TOOL_MANIFEST, { include: true }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("include");
  });
  it("omits when not include", () => {
    const r = decideSync(TOOL_MANIFEST, { include: false }, { run_id: null, recorder: { record: () => null } });
    expect(r.verdict).toBe("omit");
  });
});
