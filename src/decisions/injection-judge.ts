import { decide as jevDecide, persistDecisionRows, type Decision, type JevDecisionInsert, type SkipReason } from "../jev/decide.js";
import { langOf } from "../jev/intent-question.js";
import type { JevAnswer, JevRequest, JevResult } from "../jev/jev-client.js";
import { openAlertedIncident } from "../run/incident-alert.js";
import type { RunStore } from "../run/run-store.js";
import { decide, message } from "./decide.js";
import { passageBlock, pathBlocked, SECRET_MASK, splitEgress, splitPassages, type EgressBlock, type EgressPassage } from "./egress.js";
import {
  BATCH_SIZE, FRAME_CLOSE, FRAME_OPEN, INJECTION_BAR_P, NOT_CHECKED_CLOSE, NOT_CHECKED_OPEN, WITHHELD_UNJUDGED_TEXT, INJECTION_ROW_KEY, INJECTION_TEMPLATE_HASH, INJECTION_THRESHOLD_VERSION, INJECTION_TOTAL_MS,
  injectionQuestion, looksInjected, PASSAGE_CHARS, TOOL_INJECTION, TOOL_INJECTION_ID, WITHHELD_TEXT, type InjectionDetail, type InjectionState, type InjectionVerdict
} from "./entries/tool-injection.js";
import { bandFor, nearBar, NOISE_BANDS, type NoiseBand } from "./noise-band.js";
import { storeRecorder } from "./record.js";
import type { DecideResult, DecisionRecorder, FallbackReason, Reask, RungResult } from "./types.js";

/**
 * The judge for one tool result (spec §7.1): mask the whole text (§7.0), split into passages on the masked text, mark the
 * passages that may not leave (per-passage content check on the raw twin, or every passage for a credential path), apply
 * mu's floor on the raw twin, then ask Jev for the rest through the runner (decide → record), and give back what the model
 * may read. A clean result comes back byte-identical; only a withheld passage (a note) or a framed local one (its masked
 * form) changes (plan Ruling 2).
 */
export type InjectionSource = "shell" | "web_search" | "http_fetch" | "gmail_read" | "google_api" | "read";
/** Where the text came from, said in words to the judge (mu's `source`). */
const SOURCE_LABEL: Readonly<Record<InjectionSource, string>> = { shell: "the output of a shell command", web_search: "web search results",
  http_fetch: "a fetched web page", gmail_read: "an email", google_api: "a calendar or Google API response", read: "a file the assistant read" };
/** A re-ask needs at least this much of the 3 s budget left (Addition B: never past the bound). */
const REASK_MIN_MS = 1_500;

/** `outside`: the text came from a wall tool or network shell output (controller ruling 1: a passage that may not leave is withheld, not framed). */
export interface JudgeInput {
  run_id: string; tool_call_id: string; source: InjectionSource; text: string; outside: boolean; paths?: readonly string[]; extracted?: readonly string[];
  /** Values the caller holds and the broker does not: the per-spawn bridge token (senior S-R3-2). */
  known?: readonly string[];
  /** The mail extract channel: a link's token-like path segments are masked too (Ruling 25). */
  linkTokens?: boolean;
  /** 2b-i (ruling 9): true when the turn's trust already finalised; the row is then armed_mode "late". */
  late?: () => boolean;
}
export interface JudgeOutcome {
  /** `withheld` counts every withheld passage; `withheldUnjudged` those withheld only because, from outside, they held credential material. */
  text: string; verdict: InjectionVerdict; withheld: number; withheldUnjudged: number; framed: number;
  /** Outside passages whose judgement was lost, delivered inside the not-checked frame (security final I-2: the turn goes hostile). */
  notChecked: number;
  /** Passages that went to Jev, and how many of them got no answer (a lost judgement: Task 12 raises judge_timeout). */
  sent: number; unanswered: number; skipped: boolean; blocked: EgressBlock | null; decisionId: string | null;
  /** Mirrored masks in the planner copy (2b-R8): a local read with masked > 0 makes its paths ask on edit. */
  masked: number;
}
export type InjectionJudge = (i: JudgeInput) => Promise<JudgeOutcome>;
export interface JudgeDeps { store: RunStore; client: (r: JevRequest) => Promise<JevResult>; home: string; bands?: readonly NoiseBand[]; env?: NodeJS.ProcessEnv; clock?: () => number }
/** What the local checks need: the broker's redactor (through the store) and $HOME for the credential paths. */
export type LocalDeps = Pick<JudgeDeps, "store" | "home">;

