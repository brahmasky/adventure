import type { RunStore } from "../run/run-store.js";
import { JEV_MODEL } from "./jev-client.js";
import { observedAction, type ObservedAction } from "./labels.js";
import { atThreshold, confusion, pct, THRESHOLDS } from "./replay-report.js";

/**
 * `houge jev-shadow report` (Jev spec 2026-09-25 §"Live shadow" + 2026-09-26 amendments): the live
 * intent_shadow rows → a PROMOTE / HOLD / KILL verdict per language. Read-only; promotion itself is a
 * separate spec.
 */
const GATE_CONFIDENCE = 0.7;
const PROMOTE_AGREEMENT = 0.9;
const PROMOTE_COVERAGE = 0.6;
const MIN_MATCHED = 60;
const MIN_DAYS = 28;
const DAY_MS = 86_400_000;

export interface ShadowRow {
  run_id: string;
  occurred_at: string;
  status: string;
  lang: string;
  llm_intent: string;
  llm_parsed: boolean;
  jev_intent?: string;
  jev_confidence?: number;
  jev_model?: string;
  jev_error?: string;
  observed_action: ObservedAction;
}
export type LangVerdict = "PROMOTE" | "HOLD" | "KILL";
export interface LangSummary {
  rows: number;
  matched: number;
  agreement: number | null;
  coverage: number | null;
  verdict: LangVerdict;
  reason: string;
  byStatus: Record<string, number>;
  byModel: Record<string, number>;
}
export interface ShadowSummary {
  rows: number;
  matched: number;
  missing: number;
  days: number;
  byStatus: Record<string, number>;
  byModel: Record<string, number>;
  thresholds: ReturnType<typeof atThreshold>[];
  byLang: Record<string, LangSummary>;
  costly: { research: number; missed: number };
  clarify: { llm: number; matched: number };
}

/** Matched = a parsed classifier label AND an ok answer from the pinned Jev model. */
export function isShadowMatched(r: ShadowRow): boolean {
  return r.status === "ok" && r.llm_parsed && r.jev_intent !== undefined && r.jev_confidence !== undefined && r.jev_model === JEV_MODEL;
}

