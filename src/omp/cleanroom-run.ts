import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLEANROOM_PROFILE_NAME, type CleanroomDirs, CleanroomPathError, type CleanroomReason, cleanroomRoot, type RoomPair, validateCleanroomDirs, writeCleanroomProfile } from "./cleanroom.js";
import type { OmpConfig } from "./omp-config.js";
import { renderCleanroom } from "./seatbelt.js";
import { runShell, type ShellFailure, type ShellRunResult } from "./shell-adapter.js";

export type CleanroomFailure = ShellFailure | "cleanroom_unavailable" | "cleanroom_setup" | "cleanroom_invalid" | "cleanroom_tampered";
/** Total: never throws; every exit is one of these shapes. */
export type CleanroomRunResult = Omit<ShellRunResult, "reason"> & {
  reason?: CleanroomFailure;
  executor: "cleanroom";
  /** The wrapper was spawned (the command may have had an effect). False for every pre-spawn exit, for `spawn`, and for a late abort. */
  ran: boolean;
  /** Absent when the run failed before a room existed. */
  room?: string;
  torn_down: boolean;
  tampered: boolean;
  /** Which check saw the escape: the wrapper's pipe check, the lsof cwd scan, or both. Set whenever `escaped` is. */
  escape_source?: "pipe" | "orphan_scan" | "both";
  orphans?: number[];
  /** Names the sweep removed (pushed as removed, so a sweep that throws midway still reports the ones gone). */
  swept?: string[];
  tamper_names?: string[];
  setup_step?: "root" | "sweep" | "mkdtemp" | "sidecar" | "precheck";
  setup_error?: string;
  invalid_reason?: CleanroomReason;
  teardown_error?: string;
  check_error?: string;
};
export interface CleanroomDeps {
  cfg: Pick<OmpConfig, "sandbox" | "shellTimeoutMs">; distDir: string;
  /** Tests only: clock for the sweep, lsof text, the remover, and two tamper hooks (after the sidecar is written; right after runShell is invoked). */
  now?: () => number; lsof?: (uid: number) => string; rm?: (path: string) => void;
  afterSidecar?: (dirs: RoomPair) => void; afterSpawn?: (dirs: RoomPair) => void;
  /** Tests only: stands in for runShell (a resolved `reason: "spawn"` cannot be produced with the real wrapper — bash itself always spawns). */
  shell?: typeof runShell;
}
type Inodes = { room: bigint; home: bigint };

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Far above any shell timeout, so a room of a run still in flight in another daemon process is never swept. */
export const CLEANROOM_SWEEP_MIN_MS = 60 * 60_000;
const active = new Set<string>(); // rooms/homes of runs in flight in this process: never swept

function base(over: Partial<CleanroomRunResult>): CleanroomRunResult {
  return { status: "failed", exitCode: null, output: "", truncated: false, wrapperStatus: "unknown", executor: "cleanroom", ran: false, torn_down: true, tampered: false, ...over };
}

/** A clean room without the sandbox would be an ordinary shell with a fake name: refuse rather than degrade. */
export function cleanroomAvailable(cfg: Pick<OmpConfig, "sandbox">): boolean {
  if (!cfg.sandbox) return false;
  try { accessSync(SANDBOX_EXEC, constants.X_OK); return true; } catch { return false; }
}

/** Stale room- and home- entries from an earlier daemon process (older than the bound, not in flight) are removed by name; `gone` is pushed as it goes so a throw midway still reports what left. */
function sweep(root: string, cfg: Pick<OmpConfig, "shellTimeoutMs">, now: number, rm: (p: string) => void, gone: string[]): void {
  const bound = Math.max(CLEANROOM_SWEEP_MIN_MS, 2 * cfg.shellTimeoutMs);
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (!/^(room|home)-/.test(name) || active.has(p)) continue;
    if (lstatSync(p).mtimeMs < now - bound) { rm(p); gone.push(name); }
  }
}

/**
 * Tamper detection (observed state, never an I/O error): the home holds exactly the sidecar with the rendered bytes, the
 * room is empty before the run, both still have the validated inodes. A missing sidecar is reported, not read.
 */