interface BatchResult { indices: readonly number[]; ps: readonly number[] | null; firstPs: readonly number[] | null; reask?: Reask["kind"]; rows: JevDecisionInsert[]; skip?: SkipReason }
interface Track { attempted: number; batches: BatchResult[] }

/**
 * Spec §7.0's order (Rev 4, controller ruling 1): mask the WHOLE text, then split on the masked text; the floor and the
 * content check read each passage's raw twin, locally. A failed broker alignment blocks every passage (fail closed).
 */
function stateOf(d: LocalDeps, i: JudgeInput): InjectionState {
  const opts = { brokerRedact: (x: string) => d.store.redactSecretValues(x), known: i.known ?? [], extracted: i.extracted ?? [], linkTokens: i.linkTokens === true };
  const split = splitEgress(i.text, PASSAGE_CHARS, opts);
  const pieces: EgressPassage[] = split ?? splitPassages(i.text, PASSAGE_CHARS).map((raw) => ({ raw, out: SECRET_MASK, planner: SECRET_MASK }));
  const all: EgressBlock | null = split === null ? "unaligned" : pathBlocked(i.paths ?? [], d.home) ? "credential_path" : null;
  const kinds = pieces.map((p) => all ?? p.block ?? passageBlock(p.raw));
  const passages = pieces.map((p) => p.raw);
  return { passages, redacted: pieces.map((p) => p.out), planner: pieces.map((p) => p.planner), floorHits: passages.flatMap((p, k) => (looksInjected(p) ? [k] : [])),
    blocked: kinds.flatMap((b, k) => (b ? [k] : [])), blockKind: kinds.find((b) => b !== null) ?? null, outside: i.outside,
    masked: split === null ? pieces.length : pieces.reduce((n, p) => n + (p.masked ?? 0), 0) };
}

/** Ruling 9: a row written after the turn finalised is `late` (the one producer of RecordedArmedMode "late"). */
function lateAware(inner: DecisionRecorder, late: (() => boolean) | undefined): DecisionRecorder {
  return { record: (entry, r, ctx) => inner.record(entry, late?.() ? { ...r, armedMode: "late" } : r, ctx) };
}

export function createInjectionJudge(d: JudgeDeps): InjectionJudge {
  return async (i) => {
    const state = stateOf(d, i);
    const track: Track = { attempted: 0, batches: [] };
    const r = await decide(TOOL_INJECTION, state, { run_id: i.run_id, tool_call_id: i.tool_call_id, recorder: lateAware(storeRecorder(d.store, d.env ? { env: d.env } : {}), i.late),
      exec: { system_one: () => askPassages(d, i, state, track) } });
    persistRows(d, track.batches, r.decisionId);
    const out = outcomeOf(i.text, state, r, track);
    // Paco 2026-10-14: a lost judgement pages nothing (record.ts); it is logged here and counted in the digest
    if (out.unanswered > 0) console.error(`decisions: ${TOOL_INJECTION_ID} judgement lost (${out.unanswered} of ${out.sent} passages); not paged`);
    return out;
  };
}

/**
 * The bridge's fallback when the judge throws (spec §7.1 "Fail: the floor's answer"; codex B2, Ruling 28): the same floor,
 * content and path checks as the normal path, outside blocked passages withheld unjudged, local ones framed. Never sends
 * anything; every passage counts unanswered, so the turn rises (judge_timeout).
 */
export function localOutcome(d: LocalDeps, i: JudgeInput): JudgeOutcome {
  const s = stateOf(d, i);
  const v = deliver(i.text, s, new Set(s.floorHits), new Set(unasked(s)));
  const verdict: InjectionVerdict = v.withheld > 0 ? "withhold" : v.framed > 0 ? "frame" : "pass";
  return { ...v, verdict, sent: 0, unanswered: s.passages.length, skipped: true, blocked: s.blockKind, decisionId: null, masked: s.masked };
}

