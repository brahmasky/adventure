import { parseModelString, type ModelString, type OmpEffort } from "./model-string.js";

/**
 * Model roles (spec 2026-10-06 §4, ADR 0028 amendment). Every Houge seat names a role, and every role is a code-owned,
 * ordered list of exact selectors (`provider/id[:effort]`). Resolution against omp's live catalog is pure and lives here;
 * RoleResolver (role-resolver.ts) holds the catalog, Paco's `/models` overrides and reads the mode per call.
 */
export type RoleName = "fast" | "default" | "thinking" | "reader" | "vision" | "tiny" | "judges" | "chair" | "reviewer";
export const ROLE_NAMES: readonly RoleName[] = ["fast", "default", "thinking", "reader", "vision", "tiny", "judges", "chair", "reviewer"];

/** Planner gears and routed efforts: structurally src/jev/tree-policy.ts `TurnRole` / `Effort` (src/omp imports nothing from src/jev). */
type PlannerRole = "fast" | "default" | "thinking";
type RoutedEffort = "low" | "medium" | "high";

/**
 * The lists `resolved` mode starts from. They start from the pre-stage-A `HOUGE_OMP_*` defaults. `openai-codex/gpt-5.5`
 * (no longer catalogued on 2026-10-07) becomes `openai-codex/gpt-6.1-sol` (plan Decision 1). Antigravity's catalog
 * changed generation during 2026-10-07: `claude-opus-4-6` gave way to `claude-opus-5-5` and `claude-sonnet-5-5`. The
 * lists keep both generations, because resolution drops whatever the catalog does not list, so a provider that rolls
 * back or forward still leaves a leg. Fast and Thinking are new (Decision 3). Judges is one selector per seat index: a
 * judge never falls back. Kimi exits next year (Paco, 2026-10-07): every role list keeps a non-Kimi leg, so resolution
 * drops k3 without emptying a role (Fast carries no k3 at all; Tiny gains gemini-3.8-flash behind it). Judge seat 0 is
 * k3 alone and needs a replacement selector then.
 */
export const ROLE_LISTS: Readonly<Record<RoleName, readonly string[]>> = {
  fast: ["anthropic/claude-sonnet-5-5:low", "google-antigravity/claude-sonnet-5-5:low", "google-antigravity/gemini-3.8-flash:low"],
  default: ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"],
  thinking: ["anthropic/claude-opus-5-5:high", "google-antigravity/claude-opus-5-5:high", "google-antigravity/claude-opus-4-6:high", "kimi-code/k3:high"],
  reader: ["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-6.1-sol:low"],
  vision: ["google-antigravity/gemini-3.8-flash:low"],
  tiny: ["kimi-code/k3:low", "google-antigravity/gemini-3.8-flash:low"],
  judges: ["kimi-code/k3", "openai-codex/gpt-6.1-sol", "google-antigravity/gemini-3.1-pro"],
  chair: ["anthropic/claude-opus-5-5:low"],
  reviewer: ["kimi-code/k3:high", "google-antigravity/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium"]
};

/**
 * The lists `static` mode runs (spec §4.3, the rollback switch): the pre-stage-A `HOUGE_OMP_*` defaults
 * (src/omp/omp-config.ts at main@94e3b4c), seat for seat and string for string. Static adds no model: Fast and Thinking
 * are the Default list, so every turn runs today's planner chain. A resolved role that comes up empty against the
 * catalog also falls back to its list here (RoleResolver), so a degraded catalog is never worse than before stage A.
 */
export const STATIC_ROLE_LISTS: Readonly<Record<RoleName, readonly string[]>> = (() => {
  const planner = ["anthropic/claude-opus-5-5:medium", "google-antigravity/claude-opus-4-6:medium", "kimi-code/k3:low"];
  return {
    fast: planner, default: planner, thinking: planner,
    reader: ["google-antigravity/gemini-3.8-flash:low", "kimi-code/k3:low", "openai-codex/gpt-5.5:low"],
    vision: ["google-antigravity/gemini-3.8-flash:low"],
    tiny: ["kimi-code/k3:low"],
    judges: ["kimi-code/k3", "openai-codex/gpt-5.5", "google-antigravity/gemini-3.1-pro"],
    chair: ["anthropic/claude-opus-5-5:low"],
    reviewer: ["kimi-code/k3:high", "google-antigravity/claude-opus-4-6:medium"]
  };
})();

