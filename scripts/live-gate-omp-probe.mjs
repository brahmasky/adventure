#!/usr/bin/env node
// Live gate — omp contract probe and the cached version check (spec 2026-10-09-omp-contract-probe §7; plan Task 7).
// Runs the REAL omp (profile houge, Seatbelt sandbox ON) against a TEMP COPY of the live DB (VACUUM INTO). The live DB
// is only read; the daemon is never touched; no dispatcher runs, so a drift page only lands in the copy's outbox.
//
//   npm run build && HOUGE_ENV_FILE=/abs/.env node scripts/live-gate-omp-probe.mjs [--db <path>] [--keep]
//
// Steps (PASS needs all four; any other outcome FAILs):
//   1  probeNow on the real omp → pass, all 7 checks pass (effort skipped only for a single-level Tiny model),
//      usage.output_tokens > 0, exactly one more omp_contract_probe row, no open omp_contract_drift.
//   2  HOUGE_OMP_BIN → a bash wrapper that execs the real omp and rewrites "not found" to "is unknown" on stderr →
//      fail, start_refusal fail:unclassified while session_open, pin_refusal and prompt still pass (the wrapper works,
//      so the fail is the rewording alone); one open omp_contract_drift omp:<version>; one more outbox row.
//   3  The same wrapper without the rewrite logs each argv. Fresh shared cache; three spawnOneShot calls on the bogus
//      chain through the real default (no versionCheck) → exactly 1 `--version`; touch the wrapper; one more → 2.
//      Each call must fail on the bogus model itself: one audited leg, error_kind model_missing.
//   4  The daemon path, on a SECOND fresh copy with this version's probe rows deleted (only in the copy, so the
//      gate re-runs after the live daemon has recorded a PASS for the installed omp): real omp, cleared shared caches, the real
//      runner with currentVersion = cache.lastVersion() as the shared cache's new-version listener (as telegram-daemon
//      wires it). One bogus spawnOneShot through the real default → exactly one new omp_contract_probe row, result pass
//      (polled, bounded 120 s); a second bogus call → no further probe and no further row.
//
// Temp root under /private/tmp (Seatbelt denies os.tmpdir() = /private/var/folders). The wrapper sits in its own bin/
// (binDirs are write-denied to the sandbox), its log at the root, the data dir at <root>/data.
// Budget: steps 1, 2 and 4 each send ONE tiny prompt on the Tiny role (flat-rate subscription); step 3 sends none.
// Exit: 0 PASS · 1 FAIL · 2 setup error.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const failures = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const BOGUS = { provider: "houge-probe", model: "no-such-model" };

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
    "config/load-env.js", "run/run-store.js", "omp/omp-config.js", "omp/role-resolver.js", "omp/model-catalog.js",
    "omp/protected-paths.js", "omp/omp-version-cache.js", "omp/omp-probe-runner.js", "omp/omp-contract-probe.js", "llm/providers/omp.js"
  ].map((p) => import(`../dist/${p}`)));
  const m = Object.assign({}, ...mods);
  const need = ["loadHougeEnv", "RunStore", "resolveOmpConfig", "resolveOmpCatalogConfig", "RoleResolver", "readOmpCatalog",
    "installedBinaryDirs", "sharedOmpVersionCache", "setSharedOmpVersionCacheForTest", "createOmpProbeRunner", "runOmpContractProbe", "OMP_CONTRACT_DRIFT", "spawnOneShot"];
  const missing = need.filter((n) => m[n] === undefined);
  if (missing.length > 0) throw new Error(`dist/ lacks ${missing.join(", ")} (build the branch first)`);
  return m;
}

