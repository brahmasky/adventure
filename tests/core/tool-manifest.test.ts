import { describe, expect, it } from "vitest";
import { manifestFor, renderManifestLines } from "../../src/core/tool-manifest.js";

describe("manifestFor (contract-derived tool manifest, ADR 0013)", () => {
  it("is the intersection of allowed_actions and known descriptors, in contract order", () => {
    const manifest = manifestFor(["intent_router", "web_search", "llm_answer", "lesson_write", "write_report"]);
    // Sentinels/report actions have no descriptor → never reach the model's menu.
    expect(manifest.map((m) => m.name)).toEqual(["web_search", "llm_answer", "lesson_write"]);
  });

  it("a capability the contract does not allow never appears (the contract stays the envelope)", () => {
    const manifest = manifestFor(["llm_answer", "write_report"]);
    expect(manifest.map((m) => m.name)).toEqual(["llm_answer"]);
  });

  it("unknown allowed actions are inert", () => {
    expect(manifestFor(["coding_agent_cli", "generic_shell"])).toEqual([]);
  });

  it("lesson_write is internal memory (side effect none) — no approval gate trips", () => {
    const [entry] = manifestFor(["lesson_write"]);
    expect(entry!.side_effect_level).toBe("none");
    expect(entry!.risk_level).toBe("low");
  });

  it("renders one prompt line per tool with description and input sketch", () => {
    const lines = renderManifestLines(manifestFor(["web_search", "lesson_write"]));
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^- web_search: .+ Input: \{"query"/);
    // lesson_write's only model-controlled input is the scope (trust-anchored otherwise).
    expect(lines[1]).toContain('"scope"');
    expect(lines[1]).not.toContain('"feedback"');
  });
});
