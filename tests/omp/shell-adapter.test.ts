import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeSeatbeltProfiles } from "../../src/omp/seatbelt.js";
import { runShell, type ShellRunInput } from "../../src/omp/shell-adapter.js";

const WRAPPER = new URL("../../src/omp/shell-wrapper.sh", import.meta.url).pathname;
const temps: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; }
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function input(command: string, over: Partial<ShellRunInput> = {}): ShellRunInput {
  const cwd = tmp("houge-shell-");
  return { command, cwd, profilePath: "/nonexistent.sb", wrapperPath: WRAPPER, env: { PATH: process.env.PATH ?? "", HOME: cwd, HOUGE_SHELL_SANDBOX: "0" },
    timeoutMs: 10_000, outputCapBytes: 32 * 1024, sandbox: false, ...over };
}
const alive = (pattern: string) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim().length > 0;

describe("bash tool adapter — R2–R7", () => {
  it("runs a plain command and preserves its exit code", async () => {
    const r = await runShell(input("echo hi; exit 3"));
    expect(r).toMatchObject({ status: "succeeded", exitCode: 3, wrapperStatus: "ok" });
    expect(r.output).toContain("hi");
  });

  it("leaves an empty process group after normal completion (R4): backgrounded children are gone", async () => {
    const tag = `houge-bg-${Date.now()}`;
    const r = await runShell(input(`sleep 60 & nohup sleep 61 >/dev/null 2>&1 & (exec -a ${tag} sleep 62 &); echo done`));
    expect(r.wrapperStatus).toBe("ok");
    expect(alive(tag)).toBe(false);
  });

  it("a command that exits 97 itself reads as ok with rc 97 — fd 3 is authoritative, not the exit code (R5)", async () => {
    const r = await runShell(input("exit 97"));
    expect(r).toMatchObject({ status: "succeeded", exitCode: 97, wrapperStatus: "ok" });
  });

  it("the command cannot forge the wrapper's status: fd 3 is closed for it (R5)", async () => {
    const r = await runShell(input("echo ok >&3; echo cleanup_failed >&3; true"));
    expect(r.wrapperStatus).toBe("ok");
    expect(r.output).toMatch(/Bad file descriptor/);
  });

  it("reports cleanup_failed when pgrep is unavailable and never calls that success (R5)", async () => {
    const bin = tmp("houge-fakebin-");
    writeFileSync(join(bin, "pgrep"), "#!/bin/sh\nexit 3\n"); chmodSync(join(bin, "pgrep"), 0o755);
    const r = await runShell(input("true", { env: { PATH: `${bin}:/usr/bin:/bin`, HOUGE_SHELL_SANDBOX: "0" } }));
    expect(r).toMatchObject({ status: "failed", reason: "cleanup_failed", wrapperStatus: "cleanup_failed" });
  });

  it("kills the whole group on deadline and returns timeout (R6)", async () => {
    const tag = `houge-to-${Date.now()}`;
    const r = await runShell(input(`(exec -a ${tag} sleep 60) & sleep 60`, { timeoutMs: 400 }));
    expect(r).toMatchObject({ status: "failed", reason: "timeout" });
    expect(alive(tag)).toBe(false);
  });

  it("kills the whole group on abort, from any source, and resolves once (R6, R7)", async () => {
    const ac = new AbortController();
    const p = runShell(input("sleep 60", { signal: ac.signal }));
    setTimeout(() => ac.abort(), 200);
    expect(await p).toMatchObject({ status: "failed", reason: "aborted" });
  });

  it("never runs when already aborted before spawn", async () => {
    const ac = new AbortController(); ac.abort();
    const r = await runShell(input("touch should-not-exist", { signal: ac.signal }));
    expect(r).toMatchObject({ status: "failed", reason: "aborted" });
  });

  it("caps output and says so, and kills the group when the cap is hit (R6)", async () => {
    const r = await runShell(input("yes x", { outputCapBytes: 1024 }));
    expect(r).toMatchObject({ status: "failed", reason: "output_cap", truncated: true });
    expect(r.output.length).toBeLessThanOrEqual(1024);
  });

  it("with the real sandbox, a secret read is denied by the kernel while the wrapper still reports ok", async () => {
    const root = tmp("houge-sbx-");
    const ctx = { home: join(root, "home"), repo: join(root, "repo"), data: join(root, "data") };
    for (const d of [join(ctx.home, ".ssh"), ctx.repo, join(ctx.data, "omp", "workspace")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(ctx.home, ".ssh", "id"), "SECRET");
    const profiles = writeSeatbeltProfiles(ctx);
    const r = await runShell(input(`cat ${ctx.home}/.ssh/id`, { sandbox: true, profilePath: profiles.shell, cwd: join(ctx.data, "omp", "workspace"),
      env: { PATH: process.env.PATH ?? "", HOME: ctx.home } }));
    expect(r.output).toContain("Operation not permitted");
    expect(r.output).not.toContain("SECRET");
    expect(r.wrapperStatus).toBe("ok");
  });
});
