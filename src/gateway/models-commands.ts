import { escapeForTelegram } from "../capabilities/text-hygiene.js";
import type { TypedTaskEvent } from "../domain/types.js";
import { ALLOWED_PROVIDERS, matchOverride, resolveModelRolesMode, ROLE_LISTS, ROLE_NAMES, selectorKey, type CatalogModel, type RoleName }
  from "../omp/model-roles.js";
import { parseModelString } from "../omp/model-string.js";
import type { OverrideKey, ResolvedRole, RoleResolver } from "../omp/role-resolver.js";
import type { RunStore } from "../run/run-store.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";

/**
 * `/models` (spec §4.2): Paco's override over the code-owned role lists. A control command (no run, no budget), idempotent on
 * the trigger key, every reply code-owned; the only stored text echoed is Paco's own pattern, rendered markdown-inert.
 * Overrides are append-only `model_role_override` rows read at each resolution (Task 7), so no restart.
 */

export type ModelsRoles = Pick<RoleResolver, "resolveAll" | "catalog">;
export const MODELS_REFUSED = "MODELS_REFUSED";
export type ModelsRefusal = "role_judges" | "no_seat" | "catalog_unavailable" | "no_match" | "outside_allow_list" | "static_mode"
  | "bad_command" | "unavailable";

const REFUSAL_TEXT: Readonly<Record<Exclude<ModelsRefusal, "outside_allow_list">, string>> = {
  role_judges: "Not saved: judges are overridden one seat at a time (/models set judges <n> <pattern>), so the seats never collapse onto one model.",
  no_seat: "Not saved: there is no such judge seat. /models lists the seats.",
  catalog_unavailable: "Not saved: omp's model catalog is unavailable right now, so the pattern cannot be checked. Try again after the next catalog read.",
  no_match: "Not saved: the pattern matches no catalogued model.",
  static_mode: "Not saved: HOUGE_MODEL_ROLES=static runs the code lists as written and applies no override.",
  bad_command: "That /models command was not understood. /help lists the forms.",
  unavailable: "Model roles are not available in this process."
};

export function modelsRefusalText(r: ModelsRefusal): string {
  if (r !== "outside_allow_list") return REFUSAL_TEXT[r];
  return `Not saved: the pattern matches only models outside this role's providers (allowed: ${ALLOWED_PROVIDERS.join(", ")}; chat roles never use openai-codex).`;
}

const ok = (): GatewayIntakeResult => ({ ok: true, status: "models_returned", run_id: "" });

function refuse(store: RunStore, event: TypedTaskEvent, r: ModelsRefusal): GatewayIntakeResult {
  replyTo(store, event, "models_refused", modelsRefusalText(r));
  return { ok: false, error: { code: MODELS_REFUSED, message: `/models refused: ${r}` } };
}

/** A gateway built without a resolver (the CLI, the eval runner): the command is understood and declined. */
export function modelsUnavailable(store: RunStore, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => refuse(store, event, "unavailable"));
}

export function handleModels(store: RunStore, roles: ModelsRoles, event: TypedTaskEvent): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    const action = event.program ?? "list";
    if (action === "list") {
      replyTo(store, event, "models", modelsListText(store, roles));
      return ok();
    }
    const t = targetOf(event);
    if (!t) return refuse(store, event, "bad_command");
    if (action === "set") return setOverride(store, roles, event, t);
    return action === "reset" ? resetOverride(store, event, t) : refuse(store, event, "bad_command");
  });
}

interface Target { role: RoleName; seat: number | undefined; pattern: string }

/** Re-validates what the adapter put on the event (the event is the trust boundary into the gateway). */
function targetOf(event: TypedTaskEvent): Target | null {
  const m = event.metadata ?? {};
  const role = ROLE_NAMES.find((r) => r === m.role);
  if (!role) return null;
  const rawSeat = m.seat;
  if (rawSeat !== undefined && (typeof rawSeat !== "number" || !Number.isSafeInteger(rawSeat) || rawSeat < 0 || role !== "judges")) return null;
  return { role, seat: rawSeat, pattern: typeof m.pattern === "string" ? m.pattern.trim() : "" };
}

const keyOf = (t: Pick<Target, "role" | "seat">): OverrideKey => (t.seat !== undefined ? `judges:${t.seat}` : t.role);