/** Spec §4 step 1: the subscription providers. The catalog also lists metered or absent ones, which never match. */
export const ALLOWED_PROVIDERS: readonly string[] = ["anthropic", "google-antigravity", "kimi-code", "openai-codex"];
/** Codex is the self-write writer: no chat seat is ever routed to it (Reader and the council may use it). */
const CODEX_PROVIDER = "openai-codex";
export const CHAT_ROLES: ReadonlySet<RoleName> = new Set<RoleName>(["fast", "default", "thinking", "vision", "tiny"]);

export interface CatalogModel { provider: string; id: string; thinking: readonly OmpEffort[] | null }
export type ModelRolesMode = "static" | "resolved";

/** `HOUGE_MODEL_ROLES` (spec §4.3), read per call: `static` is the rollback switch, anything else is `resolved`. */
export function resolveModelRolesMode(env: NodeJS.ProcessEnv): ModelRolesMode {
  return env.HOUGE_MODEL_ROLES?.trim().toLowerCase() === "static" ? "static" : "resolved";
}

export const selectorKey = (m: Pick<ModelString, "provider" | "model">): string => `${m.provider}/${m.model}`;

export interface ResolveInput { role: RoleName; seat?: number; catalog: readonly CatalogModel[] | null; override: string | null;
  refused: ReadonlySet<string>; mode: ModelRolesMode }

/**
 * The role's own selectors in `mode` (ROLE_LISTS resolved, STATIC_ROLE_LISTS static), parsed. A judge seat is its one
 * index; the judges role without a seat has none.
 */
export function roleSelectors(role: RoleName, seat?: number, mode: ModelRolesMode = "resolved"): ModelString[] {
  const lists = mode === "static" ? STATIC_ROLE_LISTS : ROLE_LISTS;
  if (role !== "judges") return lists[role].map(parseModelString);
  return seat === undefined ? [] : lists.judges.slice(seat, seat + 1).map(parseModelString);
}

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
 * Step 2: the override's candidates. Each takes the effort the role's list gives that model, else the role's first
 * selector's effort (the clamp then fits it to the model). With no catalog (Decision 4) a pattern matches only an exact
 * `provider/id` of the role's own list.
 */
export function overrideCandidates(role: RoleName, seat: number | undefined, override: string | null, catalog: readonly CatalogModel[] | null): ModelString[] {
  const own = roleSelectors(role, seat);
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
 * null catalog in resolved mode keeps the whole ROLE_LISTS entry (Decision 4), so a catalog outage never empties a role.
 * A resolved role CAN come up empty against a catalog; RoleResolver owns that case (spec §4.1, plan F7).
 */
export function resolveRole(i: ResolveInput): ModelString[] {
  const fresh = (m: ModelString) => !i.refused.has(selectorKey(m));
  if (i.mode === "static") return dedupe(roleSelectors(i.role, i.seat, "static")).filter(fresh);
  const own = roleSelectors(i.role, i.seat);
  const listed = own.filter((m) => eligible(i.role, m.provider) && (i.catalog === null || catalogued(m, i.catalog)));
  return dedupe([...overrideCandidates(i.role, i.seat, i.override, i.catalog), ...listed]).filter(fresh);
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

/** The seven OmpConfig seat chains, as the roles fill them. */
export interface RoleChains { planner: ModelString[]; reader: ModelString[]; media: ModelString[]; ticks: ModelString[];
  judges: ModelString[]; chair: ModelString[]; reviewer: ModelString[] }

/**
 * The seven seat chains as STATIC_ROLE_LISTS: today's chains exactly. `HOUGE_MODEL_ROLES=static`, callers that hold no
 * resolver (the CLI, scripts), and resolveOmpConfig's default.
 */
export function staticRoleChains(): RoleChains {
  const s = (r: RoleName): ModelString[] => STATIC_ROLE_LISTS[r].map(parseModelString);
  return { planner: s("default"), reader: s("reader"), media: s("vision"), ticks: s("tiny"), judges: s("judges"), chair: s("chair"), reviewer: s("reviewer") };
}

const JUDGE_SEAT_KEY = /^judges:(0|[1-9]\d?)$/;

/** A `/models` override key (spec §4.2): a role name, or `judges:<n>` for one judge seat. */
export function isOverrideKey(k: string): k is RoleName | `judges:${number}` {
  return (ROLE_NAMES as readonly string[]).includes(k) || JUDGE_SEAT_KEY.test(k);
}
