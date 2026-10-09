import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { RunStore } from "../run/run-store.js";
import { CATEGORIES, type Category } from "./questions/tree.js";
import { TREE_LABEL_SINCE, type TreeLabel, type TreeReplayRow } from "./triage-replay.js";

const jevChoice = (r: TreeReplayRow): string | null => { const a = r.answers?.category; return a?.type === "choice" ? a.choice : null; };

/**
 * Paco's labelling sitting (spec §7: "the labelling CLI stays for tuning the bars"). Must-label: every turn the tool
 * proxy cannot judge, and every turn the proxy or Jev puts in a no-planner lane (a wrong one swallows a turn); then a
 * random sample of the rest. Already-labelled turns are never asked again.
 */
export function selectForLabelling(rows: TreeReplayRow[], existing: Map<string, TreeLabel>, sample: number, rng: () => number = Math.random): TreeReplayRow[] {
  const fresh = rows.filter((r) => r.status === "ok" && !existing.has(r.turn_id));
  const lane = (c: string | null) => c === "memory" || c === "status";
  const must = fresh.filter((r) => r.proxy === null || lane(r.proxy) || lane(jevChoice(r)));
  const rest = fresh.filter((r) => !must.includes(r));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
  return [...must, ...rest.slice(0, sample)];
}

/** A category name or an unambiguous prefix of one ("mach" → machine_task); anything else is no label, never a guess. */
export function parseLabelAnswer(line: string): Category | null {
  const t = line.trim().toLowerCase();
  if (!t) return null;
  const exact = CATEGORIES.find((c) => c === t);
  if (exact) return exact;
  const hits = CATEGORIES.filter((c) => c.startsWith(t));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * The `jev` flags parseReplayArgs does not know (it rejects unknown tokens): `--sample=N` (the `=` form only) and
 * `--permute` are taken out here, the rest passes through. Throws on a malformed `--sample`.
 */
export function parseJevCliFlags(argv: string[]): { sample?: number; permute: boolean; rest: string[] } {
  let sample: number | undefined; let permute = false; const rest: string[] = [];
  for (const a of argv) {
    if (a === "--permute") { permute = true; continue; }
    if (a === "--since" || a.startsWith("--since=")) {
      throw new Error(`--since is not supported for jev … triage: the universe is every Telegram turn since ${TREE_LABEL_SINCE}`);
    }
    if (a === "--sample" || a.startsWith("--sample=")) {
      const v = a.slice("--sample=".length);
      if (!a.startsWith("--sample=") || !/^\d+$/.test(v)) throw new Error(`bad argument "${a}": use --sample=N (with "=", N a whole number)`);
      sample = Number(v); continue;
    }
    rest.push(a);
  }
  return { ...(sample !== undefined ? { sample } : {}), permute, rest };
}

/** Terminal only: prints the stored turn text (local DB, never egress) and reads one category per turn. Enter skips. */
export async function labelInteractively(i: { rows: TreeReplayRow[]; store: RunStore; labelsPath: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; now?: () => Date }): Promise<number> {
  mkdirSync(dirname(i.labelsPath), { recursive: true });
  const rl = createInterface({ input: i.input, output: i.output });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  let n = 0;
  try {
    i.output.write(`Answer per turn with a category (or an unambiguous prefix): ${CATEGORIES.join(", ")}. Enter = skip.\n`);
    for (const [idx, r] of i.rows.entries()) {
      const text = i.store.userTurnTextForRun(r.run_id) ?? "(text missing)";
      i.output.write(`\n[${idx + 1}/${i.rows.length}] jev=${jevChoice(r) ?? "-"} proxy=${r.proxy ?? "unlabelled"} (${r.proxy_rule})\n${text}\n`);
      const category = parseLabelAnswer(await ask("> "));
      if (!category) continue;
      appendFileSync(i.labelsPath, `${JSON.stringify({ turn_id: r.turn_id, category, by: "paco", at: (i.now?.() ?? new Date()).toISOString() })}\n`);
      n++;
    }
  } finally { rl.close(); }
  return n;
}
