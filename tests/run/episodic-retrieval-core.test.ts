import { describe, expect, it } from "vitest";
import { CORE_FACTS_CHAR_GUARD, renderCoreFactsBlock } from "../../src/run/episodic-retrieval.js";

// Net-new (location grounding): renderCoreFactsBlock — the always-known band's body.
// Pure function, no env, hermetic by construction.

describe("renderCoreFactsBlock", () => {
  it("flattens each fact to one '- <fact>' line and returns the rendered ids", () => {
    const out = renderCoreFactsBlock([{ id: 1, fact: "lives in a coastal city" }, { id: 2, fact: "works as an engineer" }]);
    expect(out.block).toBe("- lives in a coastal city\n- works as an engineer");
    expect(out.ids).toEqual([1, 2]);
  });

  it("collapses internal whitespace (defense-in-depth against a forged section line)", () => {
    expect(renderCoreFactsBlock([{ id: 1, fact: "lives   in\ta  city" }]).block).toBe("- lives in a city");
  });

  it("drops empty / whitespace-only facts and does not return their ids", () => {
    const out = renderCoreFactsBlock([{ id: 1, fact: "   " }, { id: 2, fact: "lives in a city" }, { id: 3, fact: "" }]);
    expect(out).toEqual({ block: "- lives in a city", ids: [2] });
  });

  it("returns an empty block and no ids for an empty list", () => {
    expect(renderCoreFactsBlock([])).toEqual({ block: "", ids: [] });
  });

  it("stops at the first char-guard overflow; the overflowed fact's id is not returned", () => {
    const long = "a".repeat(CORE_FACTS_CHAR_GUARD - 10);
    const out = renderCoreFactsBlock([{ id: 1, fact: long }, { id: 2, fact: "this second fact overflows the guard" }]);
    expect(out.ids).toEqual([1]);
    expect(out.block).toBe(`- ${long}`);
  });

  it("never throws on a hostile input shape (returns whatever fit)", () => {
    const hostile = { id: 9, get fact(): string { throw new Error("boom"); } };
    expect(() => renderCoreFactsBlock([hostile as unknown as { id: number; fact: string }])).not.toThrow();
    expect(renderCoreFactsBlock([hostile as unknown as { id: number; fact: string }])).toEqual({ block: "", ids: [] });
  });
});
