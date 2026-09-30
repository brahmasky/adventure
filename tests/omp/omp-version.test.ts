import { describe, expect, it } from "vitest";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { checkOmpVersion } from "../../src/omp/omp-version.js";

describe("omp version pin — hook and frame behaviour were probed on one binary only", () => {
  const cfg = resolveOmpConfig({});
  it("accepts the pinned version", () => {
    expect(checkOmpVersion(cfg, () => "omp/18.4.4\n")).toEqual({ ok: true, version: "18.4.4" });
  });
  it("refuses a different version unless the operator allow-listed it after re-running the live gate", () => {
    expect(checkOmpVersion(cfg, () => "omp/18.5.0").ok).toBe(false);
    const allowed = resolveOmpConfig({ HOUGE_OMP_VERSION_ALLOW: "18.5.0" });
    expect(checkOmpVersion(allowed, () => "omp/18.5.0").ok).toBe(true);
  });
  it("refuses when the binary is missing or prints nothing parseable", () => {
    expect(checkOmpVersion(cfg, () => { throw new Error("ENOENT"); })).toMatchObject({ ok: false, version: null });
    expect(checkOmpVersion(cfg, () => "hello").ok).toBe(false);
  });
  it("names WHY it refused: only a version that was read and differs is version_mismatch (I2)", () => {
    expect(checkOmpVersion(cfg, () => "omp/18.5.0")).toMatchObject({ ok: false, kind: "version_mismatch", version: "18.5.0" });
    expect(checkOmpVersion(cfg, () => { throw new Error("ENOENT"); })).toMatchObject({ ok: false, kind: "not_runnable", version: null });
    expect(checkOmpVersion(cfg, () => "hello")).toMatchObject({ ok: false, kind: "no_version", version: null });
  });
});
