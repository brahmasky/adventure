/**
 * `houge usage` reporting helpers (read-side only). Splitting the window resolution and the
 * table rendering out of cli.ts keeps them unit-testable — the CLI branch is a thin shell.
 */

/** One per-model usage row, as returned by RunStore.usageByModel. */
export interface UsageRow {
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/**
 * Resolve the `[--since=<iso>|--24h|--7d|--month]` flags to a cutoff ISO instant (or undefined
 * for all-time). `--24h`/`--7d` are rolling windows from `now`; `--month` is the start of the
 * current UTC calendar month (how the bill arrives, matching meteredSpendUsd's monthly window).
 * `--since=` wins if present. First recognized flag wins; unknown args are ignored.
 */
export function resolveUsageSince(args: string[], now: string): string | undefined {
  const since = args.find((a) => a.startsWith("--since="));
  if (since) return since.slice("--since=".length);

  const nowMs = Date.parse(now);
  if (args.includes("--24h")) return new Date(nowMs - 24 * 3600_000).toISOString();
  if (args.includes("--7d")) return new Date(nowMs - 7 * 24 * 3600_000).toISOString();
  if (args.includes("--month")) {
    const d = new Date(now);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  }
  return undefined;
}

/** Render the per-model usage rows as a fixed-width, column-aligned table with a TOTAL row. */
export function formatUsageTable(rows: UsageRow[]): string {
  if (rows.length === 0) return "No usage recorded in this window.";

  const header = ["PROVIDER", "MODEL", "CALLS", "IN-TOK", "OUT-TOK", "$"];
  const total: UsageRow = rows.reduce(
    (acc, r) => ({
      provider: "TOTAL",
      model: "",
      calls: acc.calls + r.calls,
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      cost_usd: acc.cost_usd + r.cost_usd
    }),
    { provider: "TOTAL", model: "", calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }
  );

  const cells = (r: UsageRow): string[] => [
    r.provider,
    r.model,
    String(r.calls),
    String(r.input_tokens),
    String(r.output_tokens),
    r.cost_usd.toFixed(2)
  ];

  const bodyRows = [...rows.map(cells), cells(total)];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...bodyRows.map((row) => (row[i] ?? "").length))
  );
  // First two columns (text) left-align; the numeric columns right-align.
  const render = (row: string[]): string =>
    row
      .map((c, i) => (i < 2 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
      .join("  ");

  return [render(header), ...bodyRows.map(render)].join("\n");
}
