import { parseModelString, type ModelString, type OmpEffort } from "./model-string.js";
import { seedTierHeads, tierDef, type TierHeads, type TierId } from "./model-tiers.js";

/**
 * Model roles (spec 2026-10-06 §4, ADR 0028 amendment). Every Houge seat names a role, and every role is a code-owned,
 * ordered list of exact selectors (`provider/id[:effort]`). Resolution against omp's live catalog is pure and lives here;
 * RoleResolver (role-resolver.ts) holds the catalog, Paco's `/models` overrides and reads the mode per call.
 */
export type RoleName = "fast" | "default" | "thinking" | "reader" | "vision" | "tiny" | "judges" | "chair" | "reviewer" | "grow_review";
export const ROLE_NAMES: readonly RoleName[] = ["fast", "default", "thinking", "reader", "vision", "tiny", "judges", "chair", "reviewer", "grow_review"];

/** Planner gears and routed efforts: structurally src/jev/tree-policy.ts `TurnRole` / `Effort` (src/omp imports nothing from src/jev). */
type PlannerRole = "fast" | "default" | "thinking";
type RoutedEffort = "low" | "medium" | "high";

/** One leg of a role (spec 2026-11-02 §4.1): a tier and the effort the role asks of it. */
export interface Leg { tier: TierId; effort?: OmpEffort }
const leg = (tier: TierId, effort?: OmpEffort): Leg => (effort ? { tier, effort } : { tier });

/**
 * The roles `resolved` mode runs (spec 2026-11-02 §4.1, ADR 0028 amendment): code-owned tiers in today's order, each
 * resolving to its adopted head then its previous head (model_tiers, the daily tick's state). Judges are one tier per seat
 * and resolve to the adopted head only: a judge never falls back inside a panel run (ADR 0027); the fallback happens
 * between runs, in the tick. Kimi exits next year (Paco, 2026-10-07): every multi-leg role keeps a non-Kimi leg.
 */
export const ROLE_LEGS: Readonly<Record<RoleName, readonly Leg[]>> = {
  fast: [leg("sonnet@anthropic", "low"), leg("sonnet@antigravity", "low"), leg("gemini-flash", "low")],
  default: [leg("opus@anthropic", "medium"), leg("opus@antigravity", "medium"), leg("kimi", "low")],
  thinking: [leg("opus@anthropic", "high"), leg("opus@antigravity", "high"), leg("kimi", "high")],
  reader: [leg("gemini-flash", "low"), leg("kimi", "low"), leg("codex-sol", "low")],
  vision: [leg("gemini-flash", "low")],
  tiny: [leg("kimi", "low"), leg("gemini-flash", "low")],
  judges: [leg("kimi"), leg("codex-sol"), leg("gemini-pro")],
  chair: [leg("opus@anthropic", "low")],
  reviewer: [leg("kimi", "high"), leg("opus@antigravity", "medium")],
  grow_review: [leg("kimi", "high"), leg("gemini-pro", "high"), leg("codex-sol", "high")]
};
/** The panel's seat count (S1: chains(), resolveAll() and the panel read this one number). */
export const JUDGE_SEATS = ROLE_LEGS.judges.length;

/** A leg's adopted head, then its previous head; a judge seat its adopted head only. */
function legIds(l: Leg, heads: TierHeads, judge: boolean): string[] {
  const h = heads.get(l.tier);
  return (judge ? [h?.adopted] : [h?.adopted, h?.previous]).filter((id): id is string => typeof id === "string");
}

function staticSelectors(role: RoleName, seat?: number): ModelString[] {
  if (role !== "judges") return STATIC_ROLE_LISTS[role].map(parseModelString);
  return seat === undefined ? [] : STATIC_ROLE_LISTS.judges.slice(seat, seat + 1).map(parseModelString);
}

/**
 * The role's own selectors: static mode STATIC_ROLE_LISTS; resolved mode its legs over `heads` (default: the seeded heads).
 * A judge seat is its one index; the judges role without a seat has none.
 */
export function roleSelectors(role: RoleName, seat?: number, mode: ModelRolesMode = "resolved", heads: TierHeads = seedTierHeads()): ModelString[] {
  if (mode === "static") return staticSelectors(role, seat);
  const legs = role !== "judges" ? ROLE_LEGS[role] : seat === undefined ? [] : ROLE_LEGS.judges.slice(seat, seat + 1);
  return legs.flatMap((l) => legIds(l, heads, role === "judges").map((id): ModelString =>
    (l.effort ? { provider: tierDef(l.tier).provider, model: id, effort: l.effort } : { provider: tierDef(l.tier).provider, model: id })));
}

/** Every key with a leg on `tier` (the change notice's shadowed-override line, spec §4.2). */
export function keysOfTier(tier: TierId): Array<RoleName | `judges:${number}`> {
  const roles = ROLE_NAMES.filter((r) => r !== "judges" && ROLE_LEGS[r].some((l) => l.tier === tier));
  const seats = ROLE_LEGS.judges.flatMap((l, i): Array<`judges:${number}`> => (l.tier === tier ? [`judges:${i}`] : []));
  return [...roles, ...seats];
}

