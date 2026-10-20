import { resolve } from "node:path";
import { REDACTED_PLACEHOLDER } from "../config/secret-broker.js";
import { isCredentialPath } from "../omp/protected-paths.js";

/**
 * The judge redactor (spec §7.0), in the spec's order on the WHOLE text before any split (controller ruling 1, Rev 4):
 * (a) known values — the broker's, located through its own literal redactor, plus values the caller holds (the bridge
 * token, this turn's extracted codes and links); (b) named secrets — PEM blocks, cookie-jar values, and ANY value after a
 * secret-named key, through its delimiter, whatever its shape and length (I2, I3); (c) shapes — Bearer/Basic credentials,
 * provider prefixes, URL userinfo, token query values and fragments, opaque path tokens, hex runs, opaque base64 runs (never
 * a word-bearing run, plan S9). Every mask is an atomic part: `splitEgress` cuts passages on the masked text, never inside
 * a mask, and each passage keeps its raw twin (the local floor and content check) and its planner copy.
 *
 * INVARIANT I1 (Rev 6): the planner never receives, as judged, text Jev did not see. Every mask is mirrored into the planner
 * copy (`Part.mirror`) EXCEPT a shape or value mask of a run that cannot carry readable text — hex-only (SHAs, hashes, UUIDs
 * with or without dashes) or digit-only (one-time codes) — which the planner keeps raw (R2). Base64 and mixed letter/digit
 * runs are mirrored. One named exception (R3): in the mail side channel (`linkTokens`), the code-extracted link field reaches
 * the planner raw — structured URLs, not free text — while Jev sees its opaque segments masked.
 *
 * Accepted residual (ADR 0030, fuzzed 2026-10-13: 50 000 random tokens per alphabet in each of five contexts — plain text,
 * a URL path, a query value, after a non-secret name, behind a word prefix): an unknown token with no recognisable name,
 * shape or content can pass; the measured counts are in the plan (Task 5 Step 3 note) and the ADR.
 */
export const SECRET_MASK = "‹secret›";
export const KEY_MASK = "‹private key›";
/** The broker's placeholder, used only to locate its spans (never sent: a located span becomes SECRET_MASK). */
export const BROKER_PLACEHOLDER = REDACTED_PLACEHOLDER;
/** I3: a named value longer than this has no delimiter in reach — its passage is blocked (`long_named`). */
export const NAMED_MAX = 4_096;
export interface RedactOptions {
  /** The broker's literal redactor (`RunStore.redactSecretValues`); its spans are found without the values leaving it. */
  brokerRedact?: (s: string) => string;
  /** Values the caller itself holds: the per-spawn bridge token (senior S-R3-2). */
  known?: readonly string[];
  /** This turn's extracted codes and links (spec §7.0 rule 5). */
  extracted?: readonly string[];
  /** The extract channel (I4): every link path segment and query value that is not a plain word or file name is masked. */
  linkTokens?: boolean;
}
/** One piece of the text: masked (atomic; `mirror`: the planner gets the mask too), settled (kept by a rule) or open. */
export interface Part { raw: string; out: string; mask: boolean; mirror?: boolean; settled?: true; oversize?: true; rewrite?: true; block?: EgressBlock }
/** `raw`: the floor and content check; `out`: what leaves for Jev; `planner`: what the model reads (I1). */
export interface EgressPassage { raw: string; out: string; planner: string; block?: EgressBlock; masked?: number }

/** I2: a key is secret-named when one of its segments (split on `_ - .` and camelCase) is exactly one of these words. */
const SECRET_WORDS = new Set(["pass", "passwd", "password", "passphrase", "pwd", "secret", "token", "key", "auth", "authorization",
  "cookie", "credential", "credentials", "signature", "apikey", "accesstoken", "authtoken", "secretkey", "privatekey", "clientsecret",
  "refreshtoken", "accesskey", "sessiontoken", "sid", "csrf", "xsrf", "jwt", "bearer"]);
/** R1: `session` is secret only beside `id`, `key` or `token` (adjacent whole segments), so `session_message` stays visible. */
const SESSION_PAIR = new Set(["id", "key", "token"]);
export function secretKey(key: string): boolean {
  const segs = key.split(/[^A-Za-z0-9]+/).flatMap((s) => s.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).map((s) => s.toLowerCase()).filter(Boolean);
  return segs.some((s, k) => SECRET_WORDS.has(s) || (s === "session" && SESSION_PAIR.has(segs[k + 1] ?? "")));
}
/**
 * A key followed by `:` or `=`; the key may be quoted (JSON). The value's extent is found by `namedValue`. At line start the key
 * may sit behind omp's read prefix `N:` (live gate 2b-i case 9: `2:api_key: …` masked nothing before).
 */
