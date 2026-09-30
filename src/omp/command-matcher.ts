/** Floor B for `bash` (spec §5.5). Best effort by design (D12): a miss runs without a tap. */
export type CommandClass = { kind: "plain" } | { kind: "external_write" | "destructive"; label: string };
type Hit = { kind: "external_write" | "destructive"; label: string } | null;

interface Parsed { segments: string[][]; subs: string[] }

const SEPARATORS = new Set([";", "&", "|", "(", ")", "`", "\n"]);

/** Quote-aware split: separators only count unquoted; quoted text is inert but kept as token values. */
function parse(input: string): Parsed {
  const text = input.replace(/\\\n/g, " ");
  const segments: string[][] = []; const subs: string[] = [];
  let seg: string[] = []; let tok = ""; let has = false;
  const endTok = () => { if (has) seg.push(tok); tok = ""; has = false; };
  const endSeg = () => { endTok(); if (seg.length) segments.push(seg); seg = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "'") {
      const j = text.indexOf("'", i + 1); const end = j < 0 ? text.length : j;
      tok += text.slice(i + 1, end); has = true; i = end;
    } else if (c === '"') {
      let j = i + 1; let body = "";
      while (j < text.length && text[j] !== '"') { if (text[j] === "\\" && j + 1 < text.length) j++; body += text[j]; j++; }
      for (const m of body.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) subs.push(m[1] ?? m[2] ?? "");
      tok += body; has = true; i = j;
    } else if (c === "\\" && i + 1 < text.length) { tok += text[++i]; has = true; }
    else if (SEPARATORS.has(c)) endSeg();
    else if (/\s/.test(c)) endTok();
    else { tok += c; has = true; }
  }
  endSeg();
  return { segments, subs };
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

function gitHit(args: string[]): Hit {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) i += args[i] === "-C" || args[i] === "-c" || args[i] === "--git-dir" || args[i] === "--work-tree" ? 2 : 1;
  const sub = args[i]; const rest = args.slice(i + 1);
  if (sub === "push" && !isDry(rest)) return { kind: "external_write", label: "git push" };
  if (sub === "clean") return { kind: "destructive", label: "git clean" };
  if (sub === "reset" && rest.includes("--hard")) return { kind: "destructive", label: "git reset --hard" };
  if (sub === "checkout" && rest.includes("--")) return { kind: "destructive", label: "git checkout --" };
  return null;
}

function curlWrites(a: string[]): boolean {
  return a.some((x, i) => (x === "-X" && HTTP_METHOD.test(a[i + 1] ?? "")) || /^-X(POST|PUT|PATCH|DELETE)$/i.test(x)
    || x.startsWith("--data") || /^-d/.test(x) || x === "--upload-file" || x === "-T" || x === "-F" || x === "--form"
    || (x === "--request" && HTTP_METHOD.test(a[i + 1] ?? "")));
}

const ext = (label: string): Hit => ({ kind: "external_write", label });
const dst = (label: string): Hit => ({ kind: "destructive", label });

function commandHit(cmd: string, a: string[]): Hit {
  switch (cmd) {
    case "git": return gitHit(a);
    case "gh": return ["pr", "issue", "release", "repo"].includes(a[0] ?? "") && ["create", "merge", "delete", "edit", "comment"].includes(a[1] ?? "") ? ext("gh write") : null;
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
    case "find": return a.includes("-delete") ? dst("find -delete") : null;
    case "truncate": case "shred": return dst(cmd);
    case "diskutil": return (a[0] ?? "").startsWith("erase") ? dst("diskutil erase") : null;
    default: return cmd.startsWith("mkfs") ? dst("mkfs") : null;
  }
}

function segmentHit(tokens: string[]): Hit[] {
  const { rest, sudo } = stripPrefixes(tokens);
  const out: Hit[] = [];
  if (rest.length) {
    const cmd = (rest[0] as string).split("/").pop() as string; const args = rest.slice(1);
    out.push(commandHit(cmd, args));
    const ci = args.indexOf("-c");
    if (["bash", "sh", "zsh"].includes(cmd) && ci >= 0 && args[ci + 1] !== undefined) out.push(toHit(classifyCommand(args[ci + 1] as string)));
    if (cmd === "eval") out.push(toHit(classifyCommand(args.join(" "))));
  }
  if (sudo) out.push(ext("sudo"));
  return out;
}

const toHit = (c: CommandClass): Hit => (c.kind === "plain" ? null : c);

export function classifyCommand(command: string): CommandClass {
  const { segments, subs } = parse(command);
  const hits = [...segments.flatMap(segmentHit), ...subs.map((s) => toHit(classifyCommand(s)))].filter((h): h is NonNullable<Hit> => h !== null);
  return hits.find((h) => h.kind === "destructive") ?? hits[0] ?? { kind: "plain" };
}
