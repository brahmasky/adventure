import { readdirSync } from "node:fs";
import type { SpawnImpl } from "../llm/providers/cli-spawn.js";
import {
  resolveExtWorkCpus,
  resolveExtWorkMemory,
  resolveExtWorkPids,
  resolveExtWorkStageTimeoutMs,
  type ContainerNetwork,
  type ContainerRunResult,
  type ContainerRuntime
} from "./container-runner.js";

/**
 * Toolchain gate (ADR 0023, Money-Work Phase P1) — the objective, ungameable truth check for
 * an EXTERNAL repo, generalized from `src/run/test-gate.ts`. Where the self-write gate runs a
 * hardcoded npm typecheck→test→build on the HOST, this one detects the repo's ecosystem from
 * the files in the workspace, then runs each stage IN A CONTAINER via the injected
 * {@link runInContainer} — so the untrusted external code (its deps, build, tests) NEVER
 * executes on the host.
 *
 * Per-stage network is EXPLICIT: deps-install runs with `egress` (the honest tradeoff — a
 * package manager must reach the registry), build/test run with `none` (fully isolated). Stages
 * run first-red-stops, output is capped + aggregated, and the whole run is bounded by the
 * per-stage wall clock. Pure of real I/O except the injected `runInContainer` and the one-shot
 * `readdirSync` used to detect the stage plan; {@link detectStagePlan} is exported so fixture
 * tests can assert detection without a container.
 */

export type ToolchainNetwork = ContainerNetwork;

export interface ToolchainStage {
  /** Human-readable stage name (surfaced in the failure output + refine feedback). */
  name: string;
  /** The command + args run inside the container. */
  cmd: string[];
  /** `egress` for a package-manager install; `none` for build/test. */
  network: ToolchainNetwork;
}

export type ToolchainGateResult =
  | { ok: true; output: string }
  | { ok: false; failedStage: string; output: string; unavailable?: boolean };

/** Cap on the aggregated cross-stage output (last N bytes). */
const AGGREGATE_CAP_BYTES = 16 * 1024;

/**
 * Detect the ordered stage plan for a workspace from the marker files in its root. Priority:
 * package.json (node) → requirements.txt (python) → Cargo.toml (rust) → Makefile. Returns an
 * empty plan when no toolchain marker is present (the gate then passes vacuously — P1 has no
 * generic builder). Exported + pure-ish (one `readdirSync`) so fixture-dir tests can assert it.
 */
export function detectStagePlan(workspace: string): ToolchainStage[] {
  let files: Set<string>;
  try {
    files = new Set(readdirSync(workspace));
  } catch {
    return [];
  }
  if (files.has("package.json")) {
    return [
      { name: "npm ci", cmd: ["npm", "ci"], network: "egress" },
      { name: "npm test", cmd: ["npm", "test"], network: "none" }
    ];
  }
  if (files.has("requirements.txt")) {
    return [
      { name: "pip install", cmd: ["pip", "install", "-r", "requirements.txt"], network: "egress" },
      { name: "pytest", cmd: ["pytest"], network: "none" }
    ];
  }
  if (files.has("Cargo.toml")) {
    return [
      // cargo must fetch crates on first build → egress; the test run is then fully offline.
      { name: "cargo build", cmd: ["cargo", "build"], network: "egress" },
      { name: "cargo test", cmd: ["cargo", "test", "--offline"], network: "none" }
    ];
  }
  if (files.has("Makefile")) {
    return [{ name: "make", cmd: ["make"], network: "none" }];
  }
  return [];
}

export interface RunToolchainGateInput {
  runtime: ContainerRuntime;
  workspace: string;
  image: string;
  /** Injected container runner — the ONLY real-I/O seam (fake in every test). */
  runInContainer: (
    rt: ContainerRuntime,
    opts: {
      workspace: string;
      image: string;
      cmd: string[];
      network: ContainerNetwork;
      memory: string;
      cpus: string;
      pidsLimit: number;
      timeoutMs: number;
    },
    spawnImpl?: SpawnImpl
  ) => Promise<ContainerRunResult>;
  env: NodeJS.ProcessEnv;
}

/**
 * Run the detected stage plan in the container, first-red-stops. All-green → `{ ok: true }`;
 * the first failing/timed-out/unavailable stage → `{ ok: false, failedStage, output }`. Never
 * throws — the injected runner returns a total result, so a stage failure is data, not an error.
 */
export async function runToolchainGate(input: RunToolchainGateInput): Promise<ToolchainGateResult> {
  const { runtime, workspace, image, env } = input;
  const plan = detectStagePlan(workspace);
  if (plan.length === 0) {
    return { ok: true, output: "no recognized toolchain (package.json / requirements.txt / Cargo.toml / Makefile) — nothing to run" };
  }

  const memory = resolveExtWorkMemory(env);
  const cpus = resolveExtWorkCpus(env);
  const pidsLimit = resolveExtWorkPids(env);
  const timeoutMs = resolveExtWorkStageTimeoutMs(env);

  const transcript: string[] = [];
  for (const stage of plan) {
    const result = await input.runInContainer(runtime, {
      workspace,
      image,
      cmd: stage.cmd,
      network: stage.network,
      memory,
      cpus,
      pidsLimit,
      timeoutMs
    });
    const header = `$ [${stage.network}] ${stage.cmd.join(" ")}`;
    transcript.push(`${header}\n${result.output}`);
    if (result.unavailable) {
      return { ok: false, failedStage: stage.name, output: capAggregate(transcript), unavailable: true };
    }
    if (result.timedOut) {
      return { ok: false, failedStage: stage.name, output: capAggregate([...transcript, `${stage.name} timed out after ${timeoutMs}ms`]) };
    }
    if (result.exitCode !== 0) {
      return { ok: false, failedStage: stage.name, output: capAggregate(transcript) };
    }
  }
  return { ok: true, output: capAggregate(transcript) };
}

function capAggregate(parts: string[]): string {
  const joined = parts.join("\n\n");
  if (joined.length <= AGGREGATE_CAP_BYTES) return joined;
  return joined.slice(joined.length - AGGREGATE_CAP_BYTES);
}
