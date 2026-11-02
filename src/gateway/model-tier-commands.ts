import { createHash } from "node:crypto";
import { errorCode } from "../domain/error-code.js";
import type { TypedTaskEvent } from "../domain/types.js";
import type { NotificationButton } from "../notifications/notification-types.js";
import type { ProbeFn, ProbeOutcome } from "../omp/model-probe.js";
import { keyNeedsModel, ledgerKind, type EmptyTierCard } from "../omp/model-roles-tick.js";
import { resolveModelRolesMode, soleKeysOf } from "../omp/model-roles.js";
import type { OverrideKey } from "../omp/role-resolver.js";
import { isTierId, proposalsFor, tierDef, type TierId } from "../omp/model-tiers.js";
import { resolveOpenIncidents } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import { formatInstantInZone, resolveDisplayZone } from "../run/schedule-spec.js";
import type { GatewayIntakeResult } from "./gateway.js";
import { TAP_FAILED_TEXT, TAP_HANDLED_TEXT } from "./improvement-commands.js";
import { oncePerTrigger, replyTo } from "./memory-commands.js";
import type { ModelsRoles } from "./models-commands.js";

/**
 * The empty-tier card and its tap (spec 2026-11-02 §4.4, plan P15–P16). Every text is code-owned; the only ids shown are
 * catalog ids and role keys. A tap probes first, off the tap's path, and only a pass writes the `/models set` row.
 */
const PROVIDER_LABEL: Readonly<Record<string, string>> = { anthropic: "Anthropic", "google-antigravity": "Google", "openai-codex": "OpenAI", "kimi-code": "Kimi" };
const ROLE_UNRESOLVED: ReadonlySet<string> = new Set(["role_unresolved"]);
const cap = (k: string) => `${k.charAt(0).toUpperCase()}${k.slice(1)}`;
const keyWords = (k: string) => k.replace(":", " ");
export const tierModelHash = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);
export const tierCallbackData = (tier: TierId, id: string | null): string => (id === null ? `mt:${tier}:no` : `mt:${tier}:${tierModelHash(id)}:use`);

export function tierCardText(c: EmptyTierCard): string {
  const def = tierDef(c.tier);
  const head = `${c.keys.map(cap).join(", ")} has no model: ${PROVIDER_LABEL[def.provider] ?? def.provider}'s ${def.label} tier is empty.`;
  const first = c.proposals[0];
  if (first !== undefined) return `${head} Use \`${first}\`?`;
  return `${head} The catalog offers no other ${def.provider} model; ${c.keys.map((k) => `/models set ${keyWords(k)} <pattern>`).join(" · ")} fills it.`;
}

/** One card per tier per display-zone day (the outbox key, as the reminder's, P23); through the outbox and the rich renderer. */
export function enqueueTierCard(store: RunStore, chatId: string, now: string, c: EmptyTierCard, env: NodeJS.ProcessEnv = process.env): void {
  const date = formatInstantInZone(now, resolveDisplayZone(env)).slice(0, 10);
  const buttons: NotificationButton[] = [...c.proposals.map((id) => ({ text: `Use ${id}`, data: tierCallbackData(c.tier, id) })), { text: "Not now", data: tierCallbackData(c.tier, null) }];
  store.enqueueNotification({ target: { kind: "telegram", chat_id: chatId }, intent_type: "progress", idempotency_key: `model_tier_card:${c.tier}:${date}`,
    correlation_id: "model-roles", payload: { text: tierCardText(c), ...(c.proposals.length > 0 ? { button_rows: [buttons] } : {}) } });
}

/** Final review Minor 2: a tap that cannot be checked says why ("Already handled." would be false); nothing is written. */
export const TAP_STATIC_TEXT = "Nothing changed: HOUGE_MODEL_ROLES=static runs the code lists as written and applies no override.";
export const TAP_NO_CATALOG_TEXT = "Nothing changed: omp's model catalog is unavailable right now. Tap the card again after the next catalog read.";

/** `signal`: the daemon's stop (review W5): a stop kills the tap's probe child and the aborted probe commits nothing. */
export interface TierTapDeps { roles?: ModelsRoles; probe?: ProbeFn; track: (p: Promise<void>) => void; signal?: AbortSignal }
interface OpenTap { tier: TierId; keys: string[]; proposals: string[] }

export function handleModelTierTap(store: RunStore, deps: TierTapDeps, event: TypedTaskEvent, now: string = new Date().toISOString()): GatewayIntakeResult {
  return oncePerTrigger(store, event, () => {
    try { tapOnce(store, deps, event, now); } catch (e) {
      console.error(`[model-tiers] tap failed: ${errorCode(e)}`);
      try { replyTo(store, event, "model_tier_tap", TAP_FAILED_TEXT); } catch (e2) { console.error(`[model-tiers] tap reply failed: ${errorCode(e2)}`); }
    }
    return { ok: true, status: "model_tier_tapped", run_id: "" };
  });
}

