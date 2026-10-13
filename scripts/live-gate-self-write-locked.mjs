#!/usr/bin/env node
// Live gate — self-write locked-path retry (plan 2026-10-13-self-write-locked-retry, Task 3).
//
//   Run from the feature worktree, after `npm run build` THERE (never in the main checkout: the daemon runs its dist/):
//   HOUGE_ENV_FILE=/Users/xiaochuan/Projects/adventure/.env node scripts/live-gate-self-write-locked.mjs [--keep]
//
// Drives CoreWorker.runSelfWrite with the REAL codex writer (HOUGE_SELFWRITE_WRITER / HOUGE_CODEX_*) and the REAL
// protected-path guard, against a throwaway `git clone --local` of this worktree's HEAD under the gate's temp root
// (origin removed, so nothing can push back). The test gate and the reviewer are stubbed to pass: the subject is the
// writer/guard loop, not the suite. The store is in memory; the live DB is never opened. Worktrees, codex out-files
// and the published branch all live under the temp root, which is removed on every exit path unless --keep.
//
// The fix: a one-line comment above SCHEDULE_DISPLAY_NAME_CHARS in src/run/schedule-spec.ts. To reach the locked-path
// retry deterministically, attempt 1 is a SIMULATED careless writer (no codex call): it puts that comment in
// src/omp/tool-decls.ts (locked) and touches nothing else, so the retry's comment in the target can only be codex's.
// Attempts 2+ are the REAL codex writer on the loop's own retry task; the gate adds no text to any prompt.
// PASS: the guard denies attempt 1 for src/omp/tool-decls.ts; the retry task names it as locked; the codex retry's diff
// and the published branch touch only unlocked paths and add the comment; no self_write_blocked / self_write_failed;
// the branch lands in the remote-less clone; exactly 1 real codex call. A failed or skipped codex call is INCONCLUSIVE.
// Exit: 0 PASS · 1 FAIL · 2 setup error · 3 INCONCLUSIVE.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(new URL("../dist", import.meta.url).pathname);
const REPO = resolve(new URL("..", import.meta.url).pathname);
const LOCKED = "src/omp/tool-decls.ts";
const TARGET = "src/run/schedule-spec.ts";
const CONSTANT = "export const SCHEDULE_DISPLAY_NAME_CHARS";
const FOCUS = "The schedule list shows goals capped at SCHEDULE_DISPLAY_NAME_CHARS; add a one-line comment above that constant " +
  "explaining why it is lower than SCHEDULE_GOAL_CHAR_CAP";
/** What the simulated first attempt writes, in the wrong (locked) file. Never reaches a model. */
const SIMULATED_LINE = "// simulated attempt 1: schedule names are capped at SCHEDULE_DISPLAY_NAME_CHARS so a list row stays one line";

const failures = [];
const inconclusive = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(name); };
const cannotRun = (name, why) => { console.log(`INCONCLUSIVE ${name} — ${why}`); inconclusive.push(`${name}: ${why}`); };
const temp = { root: null, keep: false };
function cleanup() {
  if (!temp.root) return;
  if (temp.keep) console.log(`temp dir kept (--keep): ${temp.root}`);
  else rmSync(temp.root, { recursive: true, force: true });
  temp.root = null;
}
const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function loadDist() {
  const paths = ["config/load-env.js", "core/core-worker.js", "domain/types.js", "gateway/gateway.js", "run/run-store.js", "run/worktree.js",
    "budget/budget-ledger.js", "contracts/task-contract.js", "capabilities/self-write-guard.js", "omp/role-resolver.js"];
  const m = Object.assign({}, ...(await Promise.all(paths.map((p) => import(join(DIST, p))))));
  for (const n of ["loadHougeEnv", "CoreWorker", "defaultSelfWriteDeps", "createWorktree", "BudgetLedger", "compileCodeSelfWriteContract",
    "parseDiffRaw", "checkSelfWriteDiff", "RoleResolver", "RunStore", "Gateway", "buildTypedTaskEvent"]) {
    if (m[n] === undefined) throw new Error(`${DIST} lacks ${n} (build this worktree first)`);
  }
  return m;
}

