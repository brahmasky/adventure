/**
 * Rule: `dependencies: {}` stays empty — AGENTS.md invariant, ADR 0001 and ADR 0016
 * (docs/decisions/0001-deterministic-harness-governs-everything.md, 0016-episodic-local-embeddings.md).
 * Changing this rule changes this test in the same commit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyProblems } from "./conformance.js";

describe("AGENTS.md invariant / ADR 0001, 0016: dependencies stay empty", () => {
  it("has no runtime dependency, because a dependency is supply-chain surface the daemon holds credentials beside", () => {
    const pkg = readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8");
    expect(dependencyProblems(pkg)).toEqual([]);
  });
  it("fails when a runtime dependency appears (devDependencies stay allowed)", () => {
    expect(dependencyProblems('{"dependencies":{"left-pad":"1.0.0"},"devDependencies":{"vitest":"4"}}'))
      .toEqual(["package.json dependencies is not empty: left-pad"]);
    expect(dependencyProblems('{"devDependencies":{"vitest":"4"}}')).toEqual([]);
  });
});
