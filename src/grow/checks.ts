import { createHash } from "node:crypto";

import { HIDDEN_CLASSES } from "./scrub.js";

export { fieldScrub } from "./scrub.js";

export interface GrowFields { name: string; description: string; example: string; body: string; anchors?: string[] }
export type GrowOrigin = "clean" | "untrusted" | "exemplar";
export type GrowFailCode = "bad_name" | "bad_description" | "bad_example" | "bad_body" | "bad_anchors" | "too_large" | "control_chars" | "secret_shape" | "needs_script" | "duplicate";
export type CheckResult = { ok: true } | { ok: false; code: GrowFailCode; message: string };

export const GROW_LIMITS = { nameRe: /^[a-z0-9-]{3,48}$/, descMin: 20, descMax: 200, exampleMin: 10, exampleMax: 300, bodyMin: 200, bodyMax: 8000,
  totalMax: 16_384, anchorsMax: 8, anchorMax: 300, smallLines: 20, smallShare: 0.25, smallChars: 800 } as const;
export const EXEMPLAR_HINT = "see the exemplar option-comparison (grow_read it) for the expected shape";

const fail = (code: GrowFailCode, message: string): CheckResult => ({ ok: false, code, message: `${message}; ${EXEMPLAR_HINT}` });
const oneLine = (s: string, min: number, max: number): boolean => s.length >= min && s.length <= max && !/[\r\n]/.test(s);
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
const texts = (f: GrowFields): string[] => [f.name, f.description, f.example, f.body, ...(f.anchors ?? [])];
/** The class of the first hidden character in any field, null when there is none. */
const hiddenClass = (f: GrowFields): string | null => {
  for (const t of texts(f)) for (const [label, re] of HIDDEN_CLASSES) if (re.test(t)) return label;
  return null;
};

function shape(f: GrowFields): CheckResult {
  const L = GROW_LIMITS;
  if (!L.nameRe.test(f.name)) return fail("bad_name", "name must be 3-48 chars of a-z, 0-9 and hyphen");
  if (!oneLine(f.description, L.descMin, L.descMax)) return fail("bad_description", "description must be one line of 20-200 chars saying when to use the skill");
  if (!oneLine(f.example, L.exampleMin, L.exampleMax)) return fail("bad_example", "example must be one line of 10-300 chars: a request this skill answers");
  if (f.body.length < L.bodyMin || f.body.length > L.bodyMax) return fail("bad_body", "body must be 200-8000 chars");
  const a = f.anchors ?? [];
  if (a.length > L.anchorsMax || a.some((x) => !oneLine(x, 1, L.anchorMax))) return fail("bad_anchors", "anchors must be at most 8 single lines of at most 300 chars");
  if (Buffer.byteLength(JSON.stringify(f), "utf8") > L.totalMax) return fail("too_large", "the submission exceeds 16 KB");
  return { ok: true };
}

