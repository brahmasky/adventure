import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFields, fieldScrub, parseSkillFile, renderSkillFile } from "../../src/grow/checks.js";
import { EXEMPLAR_NAME, migrateLegacySkills, seedExemplars } from "../../src/grow/seed.js";
import { CLEAN, commitCount, growBody, growFields, growSetup, mkTmp } from "../helpers/grow.js";

const NOW = "2026-11-10T10:00:00.000Z";
const SEED = join(import.meta.dirname, "..", "..", "grow-seed");
const legacyFile = (name: string, when: string, body: string): string => `---\nname: ${name}\nscope: ask\nwhen: ${when}\nanchors:\n  - 1 US cup equals 236.6 mL\n  - "The output names its sources"\nversion: 1\nscore: 0.95\n---\n\n${body}\n`;
const writeLegacy = (legacy: string, file: string, text: string): void => { mkdirSync(join(legacy, "ask"), { recursive: true }); writeFileSync(join(legacy, "ask", file), text); };

describe("grow seed", () => {
  it("the shipped exemplar passes the real formal checks and is exactly what renderSkillFile produces", async () => {
    const s = await growSetup();
    const text = readFileSync(join(SEED, "skills", EXEMPLAR_NAME, "SKILL.md"), "utf8");
    const f = parseSkillFile(text)!;
    expect(f.name).toBe(EXEMPLAR_NAME);
    expect(f.origin).toBe("exemplar");
    expect(checkFields(f, [], fieldScrub(s.store))).toEqual({ ok: true });
    expect(renderSkillFile(f, "exemplar")).toBe(text);
  });

  it("publishes the exemplar on first boot, marks it exemplar, and does nothing on the second", async () => {
    const s = await growSetup();
    expect(await seedExemplars({ store: s.store, svc: s.svc, seedDir: SEED, now: NOW })).toEqual({ seeded: [EXEMPLAR_NAME], failed: [] });
    expect(s.store.getGrowItem(EXEMPLAR_NAME)).toMatchObject({ state: "live", origin: "exemplar" });
    const commits = commitCount(s.zone);
    expect(await seedExemplars({ store: s.store, svc: s.svc, seedDir: SEED, now: NOW })).toEqual({ seeded: [], failed: [] });
    expect(commitCount(s.zone)).toBe(commits);
    expect(await s.svc.submit(growFields({ name: EXEMPLAR_NAME }), CLEAN)).toMatchObject({ status: "REFUSED", code: "name_is_exemplar" });
  });

  it("reports a missing seed folder, an unparsable exemplar and a folder with no SKILL.md, and publishes none", async () => {
    const s = await growSetup();
    expect(await seedExemplars({ store: s.store, svc: s.svc, seedDir: join(mkTmp(), "nope"), now: NOW })).toEqual({ seeded: [], failed: ["(seed folder missing)"] });
    const seedDir = mkTmp();
    mkdirSync(join(seedDir, "skills", "bad-one"), { recursive: true });
    writeFileSync(join(seedDir, "skills", "bad-one", "SKILL.md"), "---\nname: bad-one\ndescription: \"x\"\nexample: \"y\"\norigin: exemplar\n---\n\nshort\n");
    mkdirSync(join(seedDir, "skills", "no-file"), { recursive: true });
    mkdirSync(join(seedDir, "skills", "unparsable"), { recursive: true });
    writeFileSync(join(seedDir, "skills", "unparsable", "SKILL.md"), "not a skill file");
    expect(await seedExemplars({ store: s.store, svc: s.svc, seedDir, now: NOW })).toEqual({ seeded: [], failed: ["bad-one", "no-file", "unparsable"] });
    expect(s.store.listGrowItems()).toEqual([]);
  });

  it("refuses an exemplar whose folder name differs from its frontmatter name", async () => {
    const s = await growSetup(); const seedDir = mkTmp();
    mkdirSync(join(seedDir, "skills", "other-name"), { recursive: true });
    writeFileSync(join(seedDir, "skills", "other-name", "SKILL.md"), readFileSync(join(SEED, "skills", EXEMPLAR_NAME, "SKILL.md"), "utf8"));
    expect(await seedExemplars({ store: s.store, svc: s.svc, seedDir, now: NOW })).toEqual({ seeded: [], failed: ["other-name"] });
    expect(s.store.listGrowItems()).toEqual([]);
  });

  it("migrates the old skills once: when → description, anchors unquoted and kept, formal checks applied, folder renamed", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeLegacy(legacy, "recipe-unit-conversion.md", legacyFile("recipe-unit-conversion", "converting a recipe's ingredient amounts between metric and US cups", growBody(12)));
    const r = await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW });
    expect(r).toEqual({ migrated: ["recipe-unit-conversion"], invalid: [], renamed: true });
    expect(s.store.getGrowItem("recipe-unit-conversion")).toMatchObject({ state: "live", origin: "clean", description: "converting a recipe's ingredient amounts between metric and US cups" });
    expect(parseSkillFile((await s.zone.readHead("recipe-unit-conversion"))!)?.anchors).toEqual(["1 US cup equals 236.6 mL", "The output names its sources"]);
    expect(existsSync(legacy)).toBe(false);
    expect(readdirSync(dirname(legacy)).some((n) => n === "skills.migrated-2026-11")).toBe(true);
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: [], renamed: false });
  });

  it("leaves the old folder in place when a file does not pass, so a skill never disappears from view", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeLegacy(legacy, "good-one.md", legacyFile("good-one", "a good skill with a long enough when line here", growBody(12)));
    writeLegacy(legacy, "too-short.md", legacyFile("too-short", "tiny", "x"));
    const r = await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW });
    expect(r).toEqual({ migrated: ["good-one"], invalid: ["too-short.md"], renamed: false });
    expect(existsSync(join(legacy, "ask", "too-short.md"))).toBe(true);
  });

  it("never brings back a migrated skill that was undone", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeLegacy(legacy, "good-one.md", legacyFile("good-one", "a good skill with a long enough when line here", growBody(12)));
    writeLegacy(legacy, "too-short.md", legacyFile("too-short", "tiny", "x"));
    expect((await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).migrated).toEqual(["good-one"]);
    await s.svc.undo("good-one", "not wanted");
    expect(s.store.getGrowItem("good-one")?.state).toBe("removed");
    const again = await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW });
    expect(again).toEqual({ migrated: [], invalid: ["too-short.md"], renamed: false });
    expect(s.store.getGrowItem("good-one")?.state).toBe("removed");
  });
});
