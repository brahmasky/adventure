import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discardBranch,
  mergeAndReload,
  newestMtimeMs,
  resolveDaemonLabel,
  resolveSelfWritePush,
  viewDiff,
  type MergeActionDeps
} from "../../src/capabilities/self-write-merge.js";
import type { TestGateResult } from "../../src/run/test-gate.js";

/**
 * A fully-mocked {@link MergeActionDeps} that RECORDS the call order, so we can assert the
 * Phase-3.3 safety invariants without running real git/build/launchctl:
 *  - notifyDurable is written BEFORE restart (the message must survive the SIGTERM).
 *  - on a red build/testGate, resetMerge runs and restart NEVER does (daemon keeps old code).
 *  - a failed merge never reaches build/restart.
 */
function makeDeps(over: Partial<MergeActionDeps> & {
  buildOk?: boolean;
  gate?: TestGateResult;
  mergeThrows?: boolean;
  exists?: boolean;
  merged?: boolean;
} = {}): { deps: MergeActionDeps; calls: string[] } {
  const calls: string[] = [];
  const {
    buildOk = true,
    gate = { green: true } as TestGateResult,
    mergeThrows = false,
    exists = true,
    merged = false,
    ...rest
  } = over;

  const deps: MergeActionDeps = {
    branchExists: (b) => {
      calls.push(`branchExists(${b})`);
      return exists;
    },
    isMerged: (b, into) => {
      calls.push(`isMerged(${b},${into})`);
      return merged;
    },
    diff: (b, into) => {
      calls.push(`diff(${b},${into})`);
      return `DIFF ${into}...${b}`;
    },
    merge: (b, into) => {
      calls.push(`merge(${b},${into})`);
      if (mergeThrows) throw new Error("CONFLICT (content): merge conflict in foo.ts");
    },
    resetMerge: (into, toRef) => {
      calls.push(`resetMerge(${into},${toRef})`);
    },
    preMergeRef: (into) => {
      calls.push(`preMergeRef(${into})`);
      return "PREREF";
    },
    build: () => {
      calls.push("build");
      return buildOk ? { ok: true } : { ok: false, output: "build broke" };
    },
    testGate: () => {
      calls.push("testGate");
      return gate;
    },
    deleteBranch: (b) => {
      calls.push(`deleteBranch(${b})`);
    },
    writeReloadMarker: (b, into) => {
      calls.push(`writeReloadMarker(${b},${into})`);
    },
    notifyDurable: (text) => {
      calls.push(`notifyDurable(${text})`);
    },
    restart: () => {
      calls.push("restart");
    },
    push: (into) => {
      calls.push(`push(${into})`);
    },
    ...rest
  };
  return { deps, calls };
}

describe("resolveSelfWritePush", () => {
  it("defaults to false and honors the env flag", () => {
    expect(resolveSelfWritePush({})).toBe(false);
    expect(resolveSelfWritePush({ HOUGE_SELFWRITE_PUSH: "true" })).toBe(true);
    expect(resolveSelfWritePush({ HOUGE_SELFWRITE_PUSH: "1" })).toBe(true);
    expect(resolveSelfWritePush({ HOUGE_SELFWRITE_PUSH: "yes" })).toBe(true);
    expect(resolveSelfWritePush({ HOUGE_SELFWRITE_PUSH: "on" })).toBe(true);
    expect(resolveSelfWritePush({ HOUGE_SELFWRITE_PUSH: "false" })).toBe(false);
    expect(resolveSelfWritePush({ HOUGE_SELFWRITE_PUSH: "nope" })).toBe(false);
  });
});

describe("resolveDaemonLabel", () => {
  it("defaults to com.houge.daemon and honors the env override", () => {
    expect(resolveDaemonLabel({})).toBe("com.houge.daemon");
    expect(resolveDaemonLabel({ HOUGE_DAEMON_LABEL: "com.houge.test" })).toBe("com.houge.test");
    expect(resolveDaemonLabel({ HOUGE_DAEMON_LABEL: "  " })).toBe("com.houge.daemon");
  });
});

describe("viewDiff", () => {
  it("returns the bounded diff when the branch exists", () => {
    const { deps } = makeDeps();
    const r = viewDiff({ branch: "houge/selfwrite/r1", deps });
    expect(r).toEqual({ ok: true, diff: "DIFF main...houge/selfwrite/r1" });
  });

  it("returns not-found when the branch is absent (read-only, no merge)", () => {
    const { deps, calls } = makeDeps({ exists: false });
    const r = viewDiff({ branch: "gone", deps });
    expect(r).toEqual({ ok: false, reason: "branch not found" });
    expect(calls).not.toContain("merge(gone,main)");
  });

  it("honors a custom `into`", () => {
    const { deps } = makeDeps();
    const r = viewDiff({ branch: "b", into: "develop", deps });
    expect(r).toEqual({ ok: true, diff: "DIFF develop...b" });
  });
});