const PROSE_FENCES: ReadonlySet<string> = new Set(["text", "txt", "markdown", "md", "example", "output", "quote"]);
/** A fenced block of more than three inner lines that is not marked as prose: an exact procedure belongs in a script (1c). */
function longCodeFence(body: string): boolean {
  const lines = body.split("\n"); let open: { at: number; mark: string; prose: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(```|~~~)\s*([A-Za-z0-9_+-]*)/.exec(lines[i]!);
    if (!m) continue;
    if (!open) { open = { at: i, mark: m[1]!, prose: PROSE_FENCES.has(m[2]!.toLowerCase()) }; continue; }
    if (m[1] !== open.mark) continue;
    if (!open.prose && i - open.at - 1 > 3) return true;
    open = null;
  }
  return open !== null && !open.prose && lines.length - open.at - 1 > 3;
}

export function checkFields(f: GrowFields, live: ReadonlyArray<{ name: string; description: string; body_hash: string }>, scrub: (s: string) => string): CheckResult {
  const s = shape(f);
  if (!s.ok) return s;
  const hidden = hiddenClass(f);
  if (hidden) return fail("control_chars", `a field contains ${hidden}; control and invisible characters are not allowed, and emoji sequences are not allowed either`);
  // Backstop: the control-character rule above currently pre-empts every input that could fail this.
  const back = parseSkillFile(renderSkillFile(f, "clean"));
  if (!back || contentHash(back) !== contentHash(f)) return fail("control_chars", "a field does not survive the skill file format (an unusual line break or control character)");
  if (texts(f).some((t) => scrub(t) !== t)) return { ok: false, code: "secret_shape", message: "a field contains something shaped like a secret or a secret path; remove it" };
  if (longCodeFence(f.body)) return fail("needs_script", "a fenced block longer than three lines needs a script, and scripts arrive in a later slice; describe the steps in prose");
  const hash = bodyHash(f);
  const twin = live.find((x) => x.name !== f.name && (norm(x.description) === norm(f.description) || x.body_hash === hash));
  return twin ? fail("duplicate", `the live skill ${twin.name} already covers this; update that one`) : { ok: true };
}

/**
 * The heaviest in-order common subsequence of lines, each line weighing `weight(line)`, over alignments that stay
 * within `band` lines of the diagonal. A small update has at most 20 changed lines, so at most 40 insertions plus
 * deletions, and its alignment never leaves a band of 40: the answer is exact there and an under-estimate (the safe
 * side: more change) beyond, at O(lines x band) instead of O(lines^2).
 */
function common(a: string[], b: string[], weight: (line: string) => number, band: number): number {
  // Two rows reused: a cell outside the band keeps an older row's value, never more than its true one.
  let prev = new Array<number>(b.length + 1).fill(0); let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const x = a[i - 1]!;
    for (let j = Math.max(1, i - band); j <= Math.min(b.length, i + band); j++) cur[j] = Math.max(x === b[j - 1] ? prev[j - 1]! + weight(x) : 0, prev[j]!, cur[j - 1]!);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

const chars = (lines: string[]): number => lines.reduce((n, l) => n + l.length, 0);

/**
 * Goes live unreviewed (P3), so it is bounded in lines and in characters: at most 20 changed lines and a quarter of
 * them, and at most 800 changed characters and a quarter of the old body's (removed plus added lines' lengths).
 */
export function isSmallUpdate(prev: GrowFields, next: GrowFields): boolean {
  const L = GROW_LIMITS;
  if (prev.description !== next.description || prev.example !== next.example) return false;
  if (JSON.stringify(prev.anchors ?? []) !== JSON.stringify(next.anchors ?? [])) return false;
  const a = prev.body.split("\n"); const b = next.body.split("\n");
  if (Math.abs(a.length - b.length) > L.smallLines) return false;   // that many lines were added or removed outright
  const band = 2 * L.smallLines;
  const lines = Math.max(a.length, b.length) - common(a, b, () => 1, band);
  if (lines > L.smallLines || lines > Math.floor(Math.max(a.length, b.length) * L.smallShare)) return false;
  const changedChars = chars(a) + chars(b) - 2 * common(a, b, (l) => l.length, band);
  return changedChars <= L.smallChars && changedChars <= Math.floor(chars(a) * L.smallShare);
}

export function renderSkillFile(f: GrowFields, origin: GrowOrigin): string {
  const anchors = (f.anchors ?? []).length > 0 ? `anchors:\n${f.anchors!.map((a) => `  - ${JSON.stringify(a)}`).join("\n")}\n` : "";
  return `---\nname: ${f.name}\ndescription: ${JSON.stringify(f.description)}\nexample: ${JSON.stringify(f.example)}\norigin: ${origin}\n${anchors}---\n\n${f.body}\n`;
}

const str = (raw: string): string | null => { try { const v: unknown = JSON.parse(raw); return typeof v === "string" ? v : null; } catch { return null; } };

export function parseSkillFile(text: string): (GrowFields & { origin: GrowOrigin }) | null {
  const m = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)\n$/.exec(text);
  if (!m) return null;
  const head = m[1]!; const body = m[2]!;
  const line = (k: string): string | undefined => new RegExp(`^${k}: (.*)$`, "m").exec(head)?.[1];
  const name = line("name"); const description = str(line("description") ?? ""); const example = str(line("example") ?? ""); const origin = line("origin");
  if (!name || description === null || example === null || (origin !== "clean" && origin !== "untrusted" && origin !== "exemplar")) return null;
  const anchors = [...head.matchAll(/^ {2}- (.*)$/gm)].map((x) => str(x[1]!)).filter((x): x is string => x !== null);
  return { name, description, example, body, ...(anchors.length > 0 ? { anchors } : {}), origin };
}

export function contentHash(f: GrowFields): string {
  return createHash("sha256").update(JSON.stringify([f.name, f.description, f.example, f.body, f.anchors ?? []])).digest("hex");
}

/** Whitespace-normalised body digest: the same procedure under another name or description is a duplicate. */
export const bodyHash = (f: Pick<GrowFields, "body">): string => createHash("sha256").update(f.body.trim().replace(/\s+/g, " ")).digest("hex");
