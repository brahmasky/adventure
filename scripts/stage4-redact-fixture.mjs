// The redaction corpus's machinery (spec 2026-10-29 §6 item 5): a live-text reader that only ever touches a VACUUM copy, one fresh
// firewall-armed (or bare) store and run per (text, wrapper), the full-DB TEXT scan, and an oracle written independently of the
// redactor under test (split/join over the harness's fake values, trim, cut at 3,900). Not a corpus: the CLI loads stage4-corpora/*.mjs only.
// Nothing here prints a text; the live texts live in memory for the run and the VACUUM copy is deleted right after reading.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FAKE_VALUES, SetupError, mkStore } from "./stage4-diff-lib.mjs";
import { makeRun } from "./stage4-bind-fixture.mjs";

export const MARK = "«redacted»";
export const TAIL = "\n\n… (truncated)";
export const CHAT_MAX = 3900;
export const WRAPPERS = ["final", "failure", "evolution"];
export const SEAM = { final: "final_report", failure: "failure_report", evolution: "evolution_report" };
export const SHORT = FAKE_VALUES.TYPESAFE_API_KEY; // 5 chars, below MIN_REDACTABLE_SECRET_LENGTH
export const MASKABLE = Object.values(FAKE_VALUES).filter((v) => v.length >= 6);
export const pad = (n, ch = "x") => ch.repeat(n);

const cut = (t) => (t.length <= CHAT_MAX ? t : `${t.slice(0, CHAT_MAX)}${TAIL}`);
/** The stored bytes written independently of the redactor: mask (longest first), trim, cut. `armed: false` skips the mask. */
export function oracleStored(text, armed) {
  let out = text;
  if (armed) for (const v of [...MASKABLE].sort((a, b) => b.length - a.length)) out = out.split(v).join(MARK);
  return cut(out.trim());
}
/** True when a known value (>= 6 chars) is in the text, i.e. when a masking attempt must leave a `masked` row. */
export const hasSecret = (text) => MASKABLE.some((v) => text.includes(v));

/** Every non-empty string `text` of a final_report outbox row, read from a VACUUM copy of the live DB (never the live file itself). */
export function readLiveTexts(liveDb, copyPath) {
  const src = new DatabaseSync(liveDb, { readOnly: true });
  try { src.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`); } catch { throw new SetupError("VACUUM INTO the live DB failed (detail withheld)"); } finally { src.close(); }
  const db = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT json_extract(payload_json, '$.text') AS t FROM notification_outbox WHERE intent_type = 'final_report' ORDER BY created_at, notification_id`).all();
    return rows.map((r) => r.t).filter((t) => typeof t === "string");
  } finally { db.close(); rmSync(copyPath, { force: true }); }
}

const send = (store, w, run_id, text) => w === "final" ? store.enqueueFinalReportNotification(run_id, { text, report_path: "/tmp/r.md" })
  : w === "failure" ? store.enqueueFailureNotification(run_id, text) : store.enqueueEvolutionReportNotification(run_id, "self_write_propose", { text });
export const payloadFor = (w, text) => (w === "final" ? { text, report_path: "/tmp/r.md" } : { text });

