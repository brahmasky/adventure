#!/usr/bin/env node
// Rollback check — decision ladder Stage 4B, approval.bind + secret.redact (spec 2026-10-29 §8; plan Task 12).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/check-ladder-stage4b-rollback.mjs \
//     --old-dist /Users/xiaochuan/Projects/adventure/.worktrees/base-1451a66/dist [--live-db <path>]
// Two VACUUM copies of the live DB: A (this build writes a seed to it, then 1451a66 opens it, then this build reopens it) and F
// (only 1451a66 ever opens it; it is VACUUMed from A before A is touched). 1451a66 does the same six things on both: migrations,
// render /status + digest + /status decisions, resolve an approval, run a resume (no bind row), enqueue a masked report (no redact
// row), refuse review_ok outcomes naming the two new ids. PASS = nothing throws, no row count drops, and A and F differ only in the
// stated way: A's /status carries `· approval.bind` and `· secret.redact` count lines (F's carry neither), and every other count line
// equals F's plus the seed's own per-entry delta (computed from the rows the seed wrote, asserted, never excluded).
// Exit 0 PASS · 1 FAIL · 2 setup error. The live DB is read only by VACUUM INTO; every write goes to the copies, which live under
// /tmp/hg-s4d-* and are removed on every exit path (pass, FAIL, throw, SIGINT, SIGTERM). The broker is synthetic. Rendered
// text may hold Paco's data: nothing here prints it, only line names, entry ids, counts and PASS/FAIL.
import { mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { INPUT_ONE_BYTE, PACO, W, approvedRow, attempt, makeRun, scrubIds } from "./stage4-bind-fixture.mjs";
import { FAKE_VALUES, SetupError, cleanupTemp, fakeBroker, initTemp, loadDist, mkTemp, runClosers } from "./stage4-diff-lib.mjs";
import { verifyOldDist } from "./old-dist-provenance.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const CHAT = "-4310"; // not Paco's chat; nothing here sends
const NEW_IDS = ["approval.bind", "secret.redact"];
const TABLES = ["decisions", "tool_approvals", "standing_approvals", "notification_outbox"];
const COUNT_RE = /^· ([a-z_]+(?:\.[a-z_]+)+) (\d+) — /;
const STAMP = Date.now() * 1000;
const failures = [];
const msg = (e) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const nextN = (() => { let n = 0; return () => STAMP + ++n; })();
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const handles = []; // open stores/handles, closed in the finally
/** The run is otherwise all synchronous SQLite: without a macrotask yield a SIGINT/SIGTERM handler could not run until the whole run had ended. */
const yieldLoop = () => new Promise((r) => setImmediate(r));

/** VACUUM INTO `to` from `from` (read-only source); a daemon write lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt_ = 1; ; attempt_++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt_ >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}
/** A store of dist `d` on `path`, firewall armed on the fake broker. The new dist goes through storeOptionsFor, as cli.ts does. */
function openStore(d, path) {
  const broker = fakeBroker(d);
  const opts = d.storeOptionsFor ? d.storeOptionsFor(broker) : { redact: broker.redact };
  const store = d.RunStore.open(path, opts);
  handles.push(store);
  return store;
}
const closeStore = (s) => { try { s.close(); } catch { /* a closed handle is not a finding */ } };
function counts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])); } finally { db.close(); }
}
const entryCount = (path, id) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?`).get(id).n; } finally { db.close(); } };

// ---- the bind fixture over a copy store (copied from live-gate-ladder-stage4b.mjs: importing that script runs its main) ----
function stubRegistry(d) {
  const registry = new d.ToolRegistry();
  registry.register({ name: "shell_external", category: "tool", side_effect_level: "external_write", risk_level: "medium", timeout_ms: 5_000, output_limit_bytes: 10_000,
    execute: () => Promise.resolve({ ok: true, output: { ran: true } }) });
  return registry;
}
function fixtureOn(d, store) {
  const f = { d, store, opts: {}, seq: 0, adapter: { mode: "ok" }, attempts: [], requester: PACO };
  f.run_id = makeRun(d, store, "user", nextN());
  f.sink = d.createToolApprovalSink({ store, worker_id: W, tool_call_id: "tc_sink", approvalTimeoutMs: 60_000 });
  f.runner = new d.CapabilityRunner(stubRegistry(d), f.sink);
  f.recorder = d.storeRecorder(store);
  return f;
}
/** One omp-sink resume of a fresh approved row: the attempt record, scrubbed of random ids, and the bind rows THIS call wrote. */
async function resume(d, store) {
  const f = fixtureOn(d, store);
  const rec = await attempt(f, approvedRow(f));
  return { view: scrubIds({ before: rec.before, after: rec.after, result: rec.result, threw: rec.threw }, [], [[f.run_id, "RUN"]]), bind: rec.newBind };
}
const V = FAKE_VALUES.GEMINI_API_KEY;
const REPORT_TEXT = `${"x".repeat(100)}${V} end`;
/** One masked final report on a fresh schedule-born run; what it left: wrapper status, outbox payload, assistant chat turns, secret.redact rows. */
function maskedReport(d, store) {
  const run_id = makeRun(d, store, "schedule", nextN(), false);
  const res = store.enqueueFinalReportNotification(run_id, { text: REPORT_TEXT, report_path: "/tmp/r.md" });
  const row = store.db.prepare(`SELECT payload_json, state FROM notification_outbox WHERE run_id = ? AND intent_type = 'final_report'`).get(run_id) ?? null;
  const chat = store.db.prepare(`SELECT COUNT(*) AS n FROM chat_turns WHERE run_id = ? AND role = 'assistant'`).get(run_id).n;
  const redactRows = store.listDecisionsForRun(run_id).filter((r) => r.entry_id === "secret.redact").length;
  return { status: res.status, payload: row ? JSON.parse(row.payload_json) : null, state: row?.state ?? null, chat, redactRows };
}

// ---- the 4A seed shape (copied from check-standing-rollback.mjs seedRows, minus the tick probe) ----
const CMD = "curl -s -m 10 -c cj.txt -b cj.txt -o /dev/null -w '%{http_code}' -X POST -d a=1 https://httpbin.org/post";
function seedStanding(d, s, root) {
  const now = new Date().toISOString();
  const schedule_id = s.addScheduledTask({ chat_id: CHAT, goal: "rollback 4B: standing seed", spec_json: '{"kind":"daily","at":"11:00"}', tz: "Australia/Sydney", next_run_at: "2099-01-01T00:00:00.000Z", now }).schedule_id;
  const r = new d.Gateway(s, undefined, undefined, undefined, undefined, { dataDir: root }).intake(d.buildTypedTaskEvent({ source: "schedule", type: "turn", program: "turn", goal: "rollback 4B check-in",
    requested_by: { kind: "schedule", id: schedule_id }, notify: { kind: "telegram", chat_id: CHAT }, idempotency_key: `schedule:${schedule_id}:rb4b:${nextN()}`, source_reference: `scheduled_tasks.${schedule_id}` }));
  if (!r.ok || !r.run_id) throw new Error("standing seed intake failed");
  const run = r.run_id;
  s.claimRun(run, "rollback-4b", 60);
  const fp = d.actionFingerprint("shell_external", d.OMP_SHELL_META.shell_external, { command: CMD });
  const seed = s.inTransaction(() => {
    const move_id = s.insertLadderMove({ entry_id: "tool.policy", scope: "rb4b", from_rung: "paco", to_rung: "rule", evidence: ["rb-a1", "rb-a2", "rb-a3", "rb-a4", "rb-dec", run, "rb-tc4"], granted_by: "auto", granted_via: "approval.standing", paco_callback_id: null, revocable: true, created_at: now });
    const row = s.insertStandingApprovalForTest({ schedule_id, chat_id: CHAT, action_fingerprint: fp, state: "standing", move_id, credited_runs_json: '["rb-r1","rb-r2","rb-r3"]',
      approval_ids_json: '["rb-a1","rb-a2","rb-a3","rb-a4"]', expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), created_at: now });
    for (const [type, payload] of [["standing_streak", { run_id: run, approval_id: "rb-a1", streak: 1 }], ["standing_sealing", { run_id: run, tool_call_id: "rb-tc4", approval_id: "rb-a4" }],
      ["standing_sealed", { run_id: run, tool_call_id: "rb-tc4", exit_code: 0 }], ["standing_granted", { move_id }]]) s.appendStandingLedgerEvent(type, { standing_id: row.standing_id, ...payload }, run);
    s.insertDecision({ entry_id: "tool.policy", entry_version: 3, run_id: run, tool_call_id: "rb-tc5", stage: "pre_tool", rung: "rule", verdict: "allowed", p: null, reason_code: "standing", fallback_reason: null, fallback_rung: null, armed_mode: "on", latency_ms: 0 });
    return { standing_id: row.standing_id };
  });
  const used = s.standingUse({ standing_id: seed.standing_id, action_fingerprint: fp, run_id: run, tool_call_id: "rb-tc5", now });
  if (!used.ok) throw new Error(`seed standing use refused: ${used.code}`);
  s.appendRunLedgerEvent(run, "tool_finished", "core", { tool_call_id: "rb-tc5", status: "succeeded", output_hash: "rb-out", duration_ms: 1, bytes_out: 3, executor: "cleanroom",
    cleanroom: { ran: true, torn_down: true, tampered: false, escaped: false, exit_code: 0, truncated: false, check_failed: false, room: "room-rb4b" } });
  if (!s.finishRun({ run_id: run, expected_worker_id: "rollback-4b", next: "completed", report_ref: "runs/rollback-check-4b.md", duration_ms: 1, tool_calls: 1 })) throw new Error("the standing seed run did not complete");
}

/** Step 1, this build on A: one bind row (a real resume), one redact row (a masked report), the 4A standing rows. Returns the seed's own per-entry delta. */
async function seedA(dNew, path, root) {
  const s = openStore(dNew, path);
  const t0 = new Date().toISOString();
  const bind = await resume(dNew, s);
  await yieldLoop();
  const rep = maskedReport(dNew, s);
  await yieldLoop();
  seedStanding(dNew, s, root);
  const rows = s.db.prepare(`SELECT entry_id, COUNT(*) AS n FROM decisions WHERE created_at >= ? GROUP BY entry_id`).all(t0);
  closeStore(s);
  return { delta: Object.fromEntries(rows.map((r) => [r.entry_id, r.n])), bindRows: bind.bind.length, redactRows: rep.redactRows, standing: counts(path).standing_approvals };
}

// ---- rendering and comparison ----
const norm = (l) => l.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, "<id>").replace(/\b(run|tool|op|dec)_[0-9A-Za-z-]+/g, "<id>").replace(/ run [0-9a-f]{8}\b/g, " run <id>")
  .replace(/\d{4}-\d\d-\d\d(?:T[\d:.]+Z?)?/g, "<ts>").replace(/\b\d\d:\d\d\b/g, "<ts>");
/** The three renderers 1451a66 and this build share: the /status block, the digest, /status decisions. `now` is shared by A and F. */
function render(m, store, now) {
  // the improvement-tick-off watch line makes the digest non-empty on any copy, so its render is always compared (as check-standing-rollback does)
  const dg = m.buildDecisionDigest(store, now, { ...process.env, HOUGE_IMPROVE_ENABLED: "false" });
  return { status: m.decisionStatusLines(store, now), digest: dg ? dg.text.split("\n") : [], list: m.decisionListText(store, process.env).split("\n") };
}
const countMap = (lines) => new Map(lines.flatMap((l) => { const m = COUNT_RE.exec(l); return m ? [[m[1], Number(m[2])]] : []; }));
/** A's /status against F's: the two new-id lines are the stated difference; every other count line is F's plus the seed's delta; the rest equal. */
function cmpStatus(a, f, delta) {
  const bad = [];
  const [ca, cf] = [countMap(a), countMap(f)];
  const [oa, of] = [a.filter((l) => !COUNT_RE.test(l)).map(norm), f.filter((l) => !COUNT_RE.test(l)).map(norm)];
  if (JSON.stringify(oa) !== JSON.stringify(of)) bad.push(`non-count lines differ (A ${oa.length}, F ${of.length})`);
  for (const id of NEW_IDS) {
    if (ca.get(id) !== delta[id] || cf.has(id)) bad.push(`${id}: A ${ca.get(id) ?? "absent"} (expected ${delta[id] ?? 0}), F ${cf.get(id) ?? "absent"} (expected absent)`);
  }
  for (const id of new Set([...ca.keys(), ...cf.keys()])) {
    if (NEW_IDS.includes(id)) continue;
    const want = (cf.get(id) ?? 0) + (delta[id] ?? 0);
    if ((ca.get(id) ?? 0) !== want) bad.push(`${id}: A ${ca.get(id) ?? 0}, expected ${want} (F ${cf.get(id) ?? 0} + seed ${delta[id] ?? 0})`);
  }
  return bad;
}
function cmpDigest(a, f) { const [x, y] = [a.map(norm), f.map(norm)]; return JSON.stringify(x) === JSON.stringify(y) ? [] : [`digest lines differ (A ${x.length}, F ${y.length})`]; }
/** The recent-decisions list holds the newest 10 rows: the seed's rows displace F's older ones, so entries the seed touched are dropped from both, and A's rest must open F's. */
function cmpList(a, f, delta) {
  const touched = new Set([...Object.keys(delta), ...NEW_IDS]);
  const keep = (l) => ![...touched].some((id) => l.includes(` · ${id} · `));
  const [x, y] = [a.filter(keep).map(norm), f.filter(keep).map(norm)];
  return x.length > 0 && JSON.stringify(x) === JSON.stringify(y.slice(0, x.length)) ? [] : [`recent-decisions list: A's ${x.length} untouched lines do not open F's ${y.length}`];
}
function cmpRenders(tag, ra, rf, delta) {
  const bad = [...cmpStatus(ra.status, rf.status, delta), ...cmpDigest(ra.digest, rf.digest), ...cmpList(ra.list, rf.list, delta)];
  const seen = NEW_IDS.map((id) => `${id} ${countMap(ra.status).get(id) ?? 0}`).join(" · ");
  check(`A vs F at ${tag}: the new-id lines are the only difference, other count lines = F + seed delta`, bad.length === 0, bad.length ? bad.join("; ") : `A carries [${seen}], F carries none; ${countMap(ra.status).size} count lines compared; digest ${ra.digest.length} lines equal`);
}

// ---- step 2: the previous build (1451a66) on one copy ----
function resolveApproval(d, store) {
  const f = fixtureOn(d, store);
  const id = f.store.createToolApproval({ run_id: f.run_id, worker_id: W, tool_call_id: "tc_rb_pending", capability: "shell_external", input_hash: d.stableHash({ a: 1 }),
    action_fingerprint: d.actionFingerprint("shell_external", { side_effect_level: "external_write", risk_level: "medium" }, { a: 1 }), requester: PACO, summary: "rollback", side_effect_level: "external_write",
    expires_at: new Date(Date.now() + 3_600_000).toISOString() }).approval_id;
  const key = `rb4b:approve:${nextN()}`;
  const r = new d.Gateway(store).intake(d.buildTypedTaskEvent({ source: "telegram", type: "approve", approval_id: id, requested_by: PACO, notify: { kind: "telegram", chat_id: CHAT },
    idempotency_key: key, source_reference: `telegram:update:${key}:callback:1` }));
  return { status: r.status, ok: r.ok, state: store.getToolApproval(id)?.state };
}
/** review_ok naming a new id must be refused by the old build's own ENTRY_IDS (outcomes.ts:37-40); a valid id is accepted, so the refusal is about the value. */
function outcomeProbes(d, store) {
  const decision_id = store.db.prepare(`SELECT decision_id FROM decisions WHERE entry_id NOT IN ('approval.bind','secret.redact') ORDER BY rowid LIMIT 1`).get()?.decision_id;
  if (!decision_id) throw new Error("the copy holds no decision row to attach an outcome to");
  const probe = (value) => { try { return `inserted:${store.insertDecisionOutcome({ decision_id, signal: "review_ok", value, source: "code" }).inserted}`; } catch (e) { return `${e?.constructor?.name}:${msg(e)}`; } };
  return Object.fromEntries([...NEW_IDS, "tool.policy"].map((v) => [v, probe(v)]));
}
async function oldSteps(dOld, mOld, path, label, now, hook) {
  const s = openStore(dOld, path); // 1: the old build opens the copy; its migrations ran
  const r = { before: render(mOld, s, now) };
  r.resolve = resolveApproval(dOld, s);
  await yieldLoop();
  const res = await resume(dOld, s);
  r.resume = { view: res.view, newBind: res.bind.length };
  r.report = maskedReport(dOld, s);
  await yieldLoop();
  r.outcomes = outcomeProbes(dOld, s);
  if (hook) hook(s, label);
  r.after = render(mOld, s, now);
  closeStore(s);
  return r;
}
/** Every step-2 result other than the rendered text, ids and timestamps stripped, must be equal on A and F, and the old build must have written no new-id row. */
function cmpSteps(a, f) {
  const view = (r) => JSON.stringify(scrubIds({ resolve: { status: r.resolve.status, ok: r.resolve.ok, state: r.resolve.state }, resume: r.resume, report: r.report, outcomes: r.outcomes }));
  const refused = (r) => NEW_IDS.every((id) => /^OutcomeRejected:value not allowed for review_ok$/.test(r.outcomes[id])) && r.outcomes["tool.policy"] === "inserted:true";
  const quiet = (r) => r.resume.newBind === 0 && r.report.redactRows === 0 && r.report.payload?.text?.includes("«redacted»") === true;
  check("1451a66 step results equal on A and F (resolve, resume, masked report, outcome refusals)", view(a) === view(f), `resolve ${a.resolve.status} · resume bind rows ${a.resume.newBind}/${f.resume.newBind} · redact rows ${a.report.redactRows}/${f.report.redactRows}`);
  check("1451a66 refuses review_ok naming approval.bind and secret.redact (and accepts a valid id) on both copies", refused(a) && refused(f), `A ${JSON.stringify(a.outcomes)} · F ${JSON.stringify(f.outcomes)}`.replace(/"/g, ""));
  check("1451a66 writes no bind row on a resume and no redact row on a masked report (A and F)", quiet(a) && quiet(f));
}
const noDrop = (name, before, after) => {
  const dropped = TABLES.filter((t) => after[t] < before[t]);
  check(`row counts never drop: ${name}`, dropped.length === 0, dropped.length ? dropped.map((t) => `${t} ${before[t]} -> ${after[t]}`).join(", ") : TABLES.map((t) => `${t} ${before[t]}->${after[t]}`).join(" · "));
};

async function setup() {
  const oldDist = resolve(arg("--old-dist") ?? "");
  if (!arg("--old-dist")) throw new SetupError("--old-dist is required");
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  const prov = verifyOldDist(oldDist, DIST, "1451a66", "capabilities/capability-runner.js");
  console.log(`old build: worktree HEAD ${prov.head.slice(0, 7)}, capability-runner.js ${prov.oldHash} (new ${prov.newHash})`);
  const root = initTemp(false);
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  Object.assign(process.env, { HOUGE_DAEMON_TMP_DIR: join(root, "daemon"), HOUGE_TELEGRAM_CHAT_ID: CHAT, HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_EPISODIC_ENABLED: "false", HOUGE_WIKI_ENABLED: "false", HOUGE_JEV_TRIAGE_ENABLED: "off" });
  const [dNew, dOld] = [await loadDist(DIST), await loadDist(oldDist)];
  for (const k of ["storeOptionsFor", "CapabilityRunner", "Gateway", "createToolApprovalSink"]) if (!dNew[k]) throw new SetupError(`${k} missing from the new dist: rebuild`);
  for (const k of ["RunStore", "CapabilityRunner", "Gateway", "createToolApprovalSink"]) if (!dOld[k]) throw new SetupError(`${k} missing from the old dist`);
  const mods = async (dist) => ({ ...(await import(join(dist, "decisions/digest.js"))), ...(await import(join(dist, "decisions/status-view.js"))) });
  const [mNew, mOld] = [await mods(DIST), await mods(oldDist)];
  const A = join(mkTemp("copy-A"), "houge.sqlite"); const F = join(mkTemp("copy-F"), "houge.sqlite");
  vacuumInto(liveDb, A);
  vacuumInto(A, F); // F is cut from the untouched A, so a daemon write between two live reads cannot separate them
  return { dNew, dOld, mNew, mOld, A, F, root };
}

/** The whole run after setup. `hooks.afterOld(path, label)` is the seam the self-test plants use; production passes none. */
async function run(ctx, hooks = {}) {
  const { dNew, dOld, mOld, mNew, A, F, root } = ctx;
  const f0 = counts(F);
  const seed = await seedA(dNew, A, root);
  await yieldLoop();
  const a1 = counts(A);
  check("this build seeded A: one approval.bind row (real resume), one secret.redact row (masked report), the 4A standing rows",
    seed.bindRows === 1 && seed.redactRows === 1 && seed.delta["approval.bind"] === 1 && seed.delta["secret.redact"] === 1 && seed.standing >= 1 && entryCount(F, "approval.bind") === 0,
    `seed delta by entry ${JSON.stringify(seed.delta).replace(/"/g, "")} · standing_approvals ${seed.standing}`);
  // one `now` for every render on both copies, ahead of every row this run writes (a window ending at the start would never see the old build's own rows)
  const now = new Date(Date.now() + 10 * 60_000).toISOString();
  const a = await oldSteps(dOld, mOld, A, "A", now, null);
  await yieldLoop();
  const f = await oldSteps(dOld, mOld, F, "F", now, hooks.onF);
  check("1451a66 opened both copies (migrations ran) and every step completed without throwing", true);
  hooks.afterOld?.(A);
  const [a2, f1] = [counts(A), counts(F)];
  noDrop("A, seed -> after 1451a66", a1, a2);
  noDrop("F, before -> after 1451a66", f0, f1);
  const grew = (x, y) => TABLES.map((t) => y[t] - x[t]);
  check("1451a66 added exactly the same rows to A and F (per table growth equal, so no row was removed or added behind a step)", JSON.stringify(grew(a1, a2)) === JSON.stringify(grew(f0, f1)),
    `growth ${TABLES.map((t, i) => `${t} ${grew(a1, a2)[i]}/${grew(f0, f1)[i]}`).join(" · ")} (A/F)`);
  cmpRenders("start of the 1451a66 steps", a.before, f.before, seed.delta);
  cmpRenders("end of the 1451a66 steps", a.after, f.after, seed.delta);
  cmpSteps(a, f);
  const s = openStore(dNew, A);
  const re = render(mNew, s, now);
  closeStore(s);
  const a3 = counts(A);
  noDrop("A, after 1451a66 -> reopened by this build", a2, a3);
  check("this build reopens A: both new ids still counted, rows intact", countMap(re.status).get("approval.bind") === 1 && countMap(re.status).get("secret.redact") === 1
    && entryCount(A, "approval.bind") === 1 && entryCount(A, "secret.redact") === 1, `bind ${entryCount(A, "approval.bind")} · redact ${entryCount(A, "secret.redact")}`);
}

function onSignal(code) { for (const h of handles.splice(0)) closeStore(h); cleanupTemp(); process.exit(code); }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(sig, () => onSignal(code));

export async function main(hooks = {}) {
  try {
    const ctx = await setup();
    try { await run(ctx, hooks); } catch (e) { check("the rollback run completed without throwing", false, msg(e)); }
    console.log(failures.length === 0 ? "\nROLLBACK CHECK: PASS" : `\nROLLBACK CHECK: FAIL\n  - ${failures.join("\n  - ")}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(`setup error: ${e instanceof SetupError || /--old-dist|provenance|not the previous/.test(msg(e)) ? msg(e) : "withheld"}`);
    process.exitCode = 2;
  } finally {
    for (const h of handles.splice(0)) closeStore(h);
    await runClosers();
    cleanupTemp();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