/** The keys `tier` alone serves (plan P15): judge seats bound to it, and roles whose every leg is it. An empty-tier card names these. */
export function soleKeysOf(tier: TierId): Array<RoleName | `judges:${number}`> {
  const roles = ROLE_NAMES.filter((r) => r !== "judges" && ROLE_LEGS[r].every((l) => l.tier === tier));
  const seats = ROLE_LEGS.judges.flatMap((l, i): Array<`judges:${number}`> => (l.tier === tier ? [`judges:${i}`] : []));
  return [...roles, ...seats];
}

/**
 * The lists `static` mode runs (spec 2026-11-02 §4.3, D4-A: the rollback switch): re-pinned at this ship to the seeded tier
 * heads, gpt-5.5 -> gpt-6.1-sol. Static adds no model: Fast and Thinking are the Default list. Judge seat 2 has no static
 * selector: static is catalog-free and gemini-4-argon is a renamed Gemini id that joins the pro tier only via the tier resolver (spec 2026-11-03 §6.1), so static pins nothing; a code re-pin fills it. A
 * resolved role that comes up empty also falls back here (RoleResolver). The daily tick (resolved mode) reports any
 * selector here the catalog no longer lists as static_list_stale.
 */
export const STATIC_ROLE_LISTS: Readonly<Record<RoleName, readonly string[]>> = (() => {
  const planner = ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "kimi-code/k3:low"];
  return {
    fast: planner, default: planner, thinking: planner,
    reader: ["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6.1-sol:low"],
    vision: ["google-antigravity/gemini-3.8-flash:low"],
    tiny: ["kimi-code/k3:low"],
    judges: ["kimi-code/k3", "openai-codex/gpt-6.1-sol"],
    chair: ["anthropic/claude-opus-5-5:low"],
    reviewer: ["kimi-code/k3:high", "google-antigravity/claude-opus-5-5:medium"],
    grow_review: ["kimi-code/k3:high", "openai-codex/gpt-6.1-sol:high"]
  };
})();

/** Every distinct provider/id in the static lists, in list order (the stale check's subjects). */
export function staticSelectorKeys(): string[] {
  return [...new Set(ROLE_NAMES.flatMap((r) => STATIC_ROLE_LISTS[r].map((s) => selectorKey(parseModelString(s)))))];
}

/** Spec §4 step 1: the subscription providers. The catalog also lists metered or absent ones, which never match. */
export const ALLOWED_PROVIDERS: readonly string[] = ["anthropic", "google-antigravity", "kimi-code", "openai-codex"];
/** Codex is the self-write writer: no chat seat is ever routed to it (Reader and the council may use it). */
const CODEX_PROVIDER = "openai-codex";
export const CHAT_ROLES: ReadonlySet<RoleName> = new Set<RoleName>(["fast", "default", "thinking", "vision", "tiny"]);

/** A catalog entry's output price per million tokens (spec §4.4): the flat rate, and any time-based steps (epoch ms). */
export interface CatalogPrice { output: number; rates: ReadonlyArray<{ from: number; output: number }> }
export interface CatalogModel { provider: string; id: string; thinking: readonly OmpEffort[] | null; price?: CatalogPrice }
export type ModelRolesMode = "static" | "resolved";

/** `HOUGE_MODEL_ROLES` (spec §4.3), read per call: `static` is the rollback switch, anything else is `resolved`. */
export function resolveModelRolesMode(env: NodeJS.ProcessEnv): ModelRolesMode {
  return env.HOUGE_MODEL_ROLES?.trim().toLowerCase() === "static" ? "static" : "resolved";
}

export const selectorKey = (m: Pick<ModelString, "provider" | "model">): string => `${m.provider}/${m.model}`;

export interface ResolveInput { role: RoleName; seat?: number; catalog: readonly CatalogModel[] | null; override: string | null;
  refused: ReadonlySet<string>; mode: ModelRolesMode; tiers?: TierHeads }

/** Step 1 for one provider: on the allow-list, and not Codex on a chat seat. */
function eligible(role: RoleName, provider: string): boolean {
  return ALLOWED_PROVIDERS.includes(provider) && !(CHAT_ROLES.has(role) && provider === CODEX_PROVIDER);
}

/** Step 2's matcher: a case-insensitive substring over `provider/id` of the catalog AFTER the step-1 filters. */
export function matchOverride(pattern: string, role: RoleName, catalog: readonly CatalogModel[]): CatalogModel[] {
  const p = pattern.trim().toLowerCase();
  if (p.length === 0) return [];
  return catalog.filter((m) => eligible(role, m.provider) && `${m.provider}/${m.id}`.toLowerCase().includes(p));
}

/**
 * Step 2: the override's candidates. Each takes the effort the role's legs give that model, else the role's first
 * selector's effort (the clamp then fits it to the model). With no catalog (Decision 4) a pattern matches only an exact
 * `provider/id` of the role's own legs.
 */
