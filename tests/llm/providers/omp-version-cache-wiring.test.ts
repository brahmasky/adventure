import { afterEach, describe, expect, it } from "vitest";
import { resolveOmpConfig } from "../../../src/omp/omp-config.js";
import { setSharedOmpVersionCacheForTest } from "../../../src/omp/omp-version-cache.js";
import { spawnOneShot } from "../../../src/llm/providers/omp.js";

const cfg = resolveOmpConfig({ HOUGE_OMP_BIN: "/nonexistent/omp", HOUGE_OMP_SANDBOX: "0" });
const input = { seat: "ticks" as const, chain: [], prompt: "x", correlationId: "c" };
const audit = { record: () => {} };
afterEach(() => setSharedOmpVersionCacheForTest(null));

describe("one-shot version check goes through the shared cache", () => {
  // Spec §3: the one-shot path paid `omp --version` (0.8 s) on every call. With no injected check it must ask the shared
  // per-binary cache instead, and an unavailable omp must still stop the call before any leg spawns (omp_unavailable path).
  it("asks the shared cache when no versionCheck is injected", async () => {
    let asked = 0;
    setSharedOmpVersionCacheForTest(cfg, {
      current: async () => { asked += 1; return { ok: false, kind: "not_runnable", version: null, reason: "omp not runnable: ENOENT" }; },
      lastVersion: () => null, setNewVersionListener: () => {}
    });
    const r = await spawnOneShot(input, { cfg, audit });
    expect(asked).toBe(1);
    expect(r).toMatchObject({ ok: false, unavailable: true, omp_check: { kind: "not_runnable" } });
  });

  // Tests and callers that inject a check must not be second-guessed by process-wide state.
  it("an injected versionCheck still wins over the cache", async () => {
    let asked = 0;
    setSharedOmpVersionCacheForTest(cfg, { current: async () => { asked += 1; return { ok: true, version: "x" }; }, lastVersion: () => null, setNewVersionListener: () => {} });
    await spawnOneShot(input, { cfg, audit, versionCheck: () => ({ ok: false, kind: "no_version", version: null, reason: "r" }) });
    expect(asked).toBe(0);
  });
});
