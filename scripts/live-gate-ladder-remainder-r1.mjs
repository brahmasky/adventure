#!/usr/bin/env node
// Live gate — decision ladder remainder R1, the three intake entries (spec 2026-10-30 R1 §7; plan Task 6).
//   From the worktree after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-ladder-remainder-r1.mjs [--live-db <path>]
// Eight lines on stdout, each `PASS`/`FAIL <n> <name> — <detail>`; exit 0 only when all eight PASS (1 FAIL, 2 setup error).
// Everything else goes to stderr, prefixed `# `. Only counts, booleans and codes are printed, never message text.
// The live DB is opened read-only, once, by VACUUM INTO a temp copy under /tmp/hg-s4d-*, removed on every exit path (finally,
// SIGINT, SIGTERM, SIGHUP). No env file is loaded (HOUGE_ENV_FILE only locates the DB) and no Telegram adapter exists, so every
// notification stays in the copy's outbox. Safety pins, set before any store opens and restored on exit:
//   HOUGE_TOMBSTONE_PATH / HOUGE_DISARM_PATH under the temp root (line 2 intakes `kill`; the default path would stop the LIVE daemon),
//   HOUGE_TELEGRAM_CHAT_ID = gate-stub-chat (line 6's decision_record_failed alert must not page Paco).
// Clock: no counting clock anywhere. Every intake gets a real wall-clock `now`, rows carry the wall clock, and /status (line 7) is
// queried at the wall clock. Each line uses its own identity (chat gate-r1-chat-<n>, actor gate-r1-actor-<n>) so lines never share a rate window.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SetupError, cleanupTemp, initTemp, loadDist, mkTemp, redactForPrint } from "./stage4-diff-lib.mjs";
import { intakeEvent, saturateWindow, seedAsk } from "./stage4-intake-fixture.mjs";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const MAIN_CHECKOUT = "/Users/xiaochuan/Projects/adventure";
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (!DIST.includes("/.worktrees/")) throw new Error(`run from the worktree (this dist is ${DIST}); never build in the main checkout`);

