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

  it("rejects unsupported commands", () => {
    const result = parseCliTrigger(["status"]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CLI_TRIGGER_INVALID",
        message: "Unsupported CLI command: status"
      }
    });
  });

  it("rejects missing program", () => {
    const result = parseCliTrigger(["run"]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CLI_TRIGGER_INVALID",
        message: "Program is required"
      }
    });
  });

  it("rejects missing goal", () => {
    const result = parseCliTrigger(["run", "research-brief"]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CLI_TRIGGER_INVALID",
        message: "Goal is required"
      }
    });
  });
});
