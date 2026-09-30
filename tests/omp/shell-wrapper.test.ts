import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHELL_WRAPPER_SHA256, sha256File } from "../../src/omp/shell-wrapper.js";

describe("shell wrapper trust chain (R9)", () => {
  it("the pinned hash matches the .sh the build copies, so the dist check at planner start means something", () => {
    expect(sha256File(new URL("../../src/omp/shell-wrapper.sh", import.meta.url).pathname)).toBe(SHELL_WRAPPER_SHA256);
  });

  it("calls sandbox-exec and every helper by absolute path under a fixed PATH set before any helper runs (A2)", () => {
    const text = readFileSync(new URL("../../src/omp/shell-wrapper.sh", import.meta.url).pathname, "utf8");
    const code = text.split("\n").filter((l) => !l.startsWith("#"));
    const firstHelper = code.findIndex((l) => /\/(bin|usr\/bin)\//.test(l) && !l.startsWith("PATH="));
    expect(code.findIndex((l) => l === "PATH=/usr/bin:/bin:/usr/sbin:/sbin")).toBeLessThan(firstHelper);
    for (const helper of ["sandbox-exec", "pgrep", "ps", "id", "grep", "seq", "nice", "kill", "sleep"]) {
      expect(code.join("\n"), helper).not.toMatch(new RegExp(`(^|[\\s$(|;])${helper}\\b(?![-/])`, "m"));
    }
  });
});
