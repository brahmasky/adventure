import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableHash } from "../../src/domain/canonical.js";
import { writeRunReport } from "../../src/report/report-writer.js";

describe("writeRunReport", () => {
  it("writes a sourced markdown report under runs", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-report-"));
    const result = writeRunReport(root, {
      run_id: "run_1",
      title: "Research brief",
      body: "Result text",
      sources: ["src/domain/types.ts"],
      partial: false
    });

    const content = readFileSync(result.path, "utf8");

    expect(result.path).toBe(join(root, "runs", "run_1", "report.md"));
    expect(existsSync(result.path)).toBe(true);
    expect(content).toBe([
      "# Research brief",
      "",
      "Run: run_1",
      "Partial: no",
      "",
      "Result text",
      "",
      "## Sources",
      "",
      "- src/domain/types.ts",
      ""
    ].join("\n"));
    expect(result.hash).toBe(stableHash(content));
  });

  it("rejects unsafe run_id values without writing outside runs", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-report-"));

    expect(() => writeRunReport(root, {
      run_id: "../escape",
      title: "Research brief",
      body: "Result text",
      sources: ["src/domain/types.ts"],
      partial: true
    })).toThrow("Invalid run_id: ../escape");

    expect(existsSync(join(root, "escape", "report.md"))).toBe(false);
  });
});
