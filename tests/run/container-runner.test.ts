import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContainerArgs,
  DEFAULT_EXTWORK_IMAGE,
  detectContainerRuntime,
  EXTWORK_EGRESS_NETWORK,
  resolveExtWorkImage,
  runInContainer,
  type ContainerRunOpts,
  type ContainerRuntime
} from "../../src/run/container-runner.js";
import type { SpawnImpl, SpawnResult } from "../../src/llm/providers/cli-spawn.js";

// PINNED_ENV: the image + resource vars this suite asserts DEFAULTS on must be cleared so an
// ambient .env value can't red-fail the default assertion (the self-write test-gate lesson).
const PINNED_ENV = ["HOUGE_EXTWORK_IMAGE", "HOUGE_EXTWORK_MEMORY", "HOUGE_EXTWORK_CPUS", "HOUGE_EXTWORK_PIDS"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of PINNED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of PINNED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A total-function fake spawn: per-invocation override merged onto an exit-0 result. */
function fakeSpawn(handler: (file: string, args: string[]) => Partial<SpawnResult>): SpawnImpl {
  return async (file, args) => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...handler(file, args) });
}

const RT: ContainerRuntime = { bin: "docker" };
function opts(over: Partial<ContainerRunOpts> = {}): ContainerRunOpts {
  return {
    workspace: "/scratch/clone",
    image: "img:test",
    cmd: ["npm", "test"],
    network: "none",
    memory: "2g",
    cpus: "2",
    pidsLimit: 512,
    timeoutMs: 1000,
    ...over
  };
}

describe("buildContainerArgs — the load-bearing security surface", () => {
  it("emits a non-root, read-only, capless, no-new-priv, resource-capped run with EXACTLY one mount and no host escape", () => {
    const args = buildContainerArgs(RT, opts({ network: "none" }));

    // build/test are fully network-isolated.
    const netIdx = args.indexOf("--network");
    expect(args[netIdx + 1]).toBe("none");

    // EXACTLY one bind mount, and it is the scratch workspace → /work (not the host root).
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
    expect(args[args.indexOf("-v") + 1]).toBe("/scratch/clone:/work");
    expect(args).toContain("-w");

    // Non-root, locked-down.
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");

    // Resource caps.
    expect(args[args.indexOf("--memory") + 1]).toBe("2g");
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("512");

    // NEVER a docker.sock mount, a host-root mount, or --privileged.
    expect(args).not.toContain("--privileged");
    expect(args.some((a) => a.includes("docker.sock"))).toBe(false);
    expect(args.some((a) => a === "/:/work" || a.startsWith("/:") || a === "/var/run/docker.sock:/var/run/docker.sock")).toBe(false);

    // Image + command trail the flags, in order.
    expect(args.slice(-3)).toEqual(["img:test", "npm", "test"]);
  });

  it("uses the egress network for the deps-install stage (the honest tradeoff)", () => {
    const args = buildContainerArgs(RT, opts({ network: "egress", cmd: ["npm", "ci"] }));
    expect(args[args.indexOf("--network") + 1]).toBe(EXTWORK_EGRESS_NETWORK);
    // Still exactly one mount, still non-root, still no privilege escalation.
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
    expect(args).not.toContain("--privileged");
  });
});

describe("detectContainerRuntime — graceful degradation (probe or null, never throws)", () => {
  it("returns null when neither docker nor podman can be spawned (ENOENT)", async () => {
    const impl = fakeSpawn(() => ({ code: null, spawnError: { code: "ENOENT" } }));
    expect(await detectContainerRuntime(process.env, impl)).toBeNull();
  });

  it("returns {bin:'docker'} when `docker version` exits 0", async () => {
    const impl = fakeSpawn((file) => (file === "docker" ? { code: 0 } : { code: null, spawnError: { code: "ENOENT" } }));
    expect(await detectContainerRuntime(process.env, impl)).toEqual({ bin: "docker" });
  });

  it("falls through to podman when docker is absent", async () => {
    const impl = fakeSpawn((file) => (file === "podman" ? { code: 0 } : { code: null, spawnError: { code: "ENOENT" } }));
    expect(await detectContainerRuntime(process.env, impl)).toEqual({ bin: "podman" });
  });

  it("treats a non-zero `version` exit as not-present (null)", async () => {
    const impl = fakeSpawn(() => ({ code: 127 }));
    expect(await detectContainerRuntime(process.env, impl)).toBeNull();
  });
});

describe("runInContainer", () => {
  it("returns the capped output + exit code on a clean run", async () => {
    const impl = fakeSpawn(() => ({ code: 0, stdout: "ok\n" }));
    const result = await runInContainer(RT, opts(), impl);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ok");
    expect(result.timedOut).toBe(false);
    expect(result.unavailable).toBeUndefined();
  });

  it("maps a spawn failure (runtime vanished) to unavailable, never throws", async () => {
    const impl = fakeSpawn(() => ({ code: null, spawnError: { code: "ENOENT" } }));
    const result = await runInContainer(RT, opts(), impl);
    expect(result.unavailable).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});

describe("resolveExtWorkImage", () => {
  it("defaults to the pinned multi-toolchain image and honors the override", () => {
    expect(resolveExtWorkImage(process.env)).toBe(DEFAULT_EXTWORK_IMAGE);
    expect(resolveExtWorkImage({ HOUGE_EXTWORK_IMAGE: "my/img:1" } as NodeJS.ProcessEnv)).toBe("my/img:1");
  });

  it("rejects an image starting with '-' (would be parsed as a docker flag) — falls back to default", () => {
    expect(resolveExtWorkImage({ HOUGE_EXTWORK_IMAGE: "--privileged" } as NodeJS.ProcessEnv)).toBe(DEFAULT_EXTWORK_IMAGE);
    expect(resolveExtWorkImage({ HOUGE_EXTWORK_IMAGE: "  " } as NodeJS.ProcessEnv)).toBe(DEFAULT_EXTWORK_IMAGE);
  });
});