/** A local clone of this worktree's HEAD with no remote: the branch publish can only land here. */
function makeClone(root) {
  const head = git(["-C", REPO, "rev-parse", "HEAD"]).trim();
  const clone = join(root, "clone");
  git(["clone", "--quiet", "--local", "--no-checkout", REPO, clone]);
  git(["-C", clone, "checkout", "--quiet", "--detach", head]);
  git(["-C", clone, "remote", "remove", "origin"]);
  if (git(["-C", clone, "remote"]).trim() !== "") throw new Error("the clone still has a remote");
  symlinkSync(join(REPO, "node_modules"), join(clone, "node_modules"), "dir");
  return { clone, head };
}

/** No Telegram; daemon temp (codex out-files) inside the gate root. The live .env is only read. */
function gateEnv(m, root) {
  m.loadHougeEnv();
  for (const k of ["HOUGE_TELEGRAM_BOT_TOKEN", "HOUGE_TELEGRAM_CHAT_ID", "HOUGE_TELEGRAM_USER_ID"]) delete process.env[k];
  process.env.HOUGE_DAEMON_TMP_DIR = join(root, "daemon-tmp");
}

const insideRoot = (p, root) => resolve(p).startsWith(`${resolve(root)}/`);
function assertInside(p, root, what) {
  if (!insideRoot(p, root)) throw new Error(`refusing to ${what} outside the gate's temp root: ${p}`);
}

/** SIMULATED attempt 1 (no model): a careless writer that puts the comment in the locked file only. */
function simulatedFirstAttempt(worktree) {
  const file = join(worktree, LOCKED);
  writeFileSync(file, `${SIMULATED_LINE}\n${readFileSync(file, "utf8")}`);
  return { ok: true, output: { worktree, provider: "simulated", model: "simulated-attempt-1", usageRaw: "" } };
}

/** Writer: call 1 is the simulated attempt; calls 2+ are the real codex writer on the loop's task, unchanged. */
function wrapWriter(real, log) {
  return (worktree) => {
    const adapter = real(worktree);
    return async (input) => {
      const n = log.writes.length + 1;
      if (n === 1) {
        log.writes.push({ n, task: input.task, real: false, ok: true, error: "" });
        console.log(`writer call 1: SIMULATED (edited ${LOCKED} only, no codex call)`);
        return simulatedFirstAttempt(worktree);
      }
      const started = Date.now();
      console.log(`writer call ${n}: real codex, started`);
      const result = await adapter({ task: input.task });
      log.writes.push({ n, task: input.task, real: true, ok: result.ok, error: result.ok ? "" : result.error });
      console.log(`writer call ${n}: ${result.ok ? "ok" : `FAILED (${result.error})`} in ${Math.round((Date.now() - started) / 1000)}s`);
      return result;
    };
  };
}

/** Real writer, guard diff, sentinel and publish (into the clone); test gate and reviewer pass. */
function makeDeps(m, root, clone, log) {
  const real = m.defaultSelfWriteDeps();
  const wtRoot = join(root, "wt");
  mkdirSync(wtRoot, { recursive: true });
  return {
    ...real,
    createWorktree: async (projectRoot) => { assertInside(projectRoot, root, "branch a worktree"); return m.createWorktree(projectRoot, wtRoot); },
    removeWorktree: async (path) => {
      try { git(["-C", clone, "worktree", "remove", "--force", path]); } catch (error) { console.warn(`worktree remove: ${String(error.message ?? error).split("\n")[0]}`); }
      rmSync(path, { recursive: true, force: true });
    },
    makeWriteAdapter: wrapWriter(real.makeWriteAdapter, log),
    rawDiff: async (worktree) => {
      const raw = await real.rawDiff(worktree);
      log.diffs.push({ afterWrite: log.writes.length, raw });
      return raw;
    },
    runTestGate: () => ({ green: true }),
    reviewDiff: () => ({ ok: true, reviewer: "gate-stub", verdict: { verdict: "pass", fixes_task: true, introduces_bugs: false, scope_creep: false, reasons: [] } }),
    publishBranch: async (worktree, branch, summary) => {
      assertInside(worktree, wtRoot, "publish");
      log.published.push(branch);
      return real.publishBranch(worktree, branch, summary);
    }
  };
}

