import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveOmpConfig } from "../../src/omp/omp-config.js";
import { checkOmpVersion } from "../../src/omp/omp-version.js";
import { NO_OMP_BIN, STUB_MARKER } from "../helpers/omp-env.js";

describe("hermetic omp/agy default (every suite)", () => {
  it("a suite that never pins the omp env still cannot reach a real omp through process.env", () => {
    expect(process.env.HOUGE_OMP_BIN).toBe(NO_OMP_BIN);
  });

  it("an INJECTED env with no HOUGE_OMP_BIN resolves the bare `omp` — and PATH hands it the stub, never a real binary", () => {
    const cfg = resolveOmpConfig({});
    expect(cfg.bin).toBe("omp");
    const hit = spawnSync(cfg.bin, ["--version"], { encoding: "utf8" });
    expect(hit.stderr).toContain(`${STUB_MARKER}:omp --version`);
    expect(hit.status).toBe(1);
    expect(checkOmpVersion(cfg)).toMatchObject({ ok: false, kind: "not_runnable" });
  });

  it("the bare `agy` (the voice leg's default bin) is the stub too", () => {
    expect(spawnSync("agy", ["--print", "x"], { encoding: "utf8" }).stderr).toContain(`${STUB_MARKER}:agy`);
  });
});
