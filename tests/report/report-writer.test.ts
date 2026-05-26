import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("Sources");
  });
});
