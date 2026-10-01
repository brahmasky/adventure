/** Floor B for `bash` (spec §5.5). Best effort by design (D12): a miss runs without a tap. */
export type CommandClass = { kind: "plain" } | { kind: "external_write" | "destructive"; label: string };
type Hit = { kind: "external_write" | "destructive"; label: string } | null;
const ext = (label: string): Hit => ({ kind: "external_write", label });
const dst = (label: string): Hit => ({ kind: "destructive", label });

/**
 * `unterminated`: a heredoc whose terminator line never came; its "body" may be code, so the command asks.
 * `piped[k]`: segment k reads the previous segment's output (`|` or `|&`, never `||`).
 */
interface Parsed { segments: string[][]; piped: boolean[]; subs: string[]; unterminated: boolean }

const SEPARATORS = new Set([";", "&", "|", "(", ")", "`", "\n"]);

interface Heredoc { word: string; dash: boolean }

/** Reads an unambiguous `<<[-]WORD` / `<<'WORD'` / `<<"WORD"` at i (word fully quoted or bare, then a delimiter); anything else is not a heredoc. */
function readHeredocStart(text: string, i: number): { doc: Heredoc; end: number } | null {
  const m = /^<<(-?)[ \t]*(?:([A-Za-z0-9_.-]+)|'([A-Za-z0-9_.-]+)'|"([A-Za-z0-9_.-]+)")(?=[\s;|&<>]|$)/.exec(text.slice(i, i + 200));
  const word = m ? (m[2] ?? m[3] ?? m[4]) : undefined;
  return m && word ? { doc: { word, dash: m[1] === "-" }, end: i + m[0].length } : null;
}

/** Skips past the terminator line of each pending heredoc (the body is data, never classified); `open` if one never ends. */
function skipHeredocBodies(text: string, from: number, pending: Heredoc[]): { pos: number; open: boolean } {
  let pos = from; let open = false;
  for (const h of pending.splice(0)) {
    let found = false;
    while (pos < text.length && !found) {
      const nl = text.indexOf("\n", pos); const end = nl < 0 ? text.length : nl;
      const line = text.slice(pos, end); pos = nl < 0 ? text.length : nl + 1;
      found = (h.dash ? line.trim() : line.trimEnd()) === h.word;
    }
    open ||= !found;
  }
  return { pos, open };
}

/** bash deletes a backslash-newline outright, even inside a word (`gi\<newline>t push` runs git push). */
const joinContinuations = (text: string): string => text.replace(/\\\n/g, "");

/** Every line on its own. Never skips heredoc bodies: a heredoc misparse can then only make the matcher ask more, not less. */
function codeLines(text: string): string[] {
  return joinContinuations(text).split("\n");
}

/** Quote-aware split: separators only count unquoted; quoted text is inert but kept as token values. */
function parse(input: string): Parsed {
  const text = joinContinuations(input);
  const segments: string[][] = []; const piped: boolean[] = []; const subs: string[] = []; let unterminated = false;
  let seg: string[] = []; let tok = ""; let has = false; let pipeIn = false;
  const endTok = () => { if (has) seg.push(tok); tok = ""; has = false; };
  const endSeg = () => { endTok(); if (seg.length) { segments.push(seg); piped.push(pipeIn); pipeIn = false; } seg = []; };
  const pending: Heredoc[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "#" && !has) { const nl = text.indexOf("\n", i); i = nl < 0 ? text.length : nl - 1; }
    else if (text.startsWith("<<<", i)) { endTok(); seg.push("<<<"); i += 2; } // a here-string: its own token, even glued (`bash<<<'…'`)
    else if (c === "<" && !has && text[i + 1] === "<" && text[i + 2] !== "<" && text[i - 1] !== "<") {
      const h = readHeredocStart(text, i);
      if (h) { pending.push(h.doc); endTok(); i = h.end - 1; } else { tok += c; has = true; }
    } else if (c === "\n" && pending.length) {
      endSeg(); const skip = skipHeredocBodies(text, i + 1, pending); unterminated ||= skip.open; i = skip.pos - 1;
    }
    else if (c === "'") {
      const j = text.indexOf("'", i + 1); const end = j < 0 ? text.length : j;
      tok += text.slice(i + 1, end); has = true; i = end;
    } else if (c === '"') {
      let j = i + 1; let body = "";
      while (j < text.length && text[j] !== '"') { if (text[j] === "\\" && j + 1 < text.length) j++; body += text[j]; j++; }
      for (const m of body.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) subs.push(m[1] ?? m[2] ?? "");
      tok += body; has = true; i = j;
    } else if (c === "\\" && i + 1 < text.length) { tok += text[++i]; has = true; }
    else if (SEPARATORS.has(c)) {
      endSeg();
      if (c === "|" && text[i + 1] === "|") i++; // `||` runs the next command, it does not feed it
      else if (c === "|") { pipeIn = true; if (text[i + 1] === "&") i++; }
    }
    else if (/\s/.test(c)) endTok();
    else { tok += c; has = true; }
  }
  endSeg();
  return { segments, piped, subs, unterminated: unterminated || pending.length > 0 };
}

