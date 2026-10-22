import { existsSync } from "node:fs";
import { join } from "node:path";
import { agreementByCheck, answerBucket, JEV_ANCHOR_MIN_ZH, laneCountsOf, type Agreement, type CheckRun,
  type DisarmableLane, type LaneLabelCount } from "../decisions/jev-version-check.js";
import { errorCode } from "../domain/error-code.js";
import { openAlertedIncident, resolveOpenIncidents } from "../run/incident-alert.js";
import type { JevAnchorLabel, JevAnchorRow, JevAnchorState, ReplayTurnRow, RunStore } from "../run/run-store.js";
import { stateHash } from "./decide.js";
import { JEV_INCIDENT_SUBJECT } from "./jev-incidents.js";
import { JEV_REQUEST_MODEL, type JevAnswer } from "./jev-client.js";
import { criteriaHash } from "./questions/types.js";
import { readDone } from "./replay-core.js";
import { loadLabels, TREE_LABEL_SINCE, treeContextFor, treeQuestions, type TreeReplayRow } from "./triage-replay.js";

/**
 * Jev version check §2.2: Paco's approved reference, imported once and never replaced. Each turn's state is rebuilt from the
 * DB with the live path's redactor (`store.redactSecretValues`, the broker's when the firewall is armed), the anchor's own
 * baselines are computed here (agreement of run A with run B, Paco's labels as per-lane counts) and the anchor model is
 * seeded `trusted` when the zh turns alone reach the minimum. Counts and enums only in every log and incident.
 */
export const ANCHOR_DIR = ".houge/jev-tree";
export const ANCHOR_FILES = { A: "replay.jsonl", B: "replay-permuted.jsonl", labels: "labels.jsonl" } as const;
export const ANCHOR_COMMAND = "houge jev anchor import";
const INCIDENT_SUBJECT = `${JEV_INCIDENT_SUBJECT}:anchor`;
const ANCHOR_INCIDENT_KINDS: ReadonlySet<string> = new Set(["jev_anchor_missing", "jev_anchor_mixed_models", "jev_anchor_insufficient"]);
const OK: ReadonlySet<string> = new Set(["ok"]);

export type AnchorStatus = "imported" | "noop" | "missing" | "mixed_models" | "insufficient";
export interface AnchorImportResult { status: AnchorStatus; message: string; counts?: AnchorCounts }
export interface AnchorCounts {
  model: string | null; turns: Record<string, number>; dropped: Record<string, number>; labels: number;
  agreement: Record<string, Agreement>; lanes: Record<"A" | "B", Record<DisarmableLane, LaneLabelCount>>;
}
interface Kept { turn: string; lang: string; a: TreeReplayRow; b: TreeReplayRow; state: Record<string, unknown>; hash: string }

const pathsOf = (dir: string): string[] => [ANCHOR_FILES.A, ANCHOR_FILES.B, ANCHOR_FILES.labels].map((f) => join(dir, f));

/** One run's usable rows by turn: latest line per key, `ok` only, every question answered under today's hashes (A) or the permuted ones (B). */
function validRows(file: string, permute: boolean): { rows: Map<string, TreeReplayRow>; invalid: Set<string> } {
  const qs = treeQuestions(permute);
  const suffix = permute ? ":perm" : "";
  const rows = new Map<string, TreeReplayRow>(); const invalid = new Set<string>();
  for (const [key, raw] of readDone(file, OK)) {
    const r = raw as unknown as TreeReplayRow;
    const turn = suffix && key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;
    const good = typeof r.model === "string" && r.model !== "" && r.model !== JEV_REQUEST_MODEL && typeof r.state_hash === "string" && r.answers !== undefined && r.criteria_hashes !== undefined
      && qs.every((q) => r.criteria_hashes?.[q.id] === criteriaHash(q) && answerBucket(q, r.answers?.[q.id]) !== null) && (!suffix || key.endsWith(suffix));
    if (good) rows.set(turn, r); else invalid.add(turn);
  }
  return { rows, invalid };
}

