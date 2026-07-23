import { describe, expect, it } from "vitest";
import { formatUsageTable, resolveUsageSince } from "../../src/status/usage-report.js";

describe("resolveUsageSince", () => {
  const now = "2026-07-22T12:00:00.000Z";

  it("defaults to all-time (undefined) when no window flag is given", () => {
    expect(resolveUsageSince([], now)).toBeUndefined();
  });

  it("--24h and --7d compute a rolling cutoff from now", () => {
    expect(resolveUsageSince(["--24h"], now)).toBe("2026-07-21T12:00:00.000Z");
    expect(resolveUsageSince(["--7d"], now)).toBe("2026-07-15T12:00:00.000Z");
  });

  it("--month scopes to the start of the current UTC calendar month (how the bill arrives)", () => {
    expect(resolveUsageSince(["--month"], now)).toBe("2026-07-01T00:00:00.000Z");
  });

  it("--since=<iso> passes an explicit cutoff through", () => {
    expect(resolveUsageSince(["--since=2026-01-02T03:04:05.000Z"], now)).toBe(
      "2026-01-02T03:04:05.000Z"
    );
  });
});

describe("formatUsageTable", () => {
  it("renders an aligned table with a TOTAL row", () => {
    const table = formatUsageTable([
      { provider: "kimi-api", model: "moonshot-v1-auto", calls: 2, input_tokens: 300, output_tokens: 110, cost_usd: 2 },
      { provider: "pi", model: "pi-cheap", calls: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0 }
    ]);
    // Both models appear, plus a summed TOTAL row.
    expect(table).toContain("kimi-api");
    expect(table).toContain("moonshot-v1-auto");
    expect(table).toContain("pi-cheap");
    const totalLine = table.split("\n").find((l) => l.startsWith("TOTAL"))!;
    // calls 3, in 310, out 115, cost 2.00 — the summed footer.
    expect(totalLine).toContain("3");
    expect(totalLine).toContain("310");
    expect(totalLine).toContain("115");
    expect(totalLine).toContain("2.00");
    // Columns stay aligned: every row is the same width as the header.
    const lines = table.split("\n").filter((l) => l.length > 0);
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("reports an empty window without crashing", () => {
    expect(formatUsageTable([])).toContain("No usage");
  });
});
