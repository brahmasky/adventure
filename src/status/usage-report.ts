/**
 * `houge usage` reporting helpers (read-side only). Splitting the window resolution and the
 * table rendering out of cli.ts keeps them unit-testable — the CLI branch is a thin shell.
 */
import { usageTransport } from "../llm/metered-pricing.js";

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

const USAGE_HEADER = ["PROVIDER", "MODEL", "CALLS", "IN-TOK", "OUT-TOK", "$"];

/** Render one fixed-width, column-aligned section (header + body). Text cols left, numeric right. */
function renderSection(bodyRows: string[][]): string {
  const all = [USAGE_HEADER, ...bodyRows];
  const widths = USAGE_HEADER.map((_, i) => Math.max(...all.map((row) => (row[i] ?? "").length)));
  const render = (row: string[]): string =>
    row.map((c, i) => (i < 2 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
  return [render(USAGE_HEADER), ...bodyRows.map(render)].join("\n");
}

/**
 * Render the per-model usage rows as TWO honest sections: metered pay-per-token API legs (real $,
 * with a subtotal — the only genuine spend) and subscription CLI legs (tokens only, `sub` in the $
 * column — never a dollar figure, since their marginal cost is $0). Tokens are shown for EVERY leg.
 * An empty section is omitted; an empty window returns the no-usage sentinel.
 */
export function formatUsageTable(rows: UsageRow[]): string {
  const api = rows.filter((r) => usageTransport(r.provider) === "api");
  const cli = rows.filter((r) => usageTransport(r.provider) === "cli");
  if (api.length === 0 && cli.length === 0) return "No usage recorded in this window.";

  const sections: string[] = [];

  if (api.length > 0) {
    // Real money: cost desc, then calls desc.
    const sorted = [...api].sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
    const subtotal = sorted.reduce((s, r) => s + r.cost_usd, 0);
    const body = sorted.map((r) => [
      r.provider,
      r.model,
      String(r.calls),
      String(r.input_tokens),
      String(r.output_tokens),
      r.cost_usd.toFixed(2)
    ]);
    body.push(["subtotal", "", "", "", "", subtotal.toFixed(2)]);
    sections.push("API — metered (pay-per-token)\n" + renderSection(body));
  }

  if (cli.length > 0) {
    // Subscription tokens, no marginal $: calls desc. The $ column is always `sub`.
    const sorted = [...cli].sort((a, b) => b.calls - a.calls);
    const body = sorted.map((r) => [
      r.provider,
      r.model,
      String(r.calls),
      String(r.input_tokens),
      String(r.output_tokens),
      "sub"
    ]);
    sections.push("CLI — subscription (tokens only, no marginal $)\n" + renderSection(body));
  }

  return sections.join("\n\n");
}
