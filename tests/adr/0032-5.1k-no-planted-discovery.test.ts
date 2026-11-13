import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OMP_DISABLED_DISCOVERY } from "../../src/omp/omp-discovery.js";
import { writeHougeConfigFile } from "../../src/omp/planner-supervisor.js";

// ADR 0032 5.1 (k): omp may load no code the planner could have planted. If a provider came back on, a file the planner
// can write (workspace or $HOME) would run at session start, outside every gate, with the planner's rights (D11).
describe("ADR 0032 5.1 (k): omp's discovery of planted code is off", () => {
  it("the overlay sets mcp.enableProjectConfig to false and disables every listed discovery provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "adr0032k-"));
    try {
      mkdirSync(join(dir, "omp"), { recursive: true });
      const text = readFileSync(writeHougeConfigFile({ data: dir }), "utf8");
      expect(text).toMatch(/^mcp:\n {2}enableProjectConfig: false$/m);
      const block = /^disabledProviders:\n((?: {2}- .+\n)+)/m.exec(text)?.[1] ?? "";
      expect(block.split("\n").filter(Boolean).map((l) => l.slice(4)).sort()).toEqual([...OMP_DISABLED_DISCOVERY].sort());
      expect(OMP_DISABLED_DISCOVERY).toContain("native");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the ADR states the rule", () => {
    const adr = readFileSync(join(process.cwd(), "docs/decisions", "0032-omp-runtime-consolidated.md"), "utf8");
    expect(adr).toContain("(k) *Added 2026-11-13:* omp's discovery of planted code is off");
  });
});