export function overrideCandidates(role: RoleName, seat: number | undefined, override: string | null, catalog: readonly CatalogModel[] | null, tiers?: TierHeads): ModelString[] {
  const own = roleSelectors(role, seat, "resolved", tiers);
  const p = override?.trim().toLowerCase() ?? "";
  if (p.length === 0) return [];
  if (catalog === null) return own.filter((m) => selectorKey(m).toLowerCase() === p);
  return matchOverride(p, role, catalog).map((c) => {
    const effort = own.find((m) => m.provider === c.provider && m.model === c.id)?.effort ?? own[0]?.effort;
    return effort ? { provider: c.provider, model: c.id, effort } : { provider: c.provider, model: c.id };
  });
}

function dedupe(list: readonly ModelString[]): ModelString[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const k = selectorKey(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Step 3's test: the catalog lists the selector's `provider/id` (its `:effort` is not part of the match). */
function catalogued(m: ModelString, catalog: readonly CatalogModel[]): boolean {
  return catalog.some((c) => c.provider === m.provider && c.id === m.model);
}

/**
 * Spec §4 steps 1–4, pure: the override's candidates, then the role's list kept where the catalog lists it, duplicates
 * dropped, the child's refused selectors skipped. Static mode is STATIC_ROLE_LISTS in order (no catalog, no override); a
 * null catalog in resolved mode keeps the whole legs resolution (Decision 4), so a catalog outage never empties a role.
 * A resolved role CAN come up empty against a catalog; RoleResolver owns that case (spec §4.1, plan F7).
 */
export function resolveRole(i: ResolveInput): ModelString[] {
  const fresh = (m: ModelString) => !i.refused.has(selectorKey(m));
  if (i.mode === "static") return dedupe(roleSelectors(i.role, i.seat, "static")).filter(fresh);
  const own = roleSelectors(i.role, i.seat, "resolved", i.tiers);
  const listed = own.filter((m) => eligible(i.role, m.provider) && (i.catalog === null || catalogued(m, i.catalog)));
  return dedupe([...overrideCandidates(i.role, i.seat, i.override, i.catalog, i.tiers), ...listed]).filter(fresh);
}

const EFFORT_ORDER: readonly OmpEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The supported level nearest `target`; a tie rounds up (Decision 2: `medium` on a low/high/max model is `high`). */
function nearestLevel(target: OmpEffort, levels: readonly OmpEffort[]): OmpEffort {
  const rank = (e: OmpEffort) => EFFORT_ORDER.indexOf(e);
  let best = levels[0] as OmpEffort;
  for (const l of levels) {
    const d = Math.abs(rank(l) - rank(target));
    const bd = Math.abs(rank(best) - rank(target));
    if (d < bd || (d === bd && rank(l) > rank(best))) best = l;
  }
  return best;
}

/**
 * Decision 2: the routed effort (or, when null, the selector's own) clamped to the model's catalogued `thinking` levels.
 * A model the catalog lists with no levels gets no effort (no `set_thinking_level`). Static mode, or no catalog, keeps
 * the selector exactly as listed (routed effort is ledgered, not applied).
 */
export function clampEffort(m: ModelString, effort: RoutedEffort | null, catalog: readonly CatalogModel[] | null, mode: ModelRolesMode): ModelString {
  if (mode === "static" || catalog === null) return m;
  const entry = catalog.find((c) => c.provider === m.provider && c.id === m.model);
  if (!entry) return m;
  const bare: ModelString = { provider: m.provider, model: m.model };
  const target = effort ?? m.effort;
  if (entry.thinking === null || entry.thinking.length === 0 || target === undefined) return bare;
  return { ...bare, effort: nearestLevel(target, entry.thinking) };
}

/** An exhausted planner role steps up (spec §4): Fast → Default → Thinking → none (`no_planner_leg`). */
export const STEP_UP: Readonly<Record<PlannerRole, PlannerRole | null>> = { fast: "default", default: "thinking", thinking: null };

/** The eight OmpConfig seat chains, as the roles fill them. */
export interface RoleChains { planner: ModelString[]; reader: ModelString[]; media: ModelString[]; ticks: ModelString[];
  judges: ModelString[]; chair: ModelString[]; reviewer: ModelString[]; growReview: ModelString[] }

/**
 * The eight seat chains as STATIC_ROLE_LISTS: today's chains exactly. `HOUGE_MODEL_ROLES=static`, callers that hold no
 * resolver (the CLI, scripts), and resolveOmpConfig's default.
 */
export function staticRoleChains(): RoleChains {
  const s = (r: RoleName): ModelString[] => STATIC_ROLE_LISTS[r].map(parseModelString);
  return { planner: s("default"), reader: s("reader"), media: s("vision"), ticks: s("tiny"), judges: s("judges"), chair: s("chair"), reviewer: s("reviewer"), growReview: s("grow_review") };
}

const JUDGE_SEAT_KEY = /^judges:(0|[1-9]\d?)$/;

/** A `/models` override key (spec §4.2): a role name, or `judges:<n>` for one judge seat. */
export function isOverrideKey(k: string): k is RoleName | `judges:${number}` {
  return (ROLE_NAMES as readonly string[]).includes(k) || JUDGE_SEAT_KEY.test(k);
}
