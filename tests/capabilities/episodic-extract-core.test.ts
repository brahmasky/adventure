import { describe, expect, it } from "vitest";
import {
  EPISODIC_EXTRACT_DISCIPLINE,
  parseEpisodicExtractResult
} from "../../src/capabilities/episodic-extract.js";
import { RECONCILE_DISCIPLINE } from "../../src/capabilities/reconcile.js";

// Net-new (location grounding): the atomicity/split rule, the core-field instruction,
// the reconcile orthogonality/no-drop rule, and the `core` parse. Constants are asserted
// by IMPORT (never a pinned literal — self-write rule); no env is read here so the suite
// is hermetic by construction.

function extractAnswer(facts: unknown[]): string {
  return JSON.stringify({ facts });
}

describe("EPISODIC_EXTRACT_DISCIPLINE — atomicity split + core field (Part A / C1)", () => {
  it("forbids bundled facts and instructs splitting biography from preference", () => {
    // The join words that signal a bundled (non-atomic) fact.
    expect(EPISODIC_EXTRACT_DISCIPLINE).toContain("NEVER bundle two assertions into one");
    expect(EPISODIC_EXTRACT_DISCIPLINE).toContain("SPLIT it");
    expect(EPISODIC_EXTRACT_DISCIPLINE).toContain("BIOGRAPHY");
    expect(EPISODIC_EXTRACT_DISCIPLINE).toContain("SEPARATE fact entries");
  });

  it("carries a concrete Sydney split example ⇒ two facts", () => {
    expect(EPISODIC_EXTRACT_DISCIPLINE).toContain("Paco lives in Sydney.");
    expect(EPISODIC_EXTRACT_DISCIPLINE).toContain("Paco wants times reported in Sydney time.");
  });

  it("documents the `core` field: true only for stable biography/identity", () => {
    expect(EPISODIC_EXTRACT_DISCIPLINE).toContain('"core":true|false');
    expect(EPISODIC_EXTRACT_DISCIPLINE).toContain('"core":true');
    // The negative: preferences/tasks/transient are NOT core.
    expect(EPISODIC_EXTRACT_DISCIPLINE.toLowerCase()).toContain("preferences, tasks");
  });
});

describe("RECONCILE_DISCIPLINE — orthogonality / no-drop rule (Part B)", () => {
  it("permits SUPERSEDE only when the new item covers everything, else UPDATE/ADD", () => {
    expect(RECONCILE_DISCIPLINE).toContain("SUPERSEDE ONLY when the new item covers EVERYTHING");
    expect(RECONCILE_DISCIPLINE).toContain("orthogonal information");
    expect(RECONCILE_DISCIPLINE).toContain("preserving BOTH");
  });

  it("explicitly forbids dropping information by superseding", () => {
    expect(RECONCILE_DISCIPLINE).toContain("NEVER drop information by superseding");
  });
});

describe("parseEpisodicExtractResult — core parse (Part C1)", () => {
  it("parses core:true when the model marks a biography fact", () => {
    const { facts } = parseEpisodicExtractResult(
      extractAnswer([{ fact: "Paco lives in Sydney", core: true }])
    );
    expect(facts[0]!.core).toBe(true);
  });

  it("parses core:false when the model marks a preference", () => {
    const { facts } = parseEpisodicExtractResult(
      extractAnswer([{ fact: "Paco prefers concise answers", core: false }])
    );
    expect(facts[0]!.core).toBe(false);
  });

  it("defaults missing core to false", () => {
    const { facts } = parseEpisodicExtractResult(
      extractAnswer([{ fact: "Paco cycles on weekends" }])
    );
    expect(facts[0]!.core).toBe(false);
  });

  it("degrades garbage core (string / number / null) to false — only literal true counts", () => {
    const { facts } = parseEpisodicExtractResult(
      extractAnswer([
        { fact: "a fact", core: "true" },
        { fact: "b fact", core: 1 },
        { fact: "c fact", core: null }
      ])
    );
    expect(facts.map((f) => f.core)).toEqual([false, false, false]);
  });
});
