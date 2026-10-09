import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { checkOmpVersion, checkOmpVersionAsync } from "../../src/omp/omp-version.js";
import { maxLoopGap, slowVersionBin } from "../helpers/event-loop.js";

describe("omp version check — no pinned version (Paco, 2026-10-07: no hard-coded runtime versions, as with model chains)", () => {
  const cfg = resolveOmpConfig({});
  // An upgraded omp is the normal case, not an outage: a pin refused every spawn after a routine upgrade (18.4.4 → 18.7.0).
  it("accepts any version omp reports, and returns it for houge_status", () => {
    expect(checkOmpVersion(cfg, () => "omp/18.4.4\n")).toEqual({ ok: true, version: "18.4.4" });
    expect(checkOmpVersion(cfg, () => "omp/18.7.0")).toEqual({ ok: true, version: "18.7.0" });
  });
  // A missing or silent binary still cannot run a turn: that stays a refusal (omp_unavailable), named by why.
  it("refuses only when the binary is missing or prints no version, and says which", () => {
    expect(checkOmpVersion(cfg, () => { throw new Error("ENOENT"); })).toMatchObject({ ok: false, kind: "not_runnable", version: null });
    expect(checkOmpVersion(cfg, () => "hello")).toMatchObject({ ok: false, kind: "no_version", version: null });
  });
  // The retired variables must not quietly come back as a pin: setting them changes nothing.
  it("ignores the retired HOUGE_OMP_VERSION / HOUGE_OMP_VERSION_ALLOW", () => {
    const legacy = resolveOmpConfig({ HOUGE_OMP_VERSION: "18.4.4", HOUGE_OMP_VERSION_ALLOW: "" });
    expect(checkOmpVersion(legacy, () => "omp/18.7.0")).toEqual({ ok: true, version: "18.7.0" });
    expect(legacy).not.toHaveProperty("version");
    expect(legacy).not.toHaveProperty("versionAllow");
  });

  // Stage A asks Jev before every turn while the child starts: a synchronous `omp --version` (0.7–0.8 s on the Mac mini)
  // froze the event loop under Jev's 1.5 s budget and turned answers into silent timeout skips (live gate, 2026-10-09).
  it("the async check reads the same results as the sync one", async () => {
    expect(await checkOmpVersionAsync(cfg, async () => "omp/18.7.0\n")).toEqual({ ok: true, version: "18.7.0" });
    expect(await checkOmpVersionAsync(cfg, async () => { throw new Error("ENOENT"); })).toMatchObject({ ok: false, kind: "not_runnable", version: null });
    expect(await checkOmpVersionAsync(cfg, async () => "hello")).toMatchObject({ ok: false, kind: "no_version", version: null });
  });
  it("the async check's default run leaves the event loop free while omp answers", async () => {
    const { gap, result } = await maxLoopGap(() => checkOmpVersionAsync({ bin: slowVersionBin(600) }));
    expect(result).toEqual({ ok: true, version: "18.7.0" });
    expect(gap).toBeLessThan(300);
  });
  // The reason reaches the omp_unavailable error_ref and the incident: refs carry codes, never omp's own words (stderr).
  it("a refusal's reason names the exit code or signal only, never omp's stderr", async () => {
    const bin = join(mkdtempSync(join(tmpdir(), "houge-loud-omp-")), "omp");
    writeFileSync(bin, "#!/bin/sh\necho 'provider said: token abc123 expired' >&2\nexit 3\n");
    chmodSync(bin, 0o755);
    const loud = await checkOmpVersionAsync({ bin });
    expect(loud).toEqual({ ok: false, kind: "not_runnable", version: null, reason: "omp not runnable: 3" });
    expect(checkOmpVersion({ bin })).toEqual({ ok: false, kind: "not_runnable", version: null, reason: "omp not runnable: 3" });
    const missing = await checkOmpVersionAsync({ bin: join(tmpdir(), "houge-no-such-omp") });
    expect(missing).toMatchObject({ kind: "not_runnable", reason: "omp not runnable: ENOENT" });
    const thrown = await checkOmpVersionAsync(cfg, async () => { throw new Error("Command failed: omp --version\nprovider text"); });
    expect(thrown).toMatchObject({ kind: "not_runnable", reason: "omp not runnable: error" });
  });
});
