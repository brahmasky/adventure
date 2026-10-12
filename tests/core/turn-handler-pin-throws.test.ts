import { afterEach, describe, expect, it, vi } from "vitest";
import { IdMap, projectRun, treeSays, triageHarness } from "../helpers/triage-harness.js";

// Plan ruling 19 / spec §6.2 step 4 (failure behaviour matches): a throw in the tree policy after Jev answered but before
// today's `held.answered` (core-worker.ts:2782-2786 at 3bff437) settles skipped `error` and drops Jev's answered rows.
// Task 8b moves that call into turn-handler-ladder.ts; this snapshot holds it to today's settle. Its own file because
// vi.mock replaces the module for the whole file.
const fault = vi.hoisted(() => ({ next: false }));
vi.mock("../../src/jev/tree-policy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/jev/tree-policy.js")>();
  return {
    ...real,
    routeTree: (...a: Parameters<typeof real.routeTree>) => {
      if (fault.next) { fault.next = false; throw new Error("policy fault (test)"); }
      return real.routeTree(...a);
    }
  };
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fault.next = false; });

describe("turn.handler pin: a policy throw after Jev answered", () => {
  it("routeTree-throws-after-answer", async () => {
    const h = triageHarness(treeSays());
    const t = h.turn("帮我整理一下这周的待办");
    fault.next = true;
    const outcome = await h.worker.triageTurn(t.input);
    expect(fault.next).toBe(false); // the fault fired: the snapshot is the throw path, not a normal route
    await expect(`${JSON.stringify(projectRun(h.store, t.run_id, outcome, new IdMap()), null, 2)}\n`)
      .toMatchFileSnapshot("./__pins__/turn-handler/routeTree-throws-after-answer.json");
    h.store.close();
  });
});
