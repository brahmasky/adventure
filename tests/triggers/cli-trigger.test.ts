import { describe, expect, it } from "vitest";
import { parseCliTrigger } from "../../src/triggers/cli-trigger.js";

describe("parseCliTrigger", () => {
  it("normalizes local run commands into TypedTaskEvent", () => {
    const result = parseCliTrigger(["run", "research-brief", "compare gateway designs"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("run");
      expect(result.event.program).toBe("research-brief");
      expect(result.event.source).toBe("cli");
    }
  });
});
