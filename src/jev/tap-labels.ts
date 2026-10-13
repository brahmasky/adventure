import type { TapOutcomeRow } from "../run/run-store.js";
import type { Category } from "./questions/tree.js";
import type { TreeLabel, TreeReplayRow } from "./triage-replay.js";

/**
 * Paco's taps as calibration evidence (Addition A, plan Rulings 7–8), beside his labelling sittings. A tap is a label only
 * where it names the question unambiguously: ✅ on a turn.handler lane verdict (each lane needs its category over its bar).
 * Every other tap is evidence and puts its turn on the next sitting's must-label list. Nothing here commits a calibration
 * row or moves a bar: Paco commits rows by hand (SP4 owns automatic recalibration).
 */
export const TAP_ENTRIES = ["turn.handler", "turn.gear"] as const;
export type TapEvidenceKind = "lane_right" | "lane_wrong" | "planner_right" | "planner_wrong" | "gear_right" | "gear_wrong" | "dig_deeper" | "save_undone" | "gear_too_low";
export interface TapEvidence { run_id: string | null; turn_id: string | null; kind: TapEvidenceKind; value: string; at: string }
export interface TapLabels { positive: Map<string, TreeLabel>; evidence: TapEvidence[] }
const LANE_CATEGORY: Readonly<Record<string, Category>> = { answer: "answer", lookup: "lookup", memory: "memory", status: "status" };
const MUST_LABEL: ReadonlySet<TapEvidenceKind> = new Set(["lane_wrong", "planner_wrong", "dig_deeper", "save_undone"]);

/** A code-written outcome is never a tap: only Paco's own taps (the stage 1 sender allowlist upstream) are labels or evidence. */
export function classifyTap(r: TapOutcomeRow): TapEvidenceKind | null {
  if (r.source !== "paco") return null;
  if (r.signal === "dig_deeper") return "dig_deeper";
  if (r.signal === "lesson_undone") return "save_undone";
  if (r.signal === "think_harder") return "gear_too_low";
  if (r.signal !== "review_ok" && r.signal !== "review_bad") return null;
  const ok = r.signal === "review_ok";
  if (r.entry_id === "turn.gear") return ok ? "gear_right" : "gear_wrong";
  if (r.entry_id !== "turn.handler") return null;
  if (r.verdict === "planner") return ok ? "planner_right" : "planner_wrong";
  return ok ? "lane_right" : "lane_wrong";
}

export function turnOfRows(rows: readonly TreeReplayRow[]): (run_id: string) => string | undefined {
  const m = new Map(rows.map((r) => [r.run_id, r.turn_id] as const));
  return (run_id) => m.get(run_id);
}

export function tapLabels(rows: readonly TapOutcomeRow[], turnOf: (run_id: string) => string | undefined): TapLabels {
  const positive = new Map<string, TreeLabel>(); const evidence: TapEvidence[] = [];
  for (const r of rows) {
    const kind = classifyTap(r);
    if (!kind) continue;
    const turn_id = r.run_id ? turnOf(r.run_id) ?? null : null;
    evidence.push({ run_id: r.run_id, turn_id, kind, value: r.value, at: r.created_at });
    const category = LANE_CATEGORY[r.verdict];
    if (kind === "lane_right" && turn_id && category) positive.set(turn_id, { category, by: "tap", at: r.created_at });
  }
  return { positive, evidence };
}

/** Sitting labels win on the same turn (they are Paco's considered call; a tap is a quick one). */
export function mergeLabels(sitting: ReadonlyMap<string, TreeLabel>, taps: TapLabels): Map<string, TreeLabel> {
  const out = new Map(taps.positive);
  for (const [k, v] of sitting) out.set(k, v);
  return out;
}

export function mustLabel(t: TapLabels): Set<string> {
  return new Set(t.evidence.filter((e) => MUST_LABEL.has(e.kind) && e.turn_id !== null && !t.positive.has(e.turn_id)).map((e) => e.turn_id!));
}

const count = (t: TapLabels, k: TapEvidenceKind): number => t.evidence.filter((e) => e.kind === k).length;
const values = (t: TapLabels, k: TapEvidenceKind): string => {
  const m = new Map<string, number>();
  for (const e of t.evidence.filter((x) => x.kind === k)) m.set(e.value, (m.get(e.value) ?? 0) + 1);
  return [...m].map(([v, n]) => `${v} ${n}`).join(", ") || "none";
};

export function tapLines(t: TapLabels): string[] {
  const ids = [...mustLabel(t)];
  return [
    "TAP LABELS — evidence from Paco's taps (digest ✅/❌, 🔍 Dig deeper, ↩️ Undo, 认真想), never a verdict; Paco's sitting labels win on the same turn:",
    `  positive category labels (✅ on a lane route): ${t.positive.size}`,
    `  lane ✅ ${count(t, "lane_right")} · lane ❌ ${count(t, "lane_wrong")} · planner ✅ ${count(t, "planner_right")} · planner ❌ ${count(t, "planner_wrong")} · gear ✅ ${count(t, "gear_right")} · gear ❌ ${count(t, "gear_wrong")}`,
    `  Dig deeper ${count(t, "dig_deeper")} (lanes: ${values(t, "dig_deeper")}) · Undo after a save ${count(t, "save_undone")} (reads as sets_rule = no, or a bad merge) · 认真想 after ${count(t, "gear_too_low")} (roles: ${values(t, "gear_too_low")})`,
    `  not in the replay file (re-run the replay to include): ${t.evidence.filter((e) => e.turn_id === null).length}`,
    `  label these in the next sitting (houge jev label triage): ${ids.length === 0 ? "none" : `[${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ", …" : ""}]`}`
  ];
}
