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
