import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";
import { NO_OMP_BIN, STUB_MARKER } from "./omp-env.js";

// Every test file starts unable to reach a real omp or agy (both may be on the developer's PATH).
// 1. HOUGE_OMP_BIN points at a path that is never an executable (suites that want the fake set it).
// 2. Code that resolves its config from an INJECTED env object (reviewDiff({env}), buildOmpPanelSeats,
//    tickSeat, buildMediaCall) falls back to the bare names `omp` / `agy`, looked up on PATH — so PATH
//    starts with a dir of stubs that print a marker to stderr and exit 1. A spawned CLI inherits both.

process.env.HOUGE_OMP_BIN = NO_OMP_BIN;
const stubDir = mkdtempSync(join(tmpdir(), "houge-stub-bin-"));
for (const name of ["omp", "agy"]) {
  const file = join(stubDir, name);
  writeFileSync(file, `#!/bin/sh\necho "${STUB_MARKER}:${name} $*" >&2\nexit 1\n`);
  chmodSync(file, 0o755);
}
const pathBefore = process.env.PATH;
process.env.PATH = `${stubDir}${delimiter}${pathBefore ?? ""}`;
afterAll(() => {
  // Threads reuse process.env across files: restore PATH so stub dirs never pile up.
  if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore;
  rmSync(stubDir, { recursive: true, force: true });
});
