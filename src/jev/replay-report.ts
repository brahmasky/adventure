import type { ReplayRow } from "./replay.js";

/** Replay GO/STOP screen (Jev spec 2026-09-25). Replay is a feasibility screen, not the promotion gate. */
export const THRESHOLDS: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9];
const GATE_CONFIDENCE = 0.7;
const GO_AGREEMENT = 0.75;
const MIN_MATCHED_SHARE = 0.6;
const MAX_DISAGREEMENTS = 20;

export interface AgreementRow {
  jev_intent?: string;
  jev_confidence?: number;
  llm_intent?: string;
}

export interface ReplaySummary {
  eligible: number;
  matched: number;
  byStatus: Record<string, number>;
  fallbackAnchors: number;
  thresholds: { t: number; slice: number; agreement: number | null; coverage: number | null }[];
  byLang: Record<string, { matched: number; agreementAt07: number | null; coverageAt07: number | null }>;
  /** Jev-answered rows (ok or llm_failed) per Jev response model (spec: "the report splits by jev_model"). */
  byModel: Record<string, number>;
  verdict: "GO" | "STOP";
  verdictReason: string;
  disagreements: { turn_id: string; jev: string; llm: string; confidence: number; lang: string }[];
}

/** A row Jev answered (its LLM leg may still have failed): it carries the model Jev reported. */
const jevAnswered = (r: ReplayRow): boolean => (r.status === "ok" || r.status === "llm_failed") && r.jev_model !== undefined;

/**
 * The run's reference model: the first model Jev reported, whatever the LLM leg did. The request names the moving alias `jev-latest`, so
 * there is no pin; a run is one model's evidence, and rows from another reported model (the alias moved mid-run) are
 * recorded (`byModel`) but never blended into the gate.
 */
export const referenceModel = (rows: ReplayRow[]): string | undefined => rows.find(jevAnswered)?.jev_model;

/** A row only "matches" — and so only enters the GO/STOP gate, thresholds, byLang and disagreements — on the reference model. */
const matcher = (rows: ReplayRow[]) => {
  const ref = referenceModel(rows);
  return (r: ReplayRow): boolean =>
    r.status === "ok" && r.llm_parsed === true && r.jev_intent !== undefined && r.llm_intent !== undefined &&
    r.jev_confidence !== undefined && r.jev_model === ref;
};

export function atThreshold<R extends AgreementRow>(matched: R[], t: number) {
  const slice = matched.filter((r) => (r.jev_confidence ?? 0) >= t);
  const agree = slice.filter((r) => r.jev_intent === r.llm_intent).length;
  return {
    t,
    slice: slice.length,
    agreement: slice.length > 0 ? agree / slice.length : null,
    coverage: matched.length > 0 ? slice.length / matched.length : null
  };
}

export function summarizeReplay(rows: ReplayRow[]): ReplaySummary {
  const eligibleRows = rows.filter((r) => r.status !== "dry_run");
  const matched = eligibleRows.filter(matcher(rows));
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const byLang: ReplaySummary["byLang"] = {};
  for (const lang of new Set(matched.map((r) => r.lang))) {
    const m = matched.filter((r) => r.lang === lang);
    const t = atThreshold(m, GATE_CONFIDENCE);
    byLang[lang] = { matched: m.length, agreementAt07: t.agreement, coverageAt07: t.coverage };
  }
  const gate = atThreshold(matched, GATE_CONFIDENCE);
  const matchedShare = eligibleRows.length > 0 ? matched.length / eligibleRows.length : 0;
  let verdict: "GO" | "STOP" = "GO";
  let verdictReason = `agreement ${pct(gate.agreement)} at confidence ≥ ${GATE_CONFIDENCE} (bar ${pct(GO_AGREEMENT)})`;
  if (matchedShare < MIN_MATCHED_SHARE) {
    verdict = "STOP";
    verdictReason = `only ${pct(matchedShare)} of eligible turns matched (bar ${pct(MIN_MATCHED_SHARE)})`;
  } else if (gate.agreement === null || gate.agreement < GO_AGREEMENT) {
    verdict = "STOP";
  }
  const disagreements = matched
    .filter((r) => r.jev_intent !== r.llm_intent)
    .sort((a, b) => (b.jev_confidence ?? 0) - (a.jev_confidence ?? 0))
    .slice(0, MAX_DISAGREEMENTS)
    .map((r) => ({ turn_id: r.turn_id, jev: r.jev_intent!, llm: r.llm_intent!, confidence: r.jev_confidence!, lang: r.lang }));
  const byModel: Record<string, number> = {};
  for (const r of eligibleRows) {
    if (jevAnswered(r)) byModel[r.jev_model!] = (byModel[r.jev_model!] ?? 0) + 1;
  }
  return {
    eligible: eligibleRows.length,
    matched: matched.length,
    byStatus,
    fallbackAnchors: eligibleRows.filter((r) => r.anchor_kind === "run_start").length,
    thresholds: THRESHOLDS.map((t) => atThreshold(matched, t)),
    byLang,
    byModel,
    verdict,
    verdictReason,
    disagreements
  };
}

