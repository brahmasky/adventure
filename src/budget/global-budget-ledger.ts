/**
 * Global (cross-run) autonomy circuit-breaker.
 *
 * The per-run {@link ./budget-ledger.BudgetLedger} bounds a single run. This
 * bounds Houge as a whole over a rolling 24h window: once an always-on or
 * scheduled daemon can create runs without a human watching, a global ceiling
 * on run admissions, tool calls, and gated-action attempts is the safety floor
 * that turns "unattended" from reckless into responsible. When a cap is reached,
 * new run admissions are REFUSED (a fuse), not throttled — this is a breaker,
 * not a rate limiter.
 *
 * Counting sources (see RunStore):
 * - `runs`           — dedicated `global_budget_events` rows (no prior source).
 * - `tool_calls`     — derived from `tool_finished` ledger events in-window.
 * - `gated_attempts` — derived from `approval_requested` ledger events in-window.
 */

export type GlobalBudgetKind = "runs" | "tool_calls" | "gated_attempts";

export const GLOBAL_BUDGET_KINDS: readonly GlobalBudgetKind[] = [
  "runs",
  "tool_calls",
  "gated_attempts"
] as const;

export interface GlobalBudgetCaps {
  /** Max run admissions per rolling window. */
  runs: number;
  /** Max tool/LLM calls per rolling window. */
  tool_calls: number;
  /** Max gated (approval-requiring) action attempts per rolling window. */
  gated_attempts: number;
}

/** Rolling window all caps are measured over. */
export const GLOBAL_BUDGET_WINDOW_HOURS = 24;

/**
 * Conservative ceilings, sized as a breaker for a single-operator deployment —
 * high enough never to trip in normal use, low enough to contain a runaway
 * always-on loop. Override per-deployment via env.
 */
export const DEFAULT_GLOBAL_BUDGET_CAPS: GlobalBudgetCaps = {
  runs: 200,
  tool_calls: 1000,
  gated_attempts: 100
};

const CAP_ENV_VAR: Record<GlobalBudgetKind, string> = {
  runs: "HOUGE_GLOBAL_MAX_RUNS_24H",
  tool_calls: "HOUGE_GLOBAL_MAX_TOOL_CALLS_24H",
  gated_attempts: "HOUGE_GLOBAL_MAX_GATED_ATTEMPTS_24H"
};

function positiveIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Resolve caps from the environment, falling back to {@link DEFAULT_GLOBAL_BUDGET_CAPS}. */
export function resolveGlobalBudgetCaps(env: NodeJS.ProcessEnv): GlobalBudgetCaps {
  return {
    runs: positiveIntEnv(env[CAP_ENV_VAR.runs]) ?? DEFAULT_GLOBAL_BUDGET_CAPS.runs,
    tool_calls:
      positiveIntEnv(env[CAP_ENV_VAR.tool_calls]) ?? DEFAULT_GLOBAL_BUDGET_CAPS.tool_calls,
    gated_attempts:
      positiveIntEnv(env[CAP_ENV_VAR.gated_attempts]) ?? DEFAULT_GLOBAL_BUDGET_CAPS.gated_attempts
  };
}

export interface GlobalBudgetBreach {
  kind: GlobalBudgetKind;
  used: number;
  limit: number;
}

export interface GlobalBudgetHeadroom {
  kind: GlobalBudgetKind;
  used: number;
  limit: number;
  remaining: number;
}

/** A cap is breached when usage has reached the limit (the next admission is the over-cap one). */
export function computeBreaches(
  usage: Record<GlobalBudgetKind, number>,
  caps: GlobalBudgetCaps
): GlobalBudgetBreach[] {
  return GLOBAL_BUDGET_KINDS.flatMap((kind) =>
    usage[kind] >= caps[kind] ? [{ kind, used: usage[kind], limit: caps[kind] }] : []
  );
}

export function computeHeadroom(
  usage: Record<GlobalBudgetKind, number>,
  caps: GlobalBudgetCaps
): GlobalBudgetHeadroom[] {
  return GLOBAL_BUDGET_KINDS.map((kind) => ({
    kind,
    used: usage[kind],
    limit: caps[kind],
    remaining: Math.max(0, caps[kind] - usage[kind])
  }));
}

