import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PANEL_JUDGE_SEAT_INDEX } from "../../src/capabilities/idea-panel-seats.js";
import { METERED_PROVIDERS } from "../../src/llm/metered-pricing.js";
import { judgeSeat } from "../../src/llm/registry.js";
import { familyOf } from "../../src/omp/model-string.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";

/** Every `.ts` file under src/, so a source-level invariant can be asserted repo-wide. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("panel judge seats (by index into HOUGE_OMP_JUDGES)", () => {
  const cfg = resolveOmpConfig({});
  it("gives every named judge its own index and exactly one model string", () => {
    const indices = Object.values(PANEL_JUDGE_SEAT_INDEX);
    expect(new Set(indices).size).toBe(indices.length);
    for (const i of indices) expect(judgeSeat(cfg, i)).toHaveLength(1);
  });

  it("keeps the three default judge seats on three different model families", () => {
    // Panel diversity is the point of the seat pinning; two seats on one family is one opinion.
    const families = Object.values(PANEL_JUDGE_SEAT_INDEX).map((i) => familyOf(judgeSeat(cfg, i)[0]!));
    expect(new Set(families).size).toBe(3);
  });
});

describe("panel seat binding sites", () => {
  // There are TWO of them — the daemon tick and `houge radar-panel` — and the CLI-only
  // migration initially missed the CLI one because each site built its own seats.
  // Asserting a constant alone did NOT catch that: this scans the source instead.
  const files = sourceFiles(join(process.cwd(), "src"));

  it("builds the panel's seats in ONE place: both sites call buildOmpPanelSeats", () => {
    const callers = files.filter((f) => readFileSync(f, "utf8").includes("buildOmpPanelSeats(")).map((f) => f.slice(f.indexOf("src")));
    expect(callers.sort()).toEqual([join("src", "capabilities", "idea-panel-seats.ts"), join("src", "cli.ts"), join("src", "telegram", "telegram-daemon.ts")].sort());
  });

  it("names no metered provider anywhere outside the LLM layer", () => {
    // The pricing table legitimately names them; nothing else should, or the
    // CLI-only guarantee is one forgotten call site away from being false again.
    const offenders = files
      .filter((file) => !file.includes(join("src", "llm")))
      .flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return [...METERED_PROVIDERS]
          .filter((provider) => text.includes(`"${provider}"`))
          .map((provider) => `${file}: "${provider}"`);
      });
    expect(offenders).toEqual([]);
  });
});
