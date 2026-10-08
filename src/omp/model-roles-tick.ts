import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { ModelRolesResolvedRow, RunStore } from "../run/run-store.js";
import { resolveModelRolesMode } from "./model-roles.js";
import type { ResolvedRole, RoleResolver } from "./role-resolver.js";

/**
 * The daily model-roles tick (spec §4.1): re-read omp's catalog, resolve every role key, and tell Paco in one line per role
 * whose head moved. A role with no candidate is the `role_unresolved` incident (its turns step up meanwhile, Task 8); the
 * tick alone opens and clears it (it is not a sweep kind). A changed resolution is a notice, never an incident.
 */
export const MODEL_ROLES_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROLE_UNRESOLVED: ReadonlySet<string> = new Set(["role_unresolved"]);

export interface ModelRolesTickInput {
  store: RunStore;
  roles: Pick<RoleResolver, "refreshCatalog" | "resolveAll">;
  now: string;
  signal?: AbortSignal;
  notify: (text: string) => void;
}
export interface ModelRolesTickResult { ran: boolean; changed: string[]; unresolved: string[] }

const IDLE: ModelRolesTickResult = { ran: false, changed: [], unresolved: [] };

export async function runModelRolesTick(i: ModelRolesTickInput): Promise<ModelRolesTickResult> {
  if (resolveModelRolesMode(process.env) === "static" || i.signal?.aborted) return { ...IDLE };
  const last = i.store.latestModelRolesResolved();
  if (last && Date.parse(i.now) - Date.parse(last.resolved_at) < MODEL_ROLES_TICK_INTERVAL_MS) return { ...IDLE };
  const catalogOk = await i.roles.refreshCatalog();
  // The only await: a stop during the read commits nothing, and the next boot's tick runs the whole unit.
  if (i.signal?.aborted) return { ...IDLE };
  const roles = i.roles.resolveAll();
  return i.store.inTransaction(() => settle(i, roles, catalogOk));
}

/** Record, notify and sync incidents in one transaction: a notice is never lost after its row, nor sent without it. */
function settle(i: ModelRolesTickInput, roles: ResolvedRole[], catalogOk: boolean): ModelRolesTickResult {
  const baseline = catalogOk ? i.store.latestModelRolesResolved({ catalogOk: true }) : undefined;
  i.store.recordModelRolesResolved({ resolved_at: i.now, catalog_ok: catalogOk, roles: roles.map(jsonSafe) });
  // A catalog outage runs the lists as written (Decision 4): that is not a change and proves nothing about a role being empty.
  if (!catalogOk) return { ran: true, changed: [], unresolved: [] };
  const changed = baseline ? changedRoles(baseline.roles, roles) : [];
  for (const c of changed) i.notify(changeLine(c.key, c.from, c.to));
  return { ran: true, changed: changed.map((c) => c.key), unresolved: syncUnresolved(i.store, roles, i.now) };
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
