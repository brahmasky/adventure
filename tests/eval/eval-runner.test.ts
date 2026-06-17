import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalSuite } from "../../src/eval/eval-runner.js";

describe("runEvalSuite", () => {
  it("fails when a required fixture file is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-eval-"));
    mkdirSync(join(root, "evals", "suites"), { recursive: true });
    writeFileSync(
      join(root, "evals", "suites", "milestone-0.json"),
      JSON.stringify({ name: "milestone-0", required_fixtures: ["run-state-transition-table"] })
    );

    expect(await runEvalSuite(root, "milestone-0")).toEqual({
      suite: "milestone-0",
      passed: false,
      failed: ["run-state-transition-table"]
    });
  });

  it("passes when all required fixture files include checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-eval-"));
    mkdirSync(join(root, "evals", "suites"), { recursive: true });
    mkdirSync(join(root, "evals", "fixtures"), { recursive: true });
    writeFileSync(
      join(root, "evals", "suites", "milestone-0.json"),
      JSON.stringify({ name: "milestone-0", required_fixtures: ["run-state-transition-table"] })
    );
    writeFileSync(
      join(root, "evals", "fixtures", "run-state-transition-table.json"),
      JSON.stringify({
        name: "run-state-transition-table",
        checks: ["waiting_for_approval requeues through queued"]
      })
    );

    expect(await runEvalSuite(root, "milestone-0")).toEqual({
      suite: "milestone-0",
      passed: true,
      failed: []
    });
  });

  it("fails when a required fixture has no checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "houge-eval-"));
    mkdirSync(join(root, "evals", "suites"), { recursive: true });
    mkdirSync(join(root, "evals", "fixtures"), { recursive: true });
    writeFileSync(
      join(root, "evals", "suites", "milestone-1.json"),
      JSON.stringify({ name: "milestone-1", required_fixtures: ["local-cli-run"] })
    );
    writeFileSync(
      join(root, "evals", "fixtures", "local-cli-run.json"),
      JSON.stringify({ name: "local-cli-run", checks: [] })
    );

    expect(await runEvalSuite(root, "milestone-1")).toEqual({
      suite: "milestone-1",
      passed: false,
      failed: ["local-cli-run"]
    });
  });

  it("passes milestone-2 executable golden cases", async () => {
    const result = await runEvalSuite(process.cwd(), "milestone-2");

    expect(result).toEqual({ suite: "milestone-2", passed: true, failed: [] });
  });

  it("fails milestone-2 when executable output differs from golden output", async () => {
    const result = await runEvalSuite(process.cwd(), "milestone-2", {
      fixtureOverride: {
        name: "milestone-2-parser-auth",
        type: "parser-auth",
        input: { text: "/unsupported", from_id: 111, chat_id: 222 }
      }
    });

    expect(result.passed).toBe(false);
    expect(result.failed).toContain("milestone-2-parser-auth");
  });
});