const STUB_CHAT = "gate-stub-chat";
const IDS = ["intake.rate_limit", "intake.rating_reply", "intake.budget_fuse"];
const BIG = 1_000_000_000; // caps no real copy reaches
const PINNED = ["HOUGE_TOMBSTONE_PATH", "HOUGE_DISARM_PATH", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_RATING_PENDING_MINUTES"];
const out = [];
const G = { d: null, root: null, base: null, store: null, saved: null, n: 0 };
const note = (s) => console.error(`# ${s}`);
const wall = () => new Date().toISOString();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const countOf = (sql, ...args) => G.store.db.prepare(sql).get(...args).n;
const idRows = (id) => countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ?", id);
const rowsAfter = (mark, id) => G.store.db.prepare("SELECT verdict, reason_code, run_id, tool_call_id FROM decisions WHERE rowid > ? AND entry_id = ? ORDER BY rowid").all(mark, id).map((r) => ({ ...r }));
const decisionMark = () => G.store.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM decisions").get().m;
const pair = (r) => r.map((x) => `${x.verdict}/${x.reason_code}`).join(",");
const nullIds = (r) => r.every((x) => x.run_id === null && x.tool_call_id === null);
/** A fresh identity per line (the sharing of a window would make line N depend on line N-1). */
const whoFor = (n) => ({ chat: `gate-r1-chat-${n}`, actor: `gate-r1-actor-${n}` });
const gateway = (caps = {}) => new G.d.Gateway(G.store, { ...G.d.DEFAULT_GLOBAL_BUDGET_CAPS, runs: BIG, tool_calls: BIG, gated_attempts: BIG, ...caps });
const send = (gw, who, o) => gw.intake(intakeEvent(G.d, who, o), wall());

function verdict(n, name, ok, detail) {
  out.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${name} — ${redactForPrint(detail)}`);
}
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AssertionError"]);
/** A thrown value prints as its standard class name only, never its message. */
const errCode = (e) => (e instanceof Error ? (ERROR_NAMES.has(e.name) ? e.name : "<other>") : "non-Error");
async function runLine(n, name, fn) {
  try { const r = await fn(); verdict(n, name, r.ok, r.detail); } catch (e) { verdict(n, name, false, `threw: ${errCode(e)}`); }
}
/** console.error captured (not printed) while `fn` runs; the lines are counted, never echoed. */
async function captured(fn) {
  const real = console.error; const seen = [];
  console.error = (...a) => { seen.push(a.map(String).join(" ")); };
  try { return { value: await fn(), seen }; } finally { console.error = real; }
}

// ---- the live-DB copy ----
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** VACUUM INTO `to` from `from` (read-only source). The daemon writes the live DB: a lock is retried 5 x 1 s. */
function vacuumInto(from, to) {
  for (let attempt = 1; ; attempt++) {
    const src = new DatabaseSync(from, { readOnly: true });
    try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); return; }
    catch (e) { rmSync(to, { force: true }); if (attempt >= 5 || !/locked|busy/i.test(String(e))) throw new SetupError("VACUUM INTO failed (detail withheld)"); sleepSync(1_000); }
    finally { src.close(); }
  }
}

// ---- line 1 and 2: the rate limit and its exemption ----
async function line1() {
  const who = whoFor(1); const mark = decisionMark();
  saturateWindow(G.store, who, "turn", 5, wall());
  const r = send(gateway(), who, { key: "l1-sixth" });
  const rows = rowsAfter(mark, "intake.rate_limit");
  const denied = countOf("SELECT COUNT(*) AS n FROM telegram_command_audit WHERE actor_id = ? AND decision = 'denied'", who.actor);
  G.line1 = { code: r.error?.code, message: r.error?.message };
  const ok = r.ok === false && r.error?.code === "TELEGRAM_RATE_LIMITED" && pair(rows) === "limit/command_window" && rows.length === 1 && nullIds(rows) && denied >= 1;
  return { ok, detail: `code ${r.error?.code} · rows ${rows.length} [${pair(rows)}] (want 1 [limit/command_window]) · run_id/tool_call_id null ${nullIds(rows)} · denied audit rows ${denied}` };
}
async function line2() {
  const who = whoFor(2); const gw = gateway();
  saturateWindow(G.store, who, "turn", 5, wall());
  const mark = decisionMark();
  const r = send(gw, who, { type: "kill", key: "l2-kill" });
  const rows = rowsAfter(mark, "intake.rate_limit");
  const here = [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")].filter(existsSync).length;
  const pinned = existsSync(process.env.HOUGE_TOMBSTONE_PATH);
  const ok = r.error?.code !== "TELEGRAM_RATE_LIMITED" && rows.length === 0 && here === 0;
  return { ok, detail: `code ${r.ok ? "ok" : r.error?.code} · intake.rate_limit rows ${rows.length} (want 0) · houge.kill in cwd/main checkout ${here} (want 0) · tombstone at pinned path ${pinned}` };
}

// ---- lines 3 and 4: the rating reply ----
async function line3() {
  const who = whoFor(3); const gw = gateway(); const mark = decisionMark();
  seedAsk(G.store, who, wall(), 10, true);
  const first = send(gw, who, { goal: "3", key: "l3-digit" });
  const acks = countOf("SELECT COUNT(*) AS n FROM notification_outbox WHERE idempotency_key = ?", "t:l3-digit:rating");
  const again = send(gw, who, { goal: "3", key: "l3-digit" });
  const rows = rowsAfter(mark, "intake.rating_reply");
  const ok = first.ok && first.status === "rating_captured" && acks === 1 && same(first, again) && pair(rows) === "consume/bare_digit" && rows.length === 1 && nullIds(rows);
  return { ok, detail: `status ${first.status} · :rating acks ${acks} (want 1) · replay same result ${same(first, again)} · rows ${rows.length} [${pair(rows)}] (want 1 [consume/bare_digit])` };
}
async function line4() {
  const who = whoFor(4); const gw = gateway(); const mark = decisionMark();
  seedAsk(G.store, who, wall(), 10, true);
  const comment = send(gw, who, { goal: "2，synthetic", key: "l4-comment" });
  const afterComment = rowsAfter(mark, "intake.rating_reply");
  seedAsk(G.store, who, wall(), 10, true);
  const activeBefore = G.store.getPendingRating(who.chat)?.active;
  const plain = send(gw, who, { goal: "synthetic ordinary sentence", key: "l4-plain" });
  const activeAfter = G.store.getPendingRating(who.chat)?.active;
  const rows = rowsAfter(mark, "intake.rating_reply");
  const ok = comment.ok && comment.status === "created" && same(afterComment.map((x) => `${x.verdict}/${x.reason_code}`), ["forward/digit_comment"])
    && plain.ok && Number(activeBefore) === 1 && Number(activeAfter) === 0 && pair(rows) === "forward/digit_comment,lapse/not_rating" && nullIds(rows);
  return { ok, detail: `comment status ${comment.status} · plain status ${plain.status} · ask active ${activeBefore} -> ${activeAfter} (want 1 -> 0) · rows ${rows.length} [${pair(rows)}] (want forward/digit_comment,lapse/not_rating)` };
}

// ---- line 5: the budget fuse ----
const fuseAlerts = () => countOf("SELECT COUNT(*) AS n FROM notification_outbox WHERE idempotency_key LIKE 'global-budget-fuse:%'");
const latched = () => countOf("SELECT COUNT(*) AS n FROM global_budget_fuse_state WHERE id = 1 AND fused = 1") === 1;
async function line5() {
  const who = whoFor(5); const gw = gateway({ runs: 0 }); const mark = decisionMark();
  const wasLatched = latched(); const alerts0 = fuseAlerts();
  const first = send(gw, who, { key: "l5-a" });
  const alerts1 = fuseAlerts();
  const second = send(gw, who, { key: "l5-b" });
  const alerts2 = fuseAlerts();
  const rows = rowsAfter(mark, "intake.budget_fuse");
  const wantFirst = wasLatched ? 0 : 1;
  const ok = first.error?.code === "GLOBAL_BUDGET_FUSE" && second.error?.code === "GLOBAL_BUDGET_FUSE" && alerts1 - alerts0 === wantFirst && alerts2 === alerts1
    && rows.length === 2 && rows.every((x) => x.verdict === "refuse" && x.reason_code === "runs") && nullIds(rows);
  return { ok, detail: `case ${wasLatched ? "latched in the copy: no new alert, rows written" : "unlatched: one alert"} · codes ${first.error?.code},${second.error?.code} · fuse alerts +${alerts1 - alerts0} then +${alerts2 - alerts1} (want +${wantFirst} then +0) · rows ${rows.length} [${pair(rows)}] (want 2 [refuse/runs])` };
}

// ---- line 6: record faults ----
const openFailed = () => countOf("SELECT COUNT(*) AS n FROM incidents WHERE kind = 'decision_record_failed' AND subject = 'intake.rate_limit' AND state = 'open'");
const incidentAlertTargets = () => G.store.db.prepare("SELECT target_json FROM notification_outbox WHERE idempotency_key LIKE 'incident_opened:%'").all().map((r) => JSON.parse(r.target_json).chat_id);
/** The line-1 scenario on a fresh identity: five accepted turns, then a sixth. */
function sixthCommand(gw, n, gate = null) {
  const who = whoFor(n); saturateWindow(G.store, who, "turn", 5, wall());
  if (gate) gate();
  return send(gw, who, { key: `l${n}-sixth` });
}
const sameAsLine1 = (r) => r.ok === false && r.error?.code === G.line1.code && r.error?.message === G.line1.message;
async function line6() {
  const real = G.store.insertDecision.bind(G.store); let fired = 0;
  const inc0 = openFailed(); const targets0 = incidentAlertTargets().length;
  G.store.insertDecision = (...a) => { if (++fired === 1) throw new Error("gate fault: insertDecision"); return real(...a); };
  let faulted;
  try { faulted = await captured(() => sixthCommand(gateway(), "6a")); } finally { G.store.insertDecision = real; }
  const opened = openFailed() - inc0;
  const targets = incidentAlertTargets().slice(targets0);
  const gw = gateway(); gw.recorderCache = { record: () => { throw new Error("gate fault: record"); } };
  const inc1 = openFailed();
  const thrown = await captured(() => sixthCommand(gw, "6b"));
  const logged = thrown.seen.filter((l) => l.startsWith("decisions: intake.rate_limit record threw past the recorder")).length;
  const ok = fired >= 1 && opened === 1 && sameAsLine1(faulted.value) && targets.every((t) => t === STUB_CHAT)
    && openFailed() === inc1 && sameAsLine1(thrown.value) && logged === 1;
  return { ok, detail: `store fault ${fired >= 1 ? "once" : "never"}: incidents +${opened} (want 1), result same ${sameAsLine1(faulted.value)}, alerts queued ${targets.length} all to ${STUB_CHAT} ${targets.every((t) => t === STUB_CHAT)} | recorder throw: incidents +${openFailed() - inc1} (want 0), result same ${sameAsLine1(thrown.value)}, logged ${logged} (want 1)` };
}

// ---- line 7: /status ----
async function line7() {
  const sv = await import(join(DIST, "decisions/status-view.js"));
  const now = wall(); const since = new Date(Date.parse(now) - 24 * 3_600_000).toISOString();
  const lines = sv.decisionStatusLines(G.store, now);
  const parts = []; let ok = true;
  for (const id of IDS) {
    const mine = lines.filter((l) => l.startsWith(`· ${id} `));
    const shown = mine.length === 1 ? Number(/^· \S+ (\d+) — /.exec(mine[0])?.[1] ?? NaN) : NaN;
    const inWindow = countOf("SELECT COUNT(*) AS n FROM decisions WHERE entry_id = ? AND created_at >= ? AND created_at <= ?", id, since, now);
    if (!(mine.length === 1 && inWindow > 0 && shown === inWindow)) ok = false;
    parts.push(`${id} lines ${mine.length}, count ${Number.isNaN(shown) ? "none" : shown} (window ${inWindow})`);
  }
  return { ok, detail: parts.join(" · ") };
}

// ---- line 8: the lock ----
async function line8() {
  const reg = await import(join(DIST, "decisions/registry.js"));
  const move = (entry_id) => G.store.insertLadderMove({ entry_id, scope: "g", from_rung: "paco", to_rung: "rule", evidence: [], granted_by: "paco", granted_via: "gate", paco_callback_id: "cb", revocable: true });
  const before = countOf("SELECT COUNT(*) AS n FROM ladder_moves WHERE entry_id = 'intake.budget_fuse'");
  let code = "not refused";
  try { move("intake.budget_fuse"); } catch (e) { code = e?.code ?? errCode(e); }
  const after = countOf("SELECT COUNT(*) AS n FROM ladder_moves WHERE entry_id = 'intake.budget_fuse'");
  const e = reg.entryById("intake.budget_fuse");
  const ok = code === "locked_entry" && after === before && e?.locked === true;
  return { ok, detail: `insertLadderMove(intake.budget_fuse) -> ${code} (want locked_entry) · ladder_moves rows ${before} -> ${after} · registry locked ${e?.locked}` };
}

// ---- main ----
function pinEnv(root) {
  G.saved = Object.fromEntries(PINNED.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_TELEGRAM_CHAT_ID: STUB_CHAT });
  delete process.env.HOUGE_RATING_PENDING_MINUTES;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(G.saved ?? {})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  G.saved = null;
}
async function setup() {
  const liveDb = resolve(arg("--live-db") ?? join(dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env"))), "houge.sqlite"));
  if (!existsSync(liveDb)) throw new SetupError("live DB not found (--live-db <path>)");
  for (const p of [join(process.cwd(), "houge.kill"), join(MAIN_CHECKOUT, "houge.kill")]) if (existsSync(p)) throw new SetupError("a houge.kill tombstone already exists: refusing to run");
  const root = initTemp(false); G.root = root;
  pinEnv(root);
  G.base = join(root, "houge.sqlite");
  vacuumInto(liveDb, G.base);
  G.d = await loadDist(DIST);
  for (const k of ["storeOptionsFor", "RunStore", "Gateway", "buildTypedTaskEvent", "DEFAULT_GLOBAL_BUDGET_CAPS"]) if (!G.d[k]) throw new SetupError(`${k} missing from dist: rebuild`);
  G.store = G.d.RunStore.open(G.base, G.d.storeOptionsFor(undefined, {}));
  mkdirSync(join(root, "work"), { recursive: true });
  const prior = IDS.map((id) => idRows(id));
  if (prior.some((n) => n !== 0)) note("the copy already holds rows of a new id (counts are taken as deltas)");
}
function closeAll() { try { G.store?.close(); } catch { /* a closed handle is not a finding */ } G.store = null; }
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(sig, () => { closeAll(); cleanupTemp(); restoreEnv(); process.exit(code); });

try {
  await setup();
  const lines = [[1, "sixth command limited", line1], [2, "kill exempt", line2], [3, "bare digit consumed", line3], [4, "digit+comment forwarded, plain lapses", line4],
    [5, "budget fuse", line5], [6, "record faults", line6], [7, "/status lines", line7], [8, "budget_fuse lock", line8]];
  for (const [n, name, fn] of lines) await runLine(n, name, fn);
  const passed = out.filter(Boolean).length;
  note(`${passed}/8 PASS`);
  process.exitCode = out.length === 8 && passed === 8 ? 0 : 1;
} catch (e) {
  console.error(`setup error: ${e instanceof SetupError ? e.message : "withheld"}`);
  process.exitCode = 2;
} finally {
  const root = G.root;
  closeAll();
  cleanupTemp();
  restoreEnv();
  if (root) note(`temp root ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