const WRAPPERS_WITH_ARG = new Set(["-n", "-I", "-P", "-L", "-d", "-s", "-u", "-g"]);
const TRANSPARENT = new Set(["command", "exec", "nohup", "time", "env", "xargs", "then", "do", "else", "if", "while", "!", "{"]);

/** Strip command-position prefixes (sudo, env VAR=…, xargs opts, …); returns the real command tokens. */
function stripPrefixes(tokens: string[]): { rest: string[]; sudo: boolean } {
  let i = 0; let sudo = false;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (/^[A-Za-z_]\w*=/.test(t)) i++;
    else if (t === "sudo" || TRANSPARENT.has(t)) {
      if (t === "sudo") sudo = true;
      i++;
      while (i < tokens.length && (tokens[i] as string).startsWith("-")) i += WRAPPERS_WITH_ARG.has(tokens[i] as string) ? 2 : 1;
    } else break;
  }
  return { rest: tokens.slice(i), sudo };
}

const isDry = (a: string[]) => a.some((x) => x === "--dry-run" || x === "-n");
const HTTP_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;

const GIT_OPTS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
const isAlias = (x: string | undefined) => /^alias\./i.test(x ?? "");

/** A git alias can be any command (`!curl …`) or a push under Paco's credentials: defining or using one asks (adversarial I2). */
function gitHit(args: string[]): Hit {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    if (args[i] === "-c" && isAlias(args[i + 1])) return ext("git alias");
    i += GIT_OPTS_WITH_ARG.has(args[i] as string) ? 2 : 1;
  }
  const sub = args[i]; const rest = args.slice(i + 1);
  if (sub === "config" && rest.some(isAlias)) return ext("git alias");
  if (sub === "push" && !isDry(rest)) return { kind: "external_write", label: "git push" };
  if (sub === "branch" && forceDelete(rest)) return dst("git branch -D");
  if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return dst(`git stash ${rest[0]}`);
  if (sub === "clean") return { kind: "destructive", label: "git clean" };
  if (sub === "reset" && rest.includes("--hard")) return { kind: "destructive", label: "git reset --hard" };
  if (sub === "checkout" && rest.includes("--")) return { kind: "destructive", label: "git checkout --" };
  return null;
}

/** `git branch -D`, `-Df`, `--delete --force`, `-d -f`: deletes an unmerged branch. A plain `-d` refuses unmerged work. */
function forceDelete(a: string[]): boolean {
  const force = a.some((x) => x === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x));
  return a.some((x) => /^-[a-zA-Z]*D[a-zA-Z]*$/.test(x)) || (force && a.some((x) => x === "--delete" || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(x)));
}

function curlWrites(a: string[]): boolean {
  return a.some((x, i) => (x === "-X" && HTTP_METHOD.test(a[i + 1] ?? "")) || /^-X(POST|PUT|PATCH|DELETE)$/i.test(x)
    || x.startsWith("--data") || x.startsWith("--json") || /^-d/.test(x) || x.startsWith("--upload-file") || x === "-T" || x === "-F"
    || x.startsWith("--form") || (x === "--request" && HTTP_METHOD.test(a[i + 1] ?? "")) || /^--request=(POST|PUT|PATCH|DELETE)$/i.test(x));
}

