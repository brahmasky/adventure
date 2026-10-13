import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INJECTION_GOLDEN } from "../../src/decisions/golden.js";
import { plantedCorpus } from "../../src/decisions/injection-corpus.js";
import { passageBlock, redactForJudge, splitEgress } from "../../src/decisions/egress.js";
import { PASSAGE_CHARS } from "../../src/decisions/entries/tool-injection.js";

const REPO = resolve(import.meta.dirname, "../..");

// Spec §4.2 (senior W10): ≥ 60 planted attacks across web, mail, shell and file shapes in zh and en, HELD OUT from the golden
// set (the sweep's items must not be the gate's). Each payload must stand in its own passage and survive redaction, or the
// recall the gate measures is not the judge's.
describe("planted corpus", () => {
  const items = plantedCorpus();
  it("has at least 60 items, every shape in both languages", () => {
    expect(items.length).toBeGreaterThanOrEqual(60);
    for (const shape of ["web", "mail", "shell", "file"]) for (const lang of ["en", "zh"]) expect([shape, lang, items.filter((i) => i.shape === shape && i.lang === lang).length >= 6]).toEqual([shape, lang, true]);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
  it("shares no text with the golden set", () => {
    for (const g of INJECTION_GOLDEN) for (const i of items) expect(i.text.includes(g.text) || g.text.includes(i.payload)).toBe(false);
  });
  it("every payload stands in a passage of its own after redaction (query values masked, the instruction kept)", () => {
    for (const i of items) {
      const pieces = (splitEgress(i.text, 900) ?? []).map((p) => p.out); // mask, then split (Ruling 2)
      expect([i.id, pieces.some((p) => p.trim() === redactForJudge(i.payload))]).toEqual([i.id, true]);
      expect(redactForJudge(i.payload).length).toBeGreaterThan(40); // the attack's words survive, not just a mask
    }
  });
});

// The repo is public and the corpus is sent to an outside judge: every planted target must be a reserved host nobody can
// register (RFC 2606/6761), and the mu-derived items must carry mu's MIT notice, or publishing the corpus breaks the licence.
describe("planted corpus hygiene", () => {
  const items = plantedCorpus();
  it("targets only reserved hosts", () => {
    const hosts = items.flatMap((i) => [...i.payload.matchAll(/(?:https?:\/\/|@)([a-z0-9.-]+)/giu)].map((m) => m[1]!.replace(/\.+$/u, "")));
    expect(hosts.length).toBeGreaterThan(10);
    for (const h of hosts) expect([h, /(^|\.)(example|invalid)$|\.example\.invalid$/u.test(h)]).toEqual([h, true]);
  });
  it("carries mu's attribution in the source and in THIRD_PARTY_NOTICES.md", () => {
    const src = readFileSync(join(REPO, "src/decisions/injection-corpus.ts"), "utf8");
    expect(src).toMatch(/qybaihe\/mu@faed8c3/u);
    expect(src).toMatch(/Copyright \(c\) 2025 Mario Zechner, MIT License/u);
    expect(readFileSync(join(REPO, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("`src/decisions/injection-corpus.ts`");
  });
  it("no planted carrier trips the egress content check (the judge, not the floor, must see each attack)", () => {
    for (const i of items) for (const p of splitEgress(i.text, PASSAGE_CHARS) ?? []) expect([i.id, p.block ?? null]).toEqual([i.id, null]);
  });
});

interface CleanScript {
  CLEAN_URLS: string[]; CLEAN_QUERIES: string[]; CLEAN_DOCS: string[]; SHELL: Array<[string, string[]]>;
  zhRepoDocs: (repo: string) => Array<{ source: string; file: string; text: string }>; ZH_MIN_HAN: number;
}
const loadScript = async (): Promise<CleanScript> => (await import(join(REPO, "scripts/injection-corpus.mjs") as string)) as CleanScript;

// Spec §4.2 fixes the clean sources: 20 public pages, searches, common read-only shell commands, Paco-approved local files
// (plan Ruling 15: public repo docs, with the attack-discussing trees excluded whole). The repo docs are the only clean
// source a hermetic test can read: each must exist and none may trip the egress content check, or the clean withhold rate
// would be measured on text that never reaches the judge.
describe("clean capture sources", () => {
  it("fixes 20 public https pages and five searches", async () => {
    const s = await loadScript();
    expect(s.CLEAN_URLS.length).toBe(20);
    for (const u of s.CLEAN_URLS) expect(u.startsWith("https://")).toBe(true);
    expect(s.CLEAN_QUERIES.length).toBe(5);
  });
  it("reads only public repo docs outside the excluded trees, none credential-bearing", async () => {
    const s = await loadScript();
    for (const f of s.CLEAN_DOCS) {
      expect([f, /^(docs\/superpowers|docs\/decisions|tasks)\//u.test(f) || /(^|\/)\.env|sqlite/u.test(f)]).toEqual([f, false]);
      for (const p of splitEgress(readFileSync(join(REPO, f), "utf8").slice(0, 32 * 1024), PASSAGE_CHARS) ?? []) expect([f, p.block ?? null]).toEqual([f, null]);
    }
  });
  it("runs no shell command that prints the host name or writes", async () => {
    const s = await loadScript();
    for (const [cmd, args] of s.SHELL) {
      // no `ps`: the process list names the apps Paco runs, and the gate sends clean text to TypeSafe (fix round 0)
      expect([cmd, ["ls", "git", "uname", "df", "sw_vers", "npm", "cat", "sysctl"].includes(cmd)]).toEqual([cmd, true]);
      if (cmd === "uname") expect(args.some((a) => /a|n/u.test(a))).toBe(false); // -a and -n print the machine's name
      if (cmd === "git") expect(["log", "status"].includes(args[0]!)).toBe(true);
    }
  });
});

// The fetched pages and shell output are almost all English, so without a zh source the clean-withhold rate says nothing
// about Chinese text (fix round 0). The repo's own Chinese lines (test fixtures, session notes) are the allowed zh source;
// the planted and golden items under src/decisions and tests/decisions must never count as clean, or a withhold of an
// attack would be scored as a false positive.
describe("zh clean passages from the repo", () => {
  it("yields at least 60 zh passages, none from the injection trees, none tripping the content check", async () => {
    const s = await loadScript();
    const docs = s.zhRepoDocs(REPO);
    for (const d of docs) expect([d.file, /^(docs\/superpowers|docs\/decisions|tasks|src\/decisions|tests\/decisions)\//u.test(d.file)]).toEqual([d.file, false]);
    const passages = docs.flatMap((d) => splitEgress(d.text, PASSAGE_CHARS) ?? []);
    for (const p of passages) expect(p.block ?? null).toBe(null);
    const zh = passages.filter((p) => (p.raw.match(/\p{Script=Han}/gu) ?? []).length >= s.ZH_MIN_HAN);
    expect(zh.length).toBeGreaterThanOrEqual(60);
    for (const g of INJECTION_GOLDEN) expect(docs.some((d) => d.text.includes(g.text))).toBe(false);
  });
});
