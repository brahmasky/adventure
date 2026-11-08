import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAttachments } from "../../src/omp/attachments.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseAttachments (spec R7 §4.1): the refused list is the else of today's if", () => {
  it("text and attachments are today's; refused holds each refused marker's resolved path in line order; the lists are disjoint", () => {
    const d = mkdtempSync(join(tmpdir(), "hpa-")); dirs.push(d);
    const ws = join(d, "ws"); mkdirSync(ws); writeFileSync(join(d, "secret"), "k"); symlinkSync(join(d, "secret"), join(ws, "leak"));
    writeFileSync(join(ws, "ok.txt"), "o");
    const text = ["intro", "[[attach: ok.txt]]", "  [[attach:   ../up.txt ]]  ", "[[attach: /etc/hosts]]", "[[attach: leak]]", "[[attach: later.txt]]", "outro"].join("\n");
    const r = parseAttachments(text, ws);
    expect(r).toEqual({ text: "intro\noutro", attachments: [join(ws, "ok.txt"), join(ws, "later.txt")], refused: [join(d, "up.txt"), "/etc/hosts", join(ws, "leak")] });
    expect(r.attachments.filter((a) => r.refused.includes(a))).toEqual([]); // disjoint on a static filesystem (D7)
  });
  it("no marker → nothing refused; a text without markers is returned trimmed as today", () => {
    expect(parseAttachments("  hi\n", "/w")).toEqual({ text: "hi", attachments: [], refused: [] });
  });
});
