import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileAsync } from "../run/exec-file-async.js";
import { buildChildEnv } from "../llm/providers/cli-spawn.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyFetchIp, validateFetchTarget } from "../web/http-fetch.js";
import { writeRunReport } from "../report/report-writer.js";
import { createSelfWriteCodexAdapter } from "./coding-agent.js";
import {
  detectContainerRuntime,
  resolveExtWorkImage,
  runInContainer,
  type ContainerRuntime
} from "../run/container-runner.js";
import { runToolchainGate, type ToolchainGateResult } from "../run/toolchain-gate.js";
import type { ToolAdapterResult } from "../tools/tool-registry.js";

/**
 * External engineering workspace (ADR 0023, Money-Work Phase P1). An isolated, container-
 * sandboxed workspace where Houge does ENGINEERING WORK on an EXTERNAL repo: clone → Codex
 * edits host-side (in its own Seatbelt sandbox) → build/test IN A CONTAINER → produce a patch
 * + report as a LOCAL artifact. Charter-clean: produces work only — no money, no credentials,
 * no external write, no autonomy (the patch never leaves the box in P1; a human reviews it).
 *
 * TRUST BOUNDARY: the untrusted external code NEVER executes on the host. Only `git clone`
 * (which runs no repo hooks), Codex (own sandbox), `git diff`, and the artifact write run
 * host-side; ALL deps/build/test run inside the locked-down container (see container-runner).
 *
 * GRACEFUL DEGRADATION: with no container runtime installed, the pipeline stops BEFORE any
 * external code could run and delivers the {@link EXTWORK_RUNTIME_UNAVAILABLE_NOTICE} — it
 * never throws and never blocks the daemon.
 */

const DEFAULT_CLONE_TIMEOUT_MS = 120_000;
const DEFAULT_SIZE_CAP_MB = 500;

/** Whether the external workspace is armed (`HOUGE_EXTWORK_ENABLED`). DEFAULT OFF — the tool is
 *  unlisted (unreachable) unless this is truthy (armed-listing, like self_write_propose).
 *  Accepts 1/true/yes/on (case-insensitive). */
export function resolveExtWorkEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_EXTWORK_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Clone-size cap in MB (`HOUGE_EXTWORK_SIZE_CAP_MB`, default 500). */
export function resolveExtWorkSizeCapMB(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_EXTWORK_SIZE_CAP_MB);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SIZE_CAP_MB;
}

/** Clone wall-clock timeout in ms (`HOUGE_EXTWORK_CLONE_TIMEOUT_MS`, default 120000). */
export function resolveExtWorkCloneTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_EXTWORK_CLONE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLONE_TIMEOUT_MS;
}

// --- SSRF-validated clone URL ------------------------------------------------

export type CloneUrlValidation = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate a clone URL on the host. Reuses the `http_fetch` SSRF floor (scheme + creds-in-URL
 * + literal-private-IP block) then TIGHTENS to https-only for P1 — so `ssh://`, `git://`,
 * `file://`, and `http://` clone URLs are all refused (a `refused: ` prefix marks a policy
 * rejection). DNS is not resolved here (git resolves at clone time); the literal-IP + scheme
 * floor is the P1 posture, documented in ADR 0023.
 */
export function validateCloneUrl(rawUrl: string): CloneUrlValidation {
  const validated = validateFetchTarget(rawUrl, "GET", []);
  if (!validated.ok) return { ok: false, error: validated.error };
  if (validated.target.url.protocol !== "https:") {
    return { ok: false, error: `refused: clone URL must be https (got "${validated.target.url.protocol.replace(/:$/, "")}")` };
  }
  return { ok: true, url: validated.target.url.toString() };
}

// --- clone / teardown --------------------------------------------------------

