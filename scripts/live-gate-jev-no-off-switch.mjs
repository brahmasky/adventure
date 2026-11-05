#!/usr/bin/env node
// Live gate — the Jev front door has no off switch (spec 2026-11-05 §9; ADR 0034 1.6 / R13).
// Runs against the REAL .env and the REAL committed calibration, on a TEMP COPY of the live DB (VACUUM INTO). The live DB
// is only read. No Telegram (the three names are deleted after loadHougeEnv), no omp (checks 1-5 need no planner).
//
//   npm run build && HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-jev-no-off-switch.mjs [--db <path>] [--keep]
//
//   1  the real .env arms the front door: resolveJevFrontDoor = { arm, armed }
//   2  the retired flags change nothing: TRIAGE=off + LANES_OFF=answer still resolve arm; the boot warning names both
//      (two lines); treeArmed on the live calibration rows and the copy's arming still arms `answer`
//   3  a houge.jev-disarmed marker disarms and is NAMED in collectHougeStatus/renderHougeStatus and in the gateway /status reply
//   4  HOUGE_JEV_ENABLED=0 -> env_off; plus a posture file -> disarmed
//   5  one status-lane turn through the real Jev (the one metered leg): lane_reply, act, zero compose attempts, one
//      turn.handler decisions row (system_one|model, armed_mode on), answered jev_decisions rows all `act`, nothing shadow
// Exit: 0 PASS · 1 FAIL · 2 setup error.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const STATUS_Q = "你刚才重启过吗？现在跑的是哪个版本？"; // the live-gate-jev-tree status case

