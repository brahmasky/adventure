import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalSuite } from "../../src/eval/eval-runner.js";

describe("runEvalSuite", () => {
  it("fails when a required fixture file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-eval-"));
    mkdirSync(join(root, "evals", "suites"), { recursive: true });
    writeFileSync(
      join(root, "evals", "suites", "milestone-0.json"),
      JSON.stringify({ name: "milestone-0", required_fixtures: ["run-state-transition-table"] })
    );

    expect(runEvalSuite(root, "milestone-0")).toEqual({
      suite: "milestone-0",
      passed: false,
      failed: ["run-state-transition-table"]
    });
  });

  it("passes when all required fixture files are present", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-eval-"));
    mkdirSync(join(root, "evals", "suites"), { recursive: true });
    mkdirSync(join(root, "evals", "fixtures"), { recursive: true });
    writeFileSync(
      join(root, "evals", "suites", "milestone-0.json"),
      JSON.stringify({ name: "milestone-0", required_fixtures: ["run-state-transition-table"] })
    );
    writeFileSync(join(root, "evals", "fixtures", "run-state-transition-table.json"), "{}");

    expect(runEvalSuite(root, "milestone-0")).toEqual({
      suite: "milestone-0",
      passed: true,
      failed: []
    });
  });
});