const trailing = (p: string): string => /\s*$/.exec(p)?.[0] ?? "";
const withheldNote = (p: string): string => `${WITHHELD_TEXT}${trailing(p)}`;
const framedNote = (p: string): string => `${FRAME_OPEN}\n${p.trimEnd()}\n${FRAME_CLOSE}${trailing(p)}`;
const notCheckedNote = (p: string): string => `${NOT_CHECKED_OPEN}\n${p.trimEnd()}\n${NOT_CHECKED_CLOSE}${trailing(p)}`;
/** The passages that go to Jev: neither the floor nor the content check decided them locally. */
const unasked = (s: InjectionState): number[] => s.passages.map((_, k) => k).filter((k) => !s.floorHits.includes(k) && !s.blocked.includes(k));
const chunk = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, k) => xs.slice(k * n, k * n + n));

async function askPassages(d: JudgeDeps, i: JudgeInput, s: InjectionState, track: Track): Promise<RungResult<InjectionVerdict, InjectionDetail>> {
  const todo = unasked(s);
  track.attempted = todo.length; // before any await: a runner-level timeout must still count these as unanswered
  if (todo.length === 0) return { verdict: "pass", reason: "jev_passed", detail: { withheld: [], asked: false } };
  const clock = d.clock ?? Date.now;
  const deadline = clock() + INJECTION_TOTAL_MS;
  const results = await Promise.all(chunk(todo, BATCH_SIZE).map((g) => askBatch(d, i, s, g, deadline)));
  track.batches.push(...results);
  return combine(results);
}

const noulOf = (a: JevAnswer | undefined): number => (a?.type === "noul" ? a.noul : 0);

function nearInjection(bands: readonly NoiseBand[]): (answers: Record<string, JevAnswer>) => boolean {
  return (answers) => {
    const band = bandFor("injected", INJECTION_TEMPLATE_HASH, bands);
    return band !== undefined && Object.values(answers).some((a) => a.type === "noul" && nearBar(a.noul, [INJECTION_BAR_P], band));
  };
}

/** Controller ruling 5: over tool input the re-ask can only tighten — each passage takes the more cautious (higher) of the two calls. */
function cautiousPs(dec: Extract<Decision, { status: "answered" }>, ids: readonly string[]): { ps: number[]; firstPs: number[]; reask?: Reask["kind"] } {
  const first = (dec.first ?? dec.answers);
  const firstPs = ids.map((id) => noulOf(first[id]));
  if (dec.reask === "mean" && dec.second) return { ps: ids.map((id, j) => Math.max(firstPs[j]!, noulOf(dec.second![id]))), firstPs, reask: "max" };
  return { ps: firstPs, firstPs, ...(dec.reask === "failed" ? { reask: "failed" as const } : {}) };
}

async function askBatch(d: JudgeDeps, i: JudgeInput, s: InjectionState, indices: readonly number[], deadline: number): Promise<BatchResult> {
  const clock = d.clock ?? Date.now;
  const questions = indices.map((_, j) => injectionQuestion(`p${j + 1}`, `i${j + 1}`));
  const state: Record<string, string> = { source: SOURCE_LABEL[i.source] };
  indices.forEach((k, j) => { state[`p${j + 1}`] = s.redacted[k]!; }); // only the redacted passage leaves
  const dec = await jevDecide({ point: "injection", run_id: i.run_id, state, questions, lang: langOf(i.text.slice(0, 2_000)), client: d.client, store: d.store,
    thresholdVersion: INJECTION_THRESHOLD_VERSION, rowKey: INJECTION_ROW_KEY, boundMs: deadline - clock(),
    reask: { near: nearInjection(d.bands ?? NOISE_BANDS), allowed: () => deadline - clock() >= REASK_MIN_MS, boundMs: () => deadline - clock() } });
  if (dec.status === "skipped") return { indices, ps: null, firstPs: null, rows: [], skip: dec.reason };
  return { indices, rows: dec.rows, ...cautiousPs(dec, questions.map((q) => q.id)) };
}

/** Same mapping as core/turn-handler-ladder.ts fallbackOfSkip (kept here: src/decisions never imports the core glue). */
function skipToFallback(reason: SkipReason | undefined): FallbackReason {
  if (reason === "timeout") return "timeout";
  if (reason === "parse" || reason === "malformed_question") return "parse";
  return "outage";
}

