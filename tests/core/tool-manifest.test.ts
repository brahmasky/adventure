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

describe("arming policy (step ⓪·2): evolution tools appear only when their flags arm them", () => {
  const EVOLUTION = ["self_diagnose", "self_write_propose", "skill_author"];

  it("code defaults: skills ON, codex + selfwrite OFF", () => {
    const names = manifestFor(EVOLUTION, {}).map((m) => m.name);
    expect(names).toEqual(["skill_author"]);
  });

  it("all armed: each is listed, in contract order", () => {
    const names = manifestFor(EVOLUTION, {
      HOUGE_CODEX_ENABLED: "1",
      HOUGE_SELFWRITE_ENABLED: "1",
      HOUGE_SKILLS_ENABLED: "1"
    }).map((m) => m.name);
    expect(names).toEqual(EVOLUTION);
  });

  it("each flag disarms exactly its tool", () => {
    const armed = { HOUGE_CODEX_ENABLED: "1", HOUGE_SELFWRITE_ENABLED: "1", HOUGE_SKILLS_ENABLED: "1" };
    expect(manifestFor(EVOLUTION, { ...armed, HOUGE_CODEX_ENABLED: "0" }).map((m) => m.name)).toEqual([
      "self_write_propose",
      "skill_author"
    ]);
    expect(manifestFor(EVOLUTION, { ...armed, HOUGE_SELFWRITE_ENABLED: "0" }).map((m) => m.name)).toEqual([
      "self_diagnose",
      "skill_author"
    ]);
    expect(manifestFor(EVOLUTION, { ...armed, HOUGE_SKILLS_ENABLED: "0" }).map((m) => m.name)).toEqual([
      "self_diagnose",
      "self_write_propose"
    ]);
  });

  it("the heavy tools' prompt lines hint terminality (wrap up with final)", () => {
    const lines = renderManifestLines(
      manifestFor(["self_write_propose", "skill_author"], { HOUGE_SELFWRITE_ENABLED: "1" })
    );
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line).toContain('wrap up with "final"');
  });

  it("the manifest entries never leak the arming predicate (registration metadata only)", () => {
    const [entry] = manifestFor(["self_write_propose"], { HOUGE_SELFWRITE_ENABLED: "1" });
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual([
      "category",
      "description",
      "inputSketch",
      "name",
      "output_limit_bytes",
      "risk_level",
      "side_effect_level"
    ]);
  });
});
