import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { ToolAdapterResult, ToolMetadata } from "../../src/tools/tool-registry.js";

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends
  (<Value>() => Value extends Expected ? 1 : 2) ? true : false;
type Expect<Condition extends true> = Condition;

type ToolAdapterInputMatchesPlan = Expect<Equal<
  NonNullable<ToolMetadata["execute"]>,
  (input: Record<string, unknown>) => Promise<ToolAdapterResult> | ToolAdapterResult
>>;

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
