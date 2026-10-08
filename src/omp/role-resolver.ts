import { formatModelString, type ModelString } from "./model-string.js";
import {
  clampEffort, overrideCandidates, resolveModelRolesMode, resolveRole, ROLE_LISTS, ROLE_NAMES, selectorKey,
  type CatalogModel, type ModelRolesMode, type RoleChains, type RoleName
} from "./model-roles.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";

/** A `/models` override key: a role, or one judge seat (spec §4.2). */
export type OverrideKey = RoleName | `judges:${number}`;
export interface ResolvedRole { key: OverrideKey; head: string | null; candidates: string[]; source: "list" | "override" }

/** A failed catalog read is retried this long after it (plan F14), never left for the next daily tick. */
export const CATALOG_RETRY_MS = 60 * 60_000;
/** Consecutive failed reads that open the alerted `model_catalog_unavailable` incident (plan F14). */
export const CATALOG_INCIDENT_AFTER = 2;
/** A `no_planner_leg` asks for a fresh catalog at most this often (plan F7 d). */
export const NO_LEG_REFRESH_MS = 10 * 60_000;
const CATALOG_INCIDENT: ReadonlySet<string> = new Set(["model_catalog_unavailable"]);

/** Structurally src/jev/tree-policy.ts `Effort`. */
type RoutedEffort = "low" | "medium" | "high";
interface CandidateOptions { refused?: ReadonlySet<string>; effort?: RoutedEffort | null; seat?: number }
/** One resolution's view: the mode and the overrides, read once so a chains() call is consistent across its seven roles. */
interface Snapshot { mode: ModelRolesMode; overrides: Map<OverrideKey, string> }
interface ResolverDeps {
  store: RunStore; env?: () => NodeJS.ProcessEnv; readCatalog: () => Promise<CatalogModel[] | null>;
  /** Injectable clock (ms) for the retry and refresh windows; default Date.now. */
  now?: () => number;
}

const NOTHING_REFUSED: ReadonlySet<string> = new Set();
const keyOf = (role: RoleName, seat?: number): OverrideKey => (role === "judges" && seat !== undefined ? `judges:${seat}` : role);
const seatOpt = (seat?: number): CandidateOptions => (seat === undefined ? {} : { seat });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The model-role service (spec 2026-10-06 §4), one per worker. It holds omp's catalog: read at boot, by the daily tick,
 * by `/models set`, hourly after a failed read (F14) and after a `no_planner_leg` (F7). It reads Paco's overrides from
 * the ledger at every resolution (no restart) and applies the pure resolution in model-roles.ts. `HOUGE_MODEL_ROLES`
 * is read per call. It is the one owner of the catalog-outage incident.
 */
export class RoleResolver {
  private cat: readonly CatalogModel[] | null = null;
  private failures = 0;
  private lastReadAt: number | undefined;
  private reading: Promise<boolean> | undefined;
  /** Roles that fell back to their static list since the last catalog read (one model_roles_fallback note each). */
  private fellBack = new Set<OverrideKey>();

  constructor(private readonly d: ResolverDeps) {}

