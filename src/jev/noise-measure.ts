import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { redactForJudge } from "../decisions/egress.js";
import { answerValue } from "../decisions/noise-band.js";
import type { JevAnswer, JevRequest, JevResult } from "./jev-client.js";

/**
 * Addition B's measurement: k byte-identical requests per state; per question, each request's spread (max − min of the
 * answer's value) and, over requests, the max, the 95th percentile (nearest rank) and the mean. Candidate rows carry the
 * p95 rounded up to 0.01 and an empty `approved`: Paco reviews and commits them into NOISE_BANDS (src/decisions/noise-band.ts).
 */
export interface NoiseSample { question: string; criteriaHash: string; model: string; values: readonly number[] }
export interface NoiseStat { question: string; criteriaHash: string; model: string; requests: number; maxSpread: number; p95Spread: number; meanSpread: number }

const spreadOf = (xs: readonly number[]): number => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs));
const nearestRank = (sorted: readonly number[], q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;

export function spreadStats(samples: readonly NoiseSample[]): NoiseStat[] {
  const groups = new Map<string, NoiseSample[]>();
  for (const s of samples) {
    const k = `${s.question}\u0000${s.criteriaHash}\u0000${s.model}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return [...groups.values()].map((g) => {
    const spreads = g.map((s) => spreadOf(s.values)).sort((a, b) => a - b);
    return { question: g[0]!.question, criteriaHash: g[0]!.criteriaHash, model: g[0]!.model, requests: g.length,
      maxSpread: spreads.at(-1) ?? 0, p95Spread: nearestRank(spreads, 0.95), meanSpread: spreads.reduce((a, b) => a + b, 0) / spreads.length };
  });
}

export function candidateBandRows(stats: readonly NoiseStat[], date: string): string[] {
  return stats.map((s) => JSON.stringify({ question: s.question, criteriaHash: s.criteriaHash, model: s.model, band: Math.ceil(s.p95Spread * 100 - 1e-9) / 100,
    evidence: `noise measure ${date}: ${s.requests} requests, max spread ${s.maxSpread.toFixed(3)}, p95 ${s.p95Spread.toFixed(3)}, mean ${s.meanSpread.toFixed(3)}`, approved: "" }));
}

export function formatNoiseReport(stats: readonly NoiseStat[], o: { requests: number; k: number; failed: number; models: readonly string[]; spentUsd: number; date: string }): string {
  const blockers = [...(o.failed > 0 ? [`${o.failed} failed call(s): re-run`] : []), ...(o.models.length > 1 ? [`more than one reported model (${o.models.join(", ")})`] : [])];
  const head = blockers.length > 0 ? [`INCOMPLETE — ${blockers.join("; ")}. The numbers below are NOT evidence for a band.`] : [];
  const lines = stats.map((s) => `${s.question} (${s.model}): ${s.requests} requests × ${o.k}; spread max ${s.maxSpread.toFixed(3)} · p95 ${s.p95Spread.toFixed(3)} · mean ${s.meanSpread.toFixed(3)}`);
  const rows = blockers.length > 0 ? [`NO ROWS — ${blockers.join("; ")}`]
    : ["CANDIDATE NOISE_BANDS ROWS — evidence for Paco's decision; he fills `approved` and commits them into src/decisions/noise-band.ts:", ...candidateBandRows(stats, o.date)];
  return [...head, ...lines, `spent $${o.spentUsd.toFixed(4)}`, ...rows].join("\n");
}

export interface NoiseArgs { tree: boolean; injection: boolean; approved: string | null; limit: number; k: number }

/** The --tree mode re-sends Paco's messages k times; his approval named one measurement, so the flag is the gate (plan Q1). */
export function parseNoiseArgs(argv: readonly string[]): NoiseArgs {
  const a: NoiseArgs = { tree: false, injection: false, approved: null, limit: 40, k: 5 };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    if (f === "--tree") a.tree = true;
    else if (f === "--injection") a.injection = true;
    else if (f === "--approved") a.approved = value(i++, f);
    else if (f === "--limit") a.limit = Number(value(i++, f));
    else if (f === "--k") a.k = Number(value(i++, f));
    else throw new Error(`unknown argument ${f}`);
  }
  if (a.tree === a.injection) throw new Error("pick exactly one of --tree or --injection");
  if (a.tree && (a.approved ?? "").trim() === "") throw new Error("--tree re-sends Paco's messages k times: pass --approved \"<his words, date>\" (plan Q1)");
  if (!(a.k >= 2 && a.k <= 10)) throw new Error("--k must be 2..10");
  if (!(a.limit >= 1 && a.limit <= 200)) throw new Error("--limit must be 1..200");
  return a;
}

export interface RepeatOutcome { values: Record<string, number[]>; failed: number; tokens: number; models: Set<string> }

/** k byte-identical calls. A failed call, or an ok call missing a question's answer, counts as failed: never a short sample. */
export async function repeatCalls(
  client: (req: JevRequest) => Promise<JevResult>, req: JevRequest, k: number, ids: readonly string[],
  derive: (id: string, a: JevAnswer) => Record<string, number>, pause: () => Promise<void>
): Promise<RepeatOutcome> {
  const out: RepeatOutcome = { values: Object.fromEntries(ids.map((id) => [id, []])), failed: 0, tokens: 0, models: new Set() };
  for (let n = 0; n < k; n++) {
    const r = await client(req);
    await pause();
    if (!r.ok || ids.some((id) => r.answers[id] === undefined)) { out.failed++; continue; }
    out.models.add(r.model);
    out.tokens += r.input_tokens;
    for (const id of ids) {
      const ans = r.answers[id]!;
      out.values[id]!.push(answerValue(ans));
      for (const [key, v] of Object.entries(derive(id, ans))) (out.values[key] ??= []).push(v);
    }
  }
  return out;
}

/** Every string of a request state through the egress redactor, however deep: nothing leaves un-masked. */
export function redactStrings(v: unknown): unknown {
  if (typeof v === "string") return redactForJudge(v);
  if (Array.isArray(v)) return v.map(redactStrings);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactStrings(x)]));
  return v;
}

export interface TempRoot { path: string; remove: () => void }
/** `base` is the caller's: src never reads os.tmpdir() (tests/run/daemon-tmp.test.ts); the gate script passes /tmp. */
export function createTempRoot(prefix: string, base: string): TempRoot {
  const path = mkdtempSync(join(base, prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
/** The root exists only inside fn and is removed on every exit of it. */
export async function withTempRoot<T>(prefix: string, base: string, fn: (path: string) => Promise<T>): Promise<T> {
  const root = createTempRoot(prefix, base);
  try { return await fn(root.path); } finally { root.remove(); }
}
