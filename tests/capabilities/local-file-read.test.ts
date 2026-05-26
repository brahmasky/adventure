import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalFileReadAdapter,
  readProjectFile
} from "../../src/capabilities/local-file-read.js";

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

  it("returns an explicit error for a missing project root", () => {
    const parent = mkdtempSync(join(tmpdir(), "houge-parent-"));
    const root = join(parent, "missing-root");

    expect(readProjectFile(root, "note.md")).toEqual({
      ok: false,
      error: `Project root not found: ${root}`
    });
  });

  it("returns an explicit error when the target cannot be read as a file", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));
    mkdirSync(join(root, "docs"));

    expect(readProjectFile(root, "docs")).toEqual({
      ok: false,
      error: "Failed to read file: docs"
    });
  });

  it("denies symlinks that escape the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));
    const outside = mkdtempSync(join(tmpdir(), "houge-outside-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "secret-link.txt"));

    expect(readProjectFile(root, "secret-link.txt")).toEqual({
      ok: false,
      error: "Path escapes project root"
    });
  });
});

describe("createLocalFileReadAdapter", () => {
  it("rejects non-string paths", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));
    const adapter = createLocalFileReadAdapter(root);

    expect(adapter({ path: 123 })).toEqual({ ok: false, error: "path must be a string" });
  });

  it("returns the relative path and file content for successful reads", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "note.md"), "hello");
    const adapter = createLocalFileReadAdapter(root);

    expect(adapter({ path: "docs/note.md" })).toEqual({
      ok: true,
      output: { path: "docs/note.md", content: "hello" }
    });
  });

  it("propagates file read errors", () => {
    const root = mkdtempSync(join(tmpdir(), "houge-root-"));
    const adapter = createLocalFileReadAdapter(root);

    expect(adapter({ path: "missing.md" })).toEqual({
      ok: false,
      error: "File not found: missing.md"
    });
  });
});
