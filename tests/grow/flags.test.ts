import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGrowDir, resolveGrowEnabled, resolveSkillsEnabled } from "../../src/grow/flags.js";

const DEFAULT = "/Users/x/Library/Application Support/houge/grow";

describe("grow flags", () => {
  it("is on unless explicitly disabled, so a typo never silences the grow zone", () => {
    for (const v of [undefined, "", "1", "true", "typo"]) expect(resolveGrowEnabled({ HOUGE_GROW_ENABLED: v })).toBe(true);
    for (const v of ["0", "false", "No", " off "]) expect(resolveGrowEnabled({ HOUGE_GROW_ENABLED: v })).toBe(false);
    expect(resolveSkillsEnabled({ HOUGE_SKILLS_ENABLED: "off" })).toBe(false);
    expect(resolveSkillsEnabled({})).toBe(true);
  });
  it("lives outside the checkout by default and takes only an absolute override", () => {
    expect(resolveGrowDir({}, "/Users/x")).toBe(DEFAULT);
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/data/grow/zone" }, "/Users/x")).toBe("/data/grow/zone");
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "relative/grow" }, "/Users/x")).toBe(DEFAULT);
  });
  it("refuses an override that would turn a broad directory into a write-denied path", () => {
    for (const bad of ["/", "/Users", "/Users/x", "/tmp/x"]) expect(resolveGrowDir({ HOUGE_GROW_DIR: bad }, "/Users/x")).toBe(DEFAULT);
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/private/tmp/a/grow" }, "/Users/x")).toBe("/private/tmp/a/grow");
  });
  it("refuses an override that overlaps the checkout, the data dir or ~/.omp, which the sandbox would cut off from every child", () => {
    const repo = "/Users/x/Projects/adventure", data = "/Users/x/Library/Application Support/houge/data", avoid = [repo, data];
    const pick = (dir: string): string => resolveGrowDir({ HOUGE_GROW_DIR: dir }, "/Users/x", avoid);
    for (const bad of [repo, "/Users/x/Projects", `${repo}/grow`, `${data}/omp/workspace/grow`, "/Users/x/.omp/x", "/Users/x/.omp"]) expect(pick(bad), bad).toBe(DEFAULT);
    expect(pick("/private/tmp/a/grow")).toBe("/private/tmp/a/grow");
    expect(pick(`${repo}-other/grow`)).toBe(`${repo}-other/grow`);
  });
  it("compares overlaps case-insensitively, as the deny matcher does on a case-insensitive volume", () => {
    const repo = "/Users/x/Projects/adventure", avoid = [repo, "/Users/x/Library/Application Support/houge/data"];
    const pick = (dir: string): string => resolveGrowDir({ HOUGE_GROW_DIR: dir }, "/Users/x", avoid);
    for (const bad of ["/users/x/projects/adventure", "/USERS/X/Projects/adventure/grow", "/Users/x/.OMP/x", "/USERS/x"]) expect(pick(bad), bad).toBe(DEFAULT);
    expect(pick(`${repo}-other/grow`)).toBe(`${repo}-other/grow`);
    expect(pick("/Private/Tmp/A/grow")).toBe("/Private/Tmp/A/grow");
  });
  it("refuses a mixed-case spelling of a deep home or its ancestor, which would deny the whole home", () => {
    const home = "/Users/x/Home/me", fallback = `${home}/Library/Application Support/houge/grow`;
    for (const bad of ["/USERS/X/Home/me", "/USERS/X/Home"]) expect(resolveGrowDir({ HOUGE_GROW_DIR: bad }, home), bad).toBe(fallback);
  });
  it("returns the normalised path it validated, never the raw override", () => {
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/data/a/../grow/zone/" }, "/Users/x")).toBe("/data/grow/zone");
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/data/a/b/../../../../Users/x" }, "/Users/x")).toBe(DEFAULT);
    expect(resolveGrowDir({ HOUGE_GROW_DIR: "/Users/x/Library/../" }, "/Users/x")).toBe(DEFAULT);
  });
  describe("through a symlink", () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    /** A real temp root (tmpdir itself sits behind /var → /private/var), with a checkout, a data dir and a home inside. */
    const world = () => {
      const t = mkdtempSync(join(tmpdir(), "grow-flags-")); dirs.push(t);
      const repo = join(t, "repo"), data = join(t, "data"), home = join(t, "home", "me");
      for (const d of [repo, data, join(home, ".omp")]) mkdirSync(d, { recursive: true });
      return { t, repo, data, home, fallback: join(home, "Library", "Application Support", "houge", "grow") };
    };

    it("refuses an override whose real path lands inside an avoided dir, ~/.omp or the home itself", () => {
      const w = world();
      symlinkSync(w.repo, join(w.t, "to-repo")); symlinkSync(join(w.home, ".omp"), join(w.t, "to-omp")); symlinkSync(join(w.t, "home"), join(w.t, "to-homes"));
      const pick = (dir: string): string => resolveGrowDir({ HOUGE_GROW_DIR: dir }, w.home, [w.repo, w.data]);
      for (const bad of [join(w.t, "to-repo", "grow"), join(w.t, "to-repo"), join(w.t, "to-omp", "grow"), join(w.t, "to-homes")]) expect(pick(bad), bad).toBe(w.fallback);
      expect(pick(join(w.t, "zone", "grow"))).toBe(join(w.t, "zone", "grow"));
    });

    it("compares real paths on both sides: an avoided dir given by a symlink spelling still bites", () => {
      const w = world();
      symlinkSync(w.repo, join(w.t, "repo-link"));
      expect(resolveGrowDir({ HOUGE_GROW_DIR: join(w.repo, "grow") }, w.home, [join(w.t, "repo-link")])).toBe(w.fallback);
    });

    it("refuses an override through a dangling symlink that points into an avoided dir (it would come alive there)", () => {
      const w = world(); const out = join(w.t, "out"); mkdirSync(out);
      symlinkSync(join(w.repo, "notyet"), join(out, "leaf")); symlinkSync(join(w.repo, "notyet2"), join(out, "mid")); symlinkSync("../repo/sub", join(out, "rel"));
      const pick = (dir: string): string => resolveGrowDir({ HOUGE_GROW_DIR: dir }, w.home, [w.repo, w.data]);
      for (const bad of [join(out, "leaf"), join(out, "mid", "zone"), join(out, "rel")]) expect(pick(bad), bad).toBe(w.fallback);
    });

    // macOS reaches the data volume under /System/Volumes/Data as well (a firmlink, which realpath does not fold), and
    // a Seatbelt deny on that spelling denies nothing at the usual one.
    it("judges and returns a /System/Volumes/Data spelling as the path it reaches", () => {
      const w = world();
      const pick = (dir: string): string => resolveGrowDir({ HOUGE_GROW_DIR: dir }, w.home, [w.repo, w.data]);
      expect(pick(`/System/Volumes/Data${join(w.repo, "zone")}`)).toBe(w.fallback);
      expect(pick(`/system/volumes/data${join(w.repo, "zone")}`)).toBe(w.fallback);
      expect(pick(`/System/Volumes/Data${join(w.t, "zone", "grow")}`)).toBe(join(w.t, "zone", "grow"));
      expect(pick("/System/Volumes/Data")).toBe(w.fallback);
    });

    it("keeps the override's own spelling when its real path is allowed", () => {
      const w = world(); mkdirSync(join(w.t, "real-zone")); symlinkSync(join(w.t, "real-zone"), join(w.t, "zone-link"));
      expect(resolveGrowDir({ HOUGE_GROW_DIR: join(w.t, "zone-link", "grow") }, w.home, [w.repo, w.data])).toBe(join(w.t, "zone-link", "grow"));
    });
  });

  it("is pinned away from the real home directory for the whole suite", () => {
    expect(resolveGrowDir(process.env, homedir()).startsWith(join(homedir(), "Library"))).toBe(false);
  });
});
