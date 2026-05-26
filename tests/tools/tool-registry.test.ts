import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

describe("ToolRegistry", () => {
  it("registers and retrieves tool metadata", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "local_file_read",
      category: "tool",
      side_effect_level: "none",
      risk_level: "low",
      timeout_ms: 1000,
      output_limit_bytes: 10000
    });

    expect(registry.get("local_file_read")?.risk_level).toBe("low");
  });
});
