import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { RunStore } from "../run/run-store.js";
import type { TriageLabel, TriageReplayRow } from "./triage-replay.js";

/** Paco's labelling sitting (spec §5.9 step 2): the human labels decide the costly cells, not the action proxy. */
export function selectForLabelling(rows: TriageReplayRow[], existing: Map<string, TriageLabel>, sample: number, rng: () => number = Math.random): TriageReplayRow[] {
  const fresh = rows.filter((r) => r.status === "ok" && !existing.has(r.turn_id));
  const must = fresh.filter((r) => r.jev_lane === "memory" || r.jev_lane === "status" || r.observed_lesson_write);
  const rest = fresh.filter((r) => !must.includes(r));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
  return [...must, ...rest.slice(0, sample)];
}

const ANSWER = /^(m|s|n)(p|x)?(a|r)?$/;

export function parseLabelAnswer(line: string): { memory: boolean; status: boolean; pure: boolean | null; scope: "ask" | "research" | null } | null {
  const m = ANSWER.exec(line.trim().toLowerCase());
  if (!m) return null;
  const memory = m[1] === "m"; const status = m[1] === "s";
  return { memory, status, pure: memory && m[2] ? m[2] === "p" : null, scope: memory && m[3] ? (m[3] === "a" ? "ask" : "research") : null };
}

/**
 * The `jev` flags parseReplayArgs does not know (it rejects unknown tokens): `--sample=N` (the `=` form only) and
 * `--permute` are taken out here, the rest passes through. Throws on a malformed `--sample`.
 */
export function parseJevCliFlags(argv: string[]): { sample?: number; permute: boolean; rest: string[] } {
  let sample: number | undefined; let permute = false; const rest: string[] = [];
  for (const a of argv) {
    if (a === "--permute") { permute = true; continue; }
    if (a === "--sample" || a.startsWith("--sample=")) {
      const v = a.slice("--sample=".length);
      if (!a.startsWith("--sample=") || !/^\d+$/.test(v)) throw new Error(`bad argument "${a}": use --sample=N (with "=", N a whole number)`);
      sample = Number(v); continue;
    }
    rest.push(a);
  }
  return { ...(sample !== undefined ? { sample } : {}), permute, rest };
}

/** Terminal only: prints the stored turn text (local DB, never egress) and reads one answer per turn. Enter skips. */
export async function labelInteractively(i: { rows: TriageReplayRow[]; store: RunStore; labelsPath: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; now?: () => Date }): Promise<number> {
  mkdirSync(dirname(i.labelsPath), { recursive: true });
  const rl = createInterface({ input: i.input, output: i.output });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  let n = 0;
  try {
    i.output.write("Answer per turn: m = memory instruction, s = status question, n = neither; add p (pure) or x (mixed), a (ask) or r (research). Enter = skip.\n");
    for (const [idx, r] of i.rows.entries()) {
      const text = i.store.userTurnTextForRun(r.run_id) ?? "(text missing)";
      i.output.write(`\n[${idx + 1}/${i.rows.length}] jev=${r.jev_lane ?? "-"} lesson_write=${r.observed_lesson_write ? "yes" : "no"}\n${text}\n`);
      const a = parseLabelAnswer(await ask("> "));
      if (!a) continue;
      appendFileSync(i.labelsPath, `${JSON.stringify({ turn_id: r.turn_id, ...a, by: "paco", at: (i.now?.() ?? new Date()).toISOString() })}\n`);
      n++;
    }
  } finally { rl.close(); }
  return n;
}
