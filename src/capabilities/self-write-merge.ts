import { execFileSync, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runTestGate, type TestGateResult } from "../run/test-gate.js";

/**
 * Self-write merge actions (ADR 0011, Phase 3.3 — interactive Telegram merge controls).
 * The git/build/test-gate/self-restart logic behind the published-notification buttons:
 * [View diff] · [Merge & reload] · [Discard].
 *
 * §5 amendment (Phase 3.3): the daemon merges + reloads self-authored code ONLY on Paco's
 * authenticated Telegram tap; it never merges on its own. This module is the *executor* of
 * that authorized action. The protected-path guard (checker 1) still gates what can ever be
 * on a branch, so the merge mechanism cannot widen the dangerous surface.
 *
 * THE CRITICAL ORDER for [Merge & reload]:
 *   capture preMergeRef → merge → build → testGate
 *     • build/testGate RED → resetMerge to preMergeRef, NO restart, NO push (daemon keeps old code)
 *     • GREEN → writeReloadMarker (boot confirmation, ⓪·2c U2) → notifyDurable("merged,
 *       reloading…") BEFORE restart() (so the message survives the SIGTERM) → push if requested
 *       → detached launchctl kickstart (the spike pattern)
 *
 * Pure-ish + dependency-injected ({@link MergeActionDeps}): the real git/launchctl/build live
 * ONLY in {@link defaultMergeActionDeps}; the exports below are fully unit-testable with mocks,
 * so no real restart/merge/build happens in tests. No new dependencies — `git`/`launchctl` are
 * shelled via node's child_process; the test-gate is reused as-is.
 *
 * Every export NEVER throws to the caller — failures map to a structured outcome/reason.
 */

const DEFAULT_DAEMON_LABEL = "com.houge.daemon";
const DEFAULT_INTO = "main";
/** Cap the diff to its last N bytes — a callback reply can't carry an unbounded diff. */
const DIFF_CAP_BYTES = 16 * 1024;

/** The injectable seam. Real impls in {@link defaultMergeActionDeps}; tests pass mocks. */
export interface MergeActionDeps {
  /** True if `branch` exists as a ref. */
  branchExists(branch: string): boolean;
  /** True if `branch` is already an ancestor of `into` (git merge-base --is-ancestor). */
  isMerged(branch: string, into: string): boolean;
  /** `git diff into...branch`, BOUNDED to ~16KB tail. */
  diff(branch: string, into: string): string;
  /** `git merge branch` into `into`. THROWS on conflict (caller maps to merge_conflict). */
  merge(branch: string, into: string): void;
  /** Undo a merge: `git reset --hard <toRef>` on `into` (the revert path). */
  resetMerge(into: string, toRef: string): void;
  /** Capture HEAD of `into` BEFORE merging (the pre-merge ref, for revert). */
  preMergeRef(into: string): string;
  /** `npm run build` (main source → new dist/). */
  build(): { ok: boolean; output?: string };
  /**
   * Newest mtime (epoch ms) across dist/'s .js files, or `undefined` when dist/ is absent —
   * the verified-artifact probe behind the stale_dist revert. OPTIONAL so existing injected
   * test deps stay valid; the real deps always provide it.
   */
  distNewestMtimeMs?(): number | undefined;
  /** Re-run the test-gate on the merged repo (the project root, bound by the deps). */
  testGate(): TestGateResult;
  /** `git branch -D branch`. */
  deleteBranch(branch: string): void;
  /**
   * Durably record the merged HEAD (sha + subject + branch) — called ONLY on a green gate,
   * BEFORE notifyDurable/restart, so the rebooted daemon can confirm the reload (⓪·2c U2).
   */
  writeReloadMarker(branch: string, into: string): void;
  /** Write to the durable outbox BEFORE the restart (so the message survives the kill). */
  notifyDurable(text: string): void;
  /** DETACHED launchctl kickstart — the validated spike pattern (kills + relaunches us). */
  restart(): void;
  /** `git push origin into`. */
  push(into: string): void;
}

