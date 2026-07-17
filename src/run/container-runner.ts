import { buildChildEnv, defaultSpawnImpl, type SpawnImpl } from "../llm/providers/cli-spawn.js";

/**
 * Container runner (ADR 0023, Money-Work Phase P1) — the EXTERNAL engineering workspace's
 * containment floor. Untrusted external code (its deps, builds, tests) MUST NEVER execute on
 * the host; it runs ONLY inside a locked-down `docker`/`podman` container spawned here.
 *
 * GRACEFUL DEGRADATION is the contract (mirrors `src/llm/embeddings.ts`): if no container
 * runtime is installed, {@link detectContainerRuntime} returns `null` and the capability
 * reports itself unavailable — it NEVER throws and NEVER blocks the daemon. Live-container
 * tests are deferred to a later live gate on a box that has docker/podman; every test here
 * injects a FAKE spawn impl, so no real container is ever launched.
 *
 * {@link buildContainerArgs} is the load-bearing security surface: it emits a non-root,
 * read-only, all-caps-dropped, no-new-privileges, resource-capped `run --rm` with EXACTLY
 * ONE bind mount (the scratch workspace → `/work`) and NEVER a docker.sock mount, a host-root
 * mount, or `--privileged`. The child env is the `buildChildEnv` allowlist with NO secrets —
 * the container authenticates to nothing.
 */

/** A detected container runtime — just the binary name (`docker` or `podman`). */
export interface ContainerRuntime {
  bin: string;
}

/** Per-stage network posture: fully isolated, or the egress network (deps install only). */
export type ContainerNetwork = "none" | "egress";

export interface ContainerRunOpts {
  /** Absolute host path bind-mounted (the ONLY mount) to `/work` inside the container. */
  workspace: string;
  /** The container image (a pinned public multi-toolchain tag; see {@link resolveExtWorkImage}). */
  image: string;
  /** The command + args run inside the container (e.g. `["npm", "ci"]`). */
  cmd: string[];
  /** `none` (build/test — no network at all) or `egress` (deps install — the honest tradeoff). */
  network: ContainerNetwork;
  /** `--memory` value (e.g. `2g`). */
  memory: string;
  /** `--cpus` value (e.g. `2`). */
  cpus: string;
  /** `--pids-limit` value. */
  pidsLimit: number;
  /** Wall-clock cap for the spawn (ms). */
  timeoutMs: number;
}

export interface ContainerRunResult {
  /** Process exit code; `null` when killed (timeout) or the runtime could not be spawned. */
  exitCode: number | null;
  /** Combined, capped stdout+stderr. */
  output: string;
  /** True when our timeout fired. */
  timedOut: boolean;
  /** True when the runtime binary could not be spawned (ENOENT etc.) — degrade gracefully. */
  unavailable?: boolean;
}

/**
 * Documented default image (override with `HOUGE_EXTWORK_IMAGE`). A pinned public
 * multi-toolchain devcontainer image carrying node + python + rust + make; the operator
 * is expected to override this with the exact toolchain image their target repos need.
 */
export const DEFAULT_EXTWORK_IMAGE = "mcr.microsoft.com/devcontainers/universal:2-linux";

/** The docker/podman network name used for the deps-install (egress) stage. */
export const EXTWORK_EGRESS_NETWORK = "bridge";

export const DEFAULT_EXTWORK_MEMORY = "2g";
export const DEFAULT_EXTWORK_CPUS = "2";
export const DEFAULT_EXTWORK_PIDS = 512;
export const DEFAULT_EXTWORK_STAGE_TIMEOUT_MS = 300_000;

/** Short probe timeout for `docker/podman version` (detection must be quick + never hang). */
const DETECT_TIMEOUT_MS = 5_000;
const DETECT_MAX_BYTES = 1 * 1024 * 1024;
/** Cap on captured container stdout+stderr (last N bytes). A red build log can be enormous. */
const RUN_MAX_BYTES = 4 * 1024 * 1024;
const OUTPUT_CAP_BYTES = 16 * 1024;

/** The runtimes probed, in order of preference. */
const CANDIDATE_BINS = ["docker", "podman"] as const;

/** Resolve the ext-work container image (`HOUGE_EXTWORK_IMAGE`, default {@link DEFAULT_EXTWORK_IMAGE}). */
export function resolveExtWorkImage(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_EXTWORK_IMAGE?.trim();
  // An image is a bare positional after all `docker run` flags; a value starting with "-"
  // would be parsed as a flag. It's operator-set (not attacker), but reject it defensively.
  if (raw && raw.length > 0 && !raw.startsWith("-")) return raw;
  return DEFAULT_EXTWORK_IMAGE;
}

