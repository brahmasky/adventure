#!/usr/bin/env node
// Live gate — the Jev version check (spec 2026-10-22 §4; plan Task 7). Runs the REAL check job with the real Jev against a VACUUM
// copy of the live DB (the live DB is only read, through a read-only handle, to make the copy); every write goes to the copy.
// Run from the worktree after `npm run build` THERE:
//   HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-jev-version.mjs --db /abs/houge.sqlite [--keep]
//
// Steps: (0) one probe call: the model `jev-latest` reports is the candidate. (1) the anchor is imported into the copy from
// <repo>/.houge/jev-tree (read-only) and must hold >= 200 zh turns. (2) the full check job runs for the candidate with the daemon's
// own client construction and the job's pacing; PASS needs the check to complete and `treeArmingFor` to match its verdict; every
// per-check margin, the lane counts (the answer lane's +1 allowance) and the golden outcomes are printed. (3) negative control: the
// same candidate answers against an anchor whose turn ids are permuted must FAIL (no new calls). (4) self control: a second copy
// whose anchor IS the candidate's own run A (canonical) and run B (permuted), the full check re-run with fresh candidate runs, must
// PASS. (5) IMPROVE_GOLDEN is run 3 times on the live model; an item whose answer changes between runs is reported unstable.
// A drifted verdict on the live model is a valid result, reported with its numbers. An outage, a deferral, a fused meter or fewer
// answers than needed is INCONCLUSIVE, never PASS. Output is buffered and checked for the API key and for any anchor message text
// before it is printed; it carries counts, enums and margins only, never turn or state text.
// Exit: 0 PASS - 1 FAIL - 2 setup error - 3 INCONCLUSIVE.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const temp = { root: null, keep: false };
const cleanup = () => {
  if (temp.root && !temp.keep) rmSync(temp.root, { recursive: true, force: true });
  else if (temp.root) console.error(`temp dir kept (holds a live-DB copy): ${temp.root}`);
  temp.root = null;
};
const coded = (code) => Object.assign(new Error(code), { code });
const out = []; const say = (l = "") => out.push(l);
const fails = []; const incs = [];
const check = (name, ok, detail = "") => { say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); if (!ok) fails.push(name); };
const unsure = (name, why) => { say(`INCONCLUSIVE ${name} - ${why}`); incs.push(name); };
const progress = (s) => console.error(`[gate] ${s}`);
const fx = (n) => (n === null || n === undefined || Number.isNaN(n) ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(3)}`);
const rate = (g) => (g && g.n > 0 ? `${(g.agree / g.n).toFixed(3)}(${g.n})` : "n/a");

function parseArgs(argv) {
  const a = { db: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") a.db = resolve(argv[++i]); else if (argv[i] === "--keep") a.keep = true; else throw coded("BAD_ARGUMENT");
  }
  if (!DIST.includes("/.worktrees/")) throw coded("NOT_IN_WORKTREE"); // run from the worktree; never build or run in the main checkout
  return a;
}

async function load() {
  const paths = ["config/load-env.js", "domain/error-code.js", "run/run-store.js", "jev/jev-client.js", "jev/anchor-import.js", "jev/questions/tree.js", "jev/questions/types.js",
    "jev/questions/improve.js", "jev/triage-replay.js", "decisions/jev-version-job.js", "decisions/jev-version-check.js", "decisions/golden.js", "decisions/entries/improve-route.js"];
  const m = Object.assign({}, ...(await Promise.all(paths.map((p) => import(join(DIST, p))))));
  const need = ["loadHougeEnv", "errorCode", "RunStore", "createJevClient", "importJevAnchor", "TREE_QUESTIONS", "toJevQuestion", "IMPROVE_TARGET", "runJevCheck", "treeArmingFor",
    "judge", "checkOutcome", "agreementByCheck", "laneCountsOf", "CHECK_IDS", "IMPROVE_GOLDEN", "improveJevState", "askCandidate", "JEV_CHECK_PACE_MS", "abortableSleep", "JEV_ANCHOR_MIN_ZH"];
  const missing = need.filter((n) => m[n] === undefined);
  if (missing.length > 0) throw coded("DIST_STALE_REBUILD");
  return m;
}

function copyDb(from, to) {
  if (resolve(to) === resolve(from) || !resolve(to).startsWith(`${temp.root}/`)) throw coded("COPY_OUTSIDE_TEMP_ROOT");
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

function gateEnv(root) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_DAEMON_TMP_DIR: join(root, "daemon-tmp") });
}

/** The daemon's own client construction for the version job (telegram-daemon.ts runJevVersionTickSafe), audited into the given copy. */
const makeClient = (m, store) => m.createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, audit: store.llmAuditSink({ correlation_id: "jev-version-check", role: "triage" }),
  meteredBreached: () => store.meteredFuseLatched(), retries: 3, timeoutMs: 15_000 });

/** One real call for the model id the alias reports now (the first golden item's request; its answer is discarded). */
async function probeModel(m) {
  const mem = m.RunStore.openInMemory();
  try {
    const client = m.createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, audit: mem.llmAuditSink({ correlation_id: "gate:jev-probe", role: "" }), meteredBreached: () => false, retries: 1, timeoutMs: 15_000 });
    const questions = Object.fromEntries(m.TREE_QUESTIONS.map((q) => [q.id, m.toJevQuestion(q)]));
    const r = await client({ state: { latest_message: "hello" }, questions });
    if (!r.ok) throw coded(`PROBE_${String(r.reason).toUpperCase()}`);
    return r.model;
  } finally { mem.close(); }
}

// ── The check's inputs, read back from a store the way the job reads them ──
const TREE_IDS = (m) => m.TREE_QUESTIONS.map((q) => q.id);
function anchorOf(m, store) {
  const turns = store.anchorStates().filter((s) => s.lang === "zh" || s.lang === "mixed").map((s) => ({ turn: s.turn_id, lang: s.lang, state: JSON.parse(s.state_json) }));
  const stateOf = new Map(turns.map((t) => [t.turn, t.state]));
  const run = (r) => {
    const mp = new Map();
    for (const row of store.anchorAnswers(r)) {
      const state = stateOf.get(row.turn_id); if (!state) continue;
      const t = mp.get(row.turn_id) ?? { state, answers: {} }; t.answers[row.question_id] = JSON.parse(row.answer_json); mp.set(row.turn_id, t);
    }
    return mp;
  };
  return { turns, stateOf, A: run("A"), B: run("B"), labels: new Map(store.anchorLabels().map((l) => [l.turn_id, l.category])) };
}
function candOf(store, model, g, anchor) {
  const runs = { A: new Map(), A2: new Map(), B: new Map() };
  for (const row of store.listJevCheckRuns(model, g, "tree")) {
    if (row.outcome !== "answered") continue;
    const i = row.run.indexOf(":"); const run = row.run.slice(0, i); const turn = row.run.slice(i + 1); const state = anchor.stateOf.get(turn);
    if (state && runs[run]) runs[run].set(turn, { state, answers: JSON.parse(row.detail_json) });
  }
  return runs;
}

/** The job's finishCheck maths (§2.5 a-d) over the five runs, restricted to the turns every run has. Returns the inputs too, for printing. */
function compare(m, anchor, cand) {
  const full = anchor.turns.filter((t) => [cand.A, cand.A2, cand.B, anchor.A, anchor.B].every((r) => r.has(t.turn)));
  const only = (r) => new Map(full.map((t) => [t.turn, r.get(t.turn)]));
  const [aA, aB, cA, cA2, cB] = [anchor.A, anchor.B, cand.A, cand.A2, cand.B].map(only);
  const label = (t) => anchor.labels.get(t);
  const inputs = { anchorAB: m.agreementByCheck(aA, aB), anchorLanes: { A: m.laneCountsOf(aA, label), B: m.laneCountsOf(aB, label) },
    candVsAnchor: m.agreementByCheck(cA, aA), candSelf: m.agreementByCheck(cA, cA2), candAB: m.agreementByCheck(cA, cB), candLanes: m.laneCountsOf(cA, label) };
  const verdict = m.judge(inputs);
  return { full, zh: full.filter((t) => t.lang === "zh").length, inputs, verdict, outcome: m.checkOutcome(verdict) };
}

function printMargins(c, title) {
  say(`  ${title}: ${c.full.length} turns compared (${c.zh} zh)`);
  say("  check          a        b        | cand~anchorA   cand~candA2    cand A~B       anchor A~B");
  for (const id of Object.keys(c.verdict.margins)) {
    const mg = c.verdict.margins[id];
    say(`  ${id.padEnd(14)} ${fx(mg.a).padEnd(8)} ${fx(mg.b).padEnd(8)} | ${rate(c.inputs.candVsAnchor[id]).padEnd(14)} ${rate(c.inputs.candSelf[id]).padEnd(14)} ${rate(c.inputs.candAB[id]).padEnd(14)} ${rate(c.inputs.anchorAB[id])}`);
  }
  say(`  verdict: ${c.outcome.state}; failed questions [${c.verdict.failed_questions.join(",")}]; route_failed ${c.verdict.route_failed}; lanes disarmed [${c.verdict.lanes_disarmed.join(",")}]`);
}
function printLanes(c) {
  say("  lane      anchor A (wrong/recall/labelled)   anchor B            candidate A         wrong allowance (anchor A wrong + 1)");
  for (const lane of ["memory", "status", "answer", "lookup"]) {
    const a = c.inputs.anchorLanes.A[lane]; const b = c.inputs.anchorLanes.B[lane]; const k = c.inputs.candLanes[lane];
    const f = (x) => `${x.wrong}/${x.recall}/${x.labelled}`;
    say(`  ${lane.padEnd(9)} ${f(a).padEnd(34)} ${f(b).padEnd(19)} ${f(k).padEnd(19)} ${k.wrong} <= ${a.wrong + 1}: ${k.wrong <= a.wrong + 1 ? "within" : "OVER (lane disarmed)"}`);
  }
  const ans = c.inputs.candLanes.answer; const ref = c.inputs.anchorLanes.A.answer;
  say(`  answer lane +1 watch: candidate wrong routes ${ans.wrong}, anchor wrong ${ref.wrong} (allowed ${ref.wrong + 1})`);
  if (c.verdict.recall_drops.length > 0) for (const r of c.verdict.recall_drops) say(`  recall drop (reported only): ${r.lane} ${r.anchor} -> ${r.candidate} (allowed ${r.allowed}, ${r.labelled} labelled)`);
}

/** The arming a verdict must produce, derived from its state and detail independently of src. */
function expectedArming(m, row) {
  const ids = TREE_IDS(m);
  if (row.state === "trusted" || row.state === "accepted") return { questions: new Set(ids), lanes: new Set() };
  if (row.state !== "drifted") return { questions: new Set(), lanes: new Set() };
  const d = JSON.parse(row.detail_json);
  if (d.route_failed) return { questions: new Set(), lanes: new Set() };
  return { questions: new Set(ids.filter((id) => !d.failed_questions.includes(id))), lanes: new Set(d.lanes_disarmed) };
}
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
function checkArming(m, store, model, row) {
  const want = expectedArming(m, row);
  for (const lang of ["zh", "en", "mixed"]) {
    const got = m.treeArmingFor(store, { model }, lang);
    check(`arming matches the verdict (${lang})`, sameSet(got.questions, want.questions) && sameSet(got.lanesDisarmed, want.lanes),
      `state ${row.state}; armed questions ${got.questions.size}/${TREE_IDS(m).length}; lanes disarmed [${[...got.lanesDisarmed].join(",")}]`);
  }
  for (const other of ["jev-latest", "jev-0.0.0"]) {
    const got = m.treeArmingFor(store, { model: other }, "zh");
    check(`an unchecked model id arms nothing (${other})`, got.questions.size === 0 && got.lanesDisarmed.size === 0);
  }
}

/** The job, resumed over an outage up to twice (it is resumable by design); any other non-terminal end is INCONCLUSIVE. */
async function runCheck(m, store, model, label, golden) {
  const ac = new AbortController(); let result = "";
  const stop = () => ac.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let resumed = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = await m.runJevCheck({ store, client: makeClient(m, store), signal: ac.signal, chatId: null, now: () => new Date().toISOString(), log: (l) => progress(`${label}: ${l}`),
      ...(golden ? { golden } : {}) }, model);
    if (result === "outage" && attempt < 3) { resumed++; progress(`${label}: outage; resuming in 30 s (${resumed})`); await m.abortableSleep(30_000, ac.signal); continue; }
    if (result === "retrying") { progress(`${label}: failed turns retried`); continue; }
    break;
  }
  say(`  ${label}: job ended "${result}"${resumed > 0 ? ` after ${resumed} outage resume(s)` : ""}`);
  return result;
}

function seedChecking(store, model) {
  const now = new Date().toISOString();
  store.noteJevModel(model, now);
  const row = store.getJevModel(model);
  if (row.state !== "checking" && !store.setJevModelState(model, row.state, "checking", "{}", now)) throw coded("MODEL_STATE_FENCE");
}

/** The anchor a negative control sees: turn t carries the answers of pi(t) (a rotation of the sorted turn ids), in both runs. States stay with their own turn. */
function shuffledAnchor(anchor, full) {
  const ids = full.map((t) => t.turn).sort(); const n = ids.length; const k = Math.floor(n / 2);
  const to = new Map(ids.map((t, i) => [t, ids[(i + k) % n]]));
  const run = (r) => new Map(ids.map((t) => [t, { state: anchor.stateOf.get(t), answers: r.get(to.get(t)).answers }]));
  return { ...anchor, A: run(anchor.A), B: run(anchor.B) };
}

/** A copy whose anchor IS the candidate's own run A / run B over the fully answered turns (the self control). */
function makeSelfAnchorCopy(m, live, root, anchor1, cand1, fullTurns, model) {
  const path = join(root, "houge-self.sqlite"); copyDb(live, path);
  const store = m.RunStore.open(path);
  const r = m.importJevAnchor(store, join(REPO, "..", "..", ".houge", "jev-tree"), { env: process.env });
  if (r.status !== "imported") throw coded(`SELF_IMPORT_${r.status.toUpperCase()}`);
  const db = store.db; const keep = new Set(fullTurns);
  const hashOf = (run) => Object.fromEntries(db.prepare(`SELECT DISTINCT question_id, criteria_hash FROM jev_anchor WHERE run = ?`).all(run).map((x) => [x.question_id, x.criteria_hash]));
  const hashes = { A: hashOf("A"), B: hashOf("B") };
  const langOf = new Map(anchor1.turns.map((t) => [t.turn, t.lang]));
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM jev_anchor");
    const ins = db.prepare(`INSERT INTO jev_anchor (turn_id, lang, question_id, criteria_hash, run, answer_json, model) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const [run, runs] of [["A", cand1.A], ["B", cand1.B]]) for (const [turn, t] of runs) {
      if (!keep.has(turn)) continue;
      for (const [qid, ans] of Object.entries(t.answers)) ins.run(turn, langOf.get(turn), qid, hashes[run][qid] ?? "", run, JSON.stringify(ans), model);
    }
    for (const t of ["jev_anchor_states", "jev_anchor_labels"]) {
      const ids = db.prepare(`SELECT turn_id FROM ${t}`).all().map((x) => x.turn_id).filter((id) => !keep.has(id));
      for (const id of ids) db.prepare(`DELETE FROM ${t} WHERE turn_id = ?`).run(id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return store;
}

const topOf = (a) => (a?.type === "choice" ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null : null);
/** IMPROVE_GOLDEN three times on the live model, paced as the job paces. */
async function goldenStability(m, store, model) {
  const ac = new AbortController(); const pace = () => m.abortableSleep(m.JEV_CHECK_PACE_MS, ac.signal);
  const client = makeClient(m, store); const runs = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (const g of m.IMPROVE_GOLDEN) {
      const req = { state: m.improveJevState(g.state), questions: { [m.IMPROVE_TARGET.id]: m.toJevQuestion(m.IMPROVE_TARGET) } };
      const a = await m.askCandidate(client, req, model, { pace });
      if (!a.ok) { row.push(null); continue; }
      const p = a.answers[m.IMPROVE_TARGET.id]; row.push({ top: topOf(p), p: p?.type === "choice" ? Math.max(...Object.values(p.probabilities)) : null });
    }
    runs.push(row); progress(`IMPROVE_GOLDEN run ${r + 1}/3 done`);
  }
  return runs;
}

