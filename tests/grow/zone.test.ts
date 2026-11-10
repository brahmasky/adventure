import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrowZone, GrowZoneError } from "../../src/grow/zone.js";

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "grow-zone-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("grow zone repository", () => {
  it("creates its own repository and commits a skill, readable back from HEAD", async () => {
    const z = new GrowZone(join(tmp(), "grow")); await z.ensure(true);
    const c = await z.writeAndCommit("unit-convert", "v1\n", "skill(unit-convert): add");
    expect(await z.head()).toBe(c);
    expect(await z.readHead("unit-convert")).toBe("v1\n");
    expect(await z.listHead()).toEqual(["unit-convert"]);
    expect(await z.readHead("missing")).toBeNull();
  });

  it("does not create a repository when init is not allowed, so a lost .git over existing items is a fault, not a silent empty zone", async () => {
    const dir = join(tmp(), "grow"); mkdirSync(join(dir, "skills", "unit-convert"), { recursive: true });
    await expect(new GrowZone(dir).ensure(false)).rejects.toMatchObject({ code: "not_toplevel" });
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("refuses to act when its .git is gone, so git discovery can never climb into an enclosing repository", async () => {
    const outer = tmp();
    execFileSync("git", ["init", "-q", outer]);
    const z = new GrowZone(join(outer, "grow")); await z.ensure(true);
    rmSync(join(outer, "grow", ".git"), { recursive: true, force: true });
    await expect(z.assertToplevel()).rejects.toMatchObject({ code: "not_toplevel" });
    await expect(z.restoreToHead()).rejects.toBeInstanceOf(GrowZoneError);
    expect(existsSync(join(outer, ".git"))).toBe(true);
  });

  it("ignores hooks and config planted inside the zone", async () => {
    const dir = join(tmp(), "grow"); const z = new GrowZone(dir); await z.ensure(true);
    const marker = join(dir, "..", "hook-ran");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    await z.writeAndCommit("unit-convert", "v1\n", "m");
    expect(existsSync(marker)).toBe(false);
  });

  it("restores the tree to HEAD, removing a half-written file", async () => {
    const dir = join(tmp(), "grow"); const z = new GrowZone(dir); await z.ensure(true);
    await z.writeAndCommit("unit-convert", "v1\n", "m");
    writeFileSync(join(dir, "skills", "unit-convert", "SKILL.md"), "half");
    writeFileSync(join(dir, "skills", "unit-convert", "SKILL.md.tmp"), "junk");
    await z.restoreToHead();
    expect(readFileSync(join(dir, "skills", "unit-convert", "SKILL.md"), "utf8")).toBe("v1\n");
    expect(existsSync(join(dir, "skills", "unit-convert", "SKILL.md.tmp"))).toBe(false);
  });

  it("unstages a file added before a crash, even when the only commit is empty, so the next commit cannot carry it", async () => {
    const dir = join(tmp(), "grow"); const z = new GrowZone(dir); await z.ensure(true);
    mkdirSync(join(dir, "skills", "half-done"), { recursive: true });
    writeFileSync(join(dir, "skills", "half-done", "SKILL.md"), "x");
    execFileSync("git", ["-C", dir, "add", "skills/half-done/SKILL.md"]);
    await z.restoreToHead();
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    expect(existsSync(join(dir, "skills", "half-done", "SKILL.md"))).toBe(false);
  });

  it("finds the commit of an operation by its id and not by another id, so a retry can tell whether the first attempt landed", async () => {
    const z = new GrowZone(join(tmp(), "grow")); await z.ensure(true);
    const op = "0b6f3a52-1c1e-4d0a-9f55-3f2f4a7a9c11";
    const c = await z.writeAndCommit("unit-convert", "v1\n", `skill: add\n\nGrow-Op: ${op}`);
    await z.writeAndCommit("other", "x\n", "unrelated");
    expect(await z.findOpCommit(op)).toBe(c);
    expect(await z.findOpCommit("0b6f3a52-1c1e-4d0a-9f55-3f2f4a7a9c12")).toBeNull();
  });

  it("rejects a malformed operation id, so it cannot be read as an option or a pattern", async () => {
    const z = new GrowZone(join(tmp(), "grow")); await z.ensure(true);
    await expect(z.findOpCommit("--all")).rejects.toMatchObject({ code: "bad_name" });
    await expect(z.findOpCommit("not-a-uuid")).rejects.toMatchObject({ code: "bad_name" });
  });

  it("throws instead of answering null when git cannot read the repository, so a fault never looks like absence", async () => {
    const dir = join(tmp(), "grow"); const z = new GrowZone(dir); await z.ensure(true);
    await z.writeAndCommit("unit-convert", "v1\n", "m");
    expect(await z.readHead("missing")).toBeNull();
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    await expect(z.readHead("unit-convert")).rejects.toMatchObject({ code: "git_failed" });
    await expect(z.findOpCommit("0b6f3a52-1c1e-4d0a-9f55-3f2f4a7a9c11")).rejects.toMatchObject({ code: "git_failed" });
  });

  it("writes a verified bundle that a clone can read", async () => {
    const root = tmp(); const z = new GrowZone(join(root, "grow")); await z.ensure(true);
    await z.writeAndCommit("unit-convert", "v1\n", "m");
    const out = join(root, "zone.bundle"); await z.bundle(out);
    execFileSync("git", ["clone", "-q", out, join(root, "clone")]);
    expect(readFileSync(join(root, "clone", "skills", "unit-convert", "SKILL.md"), "utf8")).toBe("v1\n");
  });

  it("rejects a name that could leave the skills folder", async () => {
    const z = new GrowZone(join(tmp(), "grow")); await z.ensure(true);
    await expect(z.writeAndCommit("../evil", "x", "m")).rejects.toMatchObject({ code: "bad_name" });
  });
});
