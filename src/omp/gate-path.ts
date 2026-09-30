import { isAbsolute, join, resolve as resolvePath } from "node:path";

/**
 * The gate's view of a built-in read/edit/write path, canonicalised as omp 18.4.4 resolves it (security C1):
 * pi-coding-agent src/tools/path-utils.ts expandPath + resolveToCwd, plus the read tool's own peeling
 * (`path:sel`, `archive:inner`, `image?question`, `a;b` lists, split-then-resolve). Every plausible target is
 * returned; the caller denies when ANY is denied. Forms omp handles that this does not model are refused
 * whole as bad_path (fail closed): control chars, backslashes, other `@`/`:` prefixes, internal URLs.
 */
export type GateTargets = { ok: true; targets: string[] } | { ok: false; reason: "missing_path" | "bad_path" | "url_read" };

export const MAX_GATE_TARGETS = 256;
const UNICODE_SPACES = /[  -   　]/g;
/** Internal URLs and their single-slash aliases (`local:/x`), after any `@`/`:` prefix. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\//i;

type Expanded = { abs: string } | { bad: "bad_path" | "url_read" };

/** omp expandPath: a stray leading `:` (before `/`, `~`, `./`, `../`) or `@` (before `/`, `~`) goes; `~`, `~/x`, `~x` expand. */
function expand(raw: string, home: string, cwd: string): Expanded {
  let p = raw.replace(UNICODE_SPACES, " ");
  if (p.startsWith(":")) {
    if (!/^:(?=[/~]|\.\.?\/)/.test(p)) return { bad: "bad_path" };
    p = p.slice(1);
  } else if (p.startsWith("@")) {
    if (SCHEME.test(p.slice(1))) return { bad: "url_read" }; // omp's `@` shorthand for an internal URL
    if (!/^@(?=[/~])/.test(p)) return { bad: "bad_path" };
    p = p.slice(1);
  }
  if (p.startsWith("@") || p.startsWith(":")) return { bad: "bad_path" };
  if (SCHEME.test(p)) return { bad: "url_read" };
  if (p === "~") p = home;
  else if (p.startsWith("~")) p = join(home, p.slice(p.startsWith("~/") ? 2 : 1));
  if (/^\/+$/.test(p)) return { abs: cwd };
  return { abs: isAbsolute(p) ? p : resolvePath(cwd, p) };
}

/** The raw string and what omp may peel from it: surrounding space and double quotes, NFC/NFD spellings. */
function spellings(raw: string): string[] {
  const t = raw.trim();
  const unq = t.length > 1 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  return [...new Set([raw, t, unq].flatMap((s) => [s, s.normalize("NFC"), s.normalize("NFD")]))];
}

/** Every prefix before a `:`, `?` or `#` (selectors, archive members, image questions) and every `;`/`,`/space-separated part. */
function peels(s: string): string[] {
  const out = [s];
  for (let i = 1; i < s.length; i++) if (s[i] === ":" || s[i] === "?" || s[i] === "#") out.push(s.slice(0, i));
  const parts = s.split(/[;,\s]+/).filter((x) => x.length > 0);
  if (parts.length > 1) for (const part of parts) out.push(part, ...peels(part).slice(1));
  return out;
}

export function gateTargets(raw: string, home: string, cwd: string): GateTargets {
  if (raw.trim() === "") return { ok: false, reason: "missing_path" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return { ok: false, reason: "bad_path" };
  const candidates = [...new Set(spellings(raw).flatMap(peels))];
  if (candidates.length > MAX_GATE_TARGETS) return { ok: false, reason: "bad_path" };
  const targets = new Set<string>();
  for (const c of candidates) {
    const e = expand(c, home, cwd);
    if ("bad" in e) return { ok: false, reason: e.bad };
    targets.add(e.abs);
  }
  return { ok: true, targets: [...targets] };
}
