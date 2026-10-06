import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";
import { setDaemonDataDir } from "../../src/run/daemon-tmp.js";
import { NO_OMP_BIN, STUB_MARKER } from "./omp-env.js";

// Every test file starts unable to reach a real omp or agy (both may be on the developer's PATH).
// 1. HOUGE_OMP_BIN points at a path that is never an executable (suites that want the fake set it).
// 2. Code that resolves its config from an INJECTED env object (reviewDiff({env}), buildOmpPanelSeats,
//    tickSeat, buildMediaCall) falls back to the bare names `omp` / `agy`, looked up on PATH — so PATH
//    starts with a dir of stubs that print a marker to stderr and exit 1. A spawned CLI inherits both.

process.env.HOUGE_OMP_BIN = NO_OMP_BIN;
// Jev (ADR 0029): no suite may reach api.typesafe.ai; an un-stubbed client must see no_key.
delete process.env.TYPESAFE_API_KEY;
// Daemon temp space (<data>/tmp, <data>/selfwrite: B13) defaults to the cwd, i.e. the repo: tests get a tmp data dir.
const dataDir = mkdtempSync(join(tmpdir(), "houge-test-data-"));
setDaemonDataDir(dataDir);
const savedDaemonTmp = process.env.HOUGE_DAEMON_TMP_DIR;
process.env.HOUGE_DAEMON_TMP_DIR = join(dataDir, "daemon-tmp"); // never the developer's ~/Library/Caches (round 2 N1)
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
  if (savedDaemonTmp === undefined) delete process.env.HOUGE_DAEMON_TMP_DIR; else process.env.HOUGE_DAEMON_TMP_DIR = savedDaemonTmp;
  rmSync(dataDir, { recursive: true, force: true });
});
