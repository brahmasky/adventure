import { describe, expect, it } from "vitest";
import { selectContext } from "../../src/context/context-selector.js";

describe("selectContext", () => {
  it("includes only core Milestone 1 context", () => {
    const pack = selectContext({
      run_id: "run_1",
      requester_id: "paco",
      program: "research-brief",
      contract_hash: "contract_hash"
    });

    expect(pack.included).toEqual([
      "memory/core/houge.md",
      "task-contract:contract_hash",
      "programs/research-brief.md"
    ]);
    expect(pack.excluded).toContain("memory/user/paco.md");
  });
});
