import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorCode } from "../domain/error-code.js";
import type { RunStore } from "../run/run-store.js";
import { readOmpCatalog } from "./model-catalog.js";
import { resolveOmpCatalogConfig, resolveOmpConfig } from "./omp-config.js";
import { createOmpProbeRunner, type OmpProbeRunner } from "./omp-probe-runner.js";
import { sharedOmpVersionCache } from "./omp-version-cache.js";
import type { OmpCheckResult } from "./omp-version.js";
import { installedBinaryDirs } from "./protected-paths.js";
import { RoleResolver } from "./role-resolver.js";

const EXIT: Record<"pass" | "fail" | "inconclusive", number> = { pass: 0, fail: 1, inconclusive: 2 };
/** omp is not runnable or silent about its version, or the probe could not run: no verdict. */
const EXIT_UNAVAILABLE = 3;
/** Ctrl-C: the probe's children were stopped and its dirs removed; no verdict, like inconclusive. */
const EXIT_INTERRUPTED = 2;

interface ProbeCliDeps {
  openStore: () => RunStore; env: NodeJS.ProcessEnv; cwd: string; out: (line: string) => void;
  /** SIGINT (cli.ts): stops the probe through the runner's stop signal. */
  signal?: AbortSignal;
  runner?: (signal: AbortSignal) => Pick<OmpProbeRunner, "probeNow">; versionCheck?: () => Promise<OmpCheckResult>;
}

/**
 * `houge omp probe` (spec §5 Manual): probe the installed omp now, skip rule ignored, and print each check. Records the
 * row and syncs the drift incident like the daemon's probe. Exit 0 pass, 1 fail, 2 inconclusive, 3 omp unavailable or
 * the probe could not run (an unexpected throw is never reported as drift; its code only, never omp's text).
 */
export async function runOmpProbeCli(d: ProbeCliDeps): Promise<number> {
  // Opening the store elsewhere would create a stray empty houge.sqlite and record the probe into it.
  if (!existsSync(join(d.cwd, "houge.sqlite"))) {
    d.out("run from the Houge project root (no houge.sqlite here)");
    return EXIT_UNAVAILABLE;
  }
  const signal = d.signal ?? new AbortController().signal;
  let store: RunStore | undefined;
  try {
    store = d.openStore();
    const code = await probeAndPrint(d, store, signal);
    return signal.aborted ? interrupted(d) : code;
  } catch (error) {
    if (signal.aborted) return interrupted(d);
    d.out(`omp probe failed: ${errorCode(error)}`);
    return EXIT_UNAVAILABLE;
  } finally {
    store?.close();
  }
}

function interrupted(d: ProbeCliDeps): number {
  d.out("omp probe interrupted");
  return EXIT_INTERRUPTED;
}

async function probeAndPrint(d: ProbeCliDeps, store: RunStore, signal: AbortSignal): Promise<number> {
  const roles = new RoleResolver({ store, readCatalog: () => readOmpCatalog(resolveOmpCatalogConfig(d.env)) });
  await roles.refreshCatalog();
  const cfg = resolveOmpConfig(d.env, roles.chains());
  // The daemon's data dir is its cwd (cli.ts telegram-poll): there is no data-dir variable.
  const ctx = { home: homedir(), repo: d.cwd, data: d.cwd, binDirs: installedBinaryDirs(d.env, process.execPath) };
  const check = await (d.versionCheck ?? (() => sharedOmpVersionCache(cfg).current()))();
  if (!check.ok) {
    d.out(`omp unavailable: ${check.reason}`);
    return EXIT_UNAVAILABLE;
  }
  const version = check.version;
  const runner = d.runner?.(signal) ?? createOmpProbeRunner({ store, cfg, ctx, roles, currentVersion: () => version, signal });
  const r = await runner.probeNow(version);
  if (signal.aborted) return EXIT_INTERRUPTED; // the caller prints "interrupted"; a cut probe's checks are not shown
  for (const [name, outcome] of Object.entries(r.checks)) d.out(`  ${name.padEnd(14)}  ${outcome}`);
  d.out(`omp ${version}: ${r.result} (model ${r.model ?? "none"})`);
  return EXIT[r.result];
}