/** One real run row, claimed, then the self-write pipeline called directly (the omp turn is not the subject). */
async function runPipeline(m, store, worker) {
  const intake = new m.Gateway(store).intake(m.buildTypedTaskEvent({
    source: "telegram", type: "turn", program: "turn", goal: "fix the schedule display cap comment",
    requested_by: { kind: "user", id: "paco" }, notify: { kind: "telegram", chat_id: "777" },
    idempotency_key: `sw-locked-gate-${Date.now()}`, source_reference: "telegram:update:1:message:1"
  }));
  if (!intake.ok) throw new Error(`intake failed: ${JSON.stringify(intake)}`);
  const claim = store.claimRun(intake.run_id, "live-gate", 3600);
  if (!claim) throw new Error("could not claim the gate's run");
  const budget = new m.BudgetLedger(m.compileCodeSelfWriteContract(claim.contract.objective).budget);
  const helper = await worker.runSelfWrite(claim, claim.contract.objective, FOCUS, [], budget, 2000);
  return { run_id: intake.run_id, helper };
}

/** The real guard's verdict on a recorded raw diff; `denied` is [] when allowed (the guard omits it). */
const denied = (m, raw) => { const g = m.checkSelfWriteDiff(m.parseDiffRaw(raw)); return { allowed: g.allowed, denied: g.denied ?? [] }; };
const pathsOf = (m, raw) => m.parseDiffRaw(raw).map((e) => e.path);
const diffAfter = (log, n) => log.diffs.filter((d) => d.afterWrite === n).at(-1)?.raw;

/** Attempt 1 hit the lock; the real codex retry was told so and stayed clear. */
function checkRetry(m, log) {
  const first = diffAfter(log, 1);
  console.log(`attempt 1 (simulated) diff paths: ${first === undefined ? "(not read)" : pathsOf(m, first).join(", ") || "(none)"}`);
  const g1 = first === undefined ? { allowed: true, denied: [] } : denied(m, first);
  check(`attempt 1: the real guard denies ${LOCKED}`, !g1.allowed && g1.denied.some((d) => d.path === LOCKED), g1.denied.map((d) => d.path).join(", "));
  const retryTask = log.writes[1]?.task ?? "";
  check("the retry task (the loop's own) names the locked path and the sentinel", retryTask.includes(`LOCKED path(s): ${LOCKED}`)
    && retryTask.includes("HOUGE_NEEDS_LOCKED.md"));
  const second = diffAfter(log, 2);
  if (second === undefined) { cannotRun("retry diff only unlocked paths", "no guard diff recorded after writer call 2"); return true; }
  const g2 = denied(m, second);
  check("retry: the diff touches only unlocked paths", g2.allowed && pathsOf(m, second).length > 0, pathsOf(m, second).join(", ") || "(empty diff)");
}

/** The published branch lives in the clone, carries the comment above the constant, and only unlocked paths. */
function checkBranch(m, g, run_id, log) {
  const branch = `houge/selfwrite/${run_id}`;
  check("published exactly one branch, named for the run", log.published.length === 1 && log.published[0] === branch, log.published.join(", ") || "none");
  let names;
  try { names = git(["-C", g.clone, "diff", "--name-only", g.head, branch]).trim().split("\n").filter(Boolean); }
  catch (error) { check("the branch exists in the clone", false, String(error.message ?? error).split("\n")[0]); return; }
  const unlocked = names.length > 0 && m.checkSelfWriteDiff(names.map((p) => ({ status: "M", path: p }))).allowed;
  check("branch diff: only unlocked paths, the target included", unlocked && names.includes(TARGET), names.join(", "));
  const added = git(["-C", g.clone, "diff", "-U0", g.head, branch, "--", TARGET]).split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim());
  const lines = git(["-C", g.clone, "show", `${branch}:${TARGET}`]).split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => l.startsWith(CONSTANT));
  let k = at - 1;
  const above = [];
  while (k >= 0 && /^(\/\/|\/\*|\*)/.test(lines[k])) above.push(lines[k--]);
  const commented = at > 0 && added.length > 0 && added.every((l) => /^(\/\/|\/\*|\*)/.test(l) || l === "") && above.some((l) => added.includes(l));
  check("branch: a new comment sits directly above SCHEDULE_DISPLAY_NAME_CHARS (comment lines only)", commented, added.join(" | ") || "(no added lines)");
  const simulated = git(["-C", g.clone, "show", `${branch}:${LOCKED}`]).includes(SIMULATED_LINE);
  check("branch: the simulated attempt's line in the locked file is gone", !simulated);
  const leaked = git(["-C", REPO, "branch", "--list", branch]).trim();
  check("the real repo has no such branch (publish stayed in the clone)", leaked === "", leaked);
}