function combine(results: readonly BatchResult[]): RungResult<InjectionVerdict, InjectionDetail> {
  const answered = results.filter((b) => b.ps !== null);
  if (answered.length === 0) return { failed: skipToFallback(results[0]?.skip), reason: "jev_skipped" };
  const withheld: number[] = [];
  let top = { p: -1, k: -1, first: 0, reask: undefined as Reask["kind"] | undefined };
  for (const b of answered) b.indices.forEach((k, j) => {
    const p = b.ps![j]!;
    if (p > INJECTION_BAR_P) withheld.push(k);
    if (p > top.p) top = { p, k, first: b.firstPs![j]!, reask: b.reask };
  });
  const reason = answered.length < results.length ? "jev_partial" : withheld.length > 0 ? "jev_withheld" : "jev_passed";
  return { verdict: withheld.length > 0 ? "withhold" : "pass", reason, p: top.p, pIndex: top.k, detail: { withheld, asked: true },
    ...(top.reask ? { reask: { kind: top.reask, pFirst: top.first } } : {}) };
}

/** The first call's raw rows under the template key, linked to the decision (spec §5.2). A failed write pages; the verdict stands. */
function persistRows(d: JudgeDeps, batches: readonly BatchResult[], decisionId: string | null): void {
  const rows = batches.flatMap((b) => b.rows);
  if (rows.length === 0) return;
  try {
    persistDecisionRows(d.store, rows, "act", `${INJECTION_THRESHOLD_VERSION}:${INJECTION_BAR_P}`, decisionId);
  } catch (e) {
    console.error(`decisions: ${TOOL_INJECTION_ID} jev rows not written: ${message(e)}`);
    try { openAlertedIncident(d.store, { kind: "decision_record_failed", subject: TOOL_INJECTION_ID, detail: { entry: TOOL_INJECTION_ID }, ...(d.env ? { env: d.env } : {}) }); }
    catch (e2) { console.error(`decisions: decision_record_failed could not open: ${message(e2)}`); }
  }
}

/**
 * Per passage: the planner copy (invariant I1: every mask Jev saw, except hex- or digit-only shape masks and the extract link field, is in it), except a withheld
 * passage (a note) or a framed local one (its masked form, framed). A result with no mask in any planner copy and nothing
 * withheld or framed comes back byte-identical.
 */
function deliver(raw: string, s: InjectionState, judged: ReadonlySet<number>, lost: ReadonlySet<number>): Pick<JudgeOutcome, "text" | "withheld" | "withheldUnjudged" | "framed" | "notChecked"> {
  const unjudged = new Set(s.outside ? s.blocked.filter((k) => !judged.has(k)) : []);   // outside: withheld, never shown (ruling 1)
  const framed = new Set(s.outside ? [] : s.blocked.filter((k) => !judged.has(k)));     // local: framed, masked
  const unchecked = new Set(s.outside ? [...lost].filter((k) => !judged.has(k)) : []);  // outside, Jev never answered: framed (I-2)
  const note = (p: string, k: number): string => (judged.has(k) ? withheldNote(p) : unjudged.has(k) ? `${WITHHELD_UNJUDGED_TEXT}${trailing(p)}`
    : framed.has(k) ? framedNote(s.redacted[k]!) : unchecked.has(k) ? notCheckedNote(s.planner[k]!) : s.planner[k]!);
  const touched = judged.size + unjudged.size + framed.size + unchecked.size > 0 || s.planner.some((t, k) => t !== s.passages[k]);
  return { text: touched ? s.passages.map(note).join("") : raw, withheld: judged.size + unjudged.size, withheldUnjudged: unjudged.size, framed: framed.size,
    notChecked: unchecked.size };
}

function outcomeOf(raw: string, s: InjectionState, r: DecideResult<InjectionVerdict, InjectionDetail>, track: Track): JudgeOutcome {
  const jev = r.walk.find((o) => o.kind === "system_one")?.result ?? null;
  const skipped = jev !== null && "failed" in jev;
  const fromJev = jev !== null && "verdict" in jev && r.verdict === "withhold" ? (jev.detail?.withheld ?? []) : [];
  // the passages Jev never answered: every one sent when the rung failed (or never finished), else the lost batches'
  const lost = skipped ? unasked(s).slice(0, track.attempted) : track.batches.flatMap((b) => (b.ps === null ? [...b.indices] : []));
  return { ...deliver(raw, s, new Set([...s.floorHits, ...fromJev]), new Set(lost)), verdict: r.verdict, sent: track.attempted,
    unanswered: lost.length, skipped, blocked: s.blockKind, decisionId: r.decisionId, masked: s.masked };
}
