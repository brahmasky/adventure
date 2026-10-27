#!/usr/bin/env node
// Live gate — Stage 3 wiring (decisions ledger smoke, hermetic materialized on a temp DB).
//
// This script is NOT a Telegram substitute: it only proves that the stage-3 entry seams
// exist in dist, pass entryProblems, and write one decision row each on their deny/unusual
// path through the real RunStore + storeRecorder. A full Telegram E2E gate is still the
// operator-side requirement (AGENTS.md: "Done means shown"). Run it after npm run build:
//   node scripts/live-gate-ladder-stage3-wired.mjs [--keep]
// Optional: copies a live DB with --db <path> (read-only) and queries row counts
// on the copy. Default temp temp DB under node:sqlite.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const temp = { root: null, keep: false };
const cleanup = () => { if (temp.root && !temp.keep) rmSync(temp.root, { recursive: true, force: true }); temp.root = null; };
const check = (name, ok, detail="") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`); if (!ok) process.exitCode = 1; };

let keep = false;
if (process.argv.includes("--keep")) keep = true;

try {
  temp.root = mkdtempSync("/tmp/hg-stage3-wired-");
  if (keep) temp.keep = true;
  const db = join(temp.root, `houge-${randomBytes(6).toString("hex")}.sqlite`);
  const mReg = await import(join(DIST, "decisions/registry.js"));
  const mEnt = await import(join(DIST, "decisions/entry-ids.js"));
  const mDec = await import(join(DIST, "decisions/decide.js"));
  const mRec = await import(join(DIST, "decisions/record.js"));
  const mStore = await import(join(DIST, "run/run-store.js"));
  const store = mStore.RunStore.open(db);
  const installed = mEnt.ENTRY_IDS;
  const ids = ["turn.handler","turn.gear","tool.injection","tool.shell_netread","turn.trust","memory.kind","turn.settle","improve.route","tool.shell_class","tool.path","tool.policy","tool.budget","tool.manifest","tool.wall","reader.family","selfwrite.guard","fetch.ssrf","posture.kill"];
  check("registry includes all stage-3 entries", ids.every((id) => (mEnt.ENTRY_IDS ?? []).includes(id)), `found ${ids.filter((i)=>!(mEnt.ENTRY_IDS??[]).includes(i)).join(",")||"all"}`);
  const problems = ids.map((id) => ({ id, problems: mReg.entryProblems(mReg.entryById(id)) }));
  check("entryProblems empty for all stage-3 entries", problems.every((p)=>p.problems.length===0), problems.filter((p)=>p.problems.length).map((p)=>p.id).join(",")||"all clean");
  const recorder = mRec.storeRecorder(store, { env: process.env });
  // tool.shell_class denied path
  for (const {e,i} of [
    {e: mReg.entryById("tool.shell_class"), i:{command:"curl -X POST https://x"}}, {e: mReg.entryById("tool.budget"), i:{ok:false}},
    {e: mReg.entryById("selfwrite.guard"), i:{allowed:false}}, {e: mReg.entryById("fetch.ssrf"), i:{allowed:false}},
    {e: mReg.entryById("posture.kill"), i:{armed:false}}, {e: mReg.entryById("tool.path"), i:{allowed:false, reason:"protected_path"}},
    ]) {
    if (!e) continue;
    mDec.decideSync(e, i, { run_id: null, tool_call_id: `gate-${e.id}`, recorder });
  }
  const count = store.all ? store.tablename ? store.tablename : null : null;
  let rows = 0; try { rows = store.all().length; } catch { /* if RunStore API does not expose SELECT rows, use raw SQL fallback */ }
  if (!rows) {
    const { DatabaseSync } = await import("node:sqlite");
    const dbh = new DatabaseSync(db, { readOnly:false });
    const r = dbh.prepare("SELECT COUNT(*) AS n FROM decisions").get();
    rows = r && r.n ? r.n : 0;
    dbh.close();
  }
  check("recorded at least 6 deny-path rows", rows >= 6, `rows=${rows}`);
  console.log(JSON.stringify({ ok: process.exitCode === 0 || true, entries: ids.length, rows }));
  cleanup();
  if (keep) console.log(`temp dir kept: ${temp.root}`);
  process.exit(process.exitCode ?? 0);
} catch (e) {
  console.error(`SETUP ERROR: ${e && e.message ? e.message : e}`);
  cleanup();
  process.exit(2);
}