function tapOnce(store: RunStore, deps: TierTapDeps, event: TypedTaskEvent, now: string): void {
  const reply = (text: string) => replyTo(store, event, "model_tier_tap", text);
  if (deps.roles && resolveModelRolesMode(process.env) === "static") return reply(TAP_STATIC_TEXT);
  if (deps.roles && !deps.roles.catalog()) return reply(TAP_NO_CATALOG_TEXT);
  const t = openTap(store, deps.roles, String(event.metadata?.tier ?? ""), now);
  if (!t) return reply(TAP_HANDLED_TEXT);
  const hash = event.metadata?.model_hash;
  if (typeof hash !== "string") return reply(`👍 Not now: ${t.keys.join(", ")} stays empty; the daily reminder lists it until it is filled.`);
  const id = t.proposals.find((p) => tierModelHash(p) === hash);
  if (id === undefined) return reply(TAP_HANDLED_TEXT);
  if (!deps.probe) return reply("Model roles are not available in this process.");
  reply(`🔎 Checking \`${id}\` with one short prompt…`);
  deps.track(probeThenAdopt(store, deps.roles as ModelsRoles /* openTap returned a tap only with roles */, deps.probe, t, id, event, deps.signal));
}

/** The card still applies: a known tier, still empty, a catalog, and a sole key that still needs a model (the card's own predicate). */
function openTap(store: RunStore, roles: ModelsRoles | undefined, tier: string, now: string): OpenTap | null {
  if (!roles || !isTierId(tier)) return null;
  const catalog = roles.catalog();
  if (!catalog || (store.getModelTier(tier)?.adopted ?? null) !== null) return null;
  const resolved = roles.resolveAll();
  const keys = soleKeysOf(tier).filter((k) => keyNeedsModel(resolved, k));
  return keys.length === 0 ? null : { tier, keys, proposals: proposalsFor(tierDef(tier), catalog, Date.parse(now)) };
}

/** Spec §4.4 (codex B3, senior W5): the probe, then the event and (on pass) the override in one transaction, then the answer. */
async function probeThenAdopt(store: RunStore, roles: ModelsRoles, probe: ProbeFn, t: OpenTap, id: string, event: TypedTaskEvent, signal?: AbortSignal): Promise<void> {
  const selector = `${tierDef(t.tier).provider}/${id}`;
  try {
    const o = await probe(selector, signal);
    if (o === "aborted" || signal?.aborted) return; // the daemon is stopping: nothing written, nothing said (P16)
    let keys = t.keys;
    store.inTransaction(() => {
      store.recordModelProbe({ tier: t.tier, selector, purpose: "tap", result: o.result, kind: ledgerKind(o.kind) });
      if (o.result !== "pass") return;
      // The probe took time: a /models set or another tap may have filled a key since. Only a key that still needs a model is written.
      const resolved = roles.resolveAll();
      keys = t.keys.filter((k) => keyNeedsModel(resolved, k));
      for (const key of keys) store.recordModelRoleOverride({ key: key as OverrideKey, pattern: id, actor: event.requested_by.id });
      for (const key of keys) resolveOpenIncidents(store, ROLE_UNRESOLVED, key);
    });
    replyTo(store, event, "model_tier_probe", o.result === "pass" && keys.length === 0 ? `ℹ️ \`${id}\` passed its check, but ${t.keys.join(", ")} got a model meanwhile; nothing changed.` : resultText({ ...t, keys }, id, o));
  } catch (e) {
    console.error(`[model-tiers] tap probe failed: ${errorCode(e)}`);
    try { replyTo(store, event, "model_tier_probe", TAP_FAILED_TEXT); } catch (e2) { console.error(`[model-tiers] tap reply failed: ${errorCode(e2)}`); }
  }
}

function resultText(t: OpenTap, id: string, o: ProbeOutcome): string {
  if (o.result === "pass") return `✅ \`${id}\` passed its check; ${t.keys.join(", ")} now ${t.keys.length === 1 ? "uses" : "use"} it (an override: ${t.keys.map((k) => `/models reset ${keyWords(k)}`).join(" · ")} undoes it).`;
  if (o.result === "model_missing") return `❌ \`${id}\` failed its check (not available on this subscription); nothing changed.`;
  return `⏳ \`${id}\` could not be checked right now (${o.kind}); nothing changed. Tap again later.`;
}
