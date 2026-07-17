import { describe, expect, it } from "vitest";
import { CORE_FACTS_CHAR_GUARD, renderCoreFactsBlock } from "../../src/run/episodic-retrieval.js";

// Net-new (location grounding): renderCoreFactsBlock — the always-known band's body.
// Pure function, no env, hermetic by construction.

describe("renderCoreFactsBlock", () => {
  it("flattens each fact to one '- <fact>' line", () => {
    const block = renderCoreFactsBlock([
      { fact: "Paco lives in Sydney" },
      { fact: "Paco is a software engineer" }
    ]);
    expect(block).toBe("- Paco lives in Sydney\n- Paco is a software engineer");
  });

  it("collapses internal whitespace (defense-in-depth against a forged section line)", () => {
    const block = renderCoreFactsBlock([{ fact: "Paco   lives\tin  Sydney" }]);
    expect(block).toBe("- Paco lives in Sydney");
    expect(block).not.toContain("\n- "); // one line only
  });

  it("drops empty / whitespace-only facts", () => {
    const block = renderCoreFactsBlock([{ fact: "   " }, { fact: "Paco lives in Sydney" }, { fact: "" }]);
    expect(block).toBe("- Paco lives in Sydney");
  });

  it("returns '' for an empty list", () => {
    expect(renderCoreFactsBlock([])).toBe("");
  });

  it("stops at the first char-guard overflow (input order, best-effort)", () => {
    const long = "x".repeat(CORE_FACTS_CHAR_GUARD - 5);
    const block = renderCoreFactsBlock([{ fact: long }, { fact: "this second fact overflows the guard" }]);
    expect(block).toBe(`- ${long}`);
    expect(block).not.toContain("overflows");
  });

  it("never throws on a hostile input shape (returns whatever fit)", () => {
    // A row whose `fact` getter throws must degrade, not blow up the turn.
    const hostile = {
      get fact(): string {
        throw new Error("boom");
      }
    };
    expect(() => renderCoreFactsBlock([hostile as unknown as { fact: string }])).not.toThrow();
    expect(renderCoreFactsBlock([hostile as unknown as { fact: string }])).toBe("");
  });
});