/** Resolve whether [Merge & reload] also pushes (`HOUGE_SELFWRITE_PUSH`, default false). */
export function resolveSelfWritePush(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_SELFWRITE_PUSH?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export type ViewDiffResult =
  | { ok: true; diff: string }
  | { ok: false; reason: string };

/** [View diff] — read-only `git diff into...branch` (bounded). "branch not found" if absent. */
export function viewDiff(params: {
  branch: string;
  into?: string;
  deps: MergeActionDeps;
}): ViewDiffResult {
  const { branch, deps } = params;
  const into = params.into ?? DEFAULT_INTO;
  try {
    if (!deps.branchExists(branch)) {
      return { ok: false, reason: "branch not found" };
    }
    return { ok: true, diff: deps.diff(branch, into) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export type DiscardResult =
  | { ok: true }
  | { ok: false; reason: string };

/** [Discard] — `git branch -D`. Idempotent: an already-gone branch → ok ("already gone"). */
export function discardBranch(params: { branch: string; deps: MergeActionDeps }): DiscardResult {
  const { branch, deps } = params;
  try {
    if (!deps.branchExists(branch)) {
      return { ok: true }; // already gone — idempotent no-op
    }
    deps.deleteBranch(branch);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** The structured result of [Merge & reload] — exactly one of these variants. Never throws. */
export type MergeOutcome =
  | { kind: "already_merged" }
  | { kind: "not_found" }
  | { kind: "merge_conflict"; detail: string }
  | { kind: "reverted"; stage: "build" | "test" | "stale_dist"; detail: string }
  | { kind: "reloaded"; pushed: boolean };

/**
 * [Merge & reload] — the gated merge→build→testGate→detached-restart sequence.
 *
 * Order (CRITICAL): preMergeRef → merge → build → testGate.
 *  - already merged (isMerged) → no-op `already_merged`.
 *  - branch absent (!branchExists) → `not_found`.
 *  - merge throws (conflict) → `merge_conflict` (leave `into` clean; no build/restart).
 *  - build RED → resetMerge + `reverted` (stage "build"); NO restart, NO push.
 *  - testGate RED → resetMerge + `reverted` (stage "test"); NO restart, NO push.
 *  - dist STALE (distNewestMtimeMs < merge start) → resetMerge + `reverted` (stage "stale_dist").
 *  - GREEN → writeReloadMarker → notifyDurable("merged, reloading…") BEFORE restart() → push if
 *    requested → restart().
 *
 * ── 07-07 "reload race" investigation (evidence, so the invariant below has context) ──
 * Four merge cycles showed beacon+restart at merge+12–16s while dist/ mtimes read ~2 minutes
 * later — which looked like restart racing the rebuild. It wasn't: the gate genuinely runs in
 * ~17s on this machine (typecheck 3.3s + vitest 12.1s wall + tsc 1.2s, measured), so the sync
 * green path really completes at +16s and the daemon relaunches onto dist written ~1s earlier.
 * The late mtimes were written by LATER `npm test` runs from the verification session —
 * tests/smoke.test.ts rm-rf's and rebuilds dist/ on every suite run. The stale-dist check
 * below is therefore defense-in-depth, not a race fix: it makes "restart only lands on an
 * artifact this flow built" EXPLICIT, so a future async/skipped gate (or a smoke-test rm
 * window) turns into a loud revert instead of a silent stale reload.
 *
 * `into` defaults to "main". `push` defaults to false. `now` is injectable for tests.
 */
export function mergeAndReload(params: {
  branch: string;
  into?: string;
  push?: boolean;
  deps: MergeActionDeps;
  now?: () => number;
}): MergeOutcome {
  const { branch, deps } = params;
  const into = params.into ?? DEFAULT_INTO;
  const push = params.push ?? false;
  const mergeStartedAtMs = (params.now ?? Date.now)();

  try {
    // Idempotency: already an ancestor of `into` → nothing to do (a double-tap is safe).
    if (deps.branchExists(branch) && deps.isMerged(branch, into)) {
      return { kind: "already_merged" };
    }
    if (!deps.branchExists(branch)) {
      return { kind: "not_found" };
    }

    // Capture the pre-merge HEAD FIRST so a red build/test can be cleanly reverted.
    const toRef = deps.preMergeRef(into);

    try {
      deps.merge(branch, into);
    } catch (error) {
      // Conflict — leave `into` clean (git aborts a conflicted merge on its own / abort in deps);
      // NEVER build or restart on a failed merge.
      return { kind: "merge_conflict", detail: errorMessage(error) };
    }

    // CHECKER (post-merge): build the merged source.
    const built = deps.build();
    if (!built.ok) {
      deps.resetMerge(into, toRef);
      return { kind: "reverted", stage: "build", detail: built.output ?? "build failed" };
    }

    // CHECKER (post-merge): re-run the test-gate on the merged repo. RED → revert, no restart.
    // (testGate is bound to the project dir by the deps — NOT the branch name; passing `into` here was
    //  a real bug: it ran npm with cwd=<branch> → ENOENT → every merge falsely reverted. Caught live.)
    const gate = deps.testGate();
    if (!gate.green) {
      deps.resetMerge(into, toRef);
      return { kind: "reverted", stage: "test", detail: gate.output };
    }

    // VERIFIED-ARTIFACT invariant: the restart may only land on a dist/ this flow built.
    // Newest dist mtime predating the merge start means the gate's build didn't actually
    // write the artifact (skipped/async/rm'd) — revert loudly rather than reload stale code.
    if (deps.distNewestMtimeMs) {
      const newest = deps.distNewestMtimeMs();
      if (newest === undefined || newest < mergeStartedAtMs) {
        deps.resetMerge(into, toRef);
        return {
          kind: "reverted",
          stage: "stale_dist",
          detail:
            newest === undefined
              ? "dist/ missing after a green gate — refusing to restart onto no artifact"
              : `dist/ artifact predates the merge (dist ${new Date(newest).toISOString()} < merge start ${new Date(mergeStartedAtMs).toISOString()}) — refusing to restart onto stale code`
        };
      }
    }

    // GREEN. Record the reload marker FIRST (the next boot's confirmation reads it), then the
    // durable "reloading" beacon — both must be on disk BEFORE the restart kills us. A marker
    // failure must not block the (already green) reload: the confirmation is a nicety.
    try {
      deps.writeReloadMarker(branch, into);
    } catch {
      // best-effort — the boot confirmation just won't fire
    }
    deps.notifyDurable("merged, reloading…");
    if (push) {
      deps.push(into);
    }
    // Detached launchctl kickstart — the instruction outlives our own SIGTERM (spike pattern).
    deps.restart();
    return { kind: "reloaded", pushed: push };
  } catch (error) {
    // A deps failure outside the merge (e.g. preMergeRef/build threw) — surface as a clean
    // "reverted" so the caller never gets an exception. Best-effort reset; never restart.
    try {
      deps.resetMerge(into, ""); // no-op-safe; real deps no-op on empty ref
    } catch {
      // best-effort
    }
    return { kind: "reverted", stage: "build", detail: errorMessage(error) };
  }
}

/** Resolve the daemon's launchd label (`HOUGE_DAEMON_LABEL`, default `com.houge.daemon`). */
export function resolveDaemonLabel(env: NodeJS.ProcessEnv): string {
  const label = env.HOUGE_DAEMON_LABEL?.trim();
  return label && label.length > 0 ? label : DEFAULT_DAEMON_LABEL;
}

interface NodeError extends Error {
  stderr?: Buffer | string | null;
}

/**
 * The default, real-world {@link MergeActionDeps}: shells `git` / `npm` / `launchctl` against the
 * live project root. Used ONLY in production wiring — tests inject mocks, so none of this runs in
 * the suite (no real restart/merge/build). `dir` is the live repo root (the daemon's tree).
 *
 *  - restart() mirrors `scripts/spike-self-restart-p3.mjs`: a DETACHED, unref'd
 *    `launchctl kickstart -k gui/<uid>/<label>` so the kickstart reaches launchd even as the
 *    daemon is SIGTERM'd, then launchd relaunches onto the new dist/.
 */
export function defaultMergeActionDeps(opts: {
  dir: string;
  env?: NodeJS.ProcessEnv;
  notifyDurable: (text: string) => void;
  /** Persist the reload marker (⓪·2c U2); production wires RunStore.writeReloadMarker. */
  writeReloadMarker?: (marker: { sha: string; subject: string; branch: string }) => void;
}): MergeActionDeps {
  const { dir, notifyDurable } = opts;
  const env = opts.env ?? process.env;
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  return {
    branchExists(branch: string): boolean {
      try {
        git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
        return true;
      } catch {
        return false;
      }
    },
    isMerged(branch: string, into: string): boolean {
      try {
        // Exit 0 iff `branch` is an ancestor of `into` (i.e. already merged).
        git("merge-base", "--is-ancestor", branch, into);
        return true;
      } catch {
        return false;
      }
    },
    diff(branch: string, into: string): string {
      const out = git("diff", `${into}...${branch}`);
      return out.length <= DIFF_CAP_BYTES ? out : out.slice(out.length - DIFF_CAP_BYTES);
    },
    merge(branch: string, into: string): void {
      // Ensure we're on `into`, then merge the branch. A conflict makes `git merge` exit non-zero;
      // abort so the working tree is left clean before the caller maps to merge_conflict.
      try {
        git("checkout", into);
        git("merge", "--no-edit", branch);
      } catch (error) {
        try {
          git("merge", "--abort");
        } catch {
          // best-effort — nothing to abort if the merge didn't start
        }
        const err = error as NodeError;
        const detail = err.stderr != null ? err.stderr.toString().trim() : err.message;
        throw new Error(detail || "merge failed");
      }
    },
    resetMerge(into: string, toRef: string): void {
      if (!toRef) return; // empty ref → no-op-safe
      git("checkout", into);
      git("reset", "--hard", toRef);
    },
    preMergeRef(into: string): string {
      return git("rev-parse", into).trim();
    },
    build(): { ok: boolean; output?: string } {
      try {
        execFileSync("npm", ["run", "build"], {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"]
        });
        return { ok: true };
      } catch (error) {
        const err = error as NodeError;
        const detail = err.stderr != null ? err.stderr.toString() : (error as Error).message;
        return { ok: false, output: detail.slice(-DIFF_CAP_BYTES) };
      }
    },
    testGate(): TestGateResult {
      return runTestGate(dir, { env });
    },
    distNewestMtimeMs(): number | undefined {
      return newestDistMtimeMs(join(dir, "dist"));
    },
    deleteBranch(branch: string): void {
      git("branch", "-D", branch);
    },
    writeReloadMarker(branch: string, into: string): void {
      if (!opts.writeReloadMarker) return;
      opts.writeReloadMarker({
        sha: git("rev-parse", into).trim(),
        subject: git("log", "-1", "--format=%s", into).trim(),
        branch
      });
    },
    notifyDurable,
    restart(): void {
      const uid = process.getuid?.() ?? 0;
      const label = resolveDaemonLabel(env);
      // Detached + unref'd so the kickstart survives our own SIGTERM (validated spike pattern).
      const child = spawn("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    },
    push(into: string): void {
      git("push", "origin", into);
    }
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

/** Newest `ext` mtime under `dir` (recursive), or undefined when absent/empty. Never throws. */
export function newestMtimeMs(dir: string, ext: string): number | undefined {
  try {
    let newest: number | undefined;
    for (const entry of readdirSync(dir, { recursive: true })) {
      const name = String(entry);
      if (!name.endsWith(ext)) continue;
      const ms = statSync(join(dir, name)).mtimeMs;
      if (newest === undefined || ms > newest) newest = ms;
    }
    return newest;
  } catch {
    return undefined; // dir missing or unreadable → treated as no artifact
  }
}

/** Newest .js mtime under `distDir` — the verified-artifact probe. */
export function newestDistMtimeMs(distDir: string): number | undefined {
  return newestMtimeMs(distDir, ".js");
}
