import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileAsync } from "../../src/run/exec-file-async.js";
import type { ExecFileAsyncError } from "../../src/run/exec-file-async.js";

/**
 * ⓪·3g: execFileAsync must mirror execFileSync's calling contract — the whole point is
 * that call sites (writer/reviewer/test-gate/git) keep their error handling unchanged
 * while the spawn stops blocking the event loop.
 */

let temps: string[] = [];
afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function fakeBin(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "houge-exec-async-"));
  temps.push(dir);
  const bin = join(dir, "bin");
  writeFileSync(bin, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("execFileAsync", () => {
  it("resolves stdout/stderr as utf8 strings", async () => {
    const bin = fakeBin('printf "out-text"; printf "err-text" >&2');
    const { stdout, stderr } = await execFileAsync(bin, []);
    expect(stdout).toBe("out-text");
    expect(stderr).toBe("err-text");
  });

  it("feeds `input` to the child's stdin (execFileSync's input option)", async () => {
    const bin = fakeBin("cat");
    const { stdout } = await execFileAsync(bin, [], { input: "hello 猴哥" });
    expect(stdout).toBe("hello 猴哥");
  });

  it("rejects a non-zero exit with status = exit code and captured stdout/stderr", async () => {
    const bin = fakeBin('printf "partial-out"; printf "the-detail" >&2; exit 3');
    let caught: ExecFileAsyncError | undefined;
    try {
      await execFileAsync(bin, []);
    } catch (error) {
      caught = error as ExecFileAsyncError;
    }
    expect(caught).toBeDefined();
    expect(caught!.status).toBe(3); // execFileSync callers read err.status
    expect(caught!.stdout).toBe("partial-out");
    expect(caught!.stderr).toBe("the-detail");
  });

  it("rejects ENOENT with code 'ENOENT' (missing binary)", async () => {
    let caught: ExecFileAsyncError | undefined;
    try {
      await execFileAsync("/no/such/bin-anywhere-xyz", []);
    } catch (error) {
      caught = error as ExecFileAsyncError;
    }
    expect(caught?.code).toBe("ENOENT");
  });

  it("rejects a timeout with signal SIGTERM (the check every call site uses)", async () => {
    const bin = fakeBin("sleep 5");
    let caught: ExecFileAsyncError | undefined;
    try {
      await execFileAsync(bin, [], { timeout: 200 });
    } catch (error) {
      caught = error as ExecFileAsyncError;
    }
    expect(caught?.signal).toBe("SIGTERM");
  });

  it("does NOT block the event loop while the child runs (the ⓪·3g point)", async () => {
    const bin = fakeBin("sleep 0.3");
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    try {
      await execFileAsync(bin, []);
    } finally {
      clearInterval(ticker);
    }
    // A sync spawn would freeze the loop and yield ~0 ticks over the 300ms child.
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});
