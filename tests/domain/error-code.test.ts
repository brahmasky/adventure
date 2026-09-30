import { describe, expect, it } from "vitest";
import { errorCode, safeReason } from "../../src/domain/error-code.js";

describe("error text that may reach the ledger or an incident (fix round 1, M-6)", () => {
  it("an fs error becomes its errno code: the path in its message never survives", () => {
    const e = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/p/.ssh/id'"), { code: "ENOENT" });
    expect(safeReason(e)).toBe("ENOENT");
    expect(errorCode(e)).toBe("ENOENT");
  });
  it("a short code-owned reason is kept; anything with path characters falls back to the error's name", () => {
    expect(safeReason(new Error("planner command timed out: prompt"))).toBe("planner command timed out: prompt");
    expect(safeReason(new Error("bad thing at /tmp/x"))).toBe("Error");
    expect(safeReason("x".repeat(200))).toBe("unknown");
  });
});
