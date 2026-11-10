import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_CONFIG, GrowZone, GrowZoneError } from "../../src/grow/zone.js";

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
    writeFileSync(join(outer, "keep.txt"), "mine");
    const z = new GrowZone(join(outer, "grow")); await z.ensure(true);
    rmSync(join(outer, "grow", ".git"), { recursive: true, force: true });
    await expect(z.assertToplevel()).rejects.toMatchObject({ code: "not_toplevel" });
    await expect(z.restoreToHead()).rejects.toBeInstanceOf(GrowZoneError);
    expect(existsSync(join(outer, ".git"))).toBe(true);
    expect(readFileSync(join(outer, "keep.txt"), "utf8")).toBe("mine");
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

  it("ensure(false) accepts an existing valid repository", async () => {
    const dir = join(tmp(), "grow"); await new GrowZone(dir).ensure(true);
    await expect(new GrowZone(dir).ensure(false)).resolves.toBeUndefined();
  });

  it("fails closed on config planted in .git alone, so a filter can never run a command", async () => {
    const root = tmp(); const dir = join(root, "grow"); const z = new GrowZone(dir); await z.ensure(true);
    const marker = join(root, "filter-ran"); const attrs = join(root, "evil-attributes");
    writeFileSync(attrs, "* filter=evil\n");
    appendFileSync(join(dir, ".git", "config"), `[core]\n\tattributesFile = ${attrs}\n[filter "evil"]\n\tclean = touch ${marker}\n`);
    await expect(z.writeAndCommit("unit-convert", "v1\n", "m")).rejects.toMatchObject({ code: "not_toplevel" });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a root .gitattributes alone", async () => {
    const dir = join(tmp(), "grow"); const z = new GrowZone(dir); await z.ensure(true);
    writeFileSync(join(dir, ".gitattributes"), "* text\n");
    await expect(z.assertToplevel()).rejects.toMatchObject({ code: "not_toplevel" });
  });

  it("refuses .git/info/attributes alone", async () => {
    const dir = join(tmp(), "grow"); const z = new GrowZone(dir); await z.ensure(true);
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "attributes"), "* text\n");
    await expect(z.assertToplevel()).rejects.toMatchObject({ code: "not_toplevel" });
  });

  it("refuses a .git that is a gitfile redirecting to another repository", async () => {
    const root = tmp(); const outer = join(root, "outer"); execFileSync("git", ["init", "-q", outer]);
    writeFileSync(join(outer, ".git", "config"), CANONICAL_CONFIG);
    writeFileSync(join(outer, "untracked.txt"), "mine");
    const dir = join(root, "grow"); mkdirSync(dir);
    writeFileSync(join(dir, ".git"), `gitdir: ${join(outer, ".git")}\n`);
    const z = new GrowZone(dir);
    await expect(z.restoreToHead()).rejects.toMatchObject({ code: "not_toplevel" });
    await expect(z.ensure(true)).rejects.toMatchObject({ code: "not_toplevel" });
    expect(readFileSync(join(outer, "untracked.txt"), "utf8")).toBe("mine");
  });

  it("commits only its own path, even with an unrelated file already staged, and still commits unchanged text", async () => {
    const dir = join(tmp(), "grow"); const z = new GrowZone(dir); await z.ensure(true);
    writeFileSync(join(dir, "stray.txt"), "x");
    execFileSync("git", ["-C", dir, "add", "stray.txt"]);
    const c1 = await z.writeAndCommit("unit-convert", "v1\n", "m1");
    const show = (c: string): string => execFileSync("git", ["-C", dir, "show", "--name-only", "--format=", c], { encoding: "utf8" }).trim();
    expect(show(c1)).toBe("skills/unit-convert/SKILL.md");
    const c2 = await z.writeAndCommit("unit-convert", "v1\n", "m2");
    expect(c2).not.toBe(c1);
    execFileSync("git", ["-C", dir, "reset", "-q"]);
    execFileSync("git", ["-C", dir, "add", "stray.txt"]);
    await z.removeAndCommit("unit-convert", "m3");
    expect(show("HEAD")).toBe("skills/unit-convert/SKILL.md");
  });

  it("handles an unborn HEAD: creates the root commit when allowed, otherwise faults", async () => {
    const dir = join(tmp(), "grow"); execFileSync("git", ["init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n");
    await expect(new GrowZone(dir).ensure(false)).rejects.toMatchObject({ code: "not_toplevel" });
    const z = new GrowZone(dir); await z.ensure(true);
    expect(await z.head()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps the cause of a git failure without putting git output in the message", async () => {
    const dir = join(tmp(), "grow"); const z = new GrowZone(dir); await z.ensure(true);
    writeFileSync(join(dir, ".git", "HEAD"), "garbage\n");
    const err = await z.head().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrowZoneError);
    expect((err as GrowZoneError).message).toBe("git_failed");
    expect((err as GrowZoneError).cause).toBeDefined();
  });

  it("resolves a relative zone dir and rejects a relative bundle path", async () => {
    const root = tmp(); const z = new GrowZone(join(root, "grow")); await z.ensure(true);
    expect(new GrowZone("some/rel").dir.startsWith("/")).toBe(true);
    await expect(z.bundle("zone.bundle")).rejects.toMatchObject({ code: "bad_name" });
  });

  it("refuses a skill folder that is a symlink out of the zone, writing nothing outside", async () => {
    const root = tmp(); const dir = join(root, "grow"); const z = new GrowZone(dir); await z.ensure(true);
    const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(dir, "skills", "unit-convert"));
    await expect(z.writeAndCommit("unit-convert", "v1\n", "m")).rejects.toMatchObject({ code: "not_toplevel" });
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
  });

  it("matches the Grow-Op trailer exactly, not text that merely quotes it", async () => {
    const z = new GrowZone(join(tmp(), "grow")); await z.ensure(true);
    const op = "0b6f3a52-1c1e-4d0a-9f55-3f2f4a7a9c11";
    await z.writeAndCommit("unit-convert", "v1\n", `skill: add\n\nsee Grow-Op: ${op} in the notes`);
    expect(await z.findOpCommit(op)).toBeNull();
  });

  it("finds the real trailer even when six newer commits quote it on a longer line", async () => {
    const z = new GrowZone(join(tmp(), "grow")); await z.ensure(true);
    const op = "0b6f3a52-1c1e-4d0a-9f55-3f2f4a7a9c11";
    const c = await z.writeAndCommit("unit-convert", "v1\n", `skill: add\n\nGrow-Op: ${op}`);
    for (let i = 0; i < 6; i++) await z.writeAndCommit("other", `x${i}\n`, `n${i}\n\nsee Grow-Op: ${op} in the notes`);
    expect(await z.findOpCommit(op)).toBe(c);
  });

  it("finishes a half-initialised zone (default config, unborn HEAD) on ensure(true) only", async () => {
    const dir = join(tmp(), "grow"); execFileSync("git", ["init", "-q", "-b", "main", dir]);
    await expect(new GrowZone(dir).ensure(false)).rejects.toMatchObject({ code: "not_toplevel" });
    const z = new GrowZone(dir); await z.ensure(true);
    expect(await z.writeAndCommit("unit-convert", "v1\n", "m")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("never rewrites the config of a repository that already has commits", async () => {
    const dir = join(tmp(), "grow"); execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-q", "--allow-empty", "-m", "x"]);
    await expect(new GrowZone(dir).ensure(true)).rejects.toMatchObject({ code: "not_toplevel" });
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toBe(CANONICAL_CONFIG);
  });
});
