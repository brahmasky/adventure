import { describe, expect, it } from "vitest";
import { getHougeVersion } from "../src/index.js";

describe("project scaffold", () => {
  it("exports a version string for diagnostics", () => {
    expect(getHougeVersion()).toMatch(/^0\.1\.0-/);
  });
});
