import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectFile } from "../../src/capabilities/local-file-read.js";

describe("readProjectFile", () => {
  it("reads files inside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "note.md"), "hello");

    expect(readProjectFile(root, "docs/note.md")).toEqual({ ok: true, content: "hello" });
  });

  it("denies path traversal outside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));

    expect(readProjectFile(root, "../secret.txt")).toEqual({
      ok: false,
      error: "Path escapes project root"
    });
  });

  it("returns an explicit error for missing files inside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));

    expect(readProjectFile(root, "missing.md")).toEqual({
      ok: false,
      error: "File not found: missing.md"
    });
  });
});
