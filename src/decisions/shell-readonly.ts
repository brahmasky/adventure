import { posix } from "node:path";

/**
 * The hostile read-only list (spec §7.2, codex B28, senior B10). At hostile a shell command runs without a tap only if every
 * segment is a listed program in its listed argument forms. It is an allowlist that fails closed: tool.shell_netread is
 * best effort, this list is the real gate. A strict lexer of its own (command-matcher drops prefixes and wrappers): any
 * `NAME=value` prefix, wrapper, redirect, substitution, background `&`, comment, escape, control character or token it
 * cannot lex is refused, so the command asks. Pipes, `;`, `&&` and `||` are allowed only between listed segments.
 * The command runs under `/bin/bash -c` (non-interactive: no history or alias expansion; `shell-wrapper.sh`).
 */
export type Lexed = { ok: true; segments: string[][] } | { ok: false; why: string };
/** One word: its text after quote removal, whether any quote touched it, and whether it holds an unquoted glob (`*`, `?`, `[`; braces never lex). */
interface Word { text: string; quoted: boolean; glob: boolean }
type LexedWords = { ok: true; segments: Word[][] } | { ok: false; why: string };

const FORBIDDEN_UNQUOTED = new Set(["$", "`", "<", ">", "\\", "(", ")", "{", "}", "!", "#"]);
const GLOB_UNQUOTED = new Set(["*", "?", "["]);
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function readQuoted(s: string, i: number, q: "'" | '"'): { body: string; next: number } | null {
  const end = s.indexOf(q, i + 1);
  if (end < 0) return null;
  const body = s.slice(i + 1, end);
  // inside double quotes bash still glob `$`, backticks and escapes; refuse `!` too (history expansion where it is on)
  return q === '"' && /[$`\\!]/.test(body) ? null : { body, next: end + 1 };
}

class WordLexer {
  segments: Word[][] = []; seg: Word[] = []; w: Word = { text: "", quoted: false, glob: false }; has = false;
  endWord(): void { if (this.has) this.seg.push(this.w); this.w = { text: "", quoted: false, glob: false }; this.has = false; }
  /** `strict`: an operator (`|`, `&&`, `||`) with nothing before it is a syntax error bash would refuse; refuse it too. */
  endSeg(strict: boolean): boolean {
    this.endWord();
    if (this.seg.length === 0) return !strict;
    this.segments.push(this.seg); this.seg = [];
    return true;
  }
  add(text: string, quoted: boolean, glob: boolean): void {
    this.w.text += text; this.w.quoted ||= quoted; this.w.glob ||= glob; this.has = true;
  }
}

function lexWords(command: string): LexedWords {
  if (CONTROL.test(command)) return { ok: false, why: "control" };
  const L = new WordLexer(); let pendingOp = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const r = readQuoted(command, i, c);
      if (!r) return { ok: false, why: "quote" };
      L.add(r.body, true, false); i = r.next - 1; pendingOp = false; continue;
    }
    if (c === " " || c === "\t") { L.endWord(); continue; }
    if (c === "\n" || c === ";") { if (pendingOp) return { ok: false, why: "dangling" }; L.endSeg(false); continue; }
    if (c === "|" || c === "&") {
      const two = command[i + 1] === c;
      if (c === "&" && !two) return { ok: false, why: "background" };
      if (!L.endSeg(true)) return { ok: false, why: "empty" };
      if (two) i++;
      pendingOp = true; continue;
    }
    if (FORBIDDEN_UNQUOTED.has(c)) return { ok: false, why: c };
    L.add(c, false, GLOB_UNQUOTED.has(c)); pendingOp = false;
  }
  if (pendingOp) return { ok: false, why: "dangling" };
  L.endSeg(false);
  return L.segments.length > 0 ? { ok: true, segments: L.segments } : { ok: false, why: "empty" };
}

export function lexStrict(command: string): Lexed {
  const lexed = lexWords(command);
  return lexed.ok ? { ok: true, segments: lexed.segments.map((s) => s.map((w) => w.text)) } : lexed;
}

/**
 * A listed reader's argument forms. Fix round 1: no reader takes "any options" (macOS `wc` links libxo, and
 * `--libxo=encoder=<path>` loads a dylib, so a flag can run code). Fix round 2: libxo parses `--libxo` even after `--`, so
 * `wc` is off the list (it asks; `grep -c` counts lines). Sets follow the macOS BSD binaries; nothing GNU-only.
 * `letters`: bundleable short flags without a value. `short`: short flags with a value (next word or attached) and its shape.
 * `long` / `longValued`: exact long flags (no getopt abbreviations). `legacy`: whole-word forms like `tail -20`.
 * `dashdash`: the program treats `--` as the end of options. `operands`: whether it takes any.
 */
interface ReaderSpec {
  letters: string; short?: Readonly<Record<string, RegExp>>; long?: ReadonlySet<string>; longValued?: Readonly<Record<string, RegExp>>;
  legacy?: RegExp; dashdash: boolean; operands: boolean;
}
const ANY = /^[\s\S]+$/; const NUM = /^\d+$/; const SIGNED = /^[+-]?\d+$/; const LIST = /^[0-9,-]+$/; const WHEN = /^(never|always|auto)$/;
const READERS: Readonly<Record<string, ReaderSpec>> = {
  ls: { letters: "1ACFGHLRSTUWacdfghiklmnopqrstuwx", longValued: { "--color": WHEN }, dashdash: true, operands: true },
  cat: { letters: "belnstuv", dashdash: true, operands: true },
  head: { letters: "", short: { n: NUM, c: NUM }, legacy: /^-\d+$/, dashdash: true, operands: true },
  tail: { letters: "Ffrqv", short: { n: SIGNED, c: SIGNED, b: SIGNED }, legacy: /^-\d+[bcl]?$/, dashdash: true, operands: true },
  cut: { letters: "nsw", short: { b: LIST, c: LIST, f: LIST, d: /^[\s\S]$/ }, dashdash: true, operands: true },
  stat: { letters: "FLnqlrsx", short: { f: ANY, t: ANY }, dashdash: true, operands: true },
  pwd: { letters: "LP", dashdash: false, operands: false },
  echo: { letters: "neE", dashdash: false, operands: true },
  grep: {
    letters: "EFGHILRUabchilnoqrsvwx", short: { e: ANY, m: NUM, A: NUM, B: NUM, C: NUM },
    long: new Set(["--recursive", "--line-number", "--ignore-case", "--count", "--files-with-matches", "--files-without-match", "--invert-match",
      "--word-regexp", "--line-regexp", "--fixed-strings", "--extended-regexp", "--basic-regexp", "--only-matching", "--no-filename",
      "--with-filename", "--quiet", "--silent", "--no-messages", "--color", "--colour"]),
    longValued: { "--regexp": ANY, "--max-count": NUM, "--context": NUM, "--after-context": NUM, "--before-context": NUM, "--include": ANY,
      "--exclude": ANY, "--exclude-dir": ANY, "--color": WHEN, "--colour": WHEN },
    dashdash: true, operands: true
  },
  jq: {
    letters: "rcSesnjaCM",
    long: new Set(["--raw-output", "--compact-output", "--sort-keys", "--exit-status", "--slurp", "--null-input", "--join-output",
      "--ascii-output", "--color-output", "--monochrome-output", "--tab"]),
    longValued: { "--indent": NUM }, dashdash: true, operands: true
  }
};
/** jq's `--arg NAME VALUE` / `--argjson NAME JSON`: two values. */
const JQ_TWO_VALUES: ReadonlySet<string> = new Set(["--arg", "--argjson"]);

/** How many following words one flag word consumes, or null when it is not a listed form (or its value has the wrong shape). */
function shortArity(spec: ReaderSpec, a: string, next: Word | undefined): number | null {
  for (let i = 1; i < a.length; i++) {
    const ch = a[i]!;
    if (spec.letters.includes(ch)) continue;
    const shape = spec.short?.[ch];
    if (!shape) return null;
    const attached = a.slice(i + 1);
    if (attached !== "") return shape.test(attached) ? 0 : null;
    return next !== undefined && !next.glob && shape.test(next.text) ? 1 : null;
  }
  return 0;
}

function flagArity(spec: ReaderSpec, prog: string, a: string, rest: Word[]): number | null {
  if (spec.legacy?.test(a)) return 0;
  if (!a.startsWith("--")) return shortArity(spec, a, rest[0]);
  if (prog === "jq" && JQ_TWO_VALUES.has(a)) return rest.length >= 2 && !rest[0]!.glob && !rest[1]!.glob ? 2 : null;
  if (spec.long?.has(a)) return 0;
  const eq = a.indexOf("=");
  if (eq > 2) { const shape = spec.longValued?.[a.slice(0, eq)]; return shape?.test(a.slice(eq + 1)) ? 0 : null; }
  const shape = spec.longValued?.[a];
  return shape && rest[0] !== undefined && !rest[0].glob && shape.test(rest[0].text) ? 1 : null;
}

/**
 * Fix round 1 (minor): device files other than /dev/null ask (`cat /dev/zero` never ends; `/dev/tcp/…` is a socket in a
 * redirect). An absolute path is normalized first; a relative one that climbs (`..`) and names a `dev` segment asks too.
 */
function isDevicePath(text: string): boolean {
  if (/\/dev\/(tcp|udp)\//.test(text)) return true;
  if (text.startsWith("/")) { const n = posix.normalize(text); return (n === "/dev" || n.startsWith("/dev/")) && n !== "/dev/null"; }
  return text.includes("..") && /(^|\/)dev(\/|$)/.test(text);
}

/**
 * Every `-` word must be a listed flag (its values consumed and shape-checked). A glob before `--` asks: it could expand to
 * a planted name such as `--libxo=encoder=…` or `-delete` that the program reads as a flag. After `--` every word is an
 * operand, so a glob is only a list of names.
 */
function readerOk(prog: string, spec: ReaderSpec, args: Word[]): boolean {
  if (args.some((a) => a.text.includes("libxo"))) return false; // Fix round 2: libxo reads its flag anywhere, even after `--`
  let endOpts = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (isDevicePath(a.text)) return false;
    if (endOpts) continue;
    if (a.text === "--" && spec.dashdash) { endOpts = true; continue; }
    if (a.glob) return false;
    if (a.text.startsWith("-") && a.text !== "-") {
      const n = flagArity(spec, prog, a.text, args.slice(k + 1));
      if (n === null) return false;
      k += n; continue;
    }
    if (!spec.operands) return false;
  }
  return true;
}

const FIND_WITH_ARG: ReadonlySet<string> = new Set(["-name", "-iname", "-path", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-newer"]);

/** find: starting points, then only the listed predicates with their one value each, and `-print`. find honours no `--`. */
function findOk(args: Word[]): boolean {
  if (args.some((a) => a.glob || isDevicePath(a.text))) return false; // `find ./sub*` could expand to a planted `-delete`
  let k = 0;
  while (k < args.length && !args[k]!.text.startsWith("-")) k++;
  while (k < args.length) {
    const a = args[k]!.text;
    if (a === "-print") { k++; continue; }
    if (!FIND_WITH_ARG.has(a) || k + 1 >= args.length) return false;
    k += 2;
  }
  return true;
}

/** date: no operand, or one literal `+<format>` (no clock setting, no flags). */
function dateOk(args: Word[]): boolean {
  return args.length === 0 || (args.length === 1 && !args[0]!.glob && args[0]!.text.startsWith("+"));
}

function segmentOk(words: Word[]): boolean {
  const [prog, ...args] = words;
  // the program word must be a bare listed name: no path, no assignment, no quoting, no glob
  if (!prog || prog.quoted || prog.glob) return false;
  if (prog.text === "date") return dateOk(args);
  if (prog.text === "find") return findOk(args);
  const spec = Object.hasOwn(READERS, prog.text) ? READERS[prog.text] : undefined;
  return spec !== undefined && readerOk(prog.text, spec, args);
}

export function isReadOnlyCommand(command: string): boolean {
  const lexed = lexWords(command);
  return lexed.ok && lexed.segments.every(segmentOk);
}
