#!/usr/bin/env node
// Phase 3.3 spike (M1) — can a launchd-managed node process RESTART ITSELF via `launchctl kickstart`
// and come back on (re)loaded code? This is the novel bit of the [Merge & reload] button: the daemon
// issues the command that kills its own process, then launchd relaunches it onto the new dist/.
//
// SAFETY: this uses a THROWAWAY launchd service (com.houge.spike-restart-<uuid>) — it NEVER touches
// the live com.houge.daemon. The worker stays alive (no KeepAlive loop) and self-kickstarts exactly
// once; we observe two starts with different PIDs → GO. Cleaned up (bootout) at the end.
//
// Run: node scripts/spike-self-restart-p3.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const uid = process.getuid();
const label = `com.houge.spike-restart-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "houge-selfrestart-"));
const worker = join(dir, "worker.mjs");
const plist = join(dir, `${label}.plist`);
const logFile = join(dir, "starts.log");
const marker = join(dir, "phase1.done");
const node = process.execPath;

// The worker: log each start; on the FIRST start, self-kickstart (detached) so the instruction
// survives our own SIGTERM; then stay alive (KeepAlive=false → no accidental restart loop).
writeFileSync(worker, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
const LOG = ${JSON.stringify(logFile)};
const MARKER = ${JSON.stringify(marker)};
appendFileSync(LOG, "start pid=" + process.pid + " t=" + Date.now() + "\\n");
if (!existsSync(MARKER)) {
  writeFileSync(MARKER, "phase1\\n");
  const c = execFile("launchctl", ["kickstart", "-k", "gui/${uid}/${label}"], { detached: true });
  c.unref();
}
setInterval(() => {}, 1 << 30); // stay alive; the only restart is the explicit kickstart above
`);

writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${worker}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${join(dir, "out.log")}</string>
  <key>StandardErrorPath</key><string>${join(dir, "err.log")}</string>
</dict></plist>
`);

function sh(cmd, args) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8" }) }; }
  catch (e) { return { ok: false, err: `${e.status ?? ""} ${e.message}`.trim(), out: (e.stdout || "").toString() }; }
}
function reads(path) { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function startCount() { return reads(logFile).split("\n").filter((l) => l.startsWith("start ")).length; }
// busy-wait without foreground sleep
function waitUntil(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; try { execFileSync("true"); } catch {} }
  return pred();
}

console.log("=".repeat(72));
console.log("Phase 3.3 spike — launchd self-restart (throwaway service, NOT com.houge.daemon)");
console.log("=".repeat(72));
console.log(`label: ${label}`);
console.log(`node:  ${node}\n`);

let verdict = "NO-GO";
try {
  // Boot the throwaway service (modern domain-target form).
  const boot = sh("launchctl", ["bootstrap", `gui/${uid}`, plist]);
  if (!boot.ok) { console.log(`bootstrap FAILED: ${boot.err}`); throw new Error("bootstrap"); }

  // Phase 1: wait for the first start.
  const p1 = waitUntil(() => startCount() >= 1, 15000);
  console.log(`phase 1 (first start): ${p1 ? "seen" : "TIMEOUT"} (${startCount()} start line(s))`);
  if (!p1) throw new Error("no first start");

  // Phase 2: the worker self-kickstarts → wait for a SECOND start.
  const p2 = waitUntil(() => startCount() >= 2, 20000);
  console.log(`phase 2 (self-restart): ${p2 ? "seen" : "TIMEOUT"} (${startCount()} start line(s))`);

  const lines = reads(logFile).split("\n").filter((l) => l.startsWith("start "));
  const pids = lines.map((l) => (l.match(/pid=(\d+)/) || [])[1]).filter(Boolean);
  const distinct = new Set(pids);
  console.log("\nstart log:");
  for (const l of lines) console.log("  " + l);
  console.log(`\ndistinct PIDs: ${distinct.size} (${[...distinct].join(", ")})`);

  if (p2 && distinct.size >= 2) verdict = "GO";
} catch (e) {
  console.log(`spike error: ${e.message}`);
} finally {
  sh("launchctl", ["bootout", `gui/${uid}/${label}`]);
  if (existsSync(marker)) { /* consumed */ }
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n" + "=".repeat(72));
if (verdict === "GO") {
  console.log("➤ GO. A launchd node process can kickstart ITSELF and relaunch on new code (new PID).");
  console.log("  The [Merge & reload] self-restart (detached kickstart + durable outbox) is viable.");
} else {
  console.log("➤ NO-GO. Self-kickstart did not produce a clean relaunch (see above). Fall back:");
  console.log("  merge on tap, reload stays a one-liner Paco runs. Inspect launchctl errors.");
}
console.log("=".repeat(72));