function parseArgs(argv) {
  const a = { db: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--keep") a.keep = true;
    else if (argv[i] === "--db") a.db = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

async function loadModules() {
  const mods = await Promise.all([
    "config/load-env.js", "config/disarm-posture.js", "core/core-worker.js", "domain/types.js", "gateway/gateway.js", "run/run-store.js",
    "jev/jev-client.js", "jev/jev-flags.js", "jev/questions/tree.js", "jev/questions/types.js", "jev/calibration.js", "decisions/jev-version-check.js", "status/houge-status.js"
  ].map((p) => import(`../dist/${p}`)));
  const m = Object.assign({}, ...mods);
  const need = ["loadHougeEnv", "DISARM_FLAGS", "CoreWorker", "buildTypedTaskEvent", "Gateway", "RunStore", "createJevClient", "toJevQuestion", "TREE_QUESTIONS",
    "resolveJevFrontDoor", "warnRetiredJevFlags", "RETIRED_JEV_FLAGS", "jevDisarmMarkerPath", "treeArmed", "treeArmingFor", "calibrationRows",
    "collectHougeStatus", "renderHougeStatus"];
  const missing = need.filter((n) => m[n] === undefined);
  if (missing.length > 0) throw new Error(`dist/ lacks ${missing.join(", ")} (build the branch first)`);
  return m;
}

/** One real Jev call for the model id the alias currently reports (calibration rows key on it). */
async function probeReportedModel(m) {
  const mem = m.RunStore.openInMemory();
  try {
    const jev = m.createJevClient({ apiKey: process.env.TYPESAFE_API_KEY, audit: mem.llmAuditSink({ correlation_id: "gate:jev-probe", role: "" }),
      meteredBreached: () => false, retries: 1, timeoutMs: 15_000 });
    const questions = Object.fromEntries(m.TREE_QUESTIONS.map((q) => [q.id, m.toJevQuestion(q)]));
    const r = await jev({ state: { latest_message: "hello" }, questions });
    if (!r.ok) throw new Error(`model probe failed: ${r.reason}`);
    return r.model;
  } finally { mem.close(); }
}

/** No Telegram, markers inside the temp root. Every DISARM flag but HOUGE_JEV_ENABLED is forced off (check 1 reads that one from the real .env). No calibration file and no HOUGE_JEV_GATE: check 1 must say something about the real .env. */
function gateEnv(m, root) {
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  for (const f of m.DISARM_FLAGS) if (f !== "HOUGE_JEV_ENABLED") process.env[f] = "false";
  Object.assign(process.env, {
    HOUGE_EPISODIC_ENABLED: "false", HOUGE_TOMBSTONE_PATH: join(root, "houge.kill"), HOUGE_PARK_MARKER_PATH: join(root, "houge.parked"),
    HOUGE_DISARM_PATH: join(root, "houge.disarm"), HOUGE_JEV_DISARM_PATH: join(root, "houge.jev-disarmed")
  });
}

function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/** Strict: the copy as it stands must arm the reported model (no seed): the live state is what is being proved. */
function ensureModelArmed(m, store) {
  const a = m.treeArmingFor(store, { model: m.model }, "zh");
  const ok = m.TREE_QUESTIONS.every((q) => a.questions.has(q.id)) && a.lanesDisarmed.size === 0;
  check("setup: treeArmingFor arms the reported model on the copy", ok, `state ${store.getJevModel(m.model)?.state ?? "none"}`);
  return ok;
}

const same = (r, mode, cause) => r.mode === mode && r.cause === cause;

function check1(g) {
  const r = g.m.resolveJevFrontDoor(process.env, g.root);
  check("1 the real .env arms the front door", same(r, "arm", "armed"), `${r.mode}/${r.cause}`);
}

function check2(g) {
  const env = { ...process.env, HOUGE_JEV_TRIAGE_ENABLED: "off", HOUGE_JEV_LANES_OFF: "answer" };
  const r = g.m.resolveJevFrontDoor(env, g.root);
  check("2 TRIAGE=off + LANES_OFF=answer: the front door is still armed", same(r, "arm", "armed"), `${r.mode}/${r.cause}`);
  const lines = [];
  const warned = g.m.warnRetiredJevFlags(env, (l) => lines.push(l));
  check("2 the boot warning names both retired flags, one line each", lines.length === 2 && warned.length === 2 && g.m.RETIRED_JEV_FLAGS.every((n) => warned.includes(n)), `lines=${lines.length}`);
  const rows = g.m.calibrationRows(env);
  const armed = g.m.treeArmed("zh", rows, g.m.treeArmingFor(g.store, { model: g.m.model }, "zh"));
  check("2 treeArmed still arms `answer` on the live rows", armed.answer === true, `answer=${armed.answer} status=${armed.status}`);
}

const MARKER_LINE = "houge.jev-disarmed marker";

function statusReply(g) {
  const key = `gate-nos-${Date.now()}`;
  const gw = new g.m.Gateway(g.store, undefined, undefined, undefined, undefined, { dataDir: g.root });
  const r = gw.intake(g.m.buildTypedTaskEvent({ source: "telegram", type: "status", requested_by: { kind: "user", id: "gate" },
    notify: { kind: "telegram", chat_id: g.chat }, idempotency_key: `telegram:${key}`, source_reference: `telegram:update:${key}` }));
  if (!r.ok) throw new Error("status intake failed");
  const db = new DatabaseSync(g.dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT payload_json FROM notification_outbox WHERE idempotency_key = ?").get(`telegram:${key}:status`);
    return row ? JSON.parse(row.payload_json).text ?? "" : "";
  } finally { db.close(); }
}

function check3(g) {
  const path = g.m.jevDisarmMarkerPath(process.env, g.root);
  check("3 the marker path lies under the temp root", path.startsWith(g.root), "path redacted");
  writeFileSync(path, JSON.stringify({ reason: "gate", at: new Date().toISOString() }));
  try {
    const r = g.m.resolveJevFrontDoor(process.env, g.root);
    check("3 a marker disarms the front door", same(r, "off", "disarm_marker"), `${r.mode}/${r.cause}`);
    const text = g.m.renderHougeStatus(g.m.collectHougeStatus({ store: g.store, env: process.env, dataDir: g.root, chatId: g.chat, pid: process.pid }));
    check("3 the status text names the marker", text.includes(MARKER_LINE));
    check("3 the gateway /status reply names the marker", statusReply(g).includes(MARKER_LINE));
  } finally { rmSync(path, { force: true }); }
}

function check4(g) {
  const off = { ...process.env, HOUGE_JEV_ENABLED: "0" };
  const a = g.m.resolveJevFrontDoor(off, g.root);
  check("4 HOUGE_JEV_ENABLED=0 -> env_off", same(a, "off", "env_off"), `${a.mode}/${a.cause}`);
  const posture = join(g.root, "houge.disarm"); // process.env.HOUGE_DISARM_PATH, under the temp root
  writeFileSync(posture, "");
  try {
    const b = g.m.resolveJevFrontDoor(off, g.root);
    check("4 HOUGE_JEV_ENABLED=0 + posture file -> disarmed", same(b, "off", "disarmed"), `${b.mode}/${b.cause}`);
  } finally { rmSync(posture, { force: true }); }
}

const rowsOf = (dbPath, sql, ...p) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(...p); } finally { db.close(); }
};