export function resolveExtWorkMemory(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_EXTWORK_MEMORY?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_EXTWORK_MEMORY;
}

export function resolveExtWorkCpus(env: NodeJS.ProcessEnv): string {
  const raw = env.HOUGE_EXTWORK_CPUS?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_EXTWORK_CPUS;
}

export function resolveExtWorkPids(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_EXTWORK_PIDS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EXTWORK_PIDS;
}

export function resolveExtWorkStageTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_EXTWORK_STAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_EXTWORK_STAGE_TIMEOUT_MS;
}

function capOutput(text: string): string {
  if (text.length <= OUTPUT_CAP_BYTES) return text;
  return text.slice(text.length - OUTPUT_CAP_BYTES);
}

/**
 * Detect an installed container runtime by probing `docker version` then `podman version`.
 * Returns `{ bin }` for the first that spawns and exits 0; `null` otherwise (ENOENT, timeout,
 * non-zero, or ANY throw). NEVER throws — mirrors the embeddings probe-or-null contract, so a
 * box with no container runtime degrades to "unavailable" instead of crashing the daemon.
 */
export async function detectContainerRuntime(
  env: NodeJS.ProcessEnv,
  spawnImpl: SpawnImpl = defaultSpawnImpl
): Promise<ContainerRuntime | null> {
  void env;
  for (const bin of CANDIDATE_BINS) {
    try {
      const result = await spawnImpl(bin, ["version"], {
        timeoutMs: DETECT_TIMEOUT_MS,
        cwd: process.cwd(),
        env: buildChildEnv(undefined),
        maxBytes: DETECT_MAX_BYTES,
        input: ""
      });
      if (!result.spawnError && !result.timedOut && result.code === 0) {
        return { bin };
      }
    } catch {
      // A total-function spawn impl should never throw, but never let a probe crash detection.
    }
  }
  return null;
}

/**
 * Build the argv for `docker/podman run` — THE load-bearing security surface (asserted in
 * tests). Locked down: non-root (`--user 1000:1000`), read-only root fs (`--read-only`) with a
 * writable `/tmp` tmpfs, ALL caps dropped, `no-new-privileges`, resource caps (memory/cpus/
 * pids), and network per `opts.network` (`none` for build/test, the egress network for deps
 * install). EXACTLY ONE bind mount — the scratch workspace → `/work` — and NEVER a docker.sock
 * mount, a host-root mount, or `--privileged`.
 */
export function buildContainerArgs(rt: ContainerRuntime, opts: ContainerRunOpts): string[] {
  void rt;
  const network = opts.network === "none" ? "none" : EXTWORK_EGRESS_NETWORK;
  return [
    "run",
    "--rm",
    "--network",
    network,
    // EXACTLY ONE mount: the scratch workspace. No docker.sock, no host root, no extra volumes.
    "-v",
    `${opts.workspace}:/work`,
    "-w",
    "/work",
    "--user",
    "1000:1000",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    opts.memory,
    "--cpus",
    opts.cpus,
    "--pids-limit",
    String(opts.pidsLimit),
    opts.image,
    ...opts.cmd
  ];
}

/**
 * Run ONE command inside a locked-down container. Spawns via the cli-spawn total-function
 * impl (SIGKILL timeout + hard stdout byte cap) with the {@link buildChildEnv} allowlist and
 * NO secrets. Returns `{ exitCode, output, timedOut, unavailable? }`; a spawn failure (runtime
 * vanished mid-run) maps to `unavailable: true`. NEVER throws.
 */
export async function runInContainer(
  rt: ContainerRuntime,
  opts: ContainerRunOpts,
  spawnImpl: SpawnImpl = defaultSpawnImpl
): Promise<ContainerRunResult> {
  try {
    const args = buildContainerArgs(rt, opts);
    const result = await spawnImpl(rt.bin, args, {
      timeoutMs: opts.timeoutMs,
      cwd: opts.workspace,
      // NO secrets in the container — the allowlist only (the untrusted code sees nothing sensitive).
      env: buildChildEnv(undefined),
      maxBytes: RUN_MAX_BYTES,
      input: ""
    });
    if (result.spawnError) {
      return {
        exitCode: null,
        output: `container runtime unavailable (${result.spawnError.code ?? "spawn failed"})`,
        timedOut: false,
        unavailable: true
      };
    }
    const combined = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
    return { exitCode: result.code, output: capOutput(combined), timedOut: result.timedOut };
  } catch (error) {
    return {
      exitCode: null,
      output: `container run failed: ${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
      unavailable: true
    };
  }
}