const KEY_AT = /(?<=^(?:\d{1,7}(?:-\d{1,7})?[:|])?|[\s;{,(&?[])(["']?)([A-Za-z][A-Za-z0-9_.-]*)\1\s*([:=])[ \t]*/gm;
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const COOKIE_LINE = /^((?:[^\t\n]*\t){6})([^\t\n]+)$/gm;
const AUTH_SCHEME = /\b(Bearer\s+|Basic\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const SHAPES: readonly RegExp[] = [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bAIza[0-9A-Za-z_-]{35}\b/g, /\bwhsec_[A-Za-z0-9]{16,}/g];
/** The scheme is bounded ({0,31}): unbounded, a long `[a-z0-9+.-]` run backtracked quadratically (security final M-1). */
const URL_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#@]+@)?([^\s/?#\]]+)([^\s?#\]]*)(\?[^\s#\]]*)?(#[^\s\]]*)?/gi;
const PATH_RE = /(?<![\w+/=-])(?:~|\.\.?)?\/[\w.@%+:=-]+(?:\/[\w.@%+:=-]+)*/g;
const HEX_RUN = /\b[A-Fa-f0-9]{32,}\b/g;
const B64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g;
/** A path segment's run (no `/`): a Telegram `bot<id>:<token>`, a webhook token. */
const SEG_RUN = /[A-Za-z0-9+_=:-]{20,}/g;
/** A standard-alphabet base64 run inside a path, `/` included (W-R3-1). */
const STD_RUN = /[A-Za-z0-9+=_-][A-Za-z0-9+/=_-]{31,}/g;
const ROUTE = /^[A-Za-z][a-z]{2,}(?:\.[a-z]+)?$/;

const WORD = /^(?:[A-Z]?[a-z]+|[A-Z]{2,})$/;
const camel = (p: string): string[] => p.split(/(?<=[a-z])(?=[A-Z])/);
const caseFlips = (s: string): number => {
  let n = 0;
  for (let i = 1; i < s.length; i++) { const a = s[i - 1]!; const b = s[i]!; if (/[A-Za-z]/.test(a) && /[A-Za-z]/.test(b) && (a === a.toUpperCase()) !== (b === b.toUpperCase())) n++; }
  return n;
};
/** A part of 8+ characters that is itself token-like: two digit groups, or three camel pieces of one or two letters (W-R4-2). */
const opaquePart = (p: string): boolean => p.length >= 8 && ((p.match(/\d+/g)?.length ?? 0) >= 2 || camel(p.replace(/\d/g, "")).filter((x) => x.length <= 2).length >= 3);
/** Separator or camel words: ≥ 3 parts, ≥ 80% natural-case words, no token-like part. `/` `+` separate only beside `- _ .`. */
export function proseRun(s: string): boolean {
  const sep = /[-_.]/.test(s) ? /[-_./+:]+/ : /[.:]+/;
  const raw = s.split(sep).filter(Boolean);
  const parts = raw.flatMap(camel);
  const words = parts.filter((p) => WORD.test(p) && (p.length >= 3 || /^[a-z]+$/.test(p)));
  return parts.length >= 3 && words.length >= 0.8 * parts.length && !raw.some(opaquePart);
}
/** Word-bearing (senior re-review B2): separated words only, ≥ 3 of ≥ 4 letters, ≥ 60% of the run, no token-like part. */
export function wordBearing(s: string): boolean {
  if (!/[-_.]/.test(s) || s.split(/[-_./+:=]+/).some(opaquePart)) return false;
  const words = s.split(/[-_./+:0-9=]+/).flatMap(camel).filter((p) => WORD.test(p) && p.length >= 4);
  return words.length >= 3 && words.join("").length >= 0.6 * s.length;
}
export const isProse = (s: string): boolean => proseRun(s) || wordBearing(s);
/** Lowercase dictionary-ish pieces of 4+ letters between `- _ .` (a slug's words). */
const slugWords = (s: string): string[] => s.split(/[-_.]/).filter((p) => p.length >= 4 && /^[a-z]+$/.test(p) && linkWord(p));
/** R2, I1's only exception: a run that cannot carry readable text — hex-only (dashes allowed: UUIDs) or digit-only. */
const unreadable = (s: string): boolean => /^[0-9A-Fa-f-]+$/.test(s);
/**
 * An opaque run: at least `min` long, letters plus a digit, base64's `+` `/`, or random-looking case once slug words are set
 * aside (W-R4-2: a token behind `release_notes_archive_` must not be diluted); and never prose.
 */
export function opaqueRun(s: string, min: number): boolean {
  const core = s.split(/[-_.]/).filter((p) => !slugWords(p).length).join("");
  return s.length >= min && /[A-Za-z]/.test(s) && (/[0-9+/]/.test(s) || caseFlips(core) >= core.length / 4) && !isProse(s);
}
const stdOpaque = (s: string): boolean => /[\d+]/.test(s) && caseFlips(s) >= s.length / 8 && !isProse(s);
const LINK_WORD = /^[A-Za-z]+(?:[-_][A-Za-z]+)*(?:\.[A-Za-z0-9]{1,5})?$/;
/** I4: a plain dictionary-ish word or file name — letters only; each piece of 3+ letters ≤ 14 long, with a vowel, no 5-consonant run, natural case. */
export function linkWord(seg: string): boolean {
  if (!LINK_WORD.test(seg)) return false;
  const pieces = seg.replace(/\.[A-Za-z0-9]{1,5}$/, "").split(/[-_]/).flatMap(camel);
  return pieces.every((w) => w.length <= 2 || (w.length <= 14 && /[aeiouy]/i.test(w) && !/[^aeiouy]{5,}/i.test(w) && /^(?:[A-Z]?[a-z]+|[A-Z]{2,4})$/.test(w)));
}

const keep = (raw: string): Part => ({ raw, out: raw, mask: false });
const masked = (raw: string, mirror: boolean, out = SECRET_MASK): Part => ({ raw, out, mask: true, mirror });
/** Jev reads `out` (a decoded link piece), the planner the raw bytes; atomic like a mask (Rev 9, ruling 3a). */
const rewrite = (raw: string, out: string): Part => ({ raw, out, mask: true, mirror: false, rewrite: true });
/** A shape or value mask: mirrored unless the run is hex- or digit-only (I1, R2). */
const shaped = (raw: string): Part => masked(raw, !unreadable(raw));
/** In the extract channel a mask is a link-token mask (mirrored; `linkFieldRaw` un-mirrors it inside a short link, R3). */
const linkOrShape = (raw: string, link: boolean): Part => (link ? masked(raw, true) : shaped(raw));

/** Replace each match of `re` in the open parts with the parts `fn` builds (string-local: path segments only). */
function pass(parts: readonly Part[], re: RegExp, fn: (m: RegExpMatchArray) => Part[]): Part[] {
  const next: Part[] = [];
  for (const p of parts) {
    if (p.mask || p.settled) { next.push(p); continue; }
    let last = 0;
    for (const m of p.raw.matchAll(new RegExp(re.source, re.flags))) {
      const at = m.index ?? 0;
      if (at > last) next.push(keep(p.raw.slice(last, at)));
      next.push(...fn(m).map((x): Part => (x.mask ? x : { ...x, settled: true })));
      last = at + m[0].length;
    }
    if (last < p.raw.length) next.push(keep(p.raw.slice(last)));
  }
  return next.filter((x) => x.raw.length > 0);
}

/** A mask or rewrite at raw offsets [a, b). */
interface Span { a: number; b: number; out: string; mirror: boolean; oversize?: true; rewrite?: true }
/**
 * Rev 9, ruling 1: every pass reads the WHOLE raw text, so an earlier mask is transparent — it never ends a URL, a named
 * value or a run. Passes only add spans; overlapping masks merge at the end. `claimed`: a URL or path a pass has decided,
 * which the run passes (hex, base64) skip.
 */
class Marks {
  readonly spans: Span[] = [];
  private readonly claims: Array<[number, number]> = [];
  readonly text: string;
  constructor(text: string) { this.text = text; }
  add(a: number, b: number, mirror: boolean, out = SECRET_MASK): void { if (b > a) this.spans.push({ a, b, out, mirror }); }
  claimed(a: number, b: number): boolean { return this.claims.some(([x, y]) => a < y && b > x); }
  scan(re: RegExp, fn: (m: RegExpMatchArray) => Part[], o: { claim?: boolean; skipClaimed?: boolean } = {}): void {
    for (const m of this.text.matchAll(new RegExp(re.source, re.flags))) {
      const at = m.index ?? 0, end = at + m[0].length;
      if (o.skipClaimed && this.claimed(at, end)) continue;
      if (o.claim) this.claims.push([at, end]);
      let pos = at;
      for (const p of fn(m)) {
        if (p.mask) this.spans.push({ a: pos, b: pos + p.raw.length, out: p.out, mirror: p.mirror === true, ...(p.rewrite ? { rewrite: true as const } : {}) });
        pos += p.raw.length;
      }
    }
  }
}

/** Merge overlapping masks; a merged mask is mirrored if any part was, and is a key mask if any part was. */
function mergeMasks(spans: readonly Span[]): Span[] {
  const merged: Span[] = [];
  for (const s of spans.filter((x) => !x.rewrite).sort((x, y) => x.a - y.a || y.b - x.b)) {
    const last = merged[merged.length - 1];
    if (last && s.a < last.b) {
      last.b = Math.max(last.b, s.b); last.mirror ||= s.mirror;
      last.out = last.out === KEY_MASK || s.out === KEY_MASK ? KEY_MASK : SECRET_MASK;
    } else merged.push({ ...s });
  }
  return merged;
}

/**
 * Build the parts. A rewrite (a decoded link piece) absorbs every mask wholly inside it — its decoded text is re-masked by
 * the full pipeline (Rev 10), and it is mirrored if any absorbed mask was; a rewrite that a mask crosses is dropped.
 */
function toParts(text: string, spans: readonly Span[]): Part[] {
  const masks = mergeMasks(spans);
  const inside = (m: Span, r: Span): boolean => m.a >= r.a && m.b <= r.b;
  const rewrites = spans.filter((x) => x.rewrite && !masks.some((m) => x.a < m.b && x.b > m.a && !inside(m, x)))
    .map((x) => ({ ...x, mirror: masks.some((m) => inside(m, x) && m.mirror) }));
  const kept = masks.filter((m) => !rewrites.some((r) => inside(m, r)));
  const parts: Part[] = [];
  let last = 0;
  for (const s of [...kept, ...rewrites].sort((x, y) => x.a - y.a)) {
    if (s.a > last) parts.push(keep(text.slice(last, s.a)));
    const raw = text.slice(s.a, s.b);
    parts.push(s.rewrite ? { ...rewrite(raw, s.out), mirror: s.mirror } : { ...masked(raw, s.mirror, s.out), ...(s.b - s.a > NAMED_MAX ? { oversize: true as const } : {}) });
    last = s.b;
  }
  if (last < text.length) parts.push(keep(text.slice(last)));
  return parts;
}

/**
 * The broker's known values as spans of `raw`, recovered through its literal split/join redactor alone, so no value leaves
 * the broker. Null when the alignment fails: the caller then treats the whole result as credential material (fail closed).
 */
export function brokerSpans(raw: string, redact: (s: string) => string): Array<[number, number]> | null {
  const pieces = redact(raw).split(BROKER_PLACEHOLDER);
  if (!raw.startsWith(pieces[0]!)) return null;
  const spans: Array<[number, number]> = [];
  let at = pieces[0]!.length;
  for (const next of pieces.slice(1)) {
    let end = -1;
    for (let e = at + 1; e <= Math.min(raw.length, at + 8192) && end < 0; e++) if (raw.startsWith(next, e) && redact(raw.slice(at, e)) === BROKER_PLACEHOLDER) end = e;
    if (end < 0) return null;
    spans.push([at, end]);
    at = end + next.length;
  }
  return at === raw.length ? spans : null;
}

/** Known values first: the broker's and the caller's are mirrored (I1); an extracted value unless digit- or hex-only (codes stay, R2). */
function knownSpans(k: Marks, o: RedactOptions): boolean {
  const spans = o.brokerRedact ? brokerSpans(k.text, o.brokerRedact) : [];
  if (spans === null) return false;
  for (const [a, b] of spans) k.add(a, b, true);
  const lit = (v: string, mirror: boolean): void => { for (let i = k.text.indexOf(v); i >= 0; i = k.text.indexOf(v, i + v.length)) k.add(i, i + v.length, mirror); };
  for (const v of o.known ?? []) if (v.length >= 6) lit(v, true);
  for (const v of o.extracted ?? []) if (v.length >= 4) lit(v, !unreadable(v));
  return true;
}

/**
 * I2/I3: the value spans after secret-named keys in `s`. A quoted value runs to its closing quote (or the line end); a bare
 * value after `&` or `?` runs to the next `& # " '` or space; any other bare value runs to the line end. No length cap.
 */
export function namedValues(s: string, skipUrls = false): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const urls = skipUrls ? [...s.matchAll(URL_RE)].map((u): [number, number] => [u.index ?? 0, (u.index ?? 0) + u[0].length]) : [];
  const re = new RegExp(KEY_AT.source, KEY_AT.flags);
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!secretKey(m[2]!) || urls.some(([a, b]) => m!.index > a && m!.index < b)) continue;   // Rev 8: a URL's query is the URL pass's
    const span = namedValue(s, m.index + m[0].length, s[m.index - 1] === "&" || s[m.index - 1] === "?");
    if (span[1] > span[0]) { out.push(span); re.lastIndex = Math.max(re.lastIndex, span[1]); }
  }
  return out;
}

function namedValue(s: string, j: number, query: boolean): [number, number] {
  const eol = s.indexOf("\n", j) < 0 ? s.length : s.indexOf("\n", j);
  const q = s[j];
  if (q === '"' || q === "'") {
    for (let k = j + 1; k < eol; k++) { if (s[k] === "\\") { k++; continue; } if (s[k] === q) return [j + 1, k]; }
    return [j + 1, eol];
  }
  if (query) { const m = /[&#"'\s<>\])}]/.exec(s.slice(j, eol)); return [j, m ? j + m.index : eol]; }
  return [j, j + s.slice(j, eol).trimEnd().length];
}

function namedSpans(k: Marks): void {
  k.scan(PEM_BLOCK, (m) => [masked(m[0], true, KEY_MASK)]);
  k.scan(COOKIE_LINE, (m) => [keep(m[1]!), masked(m[2]!, true)]);
  for (const [a, b] of namedValues(k.text, true)) k.add(a, b, true);
}

function shapeSpans(k: Marks, link: boolean): void {
  k.scan(AUTH_SCHEME, (m) => [keep(m[1]!), shaped(m[2]!)]);
  for (const re of SHAPES) k.scan(re, (m) => [shaped(m[0])]);
  k.scan(URL_RE, (m) => urlParts(m, link), { claim: true });
  k.scan(PATH_RE, (m) => pathParts(m[0], 24, false), { claim: true, skipClaimed: true });
  k.scan(HEX_RUN, (m) => [shaped(m[0])], { skipClaimed: true });
  k.scan(B64_RUN, (m) => [opaqueRun(m[0], 32) ? shaped(m[0]) : keep(m[0])], { skipClaimed: true });
}

/** The whole text as parts, masks atomic, in the spec's order. Null: alignment with the broker failed (fail closed). */
export function redactParts(text: string, o: RedactOptions = {}): Part[] | null {
  const k = new Marks(text);
  if (!knownSpans(k, o)) return null;
  namedSpans(k);
  shapeSpans(k, o.linkTokens === true);
  const parts = toParts(text, k.spans).map((p) => (p.rewrite ? maskDecoded(p, o) : p));
  return o.linkTokens === true ? linkFieldRaw(text, parts) : parts;
}

/**
 * Rev 10 (codex round 9): decoded link text goes through the COMPLETE pipeline — known and broker values, named secrets,
 * shapes, URLs — before it can enter a Jev request: decode first, then mask. The inner run is free text (`linkTokens` off),
 * so nothing is decoded twice (`%253D` stays `%3D`), and a run still holding a percent escape after the one decode is masked
 * as opaque. If the decoded text trips the content check, the passage is blocked.
 */
function maskDecoded(p: Part, o: RedactOptions): Part {
  const inner = redactParts(p.out, { ...o, linkTokens: false });
  const block = inner === null ? "unaligned" : passageBlock(p.out) ?? (inner.some((x) => x.oversize) ? "long_named" : null);
  const plain = inner === null ? SECRET_MASK : outOf(inner);
  const out = plain.replace(/[^\s‹›]*%[0-9A-Fa-f]{2}[^\s‹›]*/g, SECRET_MASK);
  // Rev 11 (codex round 10): I1 on decoded text — any mirrored inner mask, or a masked escaped run, mirrors the rewrite, so
  // outside the short-link exception the planner gets Jev's copy; `linkFieldRaw` still un-mirrors it inside a short link
  const mirror = p.mirror === true || inner === null || out !== plain || inner.some((x) => x.mask && x.mirror === true);
  return { ...p, out, mirror, ...(block ? { block } : {}) };
}

/** Rev 9, ruling 3b: the byte-exact planner exception covers a link of at most this many characters and query values. */
export const LINK_EXACT_MAX = 512;
export const LINK_EXACT_QUERY_MAX = 8;
/**
 * R3 (Rev 7, narrowed Rev 9): the planner's copy of a short link in the mail extract's `links=[…]` field (≤ 512 characters,
 * ≤ 8 query values) is the original URL, byte-exact — no mask or rewrite starting inside it is mirrored. A longer link
 * follows the free-text rule for both copies. Jev's copy keeps every mask.
 */
function linkFieldRaw(text: string, parts: Part[]): Part[] {
  const exact: Array<[number, number]> = [];
  for (const f of text.matchAll(/links=\[([^\]]*)\]/g)) {
    const base = (f.index ?? 0) + 7;
    for (const u of f[1]!.matchAll(URL_RE)) {
      const q = u[5] ? u[5].slice(1).split("&").length : 0;
      if (u[0].length <= LINK_EXACT_MAX && q <= LINK_EXACT_QUERY_MAX) exact.push([base + (u.index ?? 0), base + (u.index ?? 0) + u[0].length]);
    }
  }
  let pos = 0;
  return parts.map((p) => {
    const at = pos;
    pos += p.raw.length;
    return p.mask && exact.some(([a, b]) => at >= a && at < b) ? { ...p, mirror: false } : p;
  });
}
export const outOf = (parts: readonly Part[]): string => parts.map((p) => p.out).join("");
export const plannerOf = (parts: readonly Part[]): string => parts.map((p) => (p.mask && p.mirror ? p.out : p.raw)).join("");
/** The whole masked text (tests and the side channel); a failed broker alignment masks everything. */
export function redactForJudge(text: string, o: RedactOptions = {}): string {
  const parts = redactParts(text, o);
  return parts === null ? SECRET_MASK : outOf(parts);
}

/** A path: standard-alphabet base64 runs first (route words trimmed off both ends), then opaque segment runs. */
function pathParts(s: string, min: number, link: boolean): Part[] {
  if (link) return linkSegments(s);
  const out: Part[] = [];
  let last = 0;
  for (const m of s.matchAll(STD_RUN)) {
    if (!stdOpaque(m[0])) continue;
    const seg = m[0].split("/");
    let a = 0, b = seg.length;
    while (a < b - 1 && ROUTE.test(seg[a]!)) a++;
    while (b - 1 > a && ROUTE.test(seg[b - 1]!)) b--;
    const head = seg.slice(0, a).map((x) => `${x}/`).join(""), tail = seg.slice(b).map((x) => `/${x}`).join("");
    out.push(...segParts(s.slice(last, m.index ?? 0) + head, min), shaped(seg.slice(a, b).join("/")));
    last = (m.index ?? 0) + m[0].length - tail.length;
  }
  return [...out, ...segParts(s.slice(last), min)];
}

function segParts(s: string, min: number): Part[] {
  return pass([keep(s)], SEG_RUN, (m) => [opaqueRun(m[0], min) ? shaped(m[0]) : keep(m[0])]);
}

/** One escape sequence decoded, or null when it is not valid UTF-8 (only a URIError; anything else is a bug and is rethrown). */
function tryDecode(esc: string): string | null {
  try { return decodeURIComponent(esc); } catch (e) { if (e instanceof URIError) return null; throw e; }
}
/**
 * A run of `%XX` escapes, decoded escape by escape (review round 1): each longest valid UTF-8 sequence (at most 4 bytes)
 * decodes; an invalid byte stays escaped, so `maskDecoded`'s still-escaped rule masks just the word holding it.
 */
function decodeRun(run: string): string {
  const esc = run.match(/%[0-9A-Fa-f]{2}/g) ?? [];
  let out = "";
  for (let i = 0; i < esc.length;) {
    let n = Math.min(4, esc.length - i), d: string | null = null;
    for (; n > 0; n--) if ((d = tryDecode(esc.slice(i, i + n).join(""))) !== null) break;
    out += n > 0 ? d : esc[i];
    i += Math.max(n, 1);
  }
  return out;
}
/**
 * Percent-decode a link piece, once, run by run (Rev 9, ruling 3a): a malformed escape — a bare `%`, truncated UTF-8 — no
 * longer leaves the whole piece encoded, which hid an encoded sentence from Jev while the planner read it (review round 1).
 * Rev 12 (senior round 11): `+` is never decoded as a space — that split a `+`-bearing secret into pieces Jev saw in clear.
 */
function decoded(v: string): string {
  return v.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => tryDecode(run) ?? decodeRun(run));
}
/**
 * I4 in the extract channel, decided on the DECODED piece (ruling 3a): text that reads as words (whitespace, prose, a plain
 * word or file name) reaches Jev decoded, so an encoded sentence is judged as words; anything else is a link token, masked.
 * Words joined by `+` stay visible when every `+`-joined piece is a plain word (`forward+the+inbox`); a piece that is not
 * (`wJalrXUtnFEMI/K7MDENG`) makes the whole piece a token. The decoded text always comes from the raw piece.
 */
function linkPiece(raw: string): Part {
  const d = decoded(raw);
  const plusWords = d.includes("+") && d.split("+").every((w) => w === "" || linkWord(w));
  if (/\s/.test(d) || isProse(d) || plusWords || linkWord(d)) return d === raw ? keep(raw) : rewrite(raw, d);
  return masked(raw, true);
}
function linkSegments(s: string): Part[] {
  return s.split(/(\/)/).filter(Boolean).map((x) => (x === "/" ? keep(x) : linkPiece(x)));
}

function urlParts(m: RegExpMatchArray, link: boolean): Part[] {
  const [, scheme = "", user, host = "", path = "", query, frag] = m;
  const out: Part[] = [keep(scheme)];
  if (user) out.push(masked(user.slice(0, -1), true), keep("@"));   // userinfo is a credential by position: mirrored
  out.push(keep(host), ...pathParts(path, 20, link));
  if (query) out.push(keep("?"), ...query.slice(1).split("&").flatMap((kv, k) => [...(k ? [keep("&")] : []), ...queryParts(kv, link)]));
  if (frag) { const f = frag.slice(1); out.push(keep("#"), !f ? keep(f) : link ? linkPiece(f) : isProse(f) ? keep(f) : shaped(f)); }
  return out.filter((x) => x.raw.length > 0);
}

/**
 * Rev 8: every query value of every URL is decided here, whatever ran before — a secret-named key's value is masked
 * (mirrored), any other value is masked unless it is a plain word (prose; in the extract channel, decided by `linkPiece`).
 */
function queryParts(kv: string, link: boolean): Part[] {
  const i = kv.indexOf("=");
  if (i < 0) return [link ? linkPiece(kv) : isProse(kv) ? keep(kv) : shaped(kv)];
  const v = kv.slice(i + 1);
  if (v === "") return [keep(kv)];
  if (secretKey(kv.slice(0, i))) return [keep(kv.slice(0, i + 1)), masked(v, true)];
  return [keep(kv.slice(0, i + 1)), link ? linkPiece(v) : isProse(v) ? keep(v) : shaped(v)];
}

const TAIL = /[^\s"',;:{}()[\]<>=&]+$/;
const HEAD = /^[^\s"',;:{}()[\]<>=&]+/;

/**
 * Mask first, then split (ruling 1): mu's splitter runs on the masked text and never cuts inside a mask; each passage keeps
 * its raw twin and its planner copy. A hard cut through a delimiter-free run masks both halves of that run, in Jev's copy
 * and the planner's (I1), unless the whole run is prose. A passage holding a named value past NAMED_MAX is `long_named` (I3).
 * Null: the broker alignment failed — the caller withholds the whole result (outside) or frames it (local).
 */
export function splitEgress(text: string, size: number, o: RedactOptions = {}): EgressPassage[] | null {
  const parts = redactParts(text, o);
  if (parts === null) return null;
  const inside = new Set<number>();
  let pos = 0;
  for (const p of parts) { if (p.mask) for (let i = pos + 1; i < pos + p.out.length; i++) inside.add(i); pos += p.out.length; }
  const out = outOf(parts);
  const bounds = [0, ...cutPoints(out, size, inside), out.length];
  const passages = bounds.slice(1).map((end, k) => sliceParts(parts, bounds[k]!, end));
  for (let k = 0; k + 1 < passages.length; k++) maskCutRun(passages[k]!, passages[k + 1]!);
  return passages;
}

function sliceParts(parts: readonly Part[], a: number, b: number): EgressPassage {
  let pos = 0, raw = "", out = "", planner = "", masked = 0, block: EgressBlock | undefined;
  for (const p of parts) {
    const s = pos, e = pos + p.out.length;
    pos = e;
    if (e <= a || s >= b) continue;
    if (p.mask) { if (p.mirror) masked++; raw += p.raw; out += p.out; planner += p.mirror ? p.out : p.raw; block ??= p.block ?? (p.oversize ? "long_named" : undefined); continue; }
    const piece = p.raw.slice(Math.max(a, s) - s, Math.min(b, e) - s);
    raw += piece; out += piece; planner += piece;
  }
  return { raw, out, planner, masked, ...(block ? { block } : {}) };
}

function maskCutRun(left: EgressPassage, right: EgressPassage): void {
  const t = left.out.match(TAIL)?.[0], h = right.out.match(HEAD)?.[0];
  if (!t || !h || isProse(t + h)) return;
  left.out = left.out.slice(0, -t.length) + SECRET_MASK;
  right.out = SECRET_MASK + right.out.slice(h.length);
  left.planner = left.planner.replace(TAIL, SECRET_MASK);
  right.planner = right.planner.replace(HEAD, SECRET_MASK);
}

/**
 * mu's splitter (qybaihe/mu@faed8c3 tool-injection.ts `passages`, MIT): split on blank lines, pack paragraphs into pieces of
 * at most `size` characters. Houge's change: a longer paragraph is cut at its last newline, else its last space, in the
 * second half of the piece, else hard at `size` — moved out of any mask (back to its start, or past its end).
 * mu — Copyright (c) 2025 Mario Zechner, MIT License; the full notice is in THIRD_PARTY_NOTICES.md.
 */
export function cutPoints(text: string, size: number, inside: ReadonlySet<number> = new Set()): number[] {
  const cuts: number[] = [];
  let len = 0, start = 0;
  for (const end of [...[...text.matchAll(/\n\s*\n/g)].map((m) => (m.index ?? 0) + m[0].length), text.length]) {
    let at = start, rest = end - start;
    start = end;
    while (rest > size) { if (len) { cuts.push(at); len = 0; } const c = cutAt(text, at, size, inside); cuts.push(c); rest -= c - at; at = c; }
    if (len && len + rest > size) { cuts.push(at); len = 0; }
    len += rest;
  }
  return [...new Set(cuts)].filter((c) => c > 0 && c < text.length).sort((a, b) => a - b);
}

function cutAt(text: string, from: number, size: number, inside: ReadonlySet<number>): number {
  const head = text.slice(from, from + size);
  const nl = head.lastIndexOf("\n");
  if (nl >= size / 2) return from + nl + 1;
  const ws = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\t"));
  if (ws >= size / 2) return from + ws + 1;
  let c = from + size;
  if (!inside.has(c)) return c;
  while (inside.has(c)) c--;
  if (c > from) return c;
  c = from + size;
  while (inside.has(c)) c++;
  return c;
}

/** mu's splitter on plain text (the golden set, the corpus): the raw pieces, joined, give the text back exactly. */
export function splitPassages(text: string, size: number): string[] {
  const bounds = [0, ...cutPoints(text, size), text.length];
  return text ? bounds.slice(1).map((end, k) => text.slice(bounds[k]!, end)) : [];
}

/** `unaligned`: the broker alignment failed, so every passage of the result is blocked (Task 7, fail closed). */
export type EgressBlock = "credential_path" | "pem_block" | "secret_json" | "dense_secrets" | "cookie_jar" | "seed_phrase" | "unaligned" | "long_named";

/** Words a BIP-39 seed line never holds (no wordlist ships: zero dependencies); prose almost always holds one. */
const STOP = new Set("the and for are but not you all can was one our out has his how its who did get may him she too use her that this with from they have were will your what when been than them then".split(" "));
const SEED_LINE = /^(?:\d{1,7}(?:-\d{1,7})?[:|])?[ \t]*((?:[a-z]{3,8}[ \t]+){11,23}[a-z]{3,8})[ \t]*$/gm;
/** A line (behind omp's `N:` read prefix or not) of 12, 15, 18, 21 or 24 lowercase words of 3–8 letters with no common stopword: wallet recovery material (W-R3-3). */
export function seedPhrase(raw: string): boolean {
  for (const m of raw.matchAll(SEED_LINE)) { const w = m[1]!.split(/[ \t]+/); if (w.length % 3 === 0 && !w.some((x) => STOP.has(x))) return true; }
  return false;
}

/** The content checks the extension copies (2b-i §2.4); the sources are exported so tests/omp/injection-floor.test.ts pins the copy. */
export const CONTENT_CHECK_SOURCES = Object.freeze({
  pem: String.raw`-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----`,
  secretJson: String.raw`"(?:private_key|client_secret|refresh_token)"\s*:`,
  serviceAccount: String.raw`"type"\s*:\s*"service_account"`,
  cookieJar: String.raw`^(?:\d{1,7}(?:-\d{1,7})?[:|])?#\s*(?:Netscape\s+)?HTTP Cookie File`
});
const PEM_CHECK = new RegExp(CONTENT_CHECK_SOURCES.pem);
const SECRET_JSON_CHECK = new RegExp(CONTENT_CHECK_SOURCES.secretJson);
const SERVICE_ACCOUNT_CHECK = new RegExp(CONTENT_CHECK_SOURCES.serviceAccount);
const COOKIE_JAR_CHECK = new RegExp(CONTENT_CHECK_SOURCES.cookieJar, "im");

/** Spec §7.0 item 3, ruled per passage on the RAW passage, locally (plan S8). Never a pass: Task 7 withholds (outside) or frames (local). */
export function passageBlock(raw: string): EgressBlock | null {
  if (PEM_CHECK.test(raw)) return "pem_block";
  if (SECRET_JSON_CHECK.test(raw) || SERVICE_ACCOUNT_CHECK.test(raw)) return "secret_json";
  if (COOKIE_JAR_CHECK.test(raw)) return "cookie_jar";
  if (seedPhrase(raw)) return "seed_phrase";
  return countNamedSecrets(raw) >= 3 ? "dense_secrets" : null;
}

/** Secret-named values that look like credentials (8+ characters, no whitespace, not prose): the dense-secrets count (W-R4-1). */
export function countNamedSecrets(raw: string): number {
  return namedValues(raw).map(([a, b]) => raw.slice(a, b)).filter((v) => v.length >= 8 && !/\s/.test(v) && !isProse(v)).length;
}

/** Spec §7.0 item 2: a command that names a credential path keeps its whole output local. */
export function pathBlocked(paths: readonly string[], home: string): boolean {
  return paths.some((p) => isCredentialPath(p, home));
}

/** The absolute paths a command names (a loose split: the path deny-list needs recall, not a grammar). */
export function pathOperands(command: string, cwd: string, home: string): string[] {
  const words = command.split(/[\s;|&<>()]+/).map((w) => w.replace(/^["']|["']$/g, "")).filter((w) => w.length > 0 && !w.startsWith("-"));
  const paths = words.filter((w) => w.includes("/") || w.startsWith(".") || w.startsWith("~"));
  return [...new Set(paths.map((w) => (w.startsWith("~/") ? resolve(home, w.slice(2)) : resolve(cwd, w))))];
}