async function check5(g) {
  const worker = new g.m.CoreWorker(g.store, g.repo, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, { dataDir: g.root, distDir: DIST });
  const msg = 9_000_000 + Math.floor(Math.random() * 1_000_000); const upd = 8_000_000_000 + msg;
  const r = new g.m.Gateway(g.store, undefined, undefined, undefined, undefined, { dataDir: g.root }).intake(g.m.buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: STATUS_Q, requested_by: { kind: "user", id: "gate" },
    notify: { kind: "telegram", chat_id: g.chat }, idempotency_key: `telegram:${upd}:${msg}`, source_reference: `telegram:update:${upd}:message:${msg}`,
    metadata: { telegram_update_id: upd, telegram_message_id: msg } }));
  if (!r.ok || !r.run_id) { check("5 intake", false); return; }
  const claim = g.store.claimRun(r.run_id, `planner:gate:${r.run_id}`, 300);
  if (!claim) { check("5 claim", false); return; }
  worker.buildOmpTools(claim);
  try {
    const out = await worker.triageTurn({ claim, text: STATUS_Q, userText: STATUS_Q, modality: "text", posture: null, signal: new AbortController().signal });
    const v = g.store.getJevVerdictForRun(r.run_id);
    check("5 status turn: lane_reply and act", out.kind === "lane_reply" && v?.handler_outcome === "lane_reply" && v?.route_outcome === "act",
      `kind=${out.kind} lane=${v?.lane} handler=${v?.handler_outcome} route=${v?.route_outcome}`);
    const compose = g.store.getLedgerEvents(r.run_id).filter((e) => e.event_type === "llm_attempt" && e.payload.role === "compose").length;
    check("5 zero compose attempts", compose === 0, `compose=${compose}`);
    const th = rowsOf(g.dbPath, "SELECT rung, armed_mode FROM decisions WHERE run_id = ? AND entry_id = 'turn.handler'", r.run_id);
    check("5 one turn.handler decisions row: system_one|model, armed_mode on", th.length === 1 && ["system_one", "model"].includes(th[0].rung) && th[0].armed_mode === "on",
      th.map((x) => `${x.rung}/${x.armed_mode}`).join(","));
    const jd = rowsOf(g.dbPath, "SELECT status, decision FROM jev_decisions WHERE run_id = ?", r.run_id).filter((x) => x.status === "answered");
    check("5 at least one answered jev_decisions row, every one `act`", jd.length >= 1 && jd.every((x) => x.decision === "act"), jd.map((x) => x.decision).join(","));
    const sh1 = rowsOf(g.dbPath, "SELECT COUNT(*) AS n FROM decisions WHERE run_id = ? AND armed_mode = 'shadow'", r.run_id)[0].n;
    const sh2 = rowsOf(g.dbPath, "SELECT COUNT(*) AS n FROM jev_decisions WHERE run_id = ? AND decision = 'shadow'", r.run_id)[0].n;
    check("5 zero shadow rows written by this run", sh1 === 0 && sh2 === 0, `decisions=${sh1} jev_decisions=${sh2}`);
  } finally { await worker.shutdownPlanners(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const m = await loadModules();
  m.loadHougeEnv();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set (HOUGE_ENV_FILE?)");
  const repo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(process.cwd(), ".env")));
  const live = resolve(args.db ?? join(repo, "houge.sqlite"));
  if (!existsSync(live)) throw new Error("no live DB to copy (pass --db)");
  m.model = await probeReportedModel(m);
  const root = mkdtempSync("/tmp/hg-nos-");
  gateEnv(m, root);
  const dbPath = join(root, "houge.sqlite");
  copyDb(live, dbPath);
  const store = m.RunStore.open(dbPath);
  const g = { m, store, root, dbPath, repo, chat: `-1000${Date.now() % 100000}` };
  try {
    console.log(`jev no-off-switch live gate — temp copy under ${root}, reported model ${m.model}\n`);
    check1(g);
    if (ensureModelArmed(m, store)) { check2(g); check3(g); check4(g); await check5(g); }
  } finally { store.close(); }
  console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
  if (args.keep || failures.length > 0) console.log(`temp dir kept: ${root}`); else rmSync(root, { recursive: true, force: true });
  return failures.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