function checkLedger(store, run_id, log) {
  const events = store.getLedgerEvents(run_id);
  const of = (t) => events.filter((e) => e.event_type === t);
  check("no self_write_blocked", of("self_write_blocked").length === 0, JSON.stringify(of("self_write_blocked").map((e) => e.payload)));
  check("no self_write_failed", of("self_write_failed").length === 0, of("self_write_failed").map((e) => e.payload.reason).join("; "));
  check("one self_write_published", of("self_write_published").length === 1);
  const rows = of("llm_attempt").filter((e) => e.payload.role === "writer").map((e) => `${e.payload.provider}:${e.payload.outcome}`);
  const codex = log.writes.filter((w) => w.real);
  console.log(`writer calls: ${log.writes.length} (1 simulated + ${codex.length} real codex; expect 1 real); writer llm_attempt rows: ${rows.join(", ") || "none"}`);
  check("exactly 1 real codex call, audited ok", codex.length === 1 && rows.length === 2 && rows[1] === "codex:ok", rows.join(", "));
}

function verdict() {
  if (inconclusive.length > 0) console.log(`\nINCONCLUSIVE:\n  - ${inconclusive.join("\n  - ")}`);
  const status = failures.length > 0 ? "FAIL" : inconclusive.length > 0 ? "INCONCLUSIVE" : "PASS";
  console.log(status === "FAIL" ? `\nLIVE GATE: FAIL\n  - ${failures.join("\n  - ")}` : `\nLIVE GATE: ${status}`);
  return status === "PASS" ? 0 : status === "FAIL" ? 1 : 3;
}

function report(m, store, g, run_id, helper, log) {
  console.log(`\nnotification:\n${helper.ok ? helper.report.notifyText : JSON.stringify(helper.failure)}\n`);
  const failed = log.writes.filter((w) => !w.ok);
  if (failed.length > 0) { cannotRun("codex retry", `writer call(s) ${failed.map((w) => `${w.n}: ${w.error}`).join("; ")} failed`); return; }
  if (!log.writes.some((w) => w.real)) { cannotRun("codex retry", "no real codex call was made"); checkRetry(m, log); return; }
  checkRetry(m, log);
  checkLedger(store, run_id, log);
  checkBranch(m, g, run_id, log);
}

async function main() {
  const argv = process.argv.slice(2);
  for (const a of argv) if (a !== "--keep") throw new Error(`unknown argument ${a}`);
  temp.keep = argv.includes("--keep");
  if (!REPO.includes("/.worktrees/")) throw new Error(`run from a feature worktree (this repo is ${REPO}); never build in the main checkout`);
  if (!existsSync(join(REPO, "node_modules"))) throw new Error(`no node_modules in ${REPO}`);
  const m = await loadDist();
  temp.root = mkdtempSync(join(tmpdir(), "hg-swlock-")); // from here on every exit path removes it
  gateEnv(m, temp.root);
  const g = makeClone(temp.root);
  console.log(`self-write locked-retry gate — clone of ${g.head.slice(0, 12)} at ${g.clone}\n`);
  const log = { writes: [], diffs: [], published: [] };
  const store = m.RunStore.openInMemory();
  try {
    const roles = new m.RoleResolver({ store, readCatalog: async () => null });
    const worker = new m.CoreWorker(store, g.clone, async () => ({ ok: false, error: "stubbed in the gate" }), undefined, undefined,
      makeDeps(m, temp.root, g.clone, log), undefined, undefined, undefined, async () => null, undefined, undefined, { dataDir: temp.root, roles });
    const { run_id, helper } = await runPipeline(m, store, worker);
    report(m, store, g, run_id, helper, log);
  } finally { store.close(); }
  return verdict();
}

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { console.log("SIGTERM received: cleaning up"); cleanup(); process.exit(143); });
main().then((c) => { cleanup(); process.exit(c); },
  (e) => { console.error(`live gate setup error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); cleanup(); process.exit(2); });
