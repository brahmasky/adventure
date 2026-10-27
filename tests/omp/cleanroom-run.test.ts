import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanroomEnv, cleanroomRoot } from "../../src/omp/cleanroom.js";
import { CLEANROOM_SWEEP_MIN_MS, killable, orphansIn, runCleanroomShell } from "../../src/omp/cleanroom-run.js";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { tmpOmpDist } from "../helpers/omp-env.js";

const alive = (pattern: string) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim().length > 0;
const root = () => process.env.HOUGE_DAEMON_TMP_DIR!;
let distDir = "";
let savedTmp: string | undefined;
const deps = () => ({ cfg: { sandbox: true, shellTimeoutMs: 10_000 }, distDir });

// Each test gets its own realpath'd cache root: rooms are canonical /private/var paths, so an unresolved tmpdir() root would not prefix them.
beforeEach(() => {
  savedTmp = process.env.HOUGE_DAEMON_TMP_DIR;
  process.env.HOUGE_DAEMON_TMP_DIR = realpathSync(mkdtempSync(join(tmpdir(), "hg-crr-")));
  distDir = tmpOmpDist(root());
});

// Nothing a run made may outlive it: the clean-room root is empty or absent after every test.
afterEach(() => {
  const r = root();
  try {
    if (existsSync(cleanroomRoot())) expect(readdirSync(cleanroomRoot())).toEqual([]);
  } finally {
    if (savedTmp === undefined) delete process.env.HOUGE_DAEMON_TMP_DIR; else process.env.HOUGE_DAEMON_TMP_DIR = savedTmp;
    rmSync(r, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "darwin")("runCleanroomShell — one sealed run, total result, nothing left behind", () => {
  it("runs in a fresh room with the fixed env, reports every seal fact, and removes both directories", async () => {
    const r = await runCleanroomShell(deps(), "/bin/pwd; /usr/bin/env | /usr/bin/sort");
    expect(r).toMatchObject({ status: "succeeded", exitCode: 0, executor: "cleanroom", ran: true, torn_down: true, tampered: false });
    expect(r.escaped).toBeUndefined();
    expect(r.room!.startsWith(join(cleanroomRoot(), "room-"))).toBe(true);
    expect(r.output.split("\n")[0]).toBe(r.room);
    expect(r.output).toMatch(/^HOME=.*\/home-/m); expect(r.output).not.toMatch(/^SB=/m);
    // the whole environment is the fixed set plus what bash itself adds: nothing of the daemon's leaks through
    const env = Object.fromEntries(r.output.split("\n").slice(1).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const fixed = cleanroomEnv({ room: r.room!, home: env.HOME! });
    expect(Object.keys(env).sort()).toEqual([...Object.keys(fixed), "PWD", "SHLVL", "_"].sort());
    for (const [k, v] of Object.entries(fixed)) expect(env[k]).toBe(v);
    expect(readdirSync(cleanroomRoot())).toEqual([]);
  });
  it("a non-zero exit is still status succeeded with the code (the adapter's contract); teardown still runs", async () => {
    const r = await runCleanroomShell(deps(), "exit 3");
    expect(r).toMatchObject({ status: "succeeded", exitCode: 3, ran: true, torn_down: true }); expect(readdirSync(cleanroomRoot())).toEqual([]);
  });
  it("timeout and abort tear down too", async () => {
    const t = await runCleanroomShell({ ...deps(), cfg: { sandbox: true, shellTimeoutMs: 300 } }, "/bin/sleep 5");
    expect(t).toMatchObject({ status: "failed", reason: "timeout", ran: true, torn_down: true });
    const ac = new AbortController(); ac.abort();
    const a = await runCleanroomShell(deps(), "/bin/echo x", ac.signal);
    expect(a).toMatchObject({ status: "failed", reason: "aborted", ran: false, torn_down: true }); expect(a.room).toBeUndefined();
    expect(readdirSync(cleanroomRoot())).toEqual([]);
  });
  it("sandbox off, or sandbox-exec missing, is cleanroom_unavailable before any directory is made", async () => {
    const r = await runCleanroomShell({ ...deps(), cfg: { sandbox: false, shellTimeoutMs: 1000 } }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "cleanroom_unavailable", ran: false, torn_down: true });
    expect(existsSync(cleanroomRoot())).toBe(false);
  });
  it("a file dropped into the home between validation and spawn is cleanroom_tampered: no spawn", async () => {
    const afterSpawn = vi.fn(); // the only honest "did not spawn" witness: the room denies every write a marker could leave
    const r = await runCleanroomShell({ ...deps(), afterSidecar: (dirs) => writeFileSync(join(dirs.home, ".curlrc"), "planted"), afterSpawn }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "cleanroom_tampered", ran: false, torn_down: true, tamper_names: [".curlrc"] }); expect(afterSpawn).not.toHaveBeenCalled();
  });
  it("a missing sidecar before spawn is tampering too, not a setup error (the state was observed)", async () => {
    const r = await runCleanroomShell({ ...deps(), afterSidecar: (dirs) => rmSync(join(dirs.home, "cleanroom.sb")) }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "cleanroom_tampered", ran: false }); expect(r.tamper_names).toContain("<sidecar missing>");
  });
  it("planted files are unreadable through the lifecycle API: one in the daemon's HOME, one in the room's parent", async () => {
    const plant = join(root(), "cleanroom", "planted.txt"); mkdirSync(join(root(), "cleanroom"), { recursive: true }); writeFileSync(plant, "X");
    const homePlant = join(process.env.HOME!, `.hg-planted-${process.pid}`); writeFileSync(homePlant, "X");
    try {
      for (const f of [plant, homePlant]) { const r = await runCleanroomShell(deps(), `/bin/cat "${f}"`); expect(r.status).toBe("succeeded"); expect(r.exitCode).not.toBe(0); expect(r.output).toMatch(/Operation not permitted/); }
    } finally { rmSync(homePlant, { force: true }); rmSync(plant, { force: true }); }
  });
  it("a spawn failure is ran:false with reason spawn (seamed: bash itself always spawns, so the real wrapper cannot produce it); a missing wrapper is a post-spawn failure, ran:true; an abort after the availability check is ran:false aborted", async () => {
    const spawnFailed = { status: "failed", exitCode: null, output: "", truncated: false, wrapperStatus: "unknown", reason: "spawn" } as const;
    const r = await runCleanroomShell({ ...deps(), shell: async () => spawnFailed }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "spawn", ran: false, torn_down: true });
    const missing = await runCleanroomShell({ ...deps(), distDir: join(root(), "nowhere") }, "/bin/echo x");
    expect(missing).toMatchObject({ status: "failed", ran: true, torn_down: true }); expect(missing.reason).not.toBe("spawn");
    const ac = new AbortController();
    const late = await runCleanroomShell({ ...deps(), afterSidecar: () => ac.abort() }, "/bin/echo x", ac.signal);
    expect(late).toMatchObject({ status: "failed", reason: "aborted", ran: false, torn_down: true });
  });
  it("a sweep clock failure reports step sweep; a symlinked cleanroom root is refused after both directories were made, and torn down — the next call succeeds", async () => {
    let n = 0; const r = await runCleanroomShell({ ...deps(), now: () => { if (++n === 1) throw new Error("clock"); return Date.now(); } }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "cleanroom_setup", setup_step: "sweep", ran: false, torn_down: true }); expect(r.setup_error).toMatch(/clock/);
    expect(readdirSync(cleanroomRoot())).toEqual([]);
    // partial creation (both directories made, then refused): `<cache>/cleanroom` itself a symlink is refused by the
    // validator's rootIdent (symlink_component) — after both mkdtemps, exactly the "made, then failed" path
    const elsewhere = join(root(), "elsewhere"); mkdirSync(elsewhere); rmSync(cleanroomRoot(), { recursive: true, force: true }); symlinkSync(elsewhere, cleanroomRoot());
    try {
      const v = await runCleanroomShell(deps(), "/bin/echo x");
      expect(v).toMatchObject({ status: "failed", reason: "cleanroom_invalid", ran: false, torn_down: true }); expect(v.invalid_reason).toBe("symlink_component");
      expect(readdirSync(elsewhere)).toEqual([]); // both mkdtemp'd directories were torn down
    } finally { rmSync(cleanroomRoot(), { force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
    expect((await runCleanroomShell(deps(), "/bin/echo y")).status).toBe("succeeded");
  });
  it("a file dropped into the home DURING the run leaves the command's result standing and sets tampered", async () => {
    const r = await runCleanroomShell({ ...deps(), afterSpawn: (dirs) => writeFileSync(join(dirs.home, ".curlrc"), "planted") }, "/bin/sleep 1; /bin/echo done");
    expect(r).toMatchObject({ status: "succeeded", exitCode: 0, ran: true, tampered: true, torn_down: true });
  });
  it("a set -m orphan outlives the wrapper, is found by the lsof cwd scan, killed, and marks the run escaped (source: orphan_scan)", async () => {
    const tag = `houge-cr-orphan-${Date.now()}`;
    const r = await runCleanroomShell(deps(), `set -m; (exec -a ${tag} /bin/sleep 20 >/dev/null 2>&1 </dev/null) & /bin/echo spawned`);
    try {
      expect(r).toMatchObject({ status: "succeeded", escaped: true, escape_source: "orphan_scan", torn_down: true }); expect(r.orphans!.length).toBeGreaterThan(0);
      expect(alive(tag)).toBe(false);
    } finally { spawnSync("pkill", ["-f", tag]); }
  });
  it("orphansIn reads lsof records: an n line counts only after fcwd for the current p record", () => {
    const room = "/private/x/cleanroom/room-1";
    expect(orphansIn(room, "p10\nfcwd\nn/private/x/cleanroom/room-1\np11\nftxt\nn/private/x/cleanroom/room-1/f\np12\nfcwd\nn/private/x/cleanroom/room-1/sub\np13\nfcwd\nn/private/x/cleanroom/room-10\n")).toEqual([10, 12]);
  });
  it("a shell that throws after being invoked is ran:true wrapper_unknown, never a retryable setup failure", async () => {
    const r = await runCleanroomShell({ ...deps(), shell: async () => { throw new Error("shell boom"); } }, "/bin/echo x");
    expect(r).toMatchObject({ status: "failed", reason: "wrapper_unknown", ran: true, torn_down: true }); expect(r.check_error).toMatch(/shell boom/);
    expect(r.setup_step).toBeUndefined();
  });
  it("the orphan kill list never holds this process or its parent", () => {
    expect(killable([process.pid, process.ppid, 1, 4242])).toEqual([4242]);
  });
  it("a remover that returns without removing is torn_down:false naming the path still present", async () => {
    const r = await runCleanroomShell({ ...deps(), rm: () => {} }, "/bin/echo x");
    expect(r).toMatchObject({ status: "succeeded", torn_down: false }); expect(r.teardown_error).toContain(`${r.room}: still present`);
    rmSync(cleanroomRoot(), { recursive: true, force: true });
  });
  it("an overlapping run's directories are in the active set: a later sweep past the age bound leaves them alone", async () => {
    const a = runCleanroomShell(deps(), "/bin/sleep 2; /bin/echo a");
    await new Promise((res) => setTimeout(res, 300));
    const b = await runCleanroomShell({ ...deps(), now: () => Date.now() + 10 * 60 * 60_000 }, "/bin/echo b");
    expect(b).toMatchObject({ status: "succeeded", swept: [] });
    const ra = await a; expect(ra).toMatchObject({ status: "succeeded", torn_down: true }); expect(ra.output).toBe("a\n");
  });
  it("an lsof failure is check_error, not escaped; a teardown failure is torn_down:false with the error, status unchanged", async () => {
    const r = await runCleanroomShell({ ...deps(), lsof: () => { throw new Error("lsof: boom"); } }, "/bin/echo x");
    expect(r).toMatchObject({ status: "succeeded", torn_down: true }); expect(r.escaped).toBeUndefined(); expect(r.check_error).toMatch(/boom/);
    const t = await runCleanroomShell({ ...deps(), rm: () => { throw new Error("EBUSY"); } }, "/bin/echo x");
    expect(t).toMatchObject({ status: "succeeded", torn_down: false }); expect(t.teardown_error).toMatch(/EBUSY/);
    rmSync(cleanroomRoot(), { recursive: true, force: true });
  });
  it("the sweep removes stale room-*/home-* from an earlier process and leaves fresh ones; its age bound exceeds the shell timeout", async () => {
    mkdirSync(join(cleanroomRoot(), "room-old"), { recursive: true }); mkdirSync(join(cleanroomRoot(), "home-fresh"));
    const old = Date.now() - 2 * 60 * 60_000; utimesSync(join(cleanroomRoot(), "room-old"), old / 1000, old / 1000);
    const r = await runCleanroomShell(deps(), "/bin/echo x");
    expect(r.swept).toEqual(["room-old"]); expect(readdirSync(cleanroomRoot())).toEqual(["home-fresh"]);
    expect(CLEANROOM_SWEEP_MIN_MS).toBeGreaterThan(resolveOmpConfig({}).shellTimeoutMs + 5000);
    rmSync(join(cleanroomRoot(), "home-fresh"), { recursive: true, force: true });
  });
});