  /** One catalog read (a read in flight is joined). A failed read keeps the last good catalog (none yet = Decision 4). Never throws. */
  refreshCatalog(): Promise<boolean> {
    if (!this.reading) this.reading = this.read().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  /** F14: re-read when the last read failed and is at least CATALOG_RETRY_MS old; null = nothing due (the daemon asks every poll cycle). */
  retryFailedRead(): Promise<boolean> | null {
    if (this.failures === 0 || this.reading || !this.readOlderThan(CATALOG_RETRY_MS)) return null;
    return this.refreshCatalog();
  }

  /** F7 (d): the supervisor found no planner leg; re-read unless a read ran in the last NO_LEG_REFRESH_MS. Fire-and-forget. */
  requestRefresh(): void {
    if (this.reading || !this.readOlderThan(NO_LEG_REFRESH_MS)) return;
    void this.refreshCatalog();
  }

  catalog(): readonly CatalogModel[] | null { return this.cat; }

  /**
   * The role's ordered candidates, efforts clamped (Decision 2). `effort` is the turn's routed effort; absent or null =
   * the list's own. A role the catalog emptied (F7): Fast returns [] so the supervisor steps up; every other role runs
   * its static list.
   */
  candidates(role: RoleName, o: CandidateOptions = {}): ModelString[] {
    const got = this.resolveWith(this.snapshot(), role, o);
    if (got) return got;
    return role === "fast" ? [] : this.fallback(role, o);
  }

  /**
   * The seven OmpConfig chains. A role the catalog emptied runs its static list (F7, the same rule as candidates()).
   * A judge seat keeps its index: an unresolved seat runs its static selector and fails alone (panel quorum).
   */
  chains(): RoleChains {
    const s = this.snapshot();
    const or = (role: RoleName, seat?: number): ModelString[] => this.resolveWith(s, role, seatOpt(seat)) ?? this.fallback(role, seatOpt(seat));
    return {
      planner: or("default"), reader: or("reader"), media: or("vision"), ticks: or("tiny"),
      judges: ROLE_LISTS.judges.map((_, seat) => or("judges", seat)[0] as ModelString),
      chair: or("chair"), reviewer: or("reviewer")
    };
  }

  /** Every role and judge seat as `/models` and the daily tick show it: the resolution itself, so an emptied role shows head null. */
  resolveAll(): ResolvedRole[] {
    const s = this.snapshot();
    const slots = ROLE_NAMES.flatMap<{ role: RoleName; seat?: number }>((role) =>
      (role === "judges" ? ROLE_LISTS.judges.map((_, seat) => ({ role, seat })) : [{ role }]));
    return slots.map(({ role, seat }) => {
      const key = keyOf(role, seat);
      const c = this.resolveWith(s, role, seatOpt(seat)) ?? [];
      const override = s.mode === "resolved" ? s.overrides.get(key) ?? null : null;
      const source: ResolvedRole["source"] = overrideCandidates(role, seat, override, this.cat).length > 0 ? "override" : "list";
      return { key, head: c[0] ? formatModelString(c[0]) : null, candidates: c.map(formatModelString), source };
    });
  }

  private async read(): Promise<boolean> {
    let next: CatalogModel[] | null = null;
    try { next = await this.d.readCatalog(); } catch { next = null; }
    this.lastReadAt = this.clock();
    this.fellBack.clear();
    if (next !== null && next.length > 0) { this.cat = next; this.readOk(); return true; }
    this.readFailed();
    return false;
  }

  private readOk(): void {
    this.failures = 0;
    try { resolveOpenIncidents(this.d.store, CATALOG_INCIDENT, "omp"); } catch (e) { console.warn(`[model-roles] could not resolve model_catalog_unavailable: ${why(e)}`); }
  }

  /** Decision 4: one ledger note per failed read; F14: the second consecutive failure pages Paco once (alerted incident). */
  private readFailed(): void {
    this.failures += 1;
    try {
      this.d.store.recordMemoryEvent("model_catalog_unavailable", { reason: "read_failed" }, "model_roles");
      if (this.failures >= CATALOG_INCIDENT_AFTER) {
        openAlertedIncident(this.d.store, { kind: "model_catalog_unavailable", subject: "omp", detail: { consecutive_failures: this.failures }, env: this.env() });
      }
    } catch (e) {
      console.warn(`[model-roles] could not record model_catalog_unavailable: ${why(e)}`);
    }
  }

  private readOlderThan(ms: number): boolean { return this.lastReadAt === undefined || this.clock() - this.lastReadAt >= ms; }
  private clock(): number { return (this.d.now ?? Date.now)(); }
  private env(): NodeJS.ProcessEnv { return (this.d.env ?? (() => process.env))(); }

  private snapshot(): Snapshot {
    const mode = resolveModelRolesMode(this.env());
    if (mode === "static") return { mode, overrides: new Map() };
    try {
      return { mode, overrides: this.d.store.latestModelRoleOverrides() };
    } catch (error) {
      console.warn(`[model-roles] override read failed, resolving on the lists: ${why(error)}`);
      return { mode, overrides: new Map() };
    }
  }

  /** The role resolved, refused skipped, efforts clamped; null when it resolved EMPTY before the refused filter (F7). */
  private resolveWith(s: Snapshot, role: RoleName, o: CandidateOptions): ModelString[] | null {
    const override = s.mode === "resolved" ? s.overrides.get(keyOf(role, o.seat)) ?? null : null;
    const all = resolveRole({ role, ...seatOpt(o.seat), catalog: this.cat, override, refused: NOTHING_REFUSED, mode: s.mode });
    if (all.length === 0) return null;
    const refused = o.refused ?? NOTHING_REFUSED;
    return all.filter((m) => !refused.has(selectorKey(m))).map((m) => clampEffort(m, o.effort ?? null, this.cat, s.mode));
  }

  /** F7: the role's static list, unfiltered and unclamped (minus what the child refused), noted once per role per catalog read. */
  private fallback(role: RoleName, o: CandidateOptions): ModelString[] {
    const key = keyOf(role, o.seat);
    if (!this.fellBack.has(key)) {
      this.fellBack.add(key);
      try { this.d.store.recordMemoryEvent("model_roles_fallback", { role: key }, "model_roles"); } catch (e) { console.warn(`[model-roles] could not record model_roles_fallback: ${why(e)}`); }
    }
    return resolveRole({ role, ...seatOpt(o.seat), catalog: null, override: null, refused: o.refused ?? NOTHING_REFUSED, mode: "static" });
  }
}