/** Spec §4.2 refusal order: static switch, seat shape, catalog, then the filtered match (the allow-list runs before matching). */
function setRefusal(roles: ModelsRoles, t: Target): ModelsRefusal | null {
  if (!t.pattern) return "bad_command";
  if (resolveModelRolesMode(process.env) === "static") return "static_mode";
  if (t.role === "judges" && t.seat === undefined) return "role_judges";
  if (t.seat !== undefined && t.seat >= ROLE_LISTS.judges.length) return "no_seat";
  const catalog = roles.catalog();
  if (!catalog) return "catalog_unavailable";
  if (matchOverride(t.pattern, t.role, catalog).length > 0) return null;
  return matchesUnfiltered(t.pattern, catalog) ? "outside_allow_list" : "no_match";
}

/** Only for the refusal's reason: does the pattern hit anything in the raw catalog (a filtered-out provider or seat)? */
function matchesUnfiltered(pattern: string, catalog: readonly CatalogModel[]): boolean {
  const p = pattern.toLowerCase();
  return catalog.some((m) => selectorKey({ provider: m.provider, model: m.id }).toLowerCase().includes(p));
}

function setOverride(store: RunStore, roles: ModelsRoles, event: TypedTaskEvent, t: Target): GatewayIntakeResult {
  const refusal = setRefusal(roles, t);
  if (refusal) return refuse(store, event, refusal);
  const key = keyOf(t);
  store.recordModelRoleOverride({ key, pattern: t.pattern, actor: event.requested_by.id });
  const head = roles.resolveAll().find((r) => r.key === key)?.head ?? null;
  replyTo(store, event, "models_set", `✅ ${key} → override \`${escapeForTelegram(t.pattern)}\`; now resolves to ${modelCode(head)}.`);
  return ok();
}

/** `reset judges` (no seat) clears every seat that holds an override; any other reset clears one key. No override → no row. */
function resetOverride(store: RunStore, event: TypedTaskEvent, t: Target): GatewayIntakeResult {
  const active = store.latestModelRoleOverrides();
  const keys = t.role === "judges" && t.seat === undefined
    ? [...active.keys()].filter((k) => k.startsWith("judges:"))
    : [keyOf(t)].filter((k) => active.has(k));
  if (keys.length === 0) {
    replyTo(store, event, "models_reset", `No override on ${keyOf(t)}; nothing changed.`);
    return ok();
  }
  store.inTransaction(() => { for (const key of keys) store.recordModelRoleOverride({ key, pattern: "", actor: event.requested_by.id }); });
  replyTo(store, event, "models_reset", `↩️ Reset ${keys.join(", ")}: back to the code list.`);
  return ok();
}

const MODELS_FOOTER = "· /models set <role> <pattern> · /models set judges <n> <pattern> · /models reset <role> [n]";

function modelCode(selector: string | null): string {
  return selector === null ? "(no candidate)" : `\`${escapeForTelegram(selector)}\``;
}

function effortOf(selector: string | null): string {
  if (selector === null) return "—";
  try { return parseModelString(selector).effort ?? "default"; } catch { return "—"; }
}

function headerLine(catalog: readonly CatalogModel[] | null): string {
  if (resolveModelRolesMode(process.env) === "static") return "🧭 **Model roles** · static: code lists as written, no catalog check, no override";
  return catalog ? `🧭 **Model roles** · catalog: ${catalog.length} models` : "🧭 **Model roles** · catalog unavailable: code lists as written";
}

function roleLines(r: ResolvedRole, pattern: string | undefined): string[] {
  const source = r.source === "override" ? `override \`${escapeForTelegram(pattern ?? "")}\`` : "list";
  const head = r.head === null ? `**${r.key}** → ${modelCode(null)}` : `**${r.key}** → ${modelCode(r.head)} · effort ${effortOf(r.head)} · ${source}`;
  return r.candidates.length > 0 ? [head, `  candidates: ${r.candidates.map(modelCode).join(", ")}`] : [head];
}

/** Role → head model, effort, list or override (with Paco's pattern), and the candidate list (spec §4.2). */
export function modelsListText(store: RunStore, roles: ModelsRoles): string {
  const overrides = store.latestModelRoleOverrides();
  const lines = [headerLine(roles.catalog())];
  for (const r of roles.resolveAll()) lines.push(...roleLines(r, overrides.get(r.key)));
  return [...lines, MODELS_FOOTER].join("\n");
}