function reportGolden(m, runs) {
  say("  IMPROVE_GOLDEN stability (item: expected | run1 | run2 | run3 | verdict)");
  let answered = true;
  m.IMPROVE_GOLDEN.forEach((g, i) => {
    const cells = runs.map((r) => (r[i] === null || r[i].top === null ? "none" : `${r[i].top}@${r[i].p?.toFixed(2)}`));
    const tops = runs.map((r) => r[i]?.top ?? null);
    if (tops.some((t) => t === null)) answered = false;
    const stable = tops.every((t) => t !== null && t === tops[0]);
    const verdict = tops.some((t) => t === null) ? "INCOMPLETE" : !stable ? "UNSTABLE" : tops[0] === g.expect ? "stable, as expected" : "stable, NOT the expected target";
    say(`  ${g.id.padEnd(14)} ${g.expect.padEnd(9)} | ${cells.join(" | ")} | ${verdict}`);
  });
  return answered;
}

/** Output is checked for the API key and any anchor message text before it is printed. */
function leaked(anchor) {
  const text = out.join("\n"); const key = process.env.TYPESAFE_API_KEY;
  if (key && text.includes(key)) return true;
  return anchor.turns.some((t) => typeof t.state.latest_message === "string" && t.state.latest_message.length >= 8 && text.includes(t.state.latest_message));
}