const colCache = new Map(); // dist dir -> [[table, column]] (the schema does not vary between stores of one dist)
function textColumns(d, db) {
  if (colCache.has(d.dir)) return colCache.get(d.dir);
  const out = [];
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()) {
    for (const c of db.prepare(`PRAGMA table_info("${name}")`).all()) if (/TEXT|CHAR|CLOB|^$/i.test(c.type)) out.push([name, c.name]);
  }
  colCache.set(d.dir, out);
  return out;
}
/** Rows containing any needle (also its JSON-escaped spelling, which payload_json stores), over every TEXT column of every table; keyed "table.column". */
export function scan(d, db, values) {
  const needles = [...new Set(values.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]))];
  const where = needles.map(() => "instr(CAST(\"@C\" AS TEXT), ?) > 0").join(" OR ");
  const hits = {};
  for (const [table, col] of textColumns(d, db)) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where.split("@C").join(col)}`).get(...needles).n;
    if (n > 0) hits[`${table}.${col}`] = n;
  }
  return hits;
}

const BOOM = `CREATE TRIGGER t BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'boom'); END`;
function runScenario(store, item, run_id) {
  const w = item.wrapper;
  if (item.scenario === "duplicate") return [send(store, w, run_id, item.text), send(store, w, run_id, item.text)];
  if (item.scenario === "conflict") return [send(store, w, run_id, item.text), send(store, w, run_id, item.secondText)];
  if (item.scenario === "insert_failure") {
    store.db.exec(BOOM);
    try { send(store, w, run_id, item.text); return [{ threw: "no error" }]; } catch (e) { return [{ threw: e instanceof Error ? e.message : String(e) }]; }
  }
  if (item.scenario === "outer_rollback") {
    store.db.exec("BEGIN");
    try { return [send(store, w, run_id, item.text)]; } finally { store.db.exec("ROLLBACK"); }
  }
  return [send(store, w, run_id, item.text)];
}

/** Outbox rows seen per dist and wrapper, over the single-call items only (the per-wrapper pin of the brief). */
export const tally = {};
let seq = 0;
/**
 * One fresh in-memory store and run per item. The projection holds the wrapper results, the outbox rows, the evolution chat turns,
 * the decisions rows and the full-DB scan; the run id is replaced by RUN. Keys that vary run to run are removed by STRIP_KEYS alone.
 */
export function projectItem(d, item) {
  const store = mkStore(d, item.firewall ? "firewall" : "bare");
  try {
    const run_id = makeRun(d, store, "telegram", ++seq, false);
    const results = runScenario(store, item, run_id);
    const outbox = store.db.prepare(`SELECT payload_json, payload_hash, state FROM notification_outbox WHERE run_id = ? AND intent_type = 'final_report'`).all(run_id);
    const chat = store.db.prepare(`SELECT text FROM chat_turns WHERE run_id = ? AND role = 'assistant'`).all(run_id).map((r) => r.text);
    const decisions = store.db.prepare(`SELECT entry_id, verdict, reason_code, rung, armed_mode, tool_call_id, run_id FROM decisions ORDER BY created_at, decision_id`).all()
      .map((r) => ({ ...r, run_id: r.run_id === run_id ? "RUN" : r.run_id }));
    const hits = scan(d, store.db, item.needles ?? MASKABLE);
    if (item.scenario === "single") { const t = (tally[d.dir] ??= { final: 0, failure: 0, evolution: 0 }); t[item.wrapper] += outbox.length; }
    return JSON.parse(JSON.stringify({ results, outbox, chat, decisions, hits }).split(run_id).join("RUN"));
  } finally { try { store.close(); } catch { /* a closed handle is not a finding */ } }
}

/** New-side facts of one item, throwing a text-free message for the first failure group. */
export function checkItem(d, item, proj) {
  const bad = [];
  const w = item.wrapper;
  const stored = item.expected ?? oracleStored(item.text, item.firewall);
  const rows = proj.decisions.filter((r) => r.entry_id === "secret.redact");
  const wantMasked = item.firewall && hasSecret(item.text) ? 1 : 0;
  const maskedRow = { entry_id: "secret.redact", verdict: "masked", reason_code: SEAM[w], rung: "rule", armed_mode: "on", tool_call_id: null, run_id: "RUN" };
  const attempts = { single: 1, duplicate: 2, conflict: 2, insert_failure: 1, outer_rollback: 0 }[item.scenario];
  const wantRows = item.scenario === "outer_rollback" ? 0 : item.scenario === "conflict" ? (wantMasked + (item.firewall && hasSecret(item.secondText) ? 1 : 0)) : wantMasked * attempts;
  if (JSON.stringify(rows) !== JSON.stringify(Array(wantRows).fill(maskedRow))) bad.push(`${rows.length} secret.redact rows, expected ${wantRows} masked/${SEAM[w]}`);
  if (JSON.stringify(proj.hits) !== JSON.stringify(item.expectHits ?? {})) bad.push(`scan hits ${JSON.stringify(proj.hits)} != ${JSON.stringify(item.expectHits ?? {})}`);
  bad.push(...checkStored(d, item, proj, stored));
  return bad;
}

function checkStored(d, item, proj, stored) {
  const w = item.wrapper;
  const want = payloadFor(w, stored);
  const bad = [];
  if (item.scenario === "insert_failure") {
    if (!/boom/.test(proj.results[0]?.threw ?? "") || proj.outbox.length || proj.chat.length) bad.push("insert failure must throw the store error and leave no outbox row or chat turn");
    return bad;
  }
  if (item.scenario === "outer_rollback") { if (proj.outbox.length || proj.chat.length) bad.push("rollback left an outbox row or chat turn"); return bad; }
  const statuses = proj.results.map((r) => r.status).join(",");
  const wantStatuses = { single: "queued", duplicate: "queued,duplicate", conflict: "queued,conflict" }[item.scenario];
  if (statuses !== wantStatuses) bad.push(`statuses ${statuses} != ${wantStatuses}`);
  const row = proj.outbox[0];
  if (proj.outbox.length !== 1 || row.payload_json !== JSON.stringify(want) || row.payload_hash !== d.stableHash(want) || row.state !== "queued") bad.push("outbox row is not exactly one queued row of the independently computed bytes");
  if (JSON.stringify(proj.chat) !== JSON.stringify(w === "evolution" ? [stored] : [])) bad.push("assistant chat turn differs from the independently computed bytes");
  return bad;
}
