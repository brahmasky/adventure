import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
vi.mock("../../src/run/git-hardened.js", async (orig) => {
  const real = await orig<typeof import("../../src/run/git-hardened.js")>();
  return { ...real, hardenedGit: (args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) => { calls.push({ args, env: opts.env ?? {} }); return real.hardenedGit(args, opts); } };
});
const { GrowZone } = await import("../../src/grow/zone.js");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); calls.splice(0); });

// The refusals in assertToplevel detect a planted redirect; these settings are what keep git from following one
// between the check and the call, so every call carries them. No hermetic plant can tell them apart from the
// refusals, which is why they are pinned here.
describe("every grow-zone git call", () => {
  it("pins the common dir to the zone's own .git, switches off system attributes, and ignores attribute and exclude files", async () => {
    const root = mkdtempSync(join(tmpdir(), "grow-env-")); dirs.push(root);
    const z = new GrowZone(join(root, "grow")); await z.ensure(true);
    await z.writeAndCommit("unit-convert", "v1\n", "m"); await z.listHead(); await z.restoreToHead();
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.env.GIT_COMMON_DIR).toBe(join(z.dir, ".git"));
      expect(c.env.GIT_ATTR_NOSYSTEM).toBe("1");
      expect(c.args.join(" ")).toContain("-c core.attributesFile=/dev/null");
      expect(c.args.join(" ")).toContain("-c core.excludesFile=/dev/null");
    }
  });
});