/** One short, chat-ready line per breached cap, for the Telegram fuse alert. */
export function formatFuseAlert(breaches: GlobalBudgetBreach[]): string {
  const lines = breaches.map(
    (b) => `• ${b.kind}: ${b.used}/${b.limit} in ${GLOBAL_BUDGET_WINDOW_HOURS}h`
  );
  return [
    "⚠️ Houge global budget fuse tripped — new runs are paused.",
    ...lines,
    "Runs resume automatically as the 24h window clears."
  ].join("\n");
}

// --- Metered-API $ ceiling (ADR 0019, Phase S-2) -----------------------------------
//
// The count caps above bound VOLUME; this bounds DOLLARS on the pay-per-token legs
// (kimi-api/gemini-api). Spend is derived from `llm_call` ledger events' `cost_usd`
// (see src/llm/metered-pricing.ts — no second bookkeeping). Two windows: a rolling
// 24h ceiling (same precedent as the count caps) and a calendar-month (UTC) ceiling
// (how the bill actually arrives). Breach = drop the metered legs from the chain
// (flat-rate legs keep working — charter: flat-rate first) + ONE deduped alert via
// a single-row latch, mirroring the global fuse.

export interface MeteredCeilings {
  daily_usd: number;
  monthly_usd: number;
}

/** Conservative defaults for a single-operator deployment; override via env. */
export const DEFAULT_METERED_DAILY_USD = 5;
export const DEFAULT_METERED_MONTHLY_USD = 50;

function nonNegativeNumberEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Resolve ceilings from the environment (`0` is a valid "hard off"); garbage → default. */
export function resolveMeteredCeilings(env: NodeJS.ProcessEnv): MeteredCeilings {
  return {
    daily_usd: nonNegativeNumberEnv(env.HOUGE_METERED_DAILY_USD) ?? DEFAULT_METERED_DAILY_USD,
    monthly_usd:
      nonNegativeNumberEnv(env.HOUGE_METERED_MONTHLY_USD) ?? DEFAULT_METERED_MONTHLY_USD
  };
}

/** Spend as summed from the ledger (see RunStore.meteredSpendUsd). */
export interface MeteredSpend {
  daily_usd: number;
  monthly_usd: number;
}

export interface MeteredBreach {
  window: "daily" | "monthly";
  spend_usd: number;
  ceiling_usd: number;
}

/** A window is breached once spend has REACHED its ceiling (same >= rule as the count caps). */
export function computeMeteredBreaches(spend: MeteredSpend, ceilings: MeteredCeilings): MeteredBreach[] {
  const breaches: MeteredBreach[] = [];
  if (spend.daily_usd >= ceilings.daily_usd) {
    breaches.push({ window: "daily", spend_usd: spend.daily_usd, ceiling_usd: ceilings.daily_usd });
  }
  if (spend.monthly_usd >= ceilings.monthly_usd) {
    breaches.push({ window: "monthly", spend_usd: spend.monthly_usd, ceiling_usd: ceilings.monthly_usd });
  }
  return breaches;
}

/** The ONE deduped Telegram alert per metered-fuse episode (0→1 latch transition only). */
export function formatMeteredFuseAlert(breaches: MeteredBreach[]): string {
  const windowLabel: Record<MeteredBreach["window"], string> = {
    daily: `rolling ${GLOBAL_BUDGET_WINDOW_HOURS}h`,
    monthly: "calendar month, UTC"
  };
  const lines = breaches.map(
    (b) => `• ${b.window}: $${b.spend_usd.toFixed(2)}/$${b.ceiling_usd.toFixed(2)} (${windowLabel[b.window]})`
  );
  return [
    "💸 Houge metered-API $ ceiling reached — kimi-api/gemini-api legs are dropped from the chain.",
    ...lines,
    "Flat-rate legs (pi/agy-cli) keep working. Metered legs return as the window clears."
  ].join("\n");
}

/** The `/status` overview line: metered spend vs both ceilings. */
export function formatMeteredStatusLine(spend: MeteredSpend, ceilings: MeteredCeilings): string {
  return (
    `Metered: $${spend.daily_usd.toFixed(2)}/$${ceilings.daily_usd.toFixed(2)} 24h, ` +
    `$${spend.monthly_usd.toFixed(2)}/$${ceilings.monthly_usd.toFixed(2)} month`
  );
}