/** `gh api` writes with any method but GET, or with a request body (-f/-F/--field/--raw-field/--input). */
function ghApiWrites(a: string[]): boolean {
  return a.some((x, i) => ((x === "-X" || x === "--method") && !/^GET$/i.test(a[i + 1] ?? "GET")) || /^-X(?!GET$)[A-Za-z]+$/i.test(x)
    || /^--method=(?!GET$)/i.test(x) || /^-[fF]/.test(x) || /^--(raw-)?field(=|$)/.test(x) || /^--input(=|$)/.test(x));
}

function ghHit(a: string[]): Hit {
  if (a[0] === "api") return ghApiWrites(a.slice(1)) ? ext("gh api write") : null;
  return ["pr", "issue", "release", "repo"].includes(a[0] ?? "") && ["create", "merge", "delete", "edit", "comment"].includes(a[1] ?? "") ? ext("gh write") : null;
}

const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Each command `find` runs: the tokens after -exec/-execdir/-ok/-okdir up to `;` or `+`. */
function findExecs(a: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < a.length; i++) {
    if (!FIND_EXEC.has(a[i] as string)) continue;
    const end = a.findIndex((x, j) => j > i && (x === ";" || x === "+"));
    out.push(a.slice(i + 1, end < 0 ? a.length : end)); i = end < 0 ? a.length : end;
  }
  return out;
}

function findHit(a: string[]): Hit {
  if (a.includes("-delete")) return dst("find -delete");
  return findExecs(a).some((cmd) => /^(rm|unlink|rmdir)$/.test((cmd[0] ?? "").split("/").pop() as string)) ? dst("find -exec rm") : null;
}

function commandHit(cmd: string, a: string[]): Hit {
  switch (cmd) {
    case "git": return gitHit(a);
    case "gh": return ghHit(a);
    case "curl": case "http": case "https": case "httpie": return curlWrites(a) ? ext("HTTP write") : null;
    case "wget": return a.some((x) => /^--(post|method|body)/.test(x)) ? ext("HTTP write") : null;
    case "mail": case "mailx": case "sendmail": return ext("send mail");
    case "osascript": return ext("AppleScript");
    case "ssh": case "scp": case "sftp": return ext("remote copy");
    case "rsync": return a.some((x) => !x.startsWith("-") && x.includes(":")) ? ext("remote copy") : null;
    case "npm": case "cargo": return a[0] === "publish" ? ext("publish package") : null;
    case "twine": case "pip": return a[0] === "upload" ? ext("publish package") : null;
    case "launchctl": case "crontab": return ext(cmd);
    case "rm": return a.some((x) => x === "--recursive" || x === "--force" || /^-[a-zA-Z]*[rRf][a-zA-Z]*$/.test(x)) ? dst("recursive/forced delete") : null;
    case "find": return findHit(a);
    case "truncate": case "shred": return dst(cmd);
    case "diskutil": return (a[0] ?? "").startsWith("erase") ? dst("diskutil erase") : null;
    default: return cmd.startsWith("mkfs") ? dst("mkfs") : null;
  }
}

