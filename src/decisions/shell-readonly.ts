/**
 * The hostile read-only list (spec §7.2, codex B28, senior B10). At hostile a shell command runs without a tap only if every
 * segment is a listed program in its listed argument forms. It is an allowlist that fails closed: tool.shell_netread is
 * best effort, this list is the real gate. A strict lexer of its own (command-matcher drops prefixes and wrappers): any
 * `NAME=value` prefix, wrapper, redirect, substitution, background `&`, comment, escape, control character or token it
 * cannot lex is refused, so the command asks. Pipes, `;`, `&&` and `||` are allowed only between listed segments.
 * The command runs under `/bin/bash -c` (non-interactive: no history or alias expansion; `shell-wrapper.sh`).
 */
export type Lexed = { ok: true; segments: string[][] } | { ok: false; why: string };
/** One word: its text after quote removal, whether any quote touched it, and whether the shell expands it (glob, tilde). */
interface Word { text: string; quoted: boolean; expands: boolean }
type LexedWords = { ok: true; segments: Word[][] } | { ok: false; why: string };

const FORBIDDEN_UNQUOTED = new Set(["$", "`", "<", ">", "\\", "(", ")", "{", "}", "!", "#"]);
const EXPANDS_UNQUOTED = new Set(["*", "?", "[", "~"]);
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function readQuoted(s: string, i: number, q: "'" | '"'): { body: string; next: number } | null {
  const end = s.indexOf(q, i + 1);
  if (end < 0) return null;
  const body = s.slice(i + 1, end);
  // inside double quotes bash still expands `$`, backticks and escapes; refuse `!` too (history expansion where it is on)
  return q === '"' && /[$`\\!]/.test(body) ? null : { body, next: end + 1 };
}

class WordLexer {
  segments: Word[][] = []; seg: Word[] = []; w: Word = { text: "", quoted: false, expands: false }; has = false;
  endWord(): void { if (this.has) this.seg.push(this.w); this.w = { text: "", quoted: false, expands: false }; this.has = false; }
  /** `strict`: an operator (`|`, `&&`, `||`) with nothing before it is a syntax error bash would refuse; refuse it too. */
  endSeg(strict: boolean): boolean {
    this.endWord();
    if (this.seg.length === 0) return !strict;
    this.segments.push(this.seg); this.seg = [];
    return true;
  }
  add(text: string, quoted: boolean, expands: boolean): void {
    this.w.text += text; this.w.quoted ||= quoted; this.w.expands ||= expands; this.has = true;
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
    L.add(c, false, EXPANDS_UNQUOTED.has(c)); pendingOp = false;
  }
  if (pendingOp) return { ok: false, why: "dangling" };
  L.endSeg(false);
  return L.segments.length > 0 ? { ok: true, segments: L.segments } : { ok: false, why: "empty" };
}

export function lexStrict(command: string): Lexed {
  const lexed = lexWords(command);
  return lexed.ok ? { ok: true, segments: lexed.segments.map((s) => s.map((w) => w.text)) } : lexed;
}

/** Spec §7.2: any options, path operands. None of these has a flag that writes or runs a program (BSD or GNU). */
const ANY_OPTIONS: ReadonlySet<string> = new Set(["ls", "cat", "head", "tail", "wc", "cut", "stat", "pwd", "echo"]);

/** Flags: `bare` take no value (and may be bundled when single letters), `valued` consume the next word. */
interface FlagSpec { bare: ReadonlySet<string>; letters: string; valued: ReadonlySet<string>; longValued: ReadonlySet<string> }

const GREP: FlagSpec = {
  letters: "EFGHILRUabchilnoqrsvwx",
  bare: new Set(["--recursive", "--line-number", "--ignore-case", "--count", "--files-with-matches", "--files-without-match", "--invert-match",
    "--word-regexp", "--line-regexp", "--fixed-strings", "--extended-regexp", "--basic-regexp", "--only-matching", "--no-filename",
    "--with-filename", "--quiet", "--silent", "--no-messages", "--color", "--colour"]),
  valued: new Set(["-e", "-m", "-A", "-B", "-C", "--regexp", "--max-count"]),
  longValued: new Set(["--regexp", "--max-count", "--context", "--after-context", "--before-context", "--include", "--exclude", "--exclude-dir",
    "--color", "--colour"])
};
const JQ: FlagSpec = {
  letters: "rcSesnjaCM",
  bare: new Set(["--raw-output", "--compact-output", "--sort-keys", "--exit-status", "--slurp", "--null-input", "--join-output",
    "--ascii-output", "--color-output", "--monochrome-output", "--tab"]),
  valued: new Set(["--indent"]),
  longValued: new Set()
};
/** jq's `--arg NAME VALUE` / `--argjson NAME JSON`: two values. */
const JQ_TWO_VALUES: ReadonlySet<string> = new Set(["--arg", "--argjson"]);

/** How many following words a flag consumes, or null when the flag is not on the list. */
function flagArity(spec: FlagSpec, a: string): number | null {
  if (spec.valued.has(a)) return 1;
  if (spec.bare.has(a)) return 0;
  const eq = a.indexOf("=");
  if (a.startsWith("--") && eq > 2) return spec.longValued.has(a.slice(0, eq)) ? 0 : null;
  if (/^-[ABCm]\d+$/.test(a) && spec === GREP) return 0;
  if (/^-[A-Za-z]+$/.test(a) && [...a.slice(1)].every((ch) => spec.letters.includes(ch))) return 0;
  return null;
}

/** grep and jq: every `-` word is a listed flag (its values consumed), every other word is a pattern, filter or path. */
function flagsOk(spec: FlagSpec, args: Word[]): boolean {
  if (args.some((a) => a.expands)) return false; // a glob or tilde could expand into a planted name that reads as a flag
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!.text;
    if (!a.startsWith("-")) continue;
    const n = spec === JQ && JQ_TWO_VALUES.has(a) ? 2 : flagArity(spec, a);
    if (n === null || k + n >= args.length) return false; // an unlisted flag, or a flag missing its value
    k += n;
  }
  return true;
}

const FIND_WITH_ARG: ReadonlySet<string> = new Set(["-name", "-iname", "-path", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-newer"]);

/** find: starting points, then only the listed predicates with their one value each, and `-print`. */
function findOk(args: Word[]): boolean {
  if (args.some((a) => a.expands)) return false; // `find ./sub*` could expand to a planted file named `-delete`
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

/** date: no operand, or one `+<format>` (no clock setting, no flags). */
function dateOk(args: Word[]): boolean {
  return args.length === 0 || (args.length === 1 && !args[0]!.expands && args[0]!.text.startsWith("+"));
}

function segmentOk(words: Word[]): boolean {
  const [prog, ...args] = words;
  // the program word must be a bare listed name: no path, no assignment, no quoting, no expansion
  if (!prog || prog.quoted || prog.expands) return false;
  if (args.some((a) => /\/dev\/(tcp|udp)\//.test(a.text))) return false;
  if (ANY_OPTIONS.has(prog.text)) return true;
  if (prog.text === "date") return dateOk(args);
  if (prog.text === "grep") return flagsOk(GREP, args);
  if (prog.text === "jq") return flagsOk(JQ, args);
  if (prog.text === "find") return findOk(args);
  return false;
}

export function isReadOnlyCommand(command: string): boolean {
  const lexed = lexWords(command);
  return lexed.ok && lexed.segments.every(segmentOk);
}
