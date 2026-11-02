import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import { MODEL_PROBE_KINDS } from "../run/run-ledger.js";
import type { ModelProbeKind, ModelRolesResolvedRow, RunStore } from "../run/run-store.js";
import type { ResolvedRole, RoleResolver } from "./role-resolver.js";
import { escapeForTelegram } from "../capabilities/text-hygiene.js";
import type { ProbeFn, ProbeOutcome } from "./model-probe.js";
import { keysOfTier, resolveModelRolesMode, type CatalogModel } from "./model-roles.js";
import { isTierId, type TierId } from "./model-tiers.js";
import { applyProbe, planTier, selectorOf, type TierPlan, type TierState } from "./tier-step.js";

/**
 * The daily model-roles tick (spec §4.1): re-read omp's catalog, resolve every role key, and tell Paco in one line per role
 * whose head moved. A role with no candidate is the `role_unresolved` incident (its turns step up meanwhile, Task 8); the
 * tick alone opens and clears it (it is not a sweep kind). A changed resolution is a notice, never an incident.
 */
export const MODEL_ROLES_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROLE_UNRESOLVED: ReadonlySet<string> = new Set(["role_unresolved"]);

export interface ModelRolesTickResult { ran: boolean; changed: string[]; unresolved: string[] }

const IDLE: ModelRolesTickResult = { ran: false, changed: [], unresolved: [] };

export interface ModelRolesTickInput {
  store: RunStore;
  /** `catalog` absent → no tier work (plan P26). */
  roles: Pick<RoleResolver, "refreshCatalog" | "resolveAll"> & Partial<Pick<RoleResolver, "catalog">>;
  /** Spec §4.2: the one-shot probe (the daemon passes ompProbe). Absent → no probe runs; retirements still follow (P26). */
  probe?: ProbeFn;
  now: string;
  signal?: AbortSignal;
  notify: (text: string) => void;
}

/**
 * Spec 2026-11-02 §4.2: read the catalog, plan each tier, probe outside any transaction (one at a time), then commit the
 * probe events, the tiers, the resolution, the notice and the incidents in one transaction. A stop during the read or a
 * probe commits nothing; the next boot's tick runs the whole unit. A catalog outage changes nothing (Decision 4).
 */
export async function runModelRolesTick(i: ModelRolesTickInput): Promise<ModelRolesTickResult> {
  if (resolveModelRolesMode(process.env) === "static" || i.signal?.aborted) return { ...IDLE };
  const last = i.store.latestModelRolesResolved();
  if (last && Date.parse(i.now) - Date.parse(last.resolved_at) < MODEL_ROLES_TICK_INTERVAL_MS) return { ...IDLE };
  const catalogOk = await i.roles.refreshCatalog();
  if (i.signal?.aborted) return { ...IDLE };
  const catalog = catalogOk ? i.roles.catalog?.() ?? null : null;
  const plans = catalog ? planAll(i.store, catalog, i.now) : [];
  const outcomes = await runProbes(plans, i.probe, i.signal);
  if (outcomes === "aborted" || i.signal?.aborted) return { ...IDLE };
  return i.store.inTransaction(() => settle(i, catalogOk, plans, outcomes));
}

function planAll(store: RunStore, catalog: readonly CatalogModel[], now: string): TierPlan[] {
  return store.listModelTiers().flatMap((r) => (isTierId(r.tier)
    ? [planTier({ tier: r.tier, adopted: r.adopted, previous: r.previous, adopted_at: r.adopted_at, rejected_selector: r.rejected_selector, rejected_at: r.rejected_at }, catalog, now)]
    : []));
}

async function runProbes(plans: readonly TierPlan[], probe: ProbeFn | undefined, signal?: AbortSignal): Promise<Array<ProbeOutcome | null> | "aborted"> {
  const out: Array<ProbeOutcome | null> = [];
  for (const p of plans) {
    if (!p.probe || !probe) { out.push(null); continue; }
    if (signal?.aborted) return "aborted";
    const o = await probe(p.probe.selector, signal);
    if (o === "aborted") return "aborted";
    out.push(o);
  }
  return out;
}

/** One transaction (spec §4.2 step 4): a notice is never lost after its row, nor sent without it. */
function settle(i: ModelRolesTickInput, catalogOk: boolean, plans: readonly TierPlan[], outcomes: ReadonlyArray<ProbeOutcome | null>): ModelRolesTickResult {
  const baseline = catalogOk ? i.store.latestModelRolesResolved({ catalogOk: true }) : undefined;
  const written = writeTiers(i, plans, outcomes);
  const roles = i.roles.resolveAll();
  i.store.recordModelRolesResolved({ resolved_at: i.now, catalog_ok: catalogOk, roles: roles.map(jsonSafe) });
  if (!catalogOk) return { ran: true, changed: [], unresolved: [] };
  const changed = baseline ? changedRoles(baseline.roles, roles) : [];
  for (const c of changed) i.notify(changeLine(c.key, c.from, c.to));
  for (const f of written.failed) i.notify(failedLine(f.selector, f.stay));
  for (const line of shadowLines(i.store, roles, written.moved)) i.notify(line);
  return { ran: true, changed: changed.map((c) => c.key), unresolved: syncUnresolved(i.store, roles, i.now) };
}