/** Rebuild the state exactly as the replay did and as the live path would send it; "state_mismatch" when it differs from the replay's hash. */
function rebuild(store: RunStore, env: NodeJS.ProcessEnv, t: ReplayTurnRow, replayHash: string): { state: Record<string, unknown>; hash: string } | "state_mismatch" {
  const plain = treeContextFor(store, env, t).built;
  if (!plain.ok || stateHash(plain.state) !== replayHash) return "state_mismatch";
  const live = treeContextFor(store, env, t, (s) => store.redactSecretValues(s)).built;
  return live.ok ? { state: live.state, hash: stateHash(live.state) } : "state_mismatch";
}

function selectTurns(store: RunStore, env: NodeJS.ProcessEnv, A: ReturnType<typeof validRows>, B: ReturnType<typeof validRows>): { kept: Kept[]; dropped: Record<string, number> } {
  const dbTurns = new Map(store.listReplayTurns({ sinceIso: TREE_LABEL_SINCE }).filter((t) => store.runSource(t.run_id) === "telegram").map((t) => [t.turn_id, t]));
  const dropped: Record<string, number> = {};
  const drop = (why: string): void => { dropped[why] = (dropped[why] ?? 0) + 1; };
  const kept: Kept[] = [];
  const all = new Set([...A.rows.keys(), ...B.rows.keys(), ...A.invalid, ...B.invalid]);
  for (const turn of [...all].sort()) {
    const a = A.rows.get(turn); const b = B.rows.get(turn); const t = dbTurns.get(turn);
    if (!a) { drop(A.invalid.has(turn) ? "invalid_a" : "no_a"); continue; }
    if (!b) { drop(B.invalid.has(turn) ? "invalid_b" : "no_b"); continue; }
    if (!t) { drop("no_turn"); continue; }
    const built = a.state_hash === b.state_hash ? rebuild(store, env, t, a.state_hash) : "state_mismatch";
    if (built === "state_mismatch") { drop("state_mismatch"); continue; }
    kept.push({ turn, lang: a.lang, a, b, state: built.state, hash: built.hash });
  }
  return { kept, dropped };
}

/** The anchor's own baselines (spec §2.2): agreement(A, B) per question and for the route, and Paco's labels as per-lane counts for A and for B. */
function baselines(kept: Kept[], labels: Map<string, { category: string }>): Pick<AnchorCounts, "agreement" | "lanes"> {
  const run = (r: "a" | "b"): CheckRun => new Map(kept.map((k) => [k.turn, { state: k.state, answers: k[r].answers as Record<string, JevAnswer> }]));
  const [A, B] = [run("a"), run("b")];
  const label = (turn: string): string | undefined => labels.get(turn)?.category;
  return { agreement: agreementByCheck(A, B), lanes: { A: laneCountsOf(A, label), B: laneCountsOf(B, label) } };
}

const rowsOf = (k: Kept, r: TreeReplayRow, run: "A" | "B"): JevAnchorRow[] =>
  treeQuestions(run === "B").map((q) => ({ turn_id: k.turn, lang: k.lang, question_id: q.id, criteria_hash: criteriaHash(q), run,
    answer_json: JSON.stringify(r.answers?.[q.id]), model: r.model as string }));

function incident(store: RunStore, kind: string, detail: Record<string, unknown>, now?: string): void {
  openAlertedIncident(store, { kind, subject: INCIDENT_SUBJECT, detail: { ...detail, command: ANCHOR_COMMAND }, ...(now ? { now } : {}) });
}

/**
 * Import the anchor from `dir`. A non-empty anchor is a no-op; missing files, mixed models or too few zh turns write nothing
 * (so a fixed file can be imported later) and open one alerted incident naming the command; otherwise everything lands in one transaction.
 */
