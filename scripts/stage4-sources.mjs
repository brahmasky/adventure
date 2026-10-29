// Input extraction shared by the command and path corpora (spec 2026-10-29 §6 items 1-2): the string literals of a vitest file's
// `it.each` tables, and the tool calls in the live omp transcripts. Read-only; transcript values live in memory only and are never printed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SetupError } from "./stage4-diff-lib.mjs";

export const DEFAULT_TRANSCRIPTS = "/Users/xiaochuan/Projects/adventure/omp/sessions/chat-8744196214";
export const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

/** The runtime value of one string literal's source text: JSON.parse for "…", a restricted unescape for '…' and `…` (no ${). */
export function evalLiteral(src) {
  const q = src[0];
  if (q === '"') return JSON.parse(src);
  if (q === "`" && src.includes("${")) throw new SetupError("template literal with ${ in a test table");
  const ESC = { n: "\n", t: "\t", "\\": "\\", "'": "'", '"': '"', "`": "`" };
  return src.slice(1, -1).replace(/\\(.)/gs, (_, c) => {
    if (!(c in ESC)) throw new SetupError(`unsupported escape \\${c} in a test literal`);
    return ESC[c];
  });
}

/** End index (exclusive) of the string literal starting at i. */
function literalEnd(text, i) {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** The first-cell strings of one `it.each([...])` table: a string element, or the first element of a row array when it is a string. */
function tableCells(text, open) {
  const out = []; let depth = 0; let rowFirst = false;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = literalEnd(text, i);
      if (depth === 1 || (depth === 2 && rowFirst)) out.push(evalLiteral(text.slice(i, end)));
      rowFirst = false; i = end - 1;
    } else if (c === "[") { depth += 1; rowFirst = depth === 2; }
    else if (c === "]") { depth -= 1; if (depth === 0) return out; }
    else if (depth === 2 && !/[\s,]/.test(c)) rowFirst = false;
  }
  throw new SetupError("unterminated it.each table");
}

/** Every it.each table's first cells, in file order, plus (with `calls`) the first string argument of each `<name>("…"` call. */
export function testLiterals(file, calls = []) {
  const text = readFileSync(file, "utf8");
  const out = [];
  for (const m of text.matchAll(/it\.each\(\s*\[/g)) out.push(...tableCells(text, m.index + m[0].length - 1));
  for (const name of calls) {
    for (const m of text.matchAll(new RegExp(`\\b${name}\\(\\s*(["'\`])`, "g"))) {
      const start = m.index + m[0].length - 1;
      out.push(evalLiteral(text.slice(start, literalEnd(text, start))));
    }
  }
  return out;
}

function walk(o, f) {
  if (Array.isArray(o)) o.forEach((x) => walk(x, f));
  else if (o && typeof o === "object") { f(o); Object.values(o).forEach((x) => walk(x, f)); }
}

/** Every toolCall object named in `names`, across the *.jsonl files of the transcripts directory (a missing directory is a setup error). */
export function transcriptCalls(dir, names) {
  const root = resolve(dir ?? DEFAULT_TRANSCRIPTS);
  if (!existsSync(root)) throw new SetupError("transcripts directory not found (pass --transcripts-dir)");
  const calls = [];
  for (const f of readdirSync(root).filter((n) => n.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      walk(j, (o) => { if (o.type === "toolCall" && names.includes(o.name) && o.arguments && typeof o.arguments === "object") calls.push(o); });
    }
  }
  return calls;
}