function intact(dirs: CleanroomDirs, ino: Inodes, afterRun: boolean): string[] {
  const bad: string[] = [];
  const home = readdirSync(dirs.home);
  bad.push(...home.filter((n) => n !== CLEANROOM_PROFILE_NAME));
  if (!home.includes(CLEANROOM_PROFILE_NAME)) bad.push("<sidecar missing>");
  else if (readFileSync(join(dirs.home, CLEANROOM_PROFILE_NAME), "utf8") !== renderCleanroom(dirs)) bad.push("<sidecar bytes>");
  if (!afterRun) bad.push(...readdirSync(dirs.room).map((n) => `room/${n}`));
  if (statSync(dirs.room, { bigint: true }).ino !== ino.room || statSync(dirs.home, { bigint: true }).ino !== ino.home) bad.push("<inode>");
  return bad;
}

/** Processes of this user whose cwd is the room or below it. lsof -Fpn emits records `p<pid>`, `f<fd>`, `n<path>`: an n line counts only under fcwd of the current p. */
export function orphansIn(room: string, lsofOut: string): number[] {
  const pids = new Set<number>(); let pid = 0; let cwd = false;
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); cwd = false; }
    else if (line.startsWith("f")) cwd = line === "fcwd";
    else if (line.startsWith("n") && cwd && pid > 0 && (line.slice(1) === room || line.slice(1).startsWith(room + "/"))) pids.add(pid);
  }
  return [...pids];
}

/**
 * One sealed run: fresh room and home, validated, sidecar written and re-checked, then the command. `out` is the one
 * object every return hands back, and `finally` mutates it, so teardown facts reach the caller on every path.
 */
export async function runCleanroomShell(deps: CleanroomDeps, command: string, signal?: AbortSignal): Promise<CleanroomRunResult> {
  if (signal?.aborted) return base({ reason: "aborted" });
  if (!cleanroomAvailable(deps.cfg)) return base({ reason: "cleanroom_unavailable" });
  const rm = deps.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 3 }));
  const made: string[] = []; let out = base({ swept: [] });
  try {
    let step: NonNullable<CleanroomRunResult["setup_step"]> = "root";
    try {
      const root = cleanroomRoot(); mkdirSync(root, { recursive: true, mode: 0o700 });
      step = "sweep"; sweep(root, deps.cfg, (deps.now ?? Date.now)(), rm, out.swept!);
      step = "mkdtemp"; const room = mkdtempSync(join(root, "room-")); made.push(room); active.add(room);
      const home = mkdtempSync(join(root, "home-")); made.push(home); active.add(home);
      let dirs: CleanroomDirs;
      try { dirs = validateCleanroomDirs({ room, home }); } catch (e) { if (e instanceof CleanroomPathError) return (out = base({ ...out, reason: "cleanroom_invalid", invalid_reason: e.reason })); throw e; }
      const ino = { room: statSync(dirs.room, { bigint: true }).ino, home: statSync(dirs.home, { bigint: true }).ino };
      step = "sidecar"; const profile = writeCleanroomProfile(dirs); deps.afterSidecar?.(dirs);
      step = "precheck"; const pre = intact(dirs, ino, false);
      if (pre.length > 0) return (out = base({ ...out, reason: "cleanroom_tampered", room: dirs.room, tamper_names: pre }));
      if (signal?.aborted) return (out = base({ ...out, reason: "aborted", room: dirs.room })); // the signal flipped during setup: nothing ran
      // runAndCheck never throws: once the shell is invoked, no error may read as a pre-spawn (ran: false) result
      return (out = await runAndCheck(deps, out, dirs, ino, profile, command, signal));
    } catch (e) { return (out = base({ ...out, reason: "cleanroom_setup", setup_step: step, setup_error: String(e) })); }
  } finally {
    for (const p of made) {
      const fail = (why: string) => { out.torn_down = false; out.teardown_error = [out.teardown_error, `${p}: ${why}`].filter(Boolean).join("; "); };
      // a remover that returns without removing is not a teardown: the directory's absence is the proof
      try { rm(p); if (existsSync(p)) fail("still present"); } catch (e) { fail(String(e)); }
      active.delete(p);
    }
  }
}