/** The command string of `bash|sh|zsh -<flags>c <string>` (`-c`, `-lc`, `-euxc`, `-o pipefail -c`): the first arg after the c flag. */
function shellPayload(args: string[]): string | undefined {
  const ci = args.findIndex((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
  return ci >= 0 ? args.slice(ci + 1).find((x) => !x.startsWith("-")) : undefined;
}

const SHELLS = new Set(["bash", "sh", "zsh"]);
/** The approval-card label for a shell fed a script the matcher cannot read. */
export const UNSEEN_SCRIPT_LABEL = "unseen shell script";

/**
 * What a shell runs: its -c string or a literal here-string is classified as a command line; a script it reads from a
 * pipe, a `<` redirect, a process substitution or an expanded here-string cannot be seen, so it asks (security N4).
 * `bash file.sh` stays plain: best effort (D12), and the file was written where floor A already applied.
 */
function shellHit(args: string[], depth: number, piped: boolean): Hit {
  const payload = shellPayload(args);
  if (payload !== undefined) return toHit(classify(payload, depth + 1));
  const hs = args.indexOf("<<<");
  if (hs >= 0) { const body = args[hs + 1] ?? ""; return /[$`]/.test(body) ? ext(UNSEEN_SCRIPT_LABEL) : toHit(classify(body, depth + 1)); }
  const fromStdin = args.some((x) => /^-[A-Za-z]*s[A-Za-z]*$/.test(x)) || !args.some((x) => !x.startsWith("-"));
  return args.some((x) => x.startsWith("<")) || (piped && fromStdin) ? ext(UNSEEN_SCRIPT_LABEL) : null;
}

const ENV_OPTS_WITH_ARG = new Set(["-u", "--unset", "-C", "--chdir", "-P"]);

/** `env -S 'cmd args'` (`-S<str>`, `--split-string[=]<str>`) runs its string as a command line (security N4). */
function envSplitString(tokens: string[]): string | undefined {
  const at = tokens.findIndex((t) => t.split("/").pop() === "env");
  for (let j = at + 1; at >= 0 && j < tokens.length && (tokens[j] as string).startsWith("-"); j++) {
    const t = tokens[j] as string; const tail = tokens.slice(j + 1);
    if (t === "--split-string") return tail.join(" ");
    if (t.startsWith("--split-string=")) return [t.slice("--split-string=".length), ...tail].join(" ");
    const m = /^-[A-Za-z]*S(.*)$/.exec(t);
    if (m) return [m[1] ?? "", ...tail].filter((x) => x.length > 0).join(" ");
    if (ENV_OPTS_WITH_ARG.has(t)) j++;
  }
  return undefined;
}

function segmentHit(tokens: string[], depth: number, piped = false): Hit[] {
  const { rest, sudo } = stripPrefixes(tokens);
  const out: Hit[] = [];
  if (rest.length) {
    const cmd = (rest[0] as string).split("/").pop() as string; const args = rest.slice(1);
    out.push(commandHit(cmd, args));
    if (SHELLS.has(cmd)) out.push(shellHit(args, depth, piped));
    if (cmd === "find") out.push(...findExecs(args).flatMap((sub) => segmentHit(sub, depth + 1)));
    if (cmd === "eval") out.push(toHit(classify(args.join(" "), depth + 1)));
  }
  const split = envSplitString(tokens);
  if (split !== undefined) out.push(toHit(classify(split, depth + 1)));
  if (sudo) out.push(ext("sudo"));
  return out;
}

const toHit = (c: CommandClass): Hit => (c.kind === "plain" ? null : c);

const MAX_DEPTH = 8;
const RANK = { plain: 0, external_write: 1, destructive: 2 } as const;
type Found = NonNullable<Hit>;

/** `whole`: the full input (not one line of it), where an unterminated heredoc means the rest may be code. */
function hitsOf(text: string, depth: number, whole: boolean): Found[] {
  const { segments, piped, subs, unterminated } = parse(text);
  const hits = [...segments.flatMap((sg, k) => segmentHit(sg, depth, piped[k] === true)), ...subs.map((sub) => toHit(classify(sub, depth + 1)))];
  if (whole && unterminated) hits.push(dst("unterminated heredoc"));
  return hits.filter((h): h is Found => h !== null);
}

/**
 * The strictest kind over the whole input and, line by line, every line on its own (an apostrophe in a comment
 * must not hide later lines). The label lists EVERY distinct match, strictest first: the approval card must not
 * show only a decoy (security I1).
 */
function classify(text: string, depth: number): CommandClass {
  if (depth > MAX_DEPTH) return { kind: "destructive", label: "nesting too deep" };
  const lines = codeLines(text);
  const found = [...hitsOf(text, depth, true), ...(lines.length > 1 ? lines.flatMap((line) => hitsOf(line, depth, false)) : [])];
  if (found.length === 0) return { kind: "plain" };
  const kind = found.some((h) => h.kind === "destructive") ? "destructive" : "external_write";
  const labels = [...new Set([...found].sort((a, b) => RANK[b.kind] - RANK[a.kind]).flatMap((h) => h.label.split(", ")))];
  return { kind, label: labels.join(", ") };
}

export function classifyCommand(command: string): CommandClass {
  try { return classify(command, 0); } catch { return { kind: "destructive", label: "unparseable" }; }
}