export function importJevAnchor(store: RunStore, dir: string, opts: { env?: NodeJS.ProcessEnv; now?: string } = {}): AnchorImportResult {
  if (!store.anchorEmpty()) return { status: "noop", message: "the anchor is already imported; it is never replaced" };
  const files = pathsOf(dir);
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    incident(store, "jev_anchor_missing", { missing: missing.length, paths: files }, opts.now);
    return { status: "missing", message: `anchor files missing (${missing.length} of ${files.length}); nothing armed. Expected: ${files.join(", ")}. Run ${ANCHOR_COMMAND} once they exist` };
  }
  const A = validRows(files[0]!, false); const B = validRows(files[1]!, true);
  const { kept, dropped } = selectTurns(store, opts.env ?? process.env, A, B);
  const models = new Set(kept.flatMap((k) => [k.a.model, k.b.model]).filter((m): m is string => typeof m === "string"));
  const turns: Record<string, number> = {};
  for (const k of kept) turns[k.lang] = (turns[k.lang] ?? 0) + 1;
  const model = models.size === 1 ? [...models][0]! : null; // the request alias never counts: validRows drops its rows
  const labels = new Map([...loadLabels(files[2]!)].filter(([id]) => kept.some((k) => k.turn === id)));
  const counts: AnchorCounts = { model, turns, dropped, labels: labels.size, ...baselines(kept, labels) };
  if (models.size > 1) { // mixed models seed nothing (task-4 brief; spec §2.2 says insufficient). Zero models is the insufficient case below.
    incident(store, "jev_anchor_mixed_models", { models: models.size, turns: kept.length }, opts.now);
    return { status: "mixed_models", message: `the anchor rows report ${models.size} models; nothing imported or armed`, counts };
  }
  return seedAnchor(store, { kept, labels, counts, model, now: opts.now ?? new Date().toISOString() });
}

function seedAnchor(store: RunStore, i: { kept: Kept[]; labels: Map<string, { category: string; by: string; at: string }>; counts: AnchorCounts; model: string | null; now: string }): AnchorImportResult {
  const { kept, counts, model, now } = i;
  const zh = counts.turns.zh ?? 0;
  if (model === null || zh < JEV_ANCHOR_MIN_ZH) {
    const cur = model === null ? undefined : (store.noteJevModel(model, now), store.getJevModel(model));
    if (model !== null && cur && cur.state !== "insufficient" && cur.state !== "trusted" && cur.state !== "accepted") store.setJevModelState(model, cur.state, "insufficient", JSON.stringify({ zh_turns: zh }), now);
    incident(store, "jev_anchor_insufficient", { zh_turns: zh, need: JEV_ANCHOR_MIN_ZH }, now);
    return { status: "insufficient", message: `only ${zh} zh paired turns (need ${JEV_ANCHOR_MIN_ZH}); the model is insufficient, nothing armed`, counts };
  }
  const states: JevAnchorState[] = kept.map((k) => ({ turn_id: k.turn, lang: k.lang, state_json: JSON.stringify(k.state), state_hash: k.hash }));
  const labels: JevAnchorLabel[] = [...i.labels].map(([turn_id, l]) => ({ turn_id, category: l.category, by: l.by, at: l.at }));
  const rows = kept.flatMap((k) => [...rowsOf(k, k.a, "A"), ...rowsOf(k, k.b, "B")]);
  const done = store.importAnchor({ rows, states, labels, meta: { baseline: JSON.stringify(counts) }, trustedModel: model, now });
  if (done) resolveOpenIncidents(store, ANCHOR_INCIDENT_KINDS, INCIDENT_SUBJECT, now);
  return done ? { status: "imported", message: `anchor imported: ${kept.length} turns, model seeded trusted`, counts }
    : { status: "noop", message: "the anchor is already imported; it is never replaced" };
}

/** Daemon boot: import when the anchor is empty. A failure is logged with its code and boot continues (the tree just stays unarmed). */
export function bootJevAnchor(store: RunStore, dir: string = ANCHOR_DIR, log: (l: string) => void = (l) => console.error(l)): AnchorImportResult | undefined {
  try {
    if (!store.anchorEmpty()) return undefined;
    const r = importJevAnchor(store, dir);
    log(`jev anchor: ${r.status}: ${r.message}`);
    return r;
  } catch (e) {
    log(`jev anchor: boot import failed: ${errorCode(e)}`);
    return undefined;
  }
}
