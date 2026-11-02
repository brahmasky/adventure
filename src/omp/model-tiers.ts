import type { CatalogModel } from "./model-roles.js";

/**
 * Model tiers (spec 2026-11-02 §4.1, ADR 0028 amendment): a tier is a provider plus an anchored pattern over the catalog id,
 * one capture group per version segment. "Newest" comes from the version in the id (the catalog has no release date).
 * `\d{1,2}` keeps dated snapshots out; the anchors keep out -lite, -highspeed, -256k and previews. A different family is
 * Paco's call (D1, or /models), never this file's.
 */
export type TierId = "opus@anthropic" | "opus@antigravity" | "sonnet@anthropic" | "sonnet@antigravity" | "gemini-flash" | "gemini-pro" | "codex-sol" | "kimi";
export interface TierDef { id: TierId; provider: string; pattern: RegExp; label: string }

const OPUS = /^claude-opus-(\d{1,2})(?:-(\d{1,2}))?$/;
const SONNET = /^claude-sonnet-(\d{1,2})(?:-(\d{1,2}))?$/;
export const TIERS: readonly TierDef[] = [
  { id: "opus@anthropic", provider: "anthropic", pattern: OPUS, label: "Opus" },
  { id: "opus@antigravity", provider: "google-antigravity", pattern: OPUS, label: "Opus" },
  { id: "sonnet@anthropic", provider: "anthropic", pattern: SONNET, label: "Sonnet" },
  { id: "sonnet@antigravity", provider: "google-antigravity", pattern: SONNET, label: "Sonnet" },
  { id: "gemini-flash", provider: "google-antigravity", pattern: /^gemini-(\d{1,2})(?:\.(\d{1,2}))?-flash$/, label: "flash" },
  { id: "gemini-pro", provider: "google-antigravity", pattern: /^gemini-(\d{1,2})(?:\.(\d{1,2}))?-pro$/, label: "pro" },
  { id: "codex-sol", provider: "openai-codex", pattern: /^gpt-(\d{1,2})(?:\.(\d{1,2}))?-sol$/, label: "sol" },
  // D1-A (Paco 2026-11-02): -pro counts (k3.1-pro > k3); -highspeed and -256k stay out by the anchor
  { id: "kimi", provider: "kimi-code", pattern: /^k(\d{1,2})(?:\.(\d{1,2}))?(?:-pro)?$/, label: "K" }
];
export const TIER_IDS: readonly TierId[] = TIERS.map((t) => t.id);
export const isTierId = (s: string): s is TierId => (TIER_IDS as readonly string[]).includes(s);
export function tierDef(id: TierId): TierDef { return TIERS.find((t) => t.id === id)!; }

/** The id's version segments (a missing segment = 0), or null when the id is not in the tier. */
export function tierVersion(def: TierDef, id: string): number[] | null {
  const m = def.pattern.exec(id);
  return m ? m.slice(1).map((s) => (s === undefined ? 0 : Number(s))) : null;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The tier's catalog ids, newest first; equal versions: the shorter id first, then by id. */
export function tierMembers(def: TierDef, catalog: readonly CatalogModel[]): string[] {
  const ids = [...new Set(catalog.filter((c) => c.provider === def.provider && tierVersion(def, c.id) !== null).map((c) => c.id))];
  return ids.sort((x, y) => compareVersions(tierVersion(def, y)!, tierVersion(def, x)!) || x.length - y.length || (x < y ? -1 : x > y ? 1 : 0));
}

export function catalogHead(def: TierDef, catalog: readonly CatalogModel[]): string | null { return tierMembers(def, catalog)[0] ?? null; }

/** Spec §4.2 bootstrap (W4): the list entries that matched each tier and ran on 2026-11-01. gemini-pro has none (§4.4). */
export const SEED_HEADS: Readonly<Record<TierId, string | null>> = {
  "opus@anthropic": "claude-opus-5-5", "opus@antigravity": "claude-opus-5-5", "sonnet@anthropic": "claude-sonnet-5-5",
  "sonnet@antigravity": "claude-sonnet-5-5", "gemini-flash": "gemini-3.8-flash", "gemini-pro": null, "codex-sol": "gpt-6.1-sol", kimi: "k3"
};

export type TierHeads = ReadonlyMap<TierId, { adopted: string | null; previous: string | null }>;
export function seedTierHeads(): TierHeads { return new Map(TIER_IDS.map((t) => [t, { adopted: SEED_HEADS[t], previous: null }])); }

/** `model_tiers` rows → heads; a tier with no row keeps its seed; a row for an unknown tier is ignored. */
export function tierHeadsOf(rows: ReadonlyArray<{ tier: string; adopted: string | null; previous: string | null }>): TierHeads {
  const m = new Map(seedTierHeads());
  for (const r of rows) if (isTierId(r.tier)) m.set(r.tier, { adopted: r.adopted, previous: r.previous });
  return m;
}

/** The output price in force at `nowMs`: the latest effective rate that has started, else the flat rate; null when unpriced. */
export function outputPriceAt(m: CatalogModel, nowMs: number): number | null {
  if (!m.price) return null;
  const started = m.price.rates.filter((r) => r.from <= nowMs).sort((a, b) => b.from - a.from)[0];
  return started ? started.output : m.price.output;
}

/** P9: same provider, matched by no tier of that provider, not a preview, not -lite. */
function isProposal(def: TierDef, m: CatalogModel): boolean {
  if (m.provider !== def.provider || m.id.includes("preview") || m.id.endsWith("-lite")) return false;
  return !TIERS.some((t) => t.provider === def.provider && tierVersion(t, m.id) !== null);
}

/** Spec §4.4: up to three ids for an empty tier, by current output price, highest first (unpriced last, then by id). */
export function proposalsFor(def: TierDef, catalog: readonly CatalogModel[], nowMs: number): string[] {
  const price = (m: CatalogModel) => outputPriceAt(m, nowMs) ?? -1;
  return catalog.filter((m) => isProposal(def, m)).sort((a, b) => price(b) - price(a) || (a.id < b.id ? -1 : 1)).slice(0, 3).map((m) => m.id);
}
