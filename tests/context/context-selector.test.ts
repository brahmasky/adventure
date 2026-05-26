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

    expect(pack).toEqual({
      context_pack_id: "ctx_run_1",
      included: [
        "memory/core/houge.md",
        "task-contract:contract_hash",
        "programs/research-brief.md"
      ],
      excluded: ["memory/user/paco.md", "memory-catalog:*"],
      token_estimate: 1200
    });
  });
});
