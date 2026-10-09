import { homedir } from "node:os";
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

interface ProbeCliDeps {
  store: RunStore; env: NodeJS.ProcessEnv; cwd: string; out: (line: string) => void;
  runner?: Pick<OmpProbeRunner, "probeNow">; versionCheck?: () => Promise<OmpCheckResult>;
}

/**
 * `houge omp probe` (spec §5 Manual): probe the installed omp now, skip rule ignored, and print each check. Records the
 * row and syncs the drift incident like the daemon's probe. Exit 0 pass, 1 fail, 2 inconclusive, 3 omp unavailable or
 * the probe could not run (an unexpected throw is never reported as drift; its code only, never omp's text).
 */
export async function runOmpProbeCli(d: ProbeCliDeps): Promise<number> {
  try {
    return await probeAndPrint(d);
  } catch (error) {
    d.out(`omp probe failed: ${errorCode(error)}`);
    return EXIT_UNAVAILABLE;
  }
}

async function probeAndPrint(d: ProbeCliDeps): Promise<number> {
  const roles = new RoleResolver({ store: d.store, readCatalog: () => readOmpCatalog(resolveOmpCatalogConfig(d.env)) });
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
  const runner = d.runner ?? createOmpProbeRunner({ store: d.store, cfg, ctx, roles, currentVersion: () => version,
    signal: new AbortController().signal });
  const r = await runner.probeNow(version);
  for (const [name, outcome] of Object.entries(r.checks)) d.out(`  ${name.padEnd(14)}  ${outcome}`);
  d.out(`omp ${version}: ${r.result} (model ${r.model ?? "none"})`);
  return EXIT[r.result];
}
