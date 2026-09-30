import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { OMP_ENV_VARS } from "../../src/omp/omp-config.js";

/** A path that is never an executable: a suite that forgets to point at the fake can never reach a real omp. */
export const NO_OMP_BIN = "/nonexistent/houge-tests/omp";
/** The marker the PATH stubs (`omp`, `agy`; tests/helpers/setup-no-real-omp.ts) write to stderr. */
export const STUB_MARKER = "HOUGE_TEST_STUB";
export const FAKE_OMP_BIN = new URL("../fixtures/fake-omp.mjs", import.meta.url).pathname;
const EXTRA = ["FAKE_OMP_SCENARIO", "FAKE_OMP_ARGV_LOG", "HOUGE_BRIDGE_SOCK", "HOUGE_BRIDGE_TOKEN", "FAKE_OMP_RESUMED"];

/**
 * PINNED_ENV (ROADMAP §3.5): saves and deletes every omp variable (plus the fake's and the bridge's)
 * before each test and restores them after, so the mini's real .env can never reach a suite that
 * builds a CoreWorker, the daemon, or resolveOmpConfig(process.env). HOUGE_OMP_BIN is then set to a
 * non-executable path: only a test that opts into the fake (`useFakeOmp`) can spawn anything.
 */
export function pinOmpEnv(): void {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of [...OMP_ENV_VARS, ...EXTRA]) { saved.set(k, process.env[k]); delete process.env[k]; }
    process.env.HOUGE_OMP_BIN = NO_OMP_BIN;
  });
  afterEach(() => {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
  });
}

/** Point the process at tests/fixtures/fake-omp.mjs with `scenario` (ruling 4: the env allowlist must pass the fake's vars). */
export function useFakeOmp(scenario: Record<string, unknown>, dir: string): void {
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify(scenario));
  process.env.HOUGE_OMP_BIN = FAKE_OMP_BIN;
  process.env.HOUGE_OMP_SANDBOX = "0";
  process.env.HOUGE_OMP_ENV_PASSTHROUGH = "FAKE_OMP_SCENARIO,FAKE_OMP_ARGV_LOG";
  process.env.FAKE_OMP_SCENARIO = file;
}

/** A tmp dist dir holding the shell wrapper copied exactly as scripts/copy-omp-assets.mjs does (ruling 6). */
export function tmpOmpDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "omp"), { recursive: true });
  copyFileSync(new URL("../../src/omp/shell-wrapper.sh", import.meta.url), join(dist, "omp", "shell-wrapper.sh"));
  return dist;
}

/** A short tmp root (the bridge socket path must fit sun_path, 104 bytes). */
export function shortTmp(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * PINNED_ENV for feature flags: saves and deletes every HOUGE_*_ENABLED flag before each test and
 * restores them after, so an armed flag in the environment (the radar, the panel, …) can never
 * change what a suite's daemon cycle or turn does. Tests arm the flags they need explicitly.
 */
export function pinEnabledFlags(): void {
  const saved = new Map<string, string>();
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!/^HOUGE_[A-Z0-9_]+_ENABLED$/.test(k)) continue;
      saved.set(k, process.env[k] as string);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (/^HOUGE_[A-Z0-9_]+_ENABLED$/.test(k)) delete process.env[k];
    for (const [k, v] of saved) process.env[k] = v;
    saved.clear();
  });
}
