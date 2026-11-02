import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PANEL_JUDGE_SEAT_INDEX } from "../../src/capabilities/idea-panel-seats.js";
import { METERED_PROVIDERS } from "../../src/llm/metered-pricing.js";
import { judgeSeat } from "../../src/llm/registry.js";
import { familyOf } from "../../src/omp/model-string.js";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { RoleResolver } from "../../src/omp/role-resolver.js";
import { RunStore } from "../../src/run/run-store.js";

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
  it("static: the kimi and codex seats have one model each; seat 2 has none (spec 2026-11-02 D4-A)", () => {
    // The rollback must not adopt a codename without Paco's tap, so the gemini seat fails alone rather than guess.
    expect(judgeSeat(cfg, PANEL_JUDGE_SEAT_INDEX.kimi)).toHaveLength(1);
    expect(judgeSeat(cfg, PANEL_JUDGE_SEAT_INDEX.codex)).toHaveLength(1);
    expect(judgeSeat(cfg, PANEL_JUDGE_SEAT_INDEX.gemini)).toHaveLength(0);
  });

  it("keeps the three judge seats on three different model families once seat 2 is tapped", async () => {
    // Panel diversity is the point of the seat pinning; two seats on one family is one opinion. Resolved over the
    // 2026-11-02 catalog with Paco's tap on judges:2 (the override a tap on the empty-tier card writes).
    const store = RunStore.openInMemory();
    store.recordModelRoleOverride({ key: "judges:2", pattern: "gemini-4-argon", actor: "paco" });
    const catalog = parseOmpCatalog(readFileSync(new URL("../fixtures/omp-catalog-2026-11-02.json", import.meta.url).pathname, "utf8"))!;
    const roles = new RoleResolver({ store, env: () => ({ HOUGE_MODEL_ROLES: "resolved" }), readCatalog: async () => catalog });
    await roles.refreshCatalog();
    const tapped = resolveOmpConfig({}, roles.chains());
    const families = Object.values(PANEL_JUDGE_SEAT_INDEX).map((i) => familyOf(judgeSeat(tapped, i)[0]!));
    expect(new Set(families).size).toBe(3);
    store.close();
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

  it("the CLI site passes resolved chains, as the daemon does (final review, codex: the static lists drop Paco's judges:2 tap)", () => {
    expect(readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8")).toContain("chains: await resolvedPanelChains(store, process.env)");
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