export function loadShadowRows(store: Pick<RunStore, "listIntentShadows" | "runLoopCapabilities">, sinceIso?: string): ShadowRow[] {
  return store.listIntentShadows(sinceIso).map(({ run_id, occurred_at, payload: p }) => ({
    run_id,
    occurred_at,
    status: String(p.status),
    lang: String(p.lang),
    llm_intent: String(p.llm_intent),
    llm_parsed: p.llm_parsed === true,
    ...(typeof p.jev_intent === "string" ? { jev_intent: p.jev_intent } : {}),
    ...(typeof p.jev_confidence === "number" ? { jev_confidence: p.jev_confidence } : {}),
    ...(typeof p.jev_model === "string" ? { jev_model: p.jev_model } : {}),
    ...(typeof p.jev_error === "string" ? { jev_error: p.jev_error } : {}),
    // One loop-capabilities read per row, the replay's pattern: hundreds of rows on in-process SQLite.
    observed_action: observedAction(store.runLoopCapabilities(run_id))
  }));
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

function langSummary(langRows: ShadowRow[], days: number): LangSummary {
  const matched = langRows.filter(isShadowMatched);
  const slice = matched.filter((r) => (r.jev_confidence ?? 0) >= GATE_CONFIDENCE);
  const agreement = slice.length > 0 ? slice.filter((r) => r.jev_intent === r.llm_intent).length / slice.length : null;
  const coverage = langRows.length > 0 ? slice.length / langRows.length : null;
  const base = {
    rows: langRows.length, matched: matched.length, agreement, coverage,
    byStatus: countBy(langRows, (r) => r.status),
    byModel: countBy(langRows.filter((r) => r.status === "ok" && r.jev_model !== undefined), (r) => r.jev_model ?? "")
  };
  if (matched.length < MIN_MATCHED || days < MIN_DAYS) {
    return { ...base, verdict: "HOLD", reason: `needs ≥${MIN_MATCHED} matched turns and ≥${MIN_DAYS} days (has ${matched.length}, ${days.toFixed(1)} days)` };
  }
  if (agreement !== null && agreement >= PROMOTE_AGREEMENT && coverage !== null && coverage >= PROMOTE_COVERAGE) {
    return { ...base, verdict: "PROMOTE", reason: `agreement ${pct(agreement)}, coverage ${pct(coverage)}, matched ${matched.length}` };
  }
  return { ...base, verdict: "KILL", reason: `agreement ${pct(agreement)} (bar ${pct(PROMOTE_AGREEMENT)}), coverage ${pct(coverage)} (bar ${pct(PROMOTE_COVERAGE)})` };
}

export function summarizeShadow(rows: ShadowRow[], missing: number, nowIso: string, campaignStartIso?: string): ShadowSummary {
  const matched = rows.filter(isShadowMatched);
  // Tenure is the campaign's age — the first intent_shadow row EVER — not the first row inside --since.
  const first = campaignStartIso ?? rows[0]?.occurred_at;
  const days = first === undefined ? 0 : (Date.parse(nowIso) - Date.parse(first)) / DAY_MS;
  const byLang: Record<string, LangSummary> = {};
  for (const lang of new Set(rows.map((r) => r.lang))) byLang[lang] = langSummary(rows.filter((r) => r.lang === lang), days);
  const confidentResearch = matched.filter((r) => r.llm_intent === "research" && (r.jev_confidence ?? 0) >= GATE_CONFIDENCE);
  const llmClarify = matched.filter((r) => r.llm_intent === "clarify");
  return {
    rows: rows.length,
    matched: matched.length,
    missing,
    days,
    byStatus: countBy(rows, (r) => r.status),
    byModel: countBy(rows.filter((r) => r.status === "ok" && r.jev_model !== undefined), (r) => r.jev_model ?? ""),
    thresholds: THRESHOLDS.map((t) => atThreshold(matched, t)),
    byLang,
    costly: { research: confidentResearch.length, missed: confidentResearch.filter((r) => r.jev_intent !== "research").length },
    clarify: { llm: llmClarify.length, matched: llmClarify.filter((r) => r.jev_intent === "clarify").length }
  };
}

export function formatShadowReport(s: ShadowSummary, matchedRows: ShadowRow[]): string {
  if (s.rows === 0) return "No intent_shadow rows yet — is HOUGE_JEV_SHADOW_ENABLED on, and has the daemon been restarted?";
  return [
    `Verdict by language (bar: ≥${pct(PROMOTE_AGREEMENT)} agreement at Jev confidence ≥${GATE_CONFIDENCE}, ≥${pct(PROMOTE_COVERAGE)} coverage, ≥${MIN_MATCHED} matched turns, ≥${MIN_DAYS} days):`,
    ...Object.entries(s.byLang).flatMap(([lang, v]) => [
      `  ${lang}: ${v.verdict} — ${v.reason}`,
      `     rows ${v.rows}, by status ${JSON.stringify(v.byStatus)}, by Jev model ${JSON.stringify(v.byModel)}`
    ]),
    "Promote only the languages marked PROMOTE; the promotion itself is a separate spec.",
    "",
    `Counts: shadowed ${s.rows}, matched ${s.matched}, missing ${s.missing} (shutdown, flag toggled, or failure after the classifier); by status ${JSON.stringify(s.byStatus)}`,
    `Shadowing for ${s.days.toFixed(1)} days.`,
    "",
    "Agreement vs the live classifier by Jev confidence (coverage here = share of matched turns):",
    ...s.thresholds.map((t) => `  ≥${t.t}: slice ${t.slice}, agreement ${pct(t.agreement)}, coverage ${pct(t.coverage)}`),
    "",
    `Costly direction (reported only): the classifier said research on ${s.costly.research} turn(s) where Jev was ≥${GATE_CONFIDENCE} confident; Jev said something else on ${s.costly.missed}.`,
    `Clarify (reported only): the classifier said clarify ${s.clarify.llm} time(s); Jev matched ${s.clarify.matched}.`,
    "",
    "By Jev model:",
    ...Object.entries(s.byModel).map(([model, n]) => `  ${model}: ${n}${model === JEV_MODEL ? "" : " (excluded from the verdict)"}`),
    "",
    ...confusion(matchedRows, (r) => r.llm_intent, "live classifier (gates)"),
    ...confusion(matchedRows, (r) => r.observed_action, "observed action (proxy, never gates)")
  ].join("\n");
}

export function parseShadowReportArgs(argv: string[]): { ok: true; sinceIso?: string } | { ok: false; error: string } {
  if (argv.length === 0) return { ok: true };
  const [flag, value] = argv;
  if (argv.length === 2 && flag === "--since" && value !== undefined && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
    return { ok: true, sinceIso: new Date(value).toISOString() };
  }
  return { ok: false, error: "Usage: houge jev-shadow report [--since ISO]" };
}