export interface CloneExternalRepoOpts {
  sizeCapMB: number;
  timeoutMs: number;
  /** Injectable git runner (tests) — defaults to the promisified execFile. */
  exec?: (file: string, args: string[], opts: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<unknown>;
  /** Injectable DNS resolver (tests) — defaults to node:dns/promises lookup(all). */
  resolveHost?: (host: string) => Promise<Array<{ address: string }>>;
}

/**
 * Resolve-and-classify the clone host against the SSRF block tables (verifier MAJOR-3):
 * `validateCloneUrl` only blocks LITERAL private IPs, so a public DNS name whose A-record
 * points at 10.x / 169.254.x / an internal git service would pass the string check and then
 * `git clone` would connect to it. Resolve every address ONCE and refuse if any is blocked.
 * (git re-resolves at connect time — a narrow TOCTOU residual — but this closes the
 * static-record case, matching the http_fetch resolve-and-pin floor.)
 */
export async function assertCloneHostPublic(
  host: string,
  resolveHost: (host: string) => Promise<Array<{ address: string }>> = (h) => lookup(h, { all: true })
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isIP(host) !== 0) return { ok: true }; // literal IPs were already classified by validateFetchTarget
  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolveHost(host);
  } catch (error) {
    return { ok: false, error: `refused: clone host did not resolve (${errorMessage(error)})` };
  }
  if (addrs.length === 0) return { ok: false, error: "refused: clone host resolved to no addresses" };
  for (const { address } of addrs) {
    if (classifyFetchIp(address) === "blocked") {
      return { ok: false, error: `refused: clone host resolves to a blocked address (${address})` };
    }
  }
  return { ok: true };
}

export type CloneResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Clone an external repo shallowly into a FRESH tmp dir (`houge-extwork-<uuid>`, NEVER
 * `process.cwd()`). https-only + SSRF-validated first; `--depth 1 --single-branch --no-tags`
 * so no history and no tags; the child env is the allowlist with NO secrets. `git clone` runs
 * no repo hooks by construction. Post-clone the working-tree size is checked against the cap.
 * Any failure tears down the partial clone and returns a flat error — never a host escape.
 */
export async function cloneExternalRepo(url: string, opts: CloneExternalRepoOpts): Promise<CloneResult> {
  const validated = validateCloneUrl(url);
  if (!validated.ok) return validated;

  // Resolve-and-classify the host BEFORE cloning (verifier MAJOR-3: string-only validation
  // let a public DNS name → private IP through).
  const host = new URL(validated.url).hostname;
  const resolved = await assertCloneHostPublic(host, opts.resolveHost);
  if (!resolved.ok) return resolved;

  const path = join(tmpdir(), `houge-extwork-${randomUUID()}`);
  const exec =
    opts.exec ??
    ((file, args, o) => execFileAsync(file, args, { timeout: o.timeout, env: o.env }));
  try {
    await exec(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--no-tags", validated.url, path],
      { timeout: opts.timeoutMs, env: buildChildEnv(undefined) }
    );
  } catch (error) {
    removeExternalWorkspace(path);
    return { ok: false, error: `clone failed: ${errorMessage(error)}` };
  }

  const sizeMB = directorySizeMB(path);
  if (sizeMB > opts.sizeCapMB) {
    removeExternalWorkspace(path);
    return { ok: false, error: `cloned repo is too large (${sizeMB.toFixed(0)}MB > ${opts.sizeCapMB}MB cap)` };
  }
  return { ok: true, path };
}

/** Remove an external workspace (rmSync recursive+force). Idempotent — never throws. */
export function removeExternalWorkspace(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort teardown — a missing/half-created dir is fine.
  }
}

/** Best-effort working-tree size in MB (walks the dir; a stat error skips that entry). */
function directorySizeMB(root: string): number {
  let bytes = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else bytes += st.size;
      } catch {
        // skip unreadable entries
      }
    }
  };
  walk(root);
  return bytes / (1024 * 1024);
}

// --- artifact ----------------------------------------------------------------

export interface ExternalWorkArtifact {
  patchPath: string;
  reportPath: string;
  reportHash: string;
}

/**
 * Write the LOCAL artifact for an external-work run under `runs/<run_id>/`: `patch.diff` (the
 * unified diff Codex produced) and `report.md` (task + repo + gate summary). Reuses
 * writeRunReport's run_id path validation for the report; the patch is written beside it.
 */
export function writeExternalWorkArtifact(
  projectRoot: string,
  run_id: string,
  input: { task: string; repoUrl: string; patch: string; gateOutput: string }
): ExternalWorkArtifact {
  const report = writeRunReport(projectRoot, {
    run_id,
    title: "External work",
    body: [
      `Repo: ${input.repoUrl}`,
      `Task: ${input.task}`,
      "",
      "## Toolchain gate",
      "",
      "```",
      input.gateOutput.trim() || "(no output)",
      "```"
    ].join("\n"),
    sources: [input.repoUrl],
    partial: false
  });
  // report.md lives in runs/<run_id>/ (path already validated by writeRunReport); patch beside it.
  const patchPath = join(projectRoot, "runs", run_id, "patch.diff");
  writeFileSync(patchPath, input.patch);
  return { patchPath, reportPath: report.path, reportHash: report.hash };
}