interface Written { failed: Array<{ selector: string; stay: string | null }>; moved: Array<{ tier: TierId; head: string }> }

function writeTiers(i: ModelRolesTickInput, plans: readonly TierPlan[], outcomes: ReadonlyArray<ProbeOutcome | null>): Written {
  const w: Written = { failed: [], moved: [] };
  plans.forEach((p, n) => {
    const o = outcomes[n] ?? null;
    if (p.probe && o) i.store.recordModelProbe({ tier: p.state.tier, selector: p.probe.selector, purpose: p.probe.purpose, result: o.result, kind: ledgerKind(o.kind) });
    const next = applyProbe(p, o, i.now);
    if (!sameTier(next, p.before)) i.store.writeModelTier(next, i.now); // review suggestion: an unchanged tier keeps its row and updated_at
    if (p.probe && o?.result === "model_missing") w.failed.push({ selector: p.probe.selector, stay: selectorOf(next.tier, next.adopted) });
    if (next.adopted !== null && next.adopted !== p.before.adopted) w.moved.push({ tier: next.tier, head: selectorOf(next.tier, next.adopted)! });
  });
  return w;
}

/** The ledger takes closed codes only; the probe's own labels (empty, unavailable, threw) are "other" there. */
const ledgerKind = (k: string): ModelProbeKind => ((MODEL_PROBE_KINDS as readonly string[]).includes(k) ? (k as ModelProbeKind) : "other");

const sameTier = (a: TierState, b: TierState): boolean => a.adopted === b.adopted && a.previous === b.previous && a.adopted_at === b.adopted_at
  && a.rejected_selector === b.rejected_selector && a.rejected_at === b.rejected_at;

/** Spec §4.2: a moved tier head that an override on one of its keys shadows. */
function shadowLines(store: RunStore, roles: ResolvedRole[], moved: Written["moved"]): string[] {
  const overrides = store.latestModelRoleOverrides();
  return moved.flatMap((m) => keysOfTier(m.tier).flatMap((key) => {
    const pattern = overrides.get(key);
    return pattern && roles.find((r) => r.key === key)?.source === "override" ? [shadowLine(key, m.head, pattern)] : [];
  }));
}

/** "X failed its check; staying on Y" (spec §4.2); selectors are code-owned catalog strings. */
export function failedLine(selector: string, stay: string | null): string {
  return `⚠️ \`${selector}\` failed its check; staying on ${shown(stay)}.`;
}

/** Spec §4.2; Paco's own pattern is rendered markdown-inert, as /models does. */
export function shadowLine(key: string, head: string, pattern: string): string {
  return `ℹ️ Tier head \`${head}\` is available; your override \`${escapeForTelegram(pattern)}\` is in place (/models reset ${key.replace(":", " ")}).`;
}

const jsonSafe = (r: ResolvedRole): ModelRolesResolvedRow["roles"][number] =>
  ({ key: r.key, head: r.head, candidates: [...r.candidates], source: r.source });

function changedRoles(prev: ModelRolesResolvedRow["roles"], next: ResolvedRole[]): Array<{ key: string; from: string | null; to: string | null }> {
  const before = new Map(prev.map((r) => [r.key, r.head]));
  return next.filter((r) => before.has(r.key) && before.get(r.key) !== r.head).map((r) => ({ key: r.key, from: before.get(r.key) ?? null, to: r.head }));
}

const shown = (s: string | null): string => (s === null ? "nothing" : `\`${s}\``);

/** "Thinking now resolves to X, was Y" (spec §4.1); selector ids are code-owned list or catalog strings. */
export function changeLine(key: string, from: string | null, to: string | null): string {
  return `🔁 ${key.charAt(0).toUpperCase()}${key.slice(1)} now resolves to ${shown(to)}, was ${shown(from)}.`;
}

/** Open `role_unresolved` per empty role key (alerted once while open), clear it for every key that resolves. */
function syncUnresolved(store: RunStore, roles: ResolvedRole[], now: string): string[] {
  const unresolved: string[] = [];
  for (const r of roles) {
    if (r.head === null) {
      unresolved.push(r.key);
      openAlertedIncident(store, { kind: "role_unresolved", subject: r.key, detail: { role: r.key }, now });
    } else {
      resolveOpenIncidents(store, ROLE_UNRESOLVED, r.key, now);
    }
  }
  return unresolved;
}