export function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

export function confusion<R extends AgreementRow>(rows: R[], other: (r: R) => string | undefined, label: string): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.jev_intent} → ${other(r) ?? "?"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [`Jev vs ${label}:`, ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`)];
}

/** F4: a --dry-run-only run has no verdict to give — the operator pre-flight expects a dispatch estimate. */
function dryRunLine(rows: ReplayRow[], estimatedUsd: number): string {
  const dispatch = rows.filter((r) => r.status === "dry_run").length;
  const skipReasons: Record<string, number> = {};
  for (const r of rows) {
    if (r.status === "skipped_state_too_large" || r.status === "skipped_no_anchor") {
      skipReasons[r.status] = (skipReasons[r.status] ?? 0) + 1;
    }
  }
  const skipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
  const byReason = Object.entries(skipReasons).map(([k, n]) => `${k} ${n}`).join(", ");
  return `DRY RUN — no verdict: would dispatch ${dispatch}, skipped ${skipped}${byReason ? ` (${byReason})` : ""}, estimated $${estimatedUsd.toFixed(4)}`;
}

export function formatReplayReport(rows: ReplayRow[], outcome: { spentUsd: number; estimatedUsd: number; stopped?: string }): string {
  const s = summarizeReplay(rows);
  const matched = rows.filter(matcher(rows));
  const ref = referenceModel(rows);
  const offModelRows = Object.entries(s.byModel).reduce((sum, [model, n]) => sum + (model === ref ? 0 : n), 0);
  const dispatched = rows.some((r) => r.status === "ok" || r.status === "jev_failed" || r.status === "llm_failed");
  const dryRunOnly = !dispatched && rows.some((r) => r.status === "dry_run");
  const headline = outcome.stopped
    ? `Verdict: INCOMPLETE — run stopped early (${outcome.stopped}); re-run to resume`
    : dryRunOnly
      ? dryRunLine(rows, outcome.estimatedUsd)
      : `Verdict: ${s.verdict} — ${s.verdictReason}`;
  return [
    headline,
    `Counts: eligible ${s.eligible}, matched ${s.matched}; by status ${JSON.stringify(s.byStatus)}`,
    `Cost: spent $${outcome.spentUsd.toFixed(4)} (estimated $${outcome.estimatedUsd.toFixed(4)})`,
    `Thread reconstruction is approximate: ${s.fallbackAnchors} turn(s) used the run-start fallback anchor.`,
    "",
    "Agreement vs replayed LLM label by Jev confidence:",
    ...s.thresholds.map((t) => `  ≥${t.t}: slice ${t.slice}, agreement ${pct(t.agreement)}, coverage ${pct(t.coverage)}`),
    "",
    "By language (at ≥0.7):",
    ...Object.entries(s.byLang).map(([lang, v]) => `  ${lang}: matched ${v.matched}, agreement ${pct(v.agreementAt07)}, coverage ${pct(v.coverageAt07)}`),
    "",
    "By Jev model:",
    ...Object.entries(s.byModel).map(([model, n]) => `  ${model}: ${n}`),
    ...(offModelRows > 0 ? [`${offModelRows} row(s) from a model other than ${ref} (the run's first reported model) excluded from the verdict`] : []),
    "",
    ...confusion(matched, (r) => r.llm_intent, "replayed LLM (gates)"),
    ...confusion(matched, (r) => r.recorded_intent, "recorded intent (noisy proxy, reported only)"),
    ...confusion(matched, (r) => r.observed_action, "observed action (proxy, never gates)"),
    "",
    `Top ${s.disagreements.length} disagreements (look the text up locally by turn_id):`,
    ...s.disagreements.map((d) => `  ${d.turn_id} [${d.lang}] jev=${d.jev}@${d.confidence.toFixed(2)} llm=${d.llm}`)
  ].filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}
