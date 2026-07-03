import { describe, expect, it } from "vitest";
import { formatDiffMessage, parseUnifiedDiff } from "../../src/telegram/diff-format.js";

const BRANCH = "houge/selfwrite/run_42";

/** The live clock-fix shape: one file, a handful of lines. Must render fully inline. */
const SMALL_DIFF = [
  "diff --git a/src/skills/clock.ts b/src/skills/clock.ts",
  "index abc123..def456 100644",
  "--- a/src/skills/clock.ts",
  "+++ b/src/skills/clock.ts",
  "@@ -10,4 +10,5 @@ export function now() {",
  "   const d = new Date();",
  "-  return d.toString();",
  "+  return d.toISOString();",
  "+  // ISO for the daemon log",
  " }"
].join("\n");

function fileDiff(path: string, added: number, removed = 0): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed + 1} +1,${added + 1} @@`
  ];
  for (let i = 0; i < removed; i++) lines.push(`-old line ${i}`);
  for (let i = 0; i < added; i++) lines.push(`+new line ${i}`);
  return lines.join("\n");
}

describe("parseUnifiedDiff", () => {
  it("counts additions/deletions per file and compacts hunk headers", () => {
    const files = parseUnifiedDiff(SMALL_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/skills/clock.ts");
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(1);
    expect(files[0]!.binary).toBe(false);
    expect(files[0]!.body[0]).toBe("@ 10");
    // Content kept verbatim; noise gone.
    expect(files[0]!.body).toContain("+  return d.toISOString();");
    expect(files[0]!.body).toContain("   const d = new Date();");
    expect(files[0]!.body.some((l) => l.startsWith("index ") || l.startsWith("+++"))).toBe(false);
  });

  it("handles new files (--- /dev/null)", () => {
    const diff = [
      "diff --git a/docs/new.md b/docs/new.md",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/docs/new.md",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world"
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("docs/new.md");
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(0);
  });

  it("renders renames as `old → new` and drops the rename metadata", () => {
    const diff = [
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 95%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "index 1111111..2222222 100644",
      "--- a/src/old-name.ts",
      "+++ b/src/new-name.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;"
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files[0]!.path).toBe("src/old-name.ts → src/new-name.ts");
    expect(files[0]!.additions).toBe(1);
    expect(files[0]!.deletions).toBe(1);
    expect(files[0]!.body.some((l) => l.startsWith("rename ") || l.startsWith("similarity"))).toBe(false);
  });

  it("flags binary files", () => {
    const diff = [
      "diff --git a/assets/icon.png b/assets/icon.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/icon.png and b/assets/icon.png differ"
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.additions).toBe(0);
    expect(files[0]!.body).toEqual([]);
  });

  it("keeps the no-newline marker and multi-file boundaries straight", () => {
    const diff = `${fileDiff("a.ts", 1)}\n\\ No newline at end of file\n${fileDiff("b.ts", 2)}`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(files[0]!.body).toContain("\\ No newline at end of file");
    expect(files[0]!.additions).toBe(1);
    expect(files[1]!.additions).toBe(2);
  });
});

describe("formatDiffMessage", () => {
  it("small diff renders FULLY inline: header, stat block, totals, compact body; not truncated", () => {
    const { text, truncated } = formatDiffMessage(BRANCH, SMALL_DIFF);
    expect(truncated).toBe(false);
    expect(text).toContain(`Diff for \`${BRANCH}\``);
    expect(text).toContain("src/skills/clock.ts | +2 −1");
    expect(text).toContain("1 file changed, +2 −1");
    expect(text).toContain("📄 src/skills/clock.ts");
    expect(text).toContain("@ 10");
    // Every content line survived.
    expect(text).toContain("-  return d.toString();");
    expect(text).toContain("+  return d.toISOString();");
    expect(text).toContain("+  // ISO for the daemon log");
    expect(text).toContain(" }");
    // Noise stripped.
    expect(text).not.toContain("diff --git");
    expect(text).not.toContain("index abc123");
    expect(text).not.toContain("--- a/");
    expect(text).not.toContain("+++ b/");
  });

  it("caps each file's body from the HEAD with a `… (+N more lines)` marker", () => {
    const { text, truncated } = formatDiffMessage(BRANCH, fileDiff("src/big.ts", 60));
    expect(truncated).toBe(true);
    expect(text).toContain("+new line 0"); // head kept…
    expect(text).toContain("+new line 39");
    expect(text).not.toContain("+new line 40"); // …tail capped
    expect(text).toContain("… (+20 more lines)");
    expect(text).toContain("src/big.ts | +60 −0"); // the stat still shows the full counts
  });

  it("drops trailing files past the overall cap with `… (+K more files)`", () => {
    const diff = Array.from({ length: 40 }, (_, i) => fileDiff(`src/file-${i}.ts`, 10)).join("\n");
    const { text, truncated } = formatDiffMessage(BRANCH, diff);
    expect(truncated).toBe(true);
    expect(text).toContain("📄 src/file-0.ts");
    expect(text).toMatch(/… \(\+\d+ more files\)/);
    expect(text).toContain("40 files changed, +400 −0");
  });

  it("stat lines show `| bin` for binaries", () => {
    const diff = [
      "diff --git a/assets/icon.png b/assets/icon.png",
      "Binary files a/assets/icon.png and b/assets/icon.png differ"
    ].join("\n");
    const { text } = formatDiffMessage(BRANCH, diff);
    expect(text).toContain("assets/icon.png | bin");
  });

  it("NEVER exceeds Telegram's 4096-char limit, even for adversarial diffs", () => {
    const longPath = `src/${"deeply/nested/".repeat(15)}component.ts`;
    const monster = Array.from({ length: 120 }, (_, i) =>
      fileDiff(`${longPath}.${i}`, 80, 40)
    ).join("\n");
    const { text, truncated } = formatDiffMessage(BRANCH, monster);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(truncated).toBe(true);

    // A single file with very long lines also stays bounded.
    const wide = fileDiff("src/wide.ts", 0) + "\n" + Array.from({ length: 30 }, () => `+${"y".repeat(300)}`).join("\n");
    const rendered = formatDiffMessage(BRANCH, wide);
    expect(rendered.text.length).toBeLessThanOrEqual(4096);
  });

  it("falls back to a bounded verbatim block for unparsable input", () => {
    const small = formatDiffMessage(BRANCH, "not a diff at all");
    expect(small.truncated).toBe(false);
    expect(small.text).toContain("not a diff at all");

    const big = formatDiffMessage(BRANCH, "z".repeat(10_000));
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBeLessThanOrEqual(4096);
  });
});