describe("discardBranch", () => {
  it("deletes an existing branch", () => {
    const { deps, calls } = makeDeps();
    expect(discardBranch({ branch: "b", deps })).toEqual({ ok: true });
    expect(calls).toContain("deleteBranch(b)");
  });

  it("is idempotent — an already-gone branch is a no-op ok", () => {
    const { deps, calls } = makeDeps({ exists: false });
    expect(discardBranch({ branch: "b", deps })).toEqual({ ok: true });
    expect(calls).not.toContain("deleteBranch(b)");
  });

  it("surfaces a git failure as a structured reason (never throws)", () => {
    const { deps } = makeDeps({
      deleteBranch: () => {
        throw new Error("git branch -D failed: not fully merged");
      }
    });
    const r = discardBranch({ branch: "b", deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not fully merged");
  });
});

describe("mergeAndReload — happy path", () => {
  it("merge→build→testGate green → writeReloadMarker BEFORE notifyDurable BEFORE restart; outcome reloaded; no push by default", () => {
    const { deps, calls } = makeDeps();
    const r = mergeAndReload({ branch: "b", deps });
    expect(r).toEqual({ kind: "reloaded", pushed: false });

    // Order is load-bearing: preMergeRef → merge → build → testGate → writeReloadMarker →
    // notifyDurable → restart (⓪·2c U2 extends the original six-step invariant additively).
    expect(calls).toEqual([
      "branchExists(b)",
      "isMerged(b,main)",
      "branchExists(b)",
      "preMergeRef(main)",
      "merge(b,main)",
      "build",
      "testGate",
      "writeReloadMarker(b,main)",
      "notifyDurable(merged, reloading…)",
      "restart"
    ]);
    // The invariants: marker before the durable notify, which strictly precedes the restart.
    expect(calls.indexOf("writeReloadMarker(b,main)")).toBeLessThan(
      calls.indexOf("notifyDurable(merged, reloading…)")
    );
    expect(calls.indexOf("notifyDurable(merged, reloading…)")).toBeLessThan(calls.indexOf("restart"));
    expect(calls).not.toContain("push(main)");
    expect(calls).not.toContain("resetMerge(main,PREREF)");
  });

  it("a marker-write failure never blocks the green reload (best-effort nicety)", () => {
    const { deps, calls } = makeDeps({
      writeReloadMarker: () => {
        throw new Error("db locked");
      }
    });
    const r = mergeAndReload({ branch: "b", deps });
    expect(r).toEqual({ kind: "reloaded", pushed: false });
    expect(calls).toContain("notifyDurable(merged, reloading…)");
    expect(calls).toContain("restart");
    expect(calls).not.toContain("resetMerge(main,PREREF)");
  });

  it("pushes only when push=true, AFTER notifyDurable and BEFORE restart", () => {
    const { deps, calls } = makeDeps();
    const r = mergeAndReload({ branch: "b", push: true, deps });
    expect(r).toEqual({ kind: "reloaded", pushed: true });
    expect(calls).toContain("push(main)");
    expect(calls.indexOf("notifyDurable(merged, reloading…)")).toBeLessThan(calls.indexOf("push(main)"));
    expect(calls.indexOf("push(main)")).toBeLessThan(calls.indexOf("restart"));
  });
});

describe("mergeAndReload — revert paths (never restart)", () => {
  it("testGate RED → resetMerge to preMergeRef, restart NEVER, outcome reverted (stage test)", () => {
    const { deps, calls } = makeDeps({ gate: { green: false, stage: "test", output: "1 test red" } });
    const r = mergeAndReload({ branch: "b", deps });
    expect(r).toEqual({ kind: "reverted", stage: "test", detail: "1 test red" });
    expect(calls).toContain("resetMerge(main,PREREF)");
    expect(calls).not.toContain("restart");
    expect(calls).not.toContain("notifyDurable(merged, reloading…)");
    expect(calls).not.toContain("push(main)");
    expect(calls).not.toContain("writeReloadMarker(b,main)");
    // reset happens after the merge it is undoing.
    expect(calls.indexOf("merge(b,main)")).toBeLessThan(calls.indexOf("resetMerge(main,PREREF)"));
  });

  it("build RED → resetMerge, restart NEVER, outcome reverted (stage build); testGate not run", () => {
    const { deps, calls } = makeDeps({ buildOk: false });
    const r = mergeAndReload({ branch: "b", deps });
    expect(r).toEqual({ kind: "reverted", stage: "build", detail: "build broke" });
    expect(calls).toContain("resetMerge(main,PREREF)");
    expect(calls).not.toContain("restart");
    expect(calls).not.toContain("testGate");
    expect(calls).not.toContain("notifyDurable(merged, reloading…)");
    expect(calls).not.toContain("writeReloadMarker(b,main)");
  });
});

describe("mergeAndReload — merge conflict", () => {
  it("merge throws → outcome merge_conflict; no build, no testGate, no restart, no reset", () => {
    const { deps, calls } = makeDeps({ mergeThrows: true });
    const r = mergeAndReload({ branch: "b", deps });
    expect(r.kind).toBe("merge_conflict");
    if (r.kind === "merge_conflict") expect(r.detail).toContain("CONFLICT");
    expect(calls).not.toContain("build");
    expect(calls).not.toContain("testGate");
    expect(calls).not.toContain("restart");
    expect(calls).not.toContain("resetMerge(main,PREREF)");
    expect(calls).not.toContain("writeReloadMarker(b,main)");
  });
});

describe("mergeAndReload — idempotency + not_found", () => {
  it("already merged (isMerged true) → already_merged; nothing run", () => {
    const { deps, calls } = makeDeps({ merged: true });
    const r = mergeAndReload({ branch: "b", deps });
    expect(r).toEqual({ kind: "already_merged" });
    expect(calls).not.toContain("merge(b,main)");
    expect(calls).not.toContain("build");
    expect(calls).not.toContain("restart");
    expect(calls).not.toContain("writeReloadMarker(b,main)");
  });

  it("branch absent (branchExists false) → not_found; nothing run", () => {
    const { deps, calls } = makeDeps({ exists: false });
    const r = mergeAndReload({ branch: "b", deps });
    expect(r).toEqual({ kind: "not_found" });
    expect(calls).not.toContain("merge(b,main)");
    expect(calls).not.toContain("build");
    expect(calls).not.toContain("restart");
    expect(calls).not.toContain("writeReloadMarker(b,main)");
  });

  it("honors a custom `into`", () => {
    const { deps, calls } = makeDeps();
    const r = mergeAndReload({ branch: "b", into: "release", deps });
    expect(r).toEqual({ kind: "reloaded", pushed: false });
    expect(calls).toContain("merge(b,release)");
    expect(calls).toContain("testGate");
  });
});

describe("mergeAndReload — verified-artifact invariant (stale_dist, 07-07)", () => {
  const T0 = 1_000_000; // injected merge-start clock

  it("dist newer than merge start → reloaded (restart runs)", () => {
    const { deps, calls } = makeDeps({ distNewestMtimeMs: () => T0 + 5_000 });
    const r = mergeAndReload({ branch: "b", deps, now: () => T0 });
    expect(r).toEqual({ kind: "reloaded", pushed: false });
    expect(calls).toContain("restart");
  });

  it("dist OLDER than merge start → reverted stage stale_dist; NO restart, NO marker, NO beacon", () => {
    const { deps, calls } = makeDeps({ distNewestMtimeMs: () => T0 - 5_000 });
    const r = mergeAndReload({ branch: "b", deps, now: () => T0 });
    expect(r.kind).toBe("reverted");
    if (r.kind !== "reverted") return;
    expect(r.stage).toBe("stale_dist");
    expect(calls).toContain("resetMerge(main,PREREF)");
    expect(calls).not.toContain("restart");
    expect(calls).not.toContain("writeReloadMarker(b,main)");
    expect(calls.some((c) => c.startsWith("notifyDurable"))).toBe(false);
  });

  it("dist MISSING after a green gate → reverted stage stale_dist; NO restart", () => {
    const { deps, calls } = makeDeps({ distNewestMtimeMs: () => undefined });
    const r = mergeAndReload({ branch: "b", deps, now: () => T0 });
    expect(r.kind).toBe("reverted");
    if (r.kind !== "reverted") return;
    expect(r.stage).toBe("stale_dist");
    expect(calls).not.toContain("restart");
  });

  it("deps without the optional probe keep the pre-invariant behavior (existing mocks stay valid)", () => {
    const { deps, calls } = makeDeps();
    const r = mergeAndReload({ branch: "b", deps, now: () => T0 });
    expect(r).toEqual({ kind: "reloaded", pushed: false });
    expect(calls).toContain("restart");
  });
});

describe("newestMtimeMs (the real artifact probe)", () => {
  it("returns the newest matching-ext mtime recursively and undefined for a missing dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "houge-dist-"));
    try {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "a.js"), "x");
      writeFileSync(join(dir, "sub", "b.js"), "y");
      writeFileSync(join(dir, "notes.txt"), "z"); // wrong ext — ignored
      const past = new Date(Date.now() - 60_000);
      utimesSync(join(dir, "a.js"), past, past);
      const newest = newestMtimeMs(dir, ".js");
      expect(newest).toBeDefined();
      expect(newest!).toBeGreaterThan(past.getTime() + 1_000); // b.js (fresh) wins over backdated a.js
      expect(newestMtimeMs(join(dir, "does-not-exist"), ".js")).toBeUndefined();
      expect(newestMtimeMs(dir, ".css")).toBeUndefined(); // no matching ext
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