/** A consistent snapshot of the live DB through a read-only connection (WAL-safe; the daemon may be running). */
function copyDb(from, to) {
  const src = new DatabaseSync(from, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
}

/** The real omp the wrapper execs: PATH lookup, then realpath (~/.bun/bin/omp → the package's cli.js). */
function realOmpPath() {
  const hit = execFileSync("/usr/bin/which", ["omp"], { encoding: "utf8" }).trim();
  if (!hit) throw new Error("omp is not on PATH");
  return realpathSync(hit);
}

/** The wrapper text with every path baked in (the child env allowlist would drop extra env vars). */
function writeWrapper(g, rewrite) {
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const text = ["#!/bin/bash", `echo "$*" >> ${q(g.log)}`,
    `if [ "$1" = "--version" ] || [ '${rewrite ? 1 : 0}' = 0 ]; then exec ${q(g.realOmp)} "$@"; fi`,
    `exec ${q(g.realOmp)} "$@" 2> >(sed -u 's/not found/is unknown/' >&2)`, ""].join("\n");
  writeFileSync(g.wrapper, text);
  chmodSync(g.wrapper, 0o755);
}

const count = (ro, sql, ...p) => ro.prepare(sql).get(...p).n;
const probeRows = (g, ro = g.ro) => count(ro, "SELECT COUNT(*) AS n FROM ledger_events WHERE event_type = 'omp_contract_probe'");
const outboxRows = (g) => count(g.ro, "SELECT COUNT(*) AS n FROM notification_outbox");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openDrift = (g) => g.store.listOpenIncidents().filter((i) => i.kind === g.m.OMP_CONTRACT_DRIFT);
const versionLines = (g) => readFileSync(g.log, "utf8").split("\n").filter((l) => l === "--version").length;

/** What the CLI composes (omp-probe-cli.ts), re-read from the current env: roles on the real catalog, cfg, ctx, version. */
async function compose(g, store = g.store) {
  const env = process.env;
  const roles = new g.m.RoleResolver({ store, readCatalog: () => g.m.readOmpCatalog(g.m.resolveOmpCatalogConfig(env)) });
  if (!(await roles.refreshCatalog())) throw new Error("RoleResolver.refreshCatalog failed against the real omp");
  const cfg = g.m.resolveOmpConfig(env, roles.chains());
  if (!cfg.sandbox) throw new Error("HOUGE_OMP_SANDBOX is off: the gate must prove the probe under Seatbelt");
  const ctx = { home: homedir(), repo: REPO, data: g.data, binDirs: g.m.installedBinaryDirs(env, process.execPath) };
  const v = await g.m.sharedOmpVersionCache(cfg).current();
  if (!v.ok) throw new Error(`omp version check failed (${v.kind})`);
  return { roles, cfg, ctx, version: v.version };
}

async function probe(g) {
  const c = await compose(g);
  const runner = g.m.createOmpProbeRunner({ store: g.store, cfg: c.cfg, ctx: c.ctx, roles: c.roles, currentVersion: () => c.version,
    signal: new AbortController().signal });
  const t0 = Date.now();
  const r = await runner.probeNow(c.version);
  const ms = Date.now() - t0;
  console.log(`  omp ${r.version} · model ${r.model ?? "none"} · result ${r.result} · ${ms} ms · usage ${JSON.stringify(r.usage)}`);
  console.log(`  checks ${JSON.stringify(r.checks)}`);
  return { r, c, ms };
}

/** Tiny's catalogued thinking levels for the probe model (effort may be skipped only when there is one). */
async function catalogLevels(g, model) {
  const cat = await g.m.readOmpCatalog(g.m.resolveOmpCatalogConfig(process.env));
  const sel = (model ?? "").split(":")[0];
  const hit = (cat ?? []).find((x) => `${x.provider}/${x.id}` === sel);
  return hit ? hit.thinking ?? [] : null;
}

async function step1(g) {
  console.log("\nstep 1 — real omp, probeNow");
  const rows0 = probeRows(g);
  const { r } = await probe(g);
  g.version = r.version; g.model = r.model;
  check("1 result pass", r.result === "pass", r.result);
  for (const [name, o] of Object.entries(r.checks)) {
    if (name === "effort" && o === "skipped") {
      const levels = await catalogLevels(g, r.model);
      console.log(`  effort skipped; catalogued levels for ${r.model}: ${JSON.stringify(levels)}`);
      check("1 check effort skipped only on a single-level model", Array.isArray(levels) && levels.length <= 1, JSON.stringify(levels));
    } else check(`1 check ${name} pass`, o === "pass", o);
  }
  check("1 usage.output_tokens > 0", (r.usage?.output_tokens ?? 0) > 0, JSON.stringify(r.usage));
  check("1 exactly one more omp_contract_probe row", probeRows(g) - rows0 === 1, `${rows0} → ${probeRows(g)}`);
  check("1 no open omp_contract_drift", openDrift(g).length === 0, `${openDrift(g).length} open`);
}

async function step2(g) {
  console.log("\nstep 2 — wrapper rewrites the start refusal on stderr");
  writeWrapper(g, true);
  writeFileSync(g.log, "");
  process.env.HOUGE_OMP_BIN = g.wrapper;
  g.m.setSharedOmpVersionCacheForTest(null);
  const out0 = outboxRows(g); const drift0 = openDrift(g).length;
  const { r } = await probe(g);
  check("2 wrapper ran omp (argv logged)", readFileSync(g.log, "utf8").trim().length > 0);
  check("2 probed the same version", r.version === g.version, `${r.version} vs ${g.version}`);
  check("2 result fail", r.result === "fail", r.result);
  check("2 start_refusal fail:unclassified", r.checks.start_refusal === "fail:unclassified", r.checks.start_refusal);
  for (const k of ["session_open", "pin_refusal", "prompt"]) check(`2 ${k} pass (the wrapper itself works)`, r.checks[k] === "pass", r.checks[k]);
  const drift = openDrift(g);
  check(`2 one open omp_contract_drift omp:${r.version}`, drift0 === 0 && drift.length === 1 && drift[0].subject === `omp:${r.version}`,
    `before ${drift0}, after ${JSON.stringify(drift.map((i) => i.subject))}`);
  check("2 one more outbox row (the drift page)", outboxRows(g) - out0 === 1, `${out0} → ${outboxRows(g)}`);
}

/** One spawnOneShot on the bogus chain; PASS only when its one leg failed on the bogus model (code-built kind, not omp text). */
async function oneShot(g, cfg, label) {
  const t0 = Date.now();
  const legs = [];
  const r = await g.m.spawnOneShot({ seat: "gate", chain: [BOGUS], prompt: "Reply with exactly OK.", correlationId: `gate:omp-probe:${label}`,
    timeoutMs: 60_000 }, { cfg, audit: { record(a) { legs.push(a); } } });
  const ms = Date.now() - t0;
  const kinds = legs.map((a) => `${a.outcome}/${a.error_kind ?? "-"}`);
  const refused = r.ok === false && !r.unavailable && legs.length === 1 && legs[0].outcome === "error" && legs[0].error_kind === "model_missing"
    && r.error === `all gate legs failed — ${BOGUS.provider}/${BOGUS.model}: model_missing`;
  check(`${label} refused on the bogus model (model_missing), version check ok`, refused,
    `ok=${r.ok} unavailable=${!!r.unavailable} legs=${JSON.stringify(kinds)} ${ms} ms`);
}

async function step3(g) {
  console.log("\nstep 3 — version cache through spawnOneShot's real default");
  writeWrapper(g, false);
  writeFileSync(g.log, "");
  g.m.setSharedOmpVersionCacheForTest(null);
  const cfg = g.m.resolveOmpConfig(process.env);
  for (const n of [1, 2, 3]) await oneShot(g, cfg, `3 call ${n}`);
  check("3 three calls → exactly 1 --version", versionLines(g) === 1, `${versionLines(g)}`);
  const later = new Date(Date.now() + 2000);
  utimesSync(g.wrapper, later, later);
  await oneShot(g, cfg, "3 call 4");
  check("3 touch + one call → exactly 2 --version", versionLines(g) === 2, `${versionLines(g)}`);
}

/** The daemon's wiring (telegram-daemon startOmpProbe) on the step-4 copy; the real probe, its in-flight promise tracked. */
async function daemonWiring(g) {
  const c = await compose(g, g.store4);
  g.m.setSharedOmpVersionCacheForTest(null); // compose() warmed a cache with no listener; the daemon's starts cold
  const cache = g.m.sharedOmpVersionCache(c.cfg);
  const ac = new AbortController();
  const w = { c, cache, ac, calls: 0, inflight: null };
  const runner = g.m.createOmpProbeRunner({ store: g.store4, cfg: c.cfg, ctx: c.ctx, roles: c.roles,
    currentVersion: () => cache.lastVersion(), signal: ac.signal,
    probe: (i) => { w.calls += 1; w.inflight = g.m.runOmpContractProbe(i); return w.inflight; } });
  cache.setNewVersionListener((v) => runner.maybeProbe(v));
  return w;
}

async function step4(g) {
  console.log("\nstep 4 — daemon path: shared-cache listener → runner.maybeProbe, fired by spawnOneShot's real default");
  delete process.env.HOUGE_OMP_BIN; // the real omp, no wrapper
  g.m.setSharedOmpVersionCacheForTest(null);
  openCopy(g, "4", (db) => {
    const n = db.prepare("DELETE FROM ledger_events WHERE event_type = 'omp_contract_probe' AND json_extract(payload_json, '$.version') = ?").run(g.version).changes;
    console.log(`  copy: deleted ${n} omp_contract_probe row(s) for ${g.version}`);
  });
  if (g.store4.latestOmpProbe(g.version)) throw new Error(`the step-4 copy still holds a probe row for omp ${g.version}: step 4 cannot fire`);
  const rows0 = probeRows(g, g.ro4);
  const w = await daemonWiring(g);
  try {
    check("4 shared cache starts cold", w.cache.lastVersion() === null, String(w.cache.lastVersion()));
    await oneShot(g, w.c.cfg, "4 call 1");
    const t0 = Date.now();
    while (probeRows(g, g.ro4) === rows0 && Date.now() - t0 < 120_000) await sleep(500);
    await w.inflight?.catch(() => undefined);
    const row = g.store4.latestOmpProbe(g.version);
    console.log(`  row after ${Date.now() - t0} ms: result ${row?.result} · checks ${JSON.stringify(row?.checks)}`);
    check("4 exactly one new omp_contract_probe row, result pass", probeRows(g, g.ro4) - rows0 === 1 && row?.result === "pass",
      `${rows0} → ${probeRows(g, g.ro4)}, result ${row?.result}`);
    await oneShot(g, w.c.cfg, "4 call 2");
    await sleep(3_000); // a probe would start on the next tick; give it room to show
    check("4 second call: no further probe, no further row", w.calls === 1 && probeRows(g, g.ro4) - rows0 === 1,
      `probe calls ${w.calls}, rows ${rows0} → ${probeRows(g, g.ro4)}`);
  } finally {
    w.cache.setNewVersionListener(null);
    w.ac.abort(); // a probe still running (the 120 s bound hit) stops its children and removes its dirs
    await w.inflight?.catch(() => undefined);
  }
}

/** A fresh VACUUM copy of the live DB under the temp root, with a store and a read-only handle (suffix "" or "4").
 *  `prepare` edits the copy before the store opens it; it never sees the live DB. */
function openCopy(g, suffix = "", prepare) {
  const path = join(g.root, `houge${suffix}.sqlite`);
  copyDb(g.live, path);
  if (prepare) {
    if (resolve(path) === resolve(g.live) || !resolve(path).startsWith(`${g.root}/`)) throw new Error(`refusing to edit ${path}: not a temp copy`);
    const db = new DatabaseSync(path);
    try { prepare(db); } finally { db.close(); }
  }
  g[`dbPath${suffix}`] = path;
  g[`store${suffix}`] = g.m.RunStore.open(path);
  g[`ro${suffix}`] = new DatabaseSync(path, { readOnly: true });
}

async function setup(args) {
  const m = await loadModules();
  m.loadHougeEnv();
  if (!process.env.HOUGE_TELEGRAM_CHAT_ID?.trim()) process.env.HOUGE_TELEGRAM_CHAT_ID = "-1000000000000";
  delete process.env.HOUGE_TELEGRAM_BOT_TOKEN; // nothing here sends; belt and braces
  delete process.env.HOUGE_OMP_BIN; // step 1 is the real omp as PATH finds it
  delete process.env.HOUGE_OMP_SANDBOX; // sandbox on (the default)
  const envRepo = dirname(resolve(process.env.HOUGE_ENV_FILE ?? join(REPO, ".env")));
  const live = resolve(args.db ?? join(envRepo, "houge.sqlite"));
  if (!existsSync(live)) throw new Error(`no DB at ${live} (pass --db)`);
  const realOmp = realOmpPath();
  // Nothing that can throw runs between mkdtemp and main's try: the root will hold full copies of the live DB.
  const root = mkdtempSync("/private/tmp/houge-gate-omp-probe-");
  return { m, live, root, data: join(root, "data"), wrapper: join(root, "bin", "omp"), log: join(root, "wrapper.log"), realOmp };
}

function closeAll(g) {
  for (const h of [g.ro, g.store, g.ro4, g.store4]) {
    try { h?.close(); } catch (e) { console.error(`close failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const g = await setup(args);
  try {
    mkdirSync(g.data); mkdirSync(join(g.root, "bin"));
    openCopy(g);
    console.log(`omp contract probe live gate — copy ${g.dbPath}, real omp ${g.realOmp}, sandbox on`);
    for (const [name, fn] of [["step 1", step1], ["step 2", step2], ["step 3", step3], ["step 4", step4]]) {
      const t0 = Date.now();
      await fn(g);
      console.log(`  ${name} took ${Date.now() - t0} ms`);
    }
  } finally {
    closeAll(g);
    if (args.keep) console.log(`temp dir kept: ${g.root}`); else rmSync(g.root, { recursive: true, force: true });
  }
  console.log(failures.length === 0 ? "\nLIVE GATE: PASS" : `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}`);
  return failures.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(2); });