// --- code-rendered notification / refusal constants --------------------------

/** Graceful-degrade notice when no container runtime is installed — surfaced, never thrown. */
export const EXTWORK_RUNTIME_UNAVAILABLE_NOTICE =
  "external_work needs a container runtime to sandbox the untrusted repo, and none is installed — install docker, podman, or colima, then try again. Nothing was cloned or run.";

/** Refusal wrapper for an SSRF/clone rejection (carries the underlying `refused:`/error reason). */
export function buildExtWorkRefusalNotice(reason: string): string {
  return `external_work refused the repo: ${reason}`;
}

/** Success notification: the patch + report are ready as a LOCAL artifact (NO merge/push in P1). */
export function buildExtWorkPublishedNotification(task: string, patchRelPath: string): string {
  return `🛠️ Worked on \`${task}\`. Wrote a patch to \`${patchRelPath}\` — review the diff, then apply it yourself (I don't push in P1).`;
}

/** Failure notification: nothing was produced; the reason is code-owned. */
export function buildExtWorkFailedNotification(task: string, reason: string): string {
  return `Tried \`${task}\` in an external workspace but couldn't land a clean patch (${reason}). Nothing written.`;
}

// --- DI bundle ---------------------------------------------------------------

/**
 * Injectable seams for the external-work pipeline (mirrors {@link import("../core/core-worker.js").SelfWriteDeps }).
 * A test mocks the whole stack — clone, the write-Codex adapter, runtime detection, the toolchain
 * gate, git diff, artifact write — without shelling out to git/codex/docker. Defaults wire the
 * real implementations.
 */
export interface ExternalWorkDeps {
  detectRuntime: (env: NodeJS.ProcessEnv) => Promise<ContainerRuntime | null>;
  resolveImage: (env: NodeJS.ProcessEnv) => string;
  cloneRepo: (url: string, opts: CloneExternalRepoOpts) => Promise<CloneResult>;
  removeWorkspace: (path: string) => void;
  /** Factory for the write-mode Codex adapter bound to the clone dir (workspace-write, -C clone). */
  makeWriteAdapter: (clonePath: string) => (input: { task: string }) => ToolAdapterResult | Promise<ToolAdapterResult>;
  /** Run the toolchain gate IN THE CONTAINER for the cloned workspace. */
  runToolchainGate: (input: { runtime: ContainerRuntime; workspace: string; image: string; env: NodeJS.ProcessEnv }) => Promise<ToolchainGateResult>;
  /** Read the clone's full unified diff against HEAD (`git diff HEAD`). */
  unifiedDiff: (clonePath: string) => Promise<string>;
  /** Write the local artifact (patch.diff + report.md) under runs/<run_id>/. */
  writeArtifact: (projectRoot: string, run_id: string, input: { task: string; repoUrl: string; patch: string; gateOutput: string }) => ExternalWorkArtifact;
}

/** Default wiring of the external-work stack to the real container/git/codex modules. */
export function defaultExternalWorkDeps(): ExternalWorkDeps {
  return {
    detectRuntime: (env) => detectContainerRuntime(env),
    resolveImage: resolveExtWorkImage,
    cloneRepo: cloneExternalRepo,
    removeWorkspace: removeExternalWorkspace,
    // Host-side Codex edit in the clone (its OWN Seatbelt sandbox; NEVER a bypass flag).
    makeWriteAdapter: (clonePath) => createSelfWriteCodexAdapter({ worktree: clonePath }),
    runToolchainGate: (input) =>
      runToolchainGate({ ...input, runInContainer }),
    // `--no-ext-diff --no-textconv` (verifier MAJOR-2): the untrusted clone's .gitattributes +
    // repo-local git config could otherwise run an external-diff/textconv COMMAND on the HOST
    // during `git diff`, escaping the container. These flags disable that host-exec path.
    unifiedDiff: async (clonePath) =>
      (await execFileAsync(
        "git",
        ["-C", clonePath, "diff", "--no-ext-diff", "--no-textconv", "HEAD"],
        { maxBuffer: 16 * 1024 * 1024 }
      )).stdout,
    writeArtifact: writeExternalWorkArtifact
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
