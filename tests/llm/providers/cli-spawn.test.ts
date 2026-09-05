import { describe, expect, it } from "vitest";
import { defaultSpawnImpl, buildChildEnv } from "../../../src/llm/providers/cli-spawn.js";

/**
 * These spawn REAL processes, because the thing under test is the interaction between the kill,
 * the process group, and Node's `close` event — none of which a fake spawn can reproduce. The
 * existing provider suites all inject a `spawnImpl` that resolves immediately, which is precisely
 * why the hang class below was unreachable from the test suite.
 */
const opts = (timeoutMs: number): Parameters<typeof defaultSpawnImpl>[2] => ({
  timeoutMs,
  cwd: process.cwd(),
  env: buildChildEnv(undefined),
  maxBytes: 65_536,
  input: ""
});

describe("defaultSpawnImpl", () => {
  it("returns a clean exit's stdout", async () => {
    const result = await defaultSpawnImpl(process.execPath, ["-e", "process.stdout.write('hi')"], opts(10_000));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(result.timedOut).toBe(false);
  });

  it("reports ENOENT for a missing binary instead of throwing", async () => {
    const result = await defaultSpawnImpl("definitely-not-a-real-binary-xyz", [], opts(10_000));

    expect(result.spawnError?.code).toBe("ENOENT");
  });

  it(
    "SETTLES when a surviving grandchild holds the stdout pipe open",
    async () => {
      // The daemon-bricking case. An AGENTIC CLI (agy) may spawn a tool grandchild that inherits
      // our stdout write end. Node emits `close` only after the process exits AND its stdio
      // streams close, so a surviving grandchild means `close` never fires. Killing only the
      // leader left the promise permanently unsettled — and because the daemon's poll loop is a
      // single serialized `while`, one such call stopped Telegram polling, every scheduled tick,
      // the outbox flush, and the heartbeat, invisibly to `/status`.
      //
      // Here the parent exits at once while the grandchild holds stdout for 60s.
      const script =
        "const {spawn}=require('child_process');" +
        "spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:['ignore',1,'ignore']});" +
        "process.exit(0);";

      const started = Date.now();
      const result = await defaultSpawnImpl(process.execPath, ["-e", script], opts(1_000));
      const elapsed = Date.now() - started;

      // Must not wait on the grandchild's 60s lifetime.
      expect(elapsed).toBeLessThan(8_000);
      expect(result.timedOut).toBe(true);
    },
    20_000
  );

  it(
    "kills the whole process group, not just the leader",
    async () => {
      // The grandchild writes a marker only if it is still alive after our kill should have
      // reached it. A leader-only SIGKILL leaves it running to print.
      const script =
        "const {spawn}=require('child_process');" +
        "spawn(process.execPath,['-e','setTimeout(()=>process.stdout.write(\"GRANDCHILD-SURVIVED\"),2000)'],{stdio:['ignore',1,'ignore']});" +
        "setTimeout(()=>{},60000);";

      const result = await defaultSpawnImpl(process.execPath, ["-e", script], opts(500));

      expect(result.timedOut).toBe(true);
      expect(result.stdout).not.toContain("GRANDCHILD-SURVIVED");
    },
    20_000
  );

  it(
    "enforces the timeout on a child that simply hangs",
    async () => {
      const started = Date.now();
      const result = await defaultSpawnImpl(process.execPath, ["-e", "setTimeout(()=>{},60000)"], opts(700));
      const elapsed = Date.now() - started;

      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(8_000);
    },
    20_000
  );
});
