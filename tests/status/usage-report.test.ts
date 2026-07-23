import { describe, expect, it } from "vitest";
import { formatUsageTable, resolveUsageSince } from "../../src/status/usage-report.js";
import { usageTransport } from "../../src/llm/metered-pricing.js";

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

describe("usageTransport", () => {
  it("classifies metered pay-per-token HTTP APIs as 'api'", () => {
    expect(usageTransport("kimi-api")).toBe("api");
    expect(usageTransport("gemini-api")).toBe("api");
  });

  it("classifies subscription coding-CLI legs as 'cli'", () => {
    expect(usageTransport("pi")).toBe("cli");
    expect(usageTransport("codex")).toBe("cli");
    expect(usageTransport("claude")).toBe("cli");
    expect(usageTransport("agy-cli")).toBe("cli");
  });
});

describe("formatUsageTable", () => {
  it("splits into an API (metered, real $) section and a CLI (subscription, tokens only) section", () => {
    const table = formatUsageTable([
      { provider: "gemini-api", model: "gemini-3.5-flash", calls: 68, input_tokens: 337283, output_tokens: 48276, cost_usd: 0.22 },
      { provider: "kimi-api", model: "moonshot-v1", calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      { provider: "pi", model: "kimi-for-coding", calls: 12, input_tokens: 500, output_tokens: 90, cost_usd: 0 },
      { provider: "codex", model: "sonnet", calls: 45, input_tokens: 15300000, output_tokens: 393621, cost_usd: 0 },
      { provider: "claude", model: "sonnet", calls: 4, input_tokens: 1100000, output_tokens: 25857, cost_usd: 0 }
    ]);

    // Both sections present, each with its own header.
    expect(table).toContain("API — metered (pay-per-token)");
    expect(table).toContain("CLI — subscription (tokens only, no marginal $)");

    const apiSection = table.slice(table.indexOf("API —"), table.indexOf("CLI —"));
    const cliSection = table.slice(table.indexOf("CLI —"));

    // API section: metered providers, the real cost, and a subtotal (the only genuine spend).
    expect(apiSection).toContain("gemini-api");
    expect(apiSection).toContain("kimi-api");
    expect(apiSection).toContain("0.22");
    const subtotalLine = apiSection.split("\n").find((l) => l.startsWith("subtotal"))!;
    expect(subtotalLine).toContain("0.22");
    // Ordering within API: cost desc → gemini (0.22) before kimi (0.00).
    expect(apiSection.indexOf("gemini-api")).toBeLessThan(apiSection.indexOf("kimi-api"));

    // CLI section: subscription legs with tokens shown but NEVER a dollar figure — `sub` instead.
    expect(cliSection).toContain("pi");
    expect(cliSection).toContain("codex");
    expect(cliSection).toContain("claude");
    expect(cliSection).toContain("393621"); // out-tokens still shown
    expect(cliSection).toContain("sub");
    // No CLI row carries a $ number: no "0.00"/decimal cost leaks into the subscription section.
    for (const line of cliSection.split("\n").slice(2)) {
      expect(line).not.toMatch(/\d+\.\d{2}/);
    }
    // Ordering within CLI: calls desc → codex (45) > pi (12) > claude (4).
    expect(cliSection.indexOf("codex")).toBeLessThan(cliSection.indexOf("claude"));

    // Columns stay aligned WITHIN each section (each section's rows share one width).
    for (const section of [apiSection, cliSection]) {
      const rowLines = section.split("\n").filter((l) => l.length > 0).slice(1); // drop the section title
      const widths = new Set(rowLines.map((l) => l.length));
      expect(widths.size).toBe(1);
    }
  });

  it("omits the CLI section when only metered API legs are present", () => {
    const table = formatUsageTable([
      { provider: "gemini-api", model: "gemini-3.5-flash", calls: 5, input_tokens: 100, output_tokens: 20, cost_usd: 0.01 }
    ]);
    expect(table).toContain("API — metered (pay-per-token)");
    expect(table).not.toContain("CLI —");
  });

  it("omits the API section when only subscription CLI legs are present", () => {
    const table = formatUsageTable([
      { provider: "codex", model: "sonnet", calls: 3, input_tokens: 100, output_tokens: 20, cost_usd: 0 }
    ]);
    expect(table).toContain("CLI — subscription (tokens only, no marginal $)");
    expect(table).not.toContain("API —");
    expect(table).toContain("sub");
  });

  it("reports an empty window without crashing", () => {
    expect(formatUsageTable([])).toContain("No usage");
  });
});
