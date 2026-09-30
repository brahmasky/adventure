import { describe, expect, it } from "vitest";
import { familyOf, formatModelString, parseModelChain, parseModelString } from "../../src/omp/model-string.js";

describe("model strings — the one syntax every seat's chain is written in", () => {
  it("parses provider/model and an optional effort, because fallback swaps whole strings", () => {
    expect(parseModelString("anthropic/claude-opus-5-5:medium")).toEqual({
      provider: "anthropic", model: "claude-opus-5-5", effort: "medium"
    });
    expect(parseModelString("kimi-code/k3")).toEqual({ provider: "kimi-code", model: "k3" });
  });

  it("rejects malformed strings so a typo in .env fails at boot, not at 3 a.m.", () => {
    for (const bad of ["", "k3", "/k3", "kimi-code/", "kimi-code/k3:turbo", "a/b/c"]) {
      expect(() => parseModelString(bad)).toThrow();
    }
  });

  it("parses a comma chain in order and round-trips through format", () => {
    const chain = parseModelChain(" anthropic/claude-opus-5-5:medium , kimi-code/k3:low ");
    expect(chain.map(formatModelString)).toEqual(["anthropic/claude-opus-5-5:medium", "kimi-code/k3:low"]);
    expect(() => parseModelChain(" , ")).toThrow();
  });

  it("derives family from the model id, not the route — Antigravity Claude is still claude (ADR 0014 cross-family rule)", () => {
    expect(familyOf({ model: "claude-opus-4-6" })).toBe("claude");
    expect(familyOf({ model: "gemini-3.8-flash" })).toBe("gemini");
    expect(familyOf({ model: "gpt-5.5" })).toBe("gpt");
    expect(familyOf({ model: "gpt-oss-120b" })).toBe("gpt");
    expect(familyOf({ model: "k3" })).toBe("kimi");
    expect(familyOf({ model: "kimi-k2.6" })).toBe("kimi");
    expect(familyOf({ model: "mystery-1" })).toBe("other");
  });
});
