import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PANEL_JUDGE_PROVIDERS } from "../../src/capabilities/idea-panel.js";
import { METERED_PROVIDERS } from "../../src/llm/metered-pricing.js";
import { buildLlmChain } from "../../src/llm/registry.js";

/** Every `.ts` file under src/, so a source-level invariant can be asserted repo-wide. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("PANEL_JUDGE_PROVIDERS", () => {
  it("pins each judge seat to its flat-rate CLI leg", () => {
    // Seat names are model FAMILIES: Kimi is served by the `pi` CLI, Gemini by the `agy` CLI.
    expect(PANEL_JUDGE_PROVIDERS).toEqual({ kimi: "pi", gemini: "agy-cli" });
  });

  it("names legs the registry can actually build", () => {
    // A typo here would throw at panel-tick time, not at test time — so resolve them for real.
    for (const provider of Object.values(PANEL_JUDGE_PROVIDERS)) {
      const chain = buildLlmChain({ HOUGE_LLM_PROVIDERS: provider } as NodeJS.ProcessEnv);
      expect(chain.map((p) => p.name)).toEqual([provider]);
    }
  });

  it("keeps the two judge seats on different model families", () => {
    // Panel diversity is the point of the seat pinning; two seats on one leg is one opinion.
    expect(PANEL_JUDGE_PROVIDERS.kimi).not.toBe(PANEL_JUDGE_PROVIDERS.gemini);
  });
});

describe("panel seat binding sites", () => {
  // There are TWO of them — the daemon tick and `houge radar-panel` — and the CLI-only
  // migration initially missed the CLI one because each site typed its own provider literals.
  // Asserting the exported constant alone did NOT catch that: this scans the source instead.
  const files = sourceFiles(join(process.cwd(), "src"));

  it("finds every pinnedJudge call taking its provider from the shared constant", () => {
    const literalPins = files.flatMap((file) => {
      const matches = [...readFileSync(file, "utf8").matchAll(/pinnedJudge\(\s*"([^"]+)"/g)];
      return matches.map((m) => `${file}: pinnedJudge("${m[1]}")`);
    });
    expect(literalPins).toEqual([]);
  });

  it("names no metered provider anywhere outside the LLM layer", () => {
    // The pricing table and the registry legitimately name them; nothing else should, or the
    // CLI-only guarantee is one forgotten call site away from being false again.
    const offenders = files
      .filter((file) => !file.includes(join("src", "llm")))
      .flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return [...METERED_PROVIDERS]
          .filter((provider) => text.includes(`"${provider}"`))
          .map((provider) => `${file}: "${provider}"`);
      })
      // llm-answer.ts tags usage by provider name for the metered legs, which stay buildable
      // as the operator escape hatch — that is a label, not a chain pin.
      .filter((hit) => !hit.includes(join("src", "capabilities", "llm-answer.ts")));
    expect(offenders).toEqual([]);
  });
});