/**
 * Spawn and check, total: from the moment the shell is invoked the command may have had an effect, so an unexpected
 * throw is `wrapper_unknown` with `ran: true` (state unknown) — never a setup failure a caller could safely retry.
 */
async function runAndCheck(deps: CleanroomDeps, prev: CleanroomRunResult, dirs: CleanroomDirs, ino: Inodes, profile: string, command: string, signal?: AbortSignal): Promise<CleanroomRunResult> {
  try { return await spawnAndCheck(deps, prev, dirs, ino, profile, command, signal); }
  catch (e) { return base({ ...prev, reason: "wrapper_unknown", ran: true, room: dirs.room, check_error: String(e) }); }
}

/** A thrown test hook after the spawn is a check error, never a setup error, because the command is already running. */
async function spawnAndCheck(deps: CleanroomDeps, prev: CleanroomRunResult, dirs: CleanroomDirs, ino: Inodes, profile: string, command: string, signal?: AbortSignal): Promise<CleanroomRunResult> {
  const pending = (deps.shell ?? runShell)({ command, cwd: dirs.room, profilePath: profile, wrapperPath: join(deps.distDir, "omp", "shell-wrapper.sh"),
    env: { HOUGE_SHELL_CLEANROOM: "1", CR_HOME: dirs.home, CR_ROOM: dirs.room }, timeoutMs: deps.cfg.shellTimeoutMs, outputCapBytes: 32 * 1024, sandbox: true, ...(signal ? { signal } : {}) });
  let hookError: string | undefined; try { deps.afterSpawn?.(dirs); } catch (e) { hookError = String(e); }
  const r = await pending;
  // copy optional fields only when defined: a present-but-undefined optional is a different shape under exactOptionalPropertyTypes
  const out: CleanroomRunResult = { ...prev, status: r.status, exitCode: r.exitCode, output: r.output, truncated: r.truncated, wrapperStatus: r.wrapperStatus,
    ...(r.reason !== undefined ? { reason: r.reason } : {}), ...(r.escaped !== undefined ? { escaped: r.escaped } : {}),
    executor: "cleanroom", ran: r.reason !== "spawn", room: dirs.room, torn_down: true, tampered: false };
  if (hookError) out.check_error = hookError;
  const addCheckError = (e: unknown) => { out.check_error = [out.check_error, String(e)].filter(Boolean).join("; "); };
  try { const post = intact(dirs, ino, true); if (post.length > 0) { out.tampered = true; out.tamper_names = post; } } catch (e) { addCheckError(e); }
  if (r.escaped) out.escape_source = "pipe"; // a source whenever escaped is set, even if the scan below cannot run
  scanOrphans(deps, dirs, out, r.escaped === true, addCheckError);
  return out;
}

/** Never this process or its parent: if either sat in the room, killing it would take the daemon down with the orphan. */
export function killable(pids: number[]): number[] {
  return pids.filter((pid) => pid > 1 && pid !== process.pid && pid !== process.ppid);
}

/** Processes still in the room after the wrapper exited left its group: kill them and mark the run escaped. */
function scanOrphans(deps: CleanroomDeps, dirs: CleanroomDirs, out: CleanroomRunResult, pipeEscaped: boolean, addCheckError: (e: unknown) => void): void {
  const uid = process.getuid?.();
  if (uid === undefined) { addCheckError("getuid unavailable"); return; }
  try {
    const found = orphansIn(dirs.room, (deps.lsof ?? defaultLsof)(uid));
    if (found.length === 0) return;
    out.orphans = found;
    for (const pid of killable(found)) {
      try { process.kill(pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") addCheckError(`kill ${pid}: ${String(e)}`); }
    }
    out.escaped = true; out.escape_source = pipeEscaped ? "both" : "orphan_scan";
  } catch (e) { addCheckError(e); }
}

/** Every process of this user with its cwd, as lsof field records; a deleted room still shows its path. */
const defaultLsof = (uid: number): string => execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-u", String(uid), "-Fpn"], { encoding: "utf8", timeout: 5000 });
