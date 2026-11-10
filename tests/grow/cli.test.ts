import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GROW_CLI_USAGE, runGrowCli } from "../../src/grow/cli.js";
import { renderSkillFile } from "../../src/grow/checks.js";
import { CLEAN, growFields, growSetup, mkTmp } from "../helpers/grow.js";

const NOW = "2026-11-10T12:00:00.000Z";
const setup = async () => {
  const s = await growSetup();
  const env = { HOUGE_GROW_DIR: s.zone.dir };     // never the real home: the override is used or the default (real home) would show
  const run = (sub: string, name = "", rest = "", backups = join(s.dir, "no-backups")) => runGrowCli(s.store, sub, name, rest, env, NOW, backups);
  return { ...s, run };
};

describe("houge grow CLI", () => {
  it("exports a usage line naming every subcommand", () => {
    for (const w of ["list", "show", "check", "log", "undo", "trust", "adopt"]) expect(GROW_CLI_USAGE).toContain(w);
  });

  it("list prints name, state, origin and uses per item", async () => {
    const s = await setup();
    await s.live(growFields(), { ...CLEAN, level: "untrusted" });
    expect(await s.run("list")).toBe("unit-convert  live  untrusted  0");
  });

  it("list says so when empty", async () => { expect(await (await setup()).run("list")).toBe("(empty)"); });

  it("show prints the committed file, and a line for an absent name", async () => {
    const s = await setup();
    await s.live(growFields());
    const text = await s.run("show", "unit-convert");
    expect(text).toBe(await s.zone.readHead("unit-convert"));
    expect(text).toContain("description:");
    expect(await s.run("show", "no-such-skill")).toBe("no skill named no-such-skill at HEAD");
  });

  it("show of a broken zone prints a short code, not a stack", async () => {
    const s = await setup();
    const out = await runGrowCli(s.store, "show", "unit-convert", "", { HOUGE_GROW_DIR: join(s.dir, "not-a-repo", "x") }, NOW, s.dir);
    expect(out).toMatch(/^cannot read unit-convert: \S+$/);
    expect(out).not.toContain("\n");
  });

  it("check passes a good item and names the code for a committed file that fails", async () => {
    const s = await setup();
    await s.live(growFields());
    expect(await s.run("check")).toBe("PASS unit-convert");
    await s.zone.writeAndCommit("unit-convert", renderSkillFile(growFields({ description: "too short" }), "clean"), "corrupt");
    expect(await s.run("check", "unit-convert")).toBe("FAIL unit-convert: bad_description");
    expect(await s.run("check", "other-skill")).toBe("(nothing to check)");
  });

  it("check calls an unparseable committed file unreadable", async () => {
    const s = await setup();
    await s.live(growFields());
    await s.zone.writeAndCommit("unit-convert", "not a skill file\n", "corrupt");
    expect(await s.run("check")).toBe("FAIL unit-convert: unreadable");
  });

  it("log prints the newest 30 events oldest-first, then one line per snapshot with its bundle", async () => {
    const s = await setup();
    await s.live(growFields());
    for (let i = 0; i < 35; i++) s.store.appendGrowEvent({ at: `2026-11-10T11:00:${String(i).padStart(2, "0")}.000Z`, run_id: null, chat_id: null, action: "undo", name: `skill-${i}`, result: "ok", code: null, reviewer_model: null, commit_id: null });
    const backups = mkTmp();
    for (const f of ["houge-2026-11-09.sqlite", "houge-2026-11-09.grow.bundle", "houge-2026-11-10.sqlite", "notes.txt"]) writeFileSync(join(backups, f), "x");
    mkdirSync(join(backups, "sub"));
    const lines = (await s.run("log", "", "", backups)).split("\n");
    expect(lines).toHaveLength(32);
    expect(lines[0]).toBe("2026-11-10T11:00:05.000Z undo skill-5 ok");
    expect(lines[29]).toBe("2026-11-10T11:00:34.000Z undo skill-34 ok");
    expect(lines.slice(30)).toEqual(["houge-2026-11-09.sqlite  bundle: yes", "houge-2026-11-10.sqlite  bundle: no"]);
  });

  it("trust clears the mark and says so, then has nothing left to clear", async () => {
    const s = await setup();
    await s.live(growFields(), { ...CLEAN, level: "untrusted" });
    expect(await s.run("trust", "unit-convert")).toBe("trusted unit-convert");
    expect(s.store.getGrowItem("unit-convert")?.origin).toBe("clean");
    expect(await s.run("trust", "unit-convert")).toBe("nothing to clear for unit-convert");
  });

  it("undo and adopt only queue a request (no git write), once per instant", async () => {
    const s = await setup();
    await s.live(growFields());
    const head = await s.zone.head();
    expect(await s.run("undo", "unit-convert", "too vague")).toBe("queued: the daemon runs it within a minute");
    expect(await s.run("undo", "unit-convert", "too vague")).toBe("already queued");
    expect(await s.run("adopt", "stray-skill")).toBe("queued: the daemon runs it within a minute");
    expect(await s.zone.head()).toBe(head);
    const due = s.store.dueGrowRequests();
    expect(due.map((r) => [r.kind, r.name, r.reason, r.chat_id])).toEqual([["undo", "unit-convert", "too vague", null], ["adopt", "stray-skill", null, null]]);
  });
});
