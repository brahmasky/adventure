import { describe, expect, it } from "vitest";
import { SHELL_WRAPPER_SHA256, sha256File } from "../../src/omp/shell-wrapper.js";

describe("shell wrapper trust chain (R9)", () => {
  it("the pinned hash matches the .sh the build copies, so the dist check at planner start means something", () => {
    expect(sha256File(new URL("../../src/omp/shell-wrapper.sh", import.meta.url).pathname)).toBe(SHELL_WRAPPER_SHA256);
  });
});