async function main() {
  const args = parseArgs(process.argv.slice(2)); temp.keep = args.keep;
  const m = await load(); m.loadHougeEnv();
  if (!process.env.TYPESAFE_API_KEY) throw coded("NO_TYPESAFE_API_KEY");
  const live = args.db ?? join(REPO, "..", "..", "houge.sqlite");
  if (!existsSync(live)) throw coded("NO_DB");
  temp.root = mkdtempSync("/tmp/hg-jevver-gate-"); gateEnv(temp.root); mkdirSync(process.env.HOUGE_DAEMON_TMP_DIR, { recursive: true });
  progress("probing the model behind the alias");
  const model = await probeModel(m);
  say(`jev version check live gate - candidate model ${model} (the alias reported it)`);
  const copy = join(temp.root, "houge.sqlite"); copyDb(live, copy);
  const store = m.RunStore.open(copy);
  let store2 = null; let anchor = null;
  try {
    // 1. the anchor
    const imp = m.importJevAnchor(store, join(REPO, "..", "..", ".houge", "jev-tree"), { env: process.env });
    const zhImported = imp.counts?.turns?.zh ?? 0;
    check("anchor imported into the copy", imp.status === "imported", `status ${imp.status}; turns ${JSON.stringify(imp.counts?.turns ?? {})}; dropped ${JSON.stringify(imp.counts?.dropped ?? {})}; labels ${imp.counts?.labels ?? 0}; anchor model ${imp.counts?.model ?? "none"}`);
    check("anchor holds >= 200 zh turns", zhImported >= 200, `${zhImported} zh`);
    if (imp.status !== "imported") return finish(m, null);
    anchor = anchorOf(m, store);
    // 2. the full check
    seedChecking(store, model);
    progress(`running the full check for ${model} (paced at ${m.JEV_CHECK_PACE_MS} ms)`);
    const result = await runCheck(m, store, model, "check", null);
    if (!["trusted", "drifted"].includes(result)) { unsure("the check completes", `the job ended "${result}" (outage, deferral, stop or too few answers); no verdict`); return finish(m, anchor); }
    const row = store.getJevModel(model); const detail = JSON.parse(row.detail_json ?? "{}");
    say(`check verdict: ${row.state} (generation ${row.generation}, attempts ${row.attempts})`);
    check("the check completed with a verdict", row.state === "trusted" || row.state === "drifted", `state ${row.state}`);
    check(">= 200 zh anchor turns compared", (detail.zh_turns ?? 0) >= 200, `${detail.zh_turns ?? 0} zh of ${detail.turns ?? 0} compared`);
    checkArming(m, store, model, row);
    const cand = candOf(store, model, row.generation, anchor);
    const c = compare(m, anchor, cand);
    printMargins(c, "live check"); printLanes(c);
    check("the gate's recomputation reproduces the job's verdict", c.outcome.state === row.state && JSON.stringify(c.verdict.margins) === JSON.stringify(detail.margins), `recomputed ${c.outcome.state}, stored ${row.state}`);
    say(`  golden outcomes: ${Object.entries(detail.golden ?? {}).map(([e, o]) => `${e} ${o}`).join(" | ") || "none"}`);
    for (const [e, o] of Object.entries(detail.golden ?? {})) if (o === "skipped" || o === "-") unsure(`golden ${e}`, `outcome ${o}: no drift claim`);
    // 3. negative control
    const neg = compare(m, shuffledAnchor(anchor, c.full), cand);
    printMargins(neg, "negative control (turn ids permuted)");
    check("negative control FAILS the check (shuffled anchor)", neg.outcome.state === "drifted", `verdict ${neg.outcome.state}; failed [${neg.verdict.failed_questions.join(",")}]${neg.verdict.route_failed ? " route" : ""}`);
    // 4. self control (fresh candidate runs against the candidate's own run A / B)
    const fullTurns = c.full.map((t) => t.turn);
    store2 = makeSelfAnchorCopy(m, live, temp.root, anchor, cand, fullTurns, model);
    seedChecking(store2, model);
    progress("self control: fresh candidate runs against the candidate's own run A as the anchor");
    const sres = await runCheck(m, store2, model, "self", []);
    if (!["trusted", "drifted"].includes(sres)) unsure("self control completes", `the job ended "${sres}"`);
    else {
      const srow = store2.getJevModel(model); const sanchor = anchorOf(m, store2); const sc = compare(m, sanchor, candOf(store2, model, srow.generation, sanchor));
      printMargins(sc, "self control (anchor = candidate's own run A / B)"); printLanes(sc);
      check("self control PASSES the check", srow.state === "trusted", `state ${srow.state}`);
    }
    // 5. IMPROVE_GOLDEN stability
    progress("IMPROVE_GOLDEN x3");
    if (!reportGolden(m, await goldenStability(m, store, model))) unsure("IMPROVE_GOLDEN stability", "some asks returned no answer; the table is incomplete");
    return finish(m, anchor);
  } finally { store2?.close(); store.close(); }
}

function finish(m, anchor) {
  if (anchor && leaked(anchor)) { console.error("LEAK CHECK FAILED: the buffered output carries the API key or anchor text; output withheld"); return 1; }
  console.log(out.join("\n"));
  const verdict = fails.length > 0 ? `LIVE GATE: FAIL\n  - ${fails.join("\n  - ")}` : incs.length > 0 ? `LIVE GATE: INCONCLUSIVE\n  - ${incs.join("\n  - ")}` : "LIVE GATE: PASS";
  console.log(`\n${verdict}`);
  return fails.length > 0 ? 1 : incs.length > 0 ? 3 : 0;
}

for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(sig, () => { cleanup(); process.exit(code); });
main().then((code) => { cleanup(); process.exit(code); }, async (e) => {
  const c = await import(join(DIST, "domain/error-code.js")).then((x) => x.errorCode(e), () => "unknown");
  console.error(`setup error: ${c}`); cleanup(); process.exit(2);
});
