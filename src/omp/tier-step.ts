import type { ProbeOutcome } from "./model-probe.js";
import type { CatalogModel } from "./model-roles.js";
import { tierDef, tierMembers, type TierId } from "./model-tiers.js";

/** Spec §4.2: a model_missing selector is not probed again for 7 days. */
export const REJECT_PROBE_MS = 7 * 24 * 60 * 60_000;
export interface TierState { tier: TierId; adopted: string | null; previous: string | null; adopted_at: string | null; rejected_selector: string | null; rejected_at: string | null }
export interface TierProbe { id: string; selector: string; purpose: "head" | "previous" }
export interface TierPlan { before: TierState; state: TierState; probe: TierProbe | null }

export const selectorOf = (tier: TierId, id: string | null): string | null => (id === null ? null : `${tierDef(tier).provider}/${id}`);

/** Step 2 of the tick (plan P13): follow a retirement, then pick at most one probe. Pure. */
export function planTier(before: TierState, catalog: readonly CatalogModel[], now: string): TierPlan {
  const def = tierDef(before.tier);
  // P13 (review W1): a read that lists nothing of the tier's provider is partial for this tier, not a retirement
  if (!catalog.some((m) => m.provider === def.provider)) return { before, state: before, probe: null };
  const members = tierMembers(def, catalog);
  const state = followRetirement(before, members, now);
  return { before, state, probe: probeFor(state, members, Date.parse(now)) };
}

/** Spec §4.1: an adopted head gone from the catalog moves the tier to its previous head (already probed); none → empty. */
function followRetirement(s: TierState, members: readonly string[], now: string): TierState {
  const live = (id: string | null): id is string => id !== null && members.includes(id);
  if (live(s.adopted)) return live(s.previous) || s.previous === null ? s : { ...s, previous: null };
  if (live(s.previous)) return { ...s, adopted: s.previous, previous: null, adopted_at: now };
  return s.adopted === null && s.previous === null ? s : { ...s, adopted: null, previous: null, adopted_at: null };
}

function probeFor(s: TierState, members: readonly string[], nowMs: number): TierProbe | null {
  const rejected = (id: string) => s.rejected_selector === selectorOf(s.tier, id) && s.rejected_at !== null && nowMs - Date.parse(s.rejected_at) < REJECT_PROBE_MS;
  const pick = (id: string, purpose: TierProbe["purpose"]): TierProbe => ({ id, selector: selectorOf(s.tier, id)!, purpose });
  const head = members[0];
  if (head !== undefined && head !== s.adopted && !rejected(head)) return pick(head, "head");
  if (s.adopted === null || s.previous !== null) return null;
  const below = members.slice(members.indexOf(s.adopted) + 1).find((id) => !rejected(id));
  return below === undefined ? null : pick(below, "previous");
}

/** Step 4: the tier after its probe (null = not run). Inconclusive changes nothing; model_missing remembers the selector. */
export function applyProbe(p: TierPlan, o: ProbeOutcome | null, now: string): TierState {
  const s = p.state;
  if (!p.probe || !o || o.result === "inconclusive") return s;
  if (o.result === "model_missing") return { ...s, rejected_selector: p.probe.selector, rejected_at: now };
  if (p.probe.purpose === "previous") return { ...s, previous: p.probe.id };
  return { ...s, adopted: p.probe.id, previous: s.adopted ?? s.previous, adopted_at: now };
}
