import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFields, fieldScrub, parseSkillFile, renderSkillFile } from "../../src/grow/checks.js";
import type { GrowService } from "../../src/grow/service.js";
import { EXEMPLAR_NAME, migrateLegacySkills, seedExemplars } from "../../src/grow/seed.js";
import { CLEAN, commitCount, growBody, growFields, growSetup, mkTmp, small } from "../helpers/grow.js";

const NOW = "2025-03-10T10:00:00.000Z";   // a past month: a wall-clock read would name another folder
const SEED = join(import.meta.dirname, "..", "..", "grow-seed");
const legacyFile = (name: string, when: string, body: string): string => `---\nname: ${name}\nscope: ask\nwhen: ${when}\nanchors:\n  - 1 US cup equals 236.6 mL\n  - "The output names its sources"\nversion: 1\nscore: 0.95\n---\n\n${body}\n`;
const writeIn = (legacy: string, scope: string, file: string, text: string): void => { mkdirSync(join(legacy, scope), { recursive: true }); writeFileSync(join(legacy, scope, file), text); };
const writeLegacy = (legacy: string, file: string, text: string): void => writeIn(legacy, "ask", file, text);
const GOOD = (name: string): string => legacyFile(name, `a good skill named ${name} with a long enough when line`, growBody(12, name));
const failingSvc = { seed: async () => "failed" } as unknown as GrowService;

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
    expect(readdirSync(dirname(legacy)).some((n) => n === "skills.migrated-2025-03")).toBe(true);
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: [], renamed: false });
  });

  it("leaves the old folder in place when a file does not pass, so a skill never disappears from view", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeLegacy(legacy, "good-one.md", legacyFile("good-one", "a good skill with a long enough when line here", growBody(12)));
    writeLegacy(legacy, "too-short.md", legacyFile("too-short", "tiny", "x"));
    const r = await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW });
    expect(r).toEqual({ migrated: ["good-one"], invalid: ["ask/too-short.md"], renamed: false });
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
    expect(again).toEqual({ migrated: [], invalid: ["ask/too-short.md"], renamed: false });
    expect(s.store.getGrowItem("good-one")?.state).toBe("removed");
  });

  it("a name repeated in two scopes is reported, nothing is renamed away, both files stay", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeIn(legacy, "ask", "dup-skill.md", GOOD("dup-skill")); writeIn(legacy, "plan", "dup-skill.md", GOOD("dup-skill"));
    const r = await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW });
    expect(r).toEqual({ migrated: ["dup-skill"], invalid: ["plan/dup-skill.md"], renamed: false });
    expect(existsSync(join(legacy, "ask", "dup-skill.md")) && existsSync(join(legacy, "plan", "dup-skill.md"))).toBe(true);
  });

  it("a known name is silent whatever its state or content: migrated then improved through the grow door, then migrated again", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeLegacy(legacy, "kept-one.md", GOOD("kept-one")); writeLegacy(legacy, "bad-one.md", legacyFile("bad-one", "tiny", "x"));
    expect((await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).migrated).toEqual(["kept-one"]);
    const { origin: _o, ...head } = parseSkillFile((await s.zone.readHead("kept-one"))!)!;
    await s.live(small(head));
    const hash = s.store.getGrowItem("kept-one")!.content_hash;
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: ["ask/bad-one.md"], renamed: false });
    expect(s.store.getGrowItem("kept-one")).toMatchObject({ state: "live", content_hash: hash });
    expect(await s.zone.readHead("kept-one")).toContain("Step three of");
  });

  it("a known name with different content is silent whether it is live or removed", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    await s.live(growFields({ name: "clash-one", description: "an unrelated live skill about something else entirely", body: growBody(40, "x") }));
    await s.live(growFields({ name: "gone-one", description: "another unrelated skill that will be removed soon", body: growBody(40, "g") }));
    await s.svc.undo("gone-one", "not wanted");
    expect(s.store.getGrowItem("gone-one")?.state).toBe("removed");
    writeLegacy(legacy, "clash-one.md", GOOD("clash-one")); writeLegacy(legacy, "gone-one.md", GOOD("gone-one"));
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: [], renamed: true });
    expect(s.store.getGrowItem("gone-one")?.state).toBe("removed");
  });

  it("a legacy file named like the exemplar is invalid and keeps the folder", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeLegacy(legacy, `${EXEMPLAR_NAME}.md`, GOOD(EXEMPLAR_NAME));
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: [`ask/${EXEMPLAR_NAME}.md`], renamed: false });
    expect(existsSync(join(legacy, "ask", `${EXEMPLAR_NAME}.md`))).toBe(true);
    expect(s.store.listGrowItems()).toEqual([]);
  });

  it("an identical live item is silently fine, before and after the folder was renamed", async () => {
    const s = await growSetup();
    const legacy2 = join(mkTmp(), "skills");
    writeLegacy(legacy2, "same-one.md", GOOD("same-one"));
    expect((await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy2, now: NOW })).migrated).toEqual(["same-one"]);
    const legacy3 = join(mkTmp(), "skills");
    writeLegacy(legacy3, "same-one.md", GOOD("same-one"));
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy3, now: NOW })).toEqual({ migrated: [], invalid: [], renamed: true });
  });

  it("keeps the folder when a publish fails, and seedExemplars reports a failed seed", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeLegacy(legacy, "good-one.md", GOOD("good-one"));
    expect(await migrateLegacySkills({ store: s.store, svc: failingSvc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: ["ask/good-one.md"], renamed: false });
    expect(existsSync(join(legacy, "ask", "good-one.md"))).toBe(true);
    expect(await seedExemplars({ store: s.store, svc: failingSvc, seedDir: SEED, now: NOW })).toEqual({ seeded: [], failed: [EXEMPLAR_NAME] });
  });

  it("skips _-prefixed folders and still renames", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeIn(legacy, "_pending", "x-skill.md", GOOD("x-skill")); writeIn(legacy, "_retired", "y-skill.md", GOOD("y-skill"));
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: [], renamed: true });
    expect(s.store.listGrowItems()).toEqual([]);
  });

  it("an exemplar whose description equals another live item's fails the duplicate check", async () => {
    const s = await growSetup();
    const ex = parseSkillFile(readFileSync(join(SEED, "skills", EXEMPLAR_NAME, "SKILL.md"), "utf8"))!;
    await s.live(growFields({ name: "other-live", description: ex.description, body: growBody(40, "o") }));
    expect(await seedExemplars({ store: s.store, svc: s.svc, seedDir: SEED, now: NOW })).toEqual({ seeded: [], failed: [EXEMPLAR_NAME] });
  });

  it("stray files (.DS_Store) in the seed and legacy folders are ignored", async () => {
    const s = await growSetup(); const seedDir = mkTmp(); const legacy = join(mkTmp(), "skills");
    mkdirSync(join(seedDir, "skills"), { recursive: true }); writeFileSync(join(seedDir, "skills", ".DS_Store"), "x");
    expect(await seedExemplars({ store: s.store, svc: s.svc, seedDir, now: NOW })).toEqual({ seeded: [], failed: [] });
    writeLegacy(legacy, "good-one.md", GOOD("good-one")); writeFileSync(join(legacy, ".DS_Store"), "x"); writeFileSync(join(legacy, "ask", ".DS_Store"), "x");
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: ["good-one"], invalid: [], renamed: true });
  });

  it("dot-named entries are never read: a dot directory in the seed, a dot scope and an AppleDouble file in the legacy folder", async () => {
    const s = await growSetup(); const seedDir = mkTmp(); const legacy = join(mkTmp(), "skills");
    mkdirSync(join(seedDir, "skills", ".hidden"), { recursive: true });
    writeFileSync(join(seedDir, "skills", ".hidden", "SKILL.md"), readFileSync(join(SEED, "skills", EXEMPLAR_NAME, "SKILL.md"), "utf8"));
    expect(await seedExemplars({ store: s.store, svc: s.svc, seedDir, now: NOW })).toEqual({ seeded: [], failed: [] });
    writeIn(legacy, ".trash", "t-skill.md", GOOD("t-skill")); writeLegacy(legacy, "._x.md", "\u0000garbage"); writeLegacy(legacy, "good-one.md", GOOD("good-one"));
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: ["good-one"], invalid: [], renamed: true });
    expect(s.store.listGrowItems().map((i) => i.name)).toEqual(["good-one"]);
  });

  it("never follows a symlink: a linked .md and a linked scope are invalid and keep the folder", async () => {
    const s = await growSetup(); const root = mkTmp(); const legacy = join(root, "skills"); const outside = join(root, "outside");
    mkdirSync(outside); writeFileSync(join(outside, "linked-one.md"), GOOD("linked-one")); writeFileSync(join(outside, "scoped-one.md"), GOOD("scoped-one"));
    mkdirSync(join(legacy, "ask"), { recursive: true });
    symlinkSync(join(outside, "linked-one.md"), join(legacy, "ask", "linked-one.md")); symlinkSync(outside, join(legacy, "plan"));
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: [join("ask", "linked-one.md"), "plan"], renamed: false });
    expect(s.store.listGrowItems()).toEqual([]);
  });

  it("uses the first free skills.migrated-<month> name when one already exists", async () => {
    const s = await growSetup(); const root = mkTmp(); const legacy = join(root, "skills");
    mkdirSync(join(root, "skills.migrated-2025-03")); mkdirSync(join(root, "skills.migrated-2025-03-2"));
    writeLegacy(legacy, "good-one.md", GOOD("good-one"));
    expect((await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).renamed).toBe(true);
    expect(existsSync(join(root, "skills.migrated-2025-03-3", "ask", "good-one.md"))).toBe(true);
  });

  it("a file name that differs from its frontmatter name is invalid", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    writeLegacy(legacy, "file-name.md", GOOD("other-name"));
    expect(await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).toEqual({ migrated: [], invalid: ["ask/file-name.md"], renamed: false });
  });

  it("reads CRLF files, and takes list lines only under the anchors key", async () => {
    const s = await growSetup(); const legacy = join(mkTmp(), "skills");
    const text = `---
name: crlf-one
scope: ask
when: a crlf skill with a long enough when line
notes:
  - not an anchor
anchors:
  - real anchor one
version: 1
---

${growBody(12)}
`.replace(/\n/g, "\r\n");
    writeLegacy(legacy, "crlf-one.md", text);
    expect((await migrateLegacySkills({ store: s.store, svc: s.svc, legacyDir: legacy, now: NOW })).migrated).toEqual(["crlf-one"]);
    expect(parseSkillFile((await s.zone.readHead("crlf-one"))!)?.anchors).toEqual(["real anchor one"]);
  });
});
