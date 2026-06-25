#!/usr/bin/env node
// Live gate for Phase 3.3 — drives the REAL merge-action sequence end-to-end (real `git merge` +
// real `npm` build/test-gate + real DETACHED `launchctl kickstart` self-restart) on a THROWAWAY git
// repo + a THROWAWAY launchd service. It NEVER touches real `main` or the live com.houge.daemon.
//
// Proves, on real infra:
//   A. [Merge & reload] green path → branch merges to (throwaway) main, build+test-gate pass,
//      notifyDurable("merged, reloading…") fires BEFORE the restart, and the throwaway service is
//      kickstarted → relaunches (new PID).
//   B. post-merge test-gate RED → resetMerge (main reverts), NO restart (service PID unchanged), no push.
//   C. [Discard] → the branch is deleted.
// (The callback→handler→auth layer is unit-verified — M2/M4/M6 tests; this harness covers the
//  merge/verify/self-restart mechanics the units mock.)
//
// Run: node scripts/live-merge-controls-p3.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mergeAndReload, discardBranch, defaultMergeActionDeps } from "../dist/capabilities/self-write-merge.js";

const uid = process.getuid();
const svcLabel = `com.houge.spike-merge-${randomUUID().slice(0, 8)}`;
const base = mkdtempSync(join(tmpdir(), "houge-mergectl-"));
const repo = join(base, "repo");
const svcDir = join(base, "svc");
const node = process.execPath;
execFileSync("mkdir", ["-p", repo, svcDir]);

// ---- throwaway launchd service that just logs each start (the restart target) ----------------
const svcLog = join(svcDir, "starts.log");
const worker = join(svcDir, "worker.mjs");
const plist = join(svcDir, `${svcLabel}.plist`);
writeFileSync(worker, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(svcLog)}, "start pid=" + process.pid + "\\n");
setInterval(() => {}, 1 << 30);
`);
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${svcLabel}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${worker}</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
</dict></plist>
`);

// ---- throwaway git repo: main + green/red self-write branches ---------------------------------
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function pkg(testExit) {
  return JSON.stringify({ name: "tw", version: "0.0.0",
    scripts: { typecheck: "exit 0", test: `exit ${testExit}`, build: "exit 0" } }, null, 2) + "\n";
}
git("init", "-q", "-b", "main");
git("config", "user.email", "live@houge.dev");
git("config", "user.name", "Live");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "package.json"), pkg(0));
writeFileSync(join(repo, "app.txt"), "v1\n");
git("add", "-A"); git("commit", "-q", "-m", "init");
// GREEN branch: a benign source change (test-gate stays green).
git("checkout", "-q", "-b", "houge/selfwrite/run_live_green");
writeFileSync(join(repo, "app.txt"), "v2 — the fix\n");
git("add", "-A"); git("commit", "-q", "-m", "fix");
// RED branch: changes the test script to fail, so the POST-MERGE test-gate goes red.
git("checkout", "-q", "main");
git("checkout", "-q", "-b", "houge/selfwrite/run_live_red");
writeFileSync(join(repo, "package.json"), pkg(1));
git("add", "-A"); git("commit", "-q", "-m", "break tests");
git("checkout", "-q", "main");

const notes = [];
const deps = defaultMergeActionDeps({
  dir: repo,
  env: { ...process.env, HOUGE_DAEMON_LABEL: svcLabel },
  notifyDurable: (t) => notes.push(t)
});

function svcStarts() { try { return readFileSync(svcLog, "utf8").split("\n").filter((l) => l.startsWith("start ")).length; } catch { return 0; } }
function mainContent() { return git("show", "main:app.txt").trim(); }
function waitFor(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; try { execFileSync("true"); } catch {} } return pred(); }

let pass = true;
console.log("=".repeat(74));
console.log("Phase 3.3 LIVE — real merge → build → test-gate → detached self-restart (throwaway targets)");
console.log("=".repeat(74));
console.log(`throwaway service: ${svcLabel}\nthrowaway repo:    ${repo}\n`);

try {
  if (spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist]).status !== 0) throw new Error("bootstrap failed");
  waitFor(() => svcStarts() >= 1, 10000);
  const startsBeforeMerge = svcStarts();
  console.log(`service up: ${startsBeforeMerge} start(s)\n`);

  // ── A. GREEN MERGE ──────────────────────────────────────────────────────────────────────
  console.log("### A. [Merge & reload] GREEN — expect: main updated, reloaded, service restarts");
  const a = mergeAndReload({ branch: "houge/selfwrite/run_live_green", into: "main", push: false, deps });
  console.log(`    outcome: ${JSON.stringify(a)}`);
  console.log(`    main app.txt: "${mainContent()}"`);
  console.log(`    notifyDurable: ${JSON.stringify(notes)}`);
  const restarted = waitFor(() => svcStarts() >= startsBeforeMerge + 1, 15000);
  console.log(`    service restarted: ${restarted} (${svcStarts()} start(s))`);
  const aOk = a.kind === "reloaded" && mainContent() === "v2 — the fix"
    && notes.some((t) => /reloading/i.test(t)) && restarted;
  console.log(aOk ? "    ✓ A PASS\n" : "    ✗ A FAIL\n"); if (!aOk) pass = false;

  // ── B. REVERT ON POST-MERGE RED ─────────────────────────────────────────────────────────
  console.log("### B. post-merge test-gate RED — expect: reverted, main unchanged, NO restart");
  const startsBeforeRed = svcStarts();
  const mainBeforeRed = mainContent();
  const b = mergeAndReload({ branch: "houge/selfwrite/run_live_red", into: "main", push: false, deps });
  console.log(`    outcome: ${JSON.stringify(b)}`);
  const noRestart = !waitFor(() => svcStarts() > startsBeforeRed, 6000);
  const mainUnchanged = mainContent() === mainBeforeRed && git("show", "main:package.json").includes('"exit 0"');
  console.log(`    main unchanged: ${mainUnchanged} · NO new restart: ${noRestart}`);
  const bOk = b.kind === "reverted" && b.stage === "test" && mainUnchanged && noRestart;
  console.log(bOk ? "    ✓ B PASS\n" : "    ✗ B FAIL\n"); if (!bOk) pass = false;

  // ── C. DISCARD ──────────────────────────────────────────────────────────────────────────
  console.log("### C. [Discard] — expect: the branch is deleted");
  const c = discardBranch({ branch: "houge/selfwrite/run_live_red", deps });
  const gone = !deps.branchExists("houge/selfwrite/run_live_red");
  console.log(`    outcome: ${JSON.stringify(c)} · branch gone: ${gone}`);
  const cOk = c.ok === true && gone;
  console.log(cOk ? "    ✓ C PASS\n" : "    ✗ C FAIL\n"); if (!cOk) pass = false;

} catch (e) {
  pass = false; console.error("HARNESS ERROR:", e?.stack || e?.message || e);
} finally {
  spawnSync("launchctl", ["bootout", `gui/${uid}/${svcLabel}`]);
  rmSync(base, { recursive: true, force: true });
}

console.log("=".repeat(74));
console.log(pass ? "LIVE GATE: PASS — merge/verify/self-restart + revert-on-red + discard all real-verified"
                 : "LIVE GATE: needs inspection (see ✗ above)");
console.log("=".repeat(74));
