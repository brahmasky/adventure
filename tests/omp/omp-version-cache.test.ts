import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpCheckResult } from "../../src/omp/omp-version.js";
import {
  createOmpVersionCache, fingerprintOmpBinary, setSharedOmpVersionCacheForTest, sharedOmpVersionCache, type OmpBinaryFingerprint
} from "../../src/omp/omp-version-cache.js";

// Spec §3: `omp --version` cost 0.8 s before every one-shot call. The cache must exec it once per binary, re-check the moment
// the binary changes (an upgrade is also the probe trigger), never remember a failure (a repaired omp must be seen at once),
// and never hand a caller the old binary's answer after an upgrade.
const cfg = { bin: "omp", envPassthrough: [] as string[] };
const fp = (o: Partial<OmpBinaryFingerprint> = {}): OmpBinaryFingerprint => ({ path: "/x/cli.js", mtimeMs: 1, size: 10, ino: 7, ...o });
const ok = (version: string): OmpCheckResult => ({ ok: true, version });
const down: OmpCheckResult = { ok: false, kind: "not_runnable", version: null, reason: "omp not runnable: ENOENT" };

function harness(results: OmpCheckResult[], fingerprint: OmpBinaryFingerprint | null = fp()) {
  let print = fingerprint; let calls = 0;
  const cache = createOmpVersionCache(cfg, {
    check: async () => { calls += 1; return results[Math.min(calls - 1, results.length - 1)] as OmpCheckResult; },
    fingerprint: () => print
  });
  return { cache, calls: () => calls, setPrint: (p: OmpBinaryFingerprint | null) => { print = p; } };
}

afterEach(() => setSharedOmpVersionCacheForTest(null));

describe("omp version cache", () => {
  it("execs once while the binary is unchanged", async () => {
    const h = harness([ok("18.7.0")]);
    for (let i = 0; i < 3; i++) expect(await h.cache.current()).toEqual(ok("18.7.0"));
    expect(h.calls()).toBe(1);
    expect(h.cache.lastVersion()).toBe("18.7.0");
  });

  it.each(["path", "mtimeMs", "size", "ino"] as const)("re-checks when the fingerprint's %s changes", async (field) => {
    const h = harness([ok("18.7.0"), ok("18.8.0")]);
    await h.cache.current();
    h.setPrint(fp({ [field]: field === "path" ? "/y/cli.js" : 99 }));
    expect(await h.cache.current()).toEqual(ok("18.8.0"));
    expect(h.calls()).toBe(2);
  });

  it("never caches a failure: a repaired omp is seen on the next call", async () => {
    const h = harness([down, down, ok("18.7.0")]);
    expect(await h.cache.current()).toEqual(down);
    expect(await h.cache.current()).toEqual(down);
    expect(await h.cache.current()).toEqual(ok("18.7.0"));
    expect(h.calls()).toBe(3);
    expect(h.cache.lastVersion()).toBe("18.7.0");
  });

  it("an unresolvable binary always checks, yet still reports its version and triggers the probe", async () => {
    const h = harness([ok("18.7.0")], null);
    const seen: string[] = [];
    h.cache.setNewVersionListener((v) => seen.push(v));
    await h.cache.current(); await h.cache.current();
    expect(h.calls()).toBe(2);
    expect(h.cache.lastVersion()).toBe("18.7.0");
    expect(seen).toEqual(["18.7.0"]);
  });

  it("joins concurrent calls for one binary into one exec", async () => {
    const h = harness([ok("18.7.0")]);
    await Promise.all([h.cache.current(), h.cache.current(), h.cache.current()]);
    expect(h.calls()).toBe(1);
  });

  it("a call after an upgrade never receives the old binary's in-flight answer", async () => {
    let release!: (r: OmpCheckResult) => void;
    let print = fp(); let calls = 0;
    const cache = createOmpVersionCache(cfg, {
      check: () => { calls += 1; return calls === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(ok("18.8.0")); },
      fingerprint: () => print
    });
    const old = cache.current();
    print = fp({ mtimeMs: 2 });
    expect(await cache.current()).toEqual(ok("18.8.0"));
    release(ok("18.7.0"));
    expect(await old).toEqual(ok("18.7.0"));
    // the stale answer settled last but must not become the cached entry for the new binary
    expect(await cache.current()).toEqual(ok("18.8.0"));
    expect(calls).toBe(2);
    expect(cache.lastVersion()).toBe("18.8.0");
  });

  it("calls the listener once per distinct ok version, after caching it", async () => {
    const h = harness([ok("18.7.0"), ok("18.8.0")]);
    const seen: Array<[string, string | null]> = [];
    h.cache.setNewVersionListener((v) => seen.push([v, h.cache.lastVersion()]));
    await h.cache.current(); await h.cache.current();
    h.setPrint(fp({ ino: 8 }));
    await h.cache.current();
    expect(seen).toEqual([["18.7.0", "18.7.0"], ["18.8.0", "18.8.0"]]);
  });

  it("a throwing listener never breaks the check", async () => {
    const h = harness([ok("18.7.0")]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.cache.setNewVersionListener(() => { throw new Error("boom"); });
    expect(await h.cache.current()).toEqual(ok("18.7.0"));
    expect(err).toHaveBeenCalledWith("[omp-version-cache] new-version listener threw");
    err.mockRestore();
  });

  it("fingerprints the real file behind a PATH lookup and a symlink-free path", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-fp-"));
    try {
      const bin = join(dir, "omp");
      writeFileSync(bin, "#!/bin/sh\necho omp/1.0.0\n"); chmodSync(bin, 0o755);
      vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
      const a = fingerprintOmpBinary({ bin: "omp", envPassthrough: [] });
      expect(a?.path).toContain("omp");
      utimesSync(bin, new Date(), new Date(Date.now() + 5_000));
      expect(fingerprintOmpBinary({ bin: "omp", envPassthrough: [] })?.mtimeMs).not.toBe(a?.mtimeMs);
      expect(fingerprintOmpBinary({ bin: join(dir, "missing"), envPassthrough: [] })).toBeNull();
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("shares one instance per bin and passthrough", () => {
    expect(sharedOmpVersionCache(cfg)).toBe(sharedOmpVersionCache({ ...cfg }));
    expect(sharedOmpVersionCache(cfg)).not.toBe(sharedOmpVersionCache({ bin: "/other/omp", envPassthrough: [] }));
  });
});
