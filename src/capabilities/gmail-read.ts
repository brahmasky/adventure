/**
 * Gmail read ops (ADR 0025): list / search / get over the allowlisted google-api transport,
 * plus deterministic verification extraction — the registration trust anchor (spec §4).
 *
 * Trust posture: every human-readable string passes text hygiene; header lines (from/subject/
 * date/snippet) are additionally markdown-escaped for Telegram; the message BODY is hygiene-only
 * (the planner sees it through the Q-LLM anyway); extracted links stay byte-exact — they are
 * NEVER escapeForTelegram'd (the planner must be able to use them verbatim).
 */
import { escapeForTelegram, sanitizeVenueText } from "./text-hygiene.js";
import {
  GOOGLE_RESULT_CHAR_CAP,
  googleApiGetJson,
  resolveGoogleEnabled,
  type GoogleApiDeps
} from "./google-api.js";
import type { GoogleAuthClient } from "./google-auth.js";

export const GMAIL_LIST_DEFAULT = 10;
export const GMAIL_LIST_MAX = 25;
export const GMAIL_BODY_CHAR_CAP = 4_000;
/** Overall soft deadline per op, checked between sequential message fetches.
 * Exported — core-worker derives the tool timeout from it (Task 7). */
export const GMAIL_OP_DEADLINE_MS = 75_000;
export const GMAIL_EXTRACT_MAX_CODES = 5;
export const GMAIL_EXTRACT_MAX_LINKS = 10;
export const GMAIL_LINK_CHAR_CAP = 300;
export const GMAIL_TRUSTED_EXTRACT_CHAR_CAP = 600;
// Digest cap: GOOGLE_RESULT_CHAR_CAP is reused from google-api.ts (single 6k constant).

const MESSAGES_PATH = "/gmail/v1/users/me/messages";
const HEADER_FIELD_CAP = 200;
const SNIPPET_CAP = 300;
// {list} is forced to the inbox (excludes Sent/Drafts; Spam/Trash already excluded by the API).
// {search} is NEVER touched — the user's query is passed verbatim (may target Sent, a label, etc.).
const LIST_INBOX_QUERY = "in:inbox";
// Navigation side-channel (ADR 0025): positional id map so the planner can chain list/search → get.
const TRUSTED_IDS_PREFIX = "message ids (use with gmail_read get):";
// Strict token charset for the un-quarantined channel — stricter than the transport allowlist (no dot).
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]+$/;
const OPERATOR_HINT =
  "(operator: Gmail refresh token likely revoked — re-run scripts/gmail-auth.mjs)";
/** googleApiGetJson renders a GoogleAuthError as `google auth <kind>: <message>`. */
const AUTH_FAILED_MARKER = "google auth auth_failed";

// Gmail's `metadataHeaders` is a REPEATED query param — pair-sequence form.
const METADATA_QUERY: ReadonlyArray<[string, string]> = [
  ["format", "metadata"],
  ["metadataHeaders", "From"],
  ["metadataHeaders", "Subject"],
  ["metadataHeaders", "Date"]
];

// Verification keyword set (spec §4): code|verification|verify|OTP|一次性|验证码, case-insensitive.
const VERIFICATION_KEYWORD_RE = /code|verification|verify|otp|一次性|验证码/gi;
const KEYWORD_PROXIMITY_CHARS = 80;
// Candidates: numeric 4-8 digits, or uppercase alphanumeric 6-10 chars containing >=1 digit.
const NUMERIC_CODE_RE = /(?<![0-9A-Za-z])[0-9]{4,8}(?![0-9A-Za-z])/g;
const ALNUM_CODE_RE = /(?<![0-9A-Za-z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{6,10}(?![0-9A-Za-z])/g;
const LINK_RE = /https?:\/\/[^\s<>"']+/g;

/**
 * Deterministic verification extraction — the registration trust anchor (spec §4).
 * Candidates ranked by proximity to a verification keyword (within 80 chars) — keyword-near
 * candidates first, then appearance order. Caps applied AFTER ranking so decoy numbers
 * (years, prices, zips) cannot evict a real code. Links kept byte-exact, length-capped, deduped.
 */
export function extractVerification(rawBody: string): { codes: string[]; links: string[] } {
  const keywordIndexes: number[] = [];
  for (const match of rawBody.matchAll(VERIFICATION_KEYWORD_RE)) {
    keywordIndexes.push(match.index ?? 0);
  }
  const nearKeyword = (index: number, length: number): boolean =>
    keywordIndexes.some(
      (k) =>
        Math.abs(k - index) <= KEYWORD_PROXIMITY_CHARS ||
        Math.abs(k - (index + length)) <= KEYWORD_PROXIMITY_CHARS
    );

  const byValue = new Map<string, { value: string; index: number; near: boolean }>();
  for (const re of [NUMERIC_CODE_RE, ALNUM_CODE_RE]) {
    for (const match of rawBody.matchAll(re)) {
      const value = match[0] ?? "";
      if (value === "") continue;
      const index = match.index ?? 0;
      const near = nearKeyword(index, value.length);
      const existing = byValue.get(value);
      if (existing) existing.near = existing.near || near;
      else byValue.set(value, { value, index, near });
    }
  }
  const codes = [...byValue.values()]
    .sort((a, b) => (a.near === b.near ? a.index - b.index : a.near ? -1 : 1))
    .slice(0, GMAIL_EXTRACT_MAX_CODES)
    .map((candidate) => candidate.value);

  const links: string[] = [];
  const seenLinks = new Set<string>();
  for (const match of rawBody.matchAll(LINK_RE)) {
    // sanitizeVenueText is a no-op for a clean URL (byte-exact); it strips smuggled
    // zero-width/bidi characters and caps runaway link lengths.
    const link = sanitizeVenueText(match[0] ?? "", GMAIL_LINK_CHAR_CAP);
    if (link === "" || seenLinks.has(link)) continue;
    seenLinks.add(link);
    links.push(link);
    if (links.length >= GMAIL_EXTRACT_MAX_LINKS) break;
  }
  return { codes, links };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function partData(node: Record<string, unknown>): string | undefined {
  const body = asRecord(node.body);
  const data = body?.data;
  return typeof data === "string" && data.length > 0 ? data : undefined;
}

function flattenParts(payload: unknown, out: Array<Record<string, unknown>>): void {
  const node = asRecord(payload);
  if (!node) return;
  out.push(node);
  if (Array.isArray(node.parts)) for (const part of node.parts) flattenParts(part, out);
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/** HTML fallback strip order (plan binding): style/script BLOCKS removed first, then tags → spaces. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

/** Walk the multipart tree, prefer the first text/plain part, fall back to tag-stripped HTML. */
export function decodeMessageBody(payload: unknown): string {
  const nodes: Array<Record<string, unknown>> = [];
  flattenParts(payload, nodes);
  let htmlData: string | undefined;
  for (const node of nodes) {
    const data = partData(node);
    if (data === undefined) continue;
    const mime = typeof node.mimeType === "string" ? node.mimeType.toLowerCase() : "";
    if (mime.startsWith("text/plain")) return decodeBase64Url(data);
    if (htmlData === undefined && mime.startsWith("text/html")) htmlData = data;
  }
  return htmlData !== undefined ? stripHtml(decodeBase64Url(htmlData)) : "";
}

export interface GmailReadResult {
  text: string;
  /** Deterministic post-quarantine side-channel (ADR 0025): codes/links the planner may use
   * verbatim. Sanitized + capped; NEVER escapeForTelegram'd (links must stay byte-exact). */
  trustedExtract?: string;
  ledger?: {
    service: string;
    op: string;
    count: number;
    extracted_codes: number;
    extracted_links: number;
  };
}

type GmailOp = { kind: "list" } | { kind: "search"; q: string } | { kind: "get"; id: string };

/** Exactly-one-op validation (mirrors schedule_task's verb validation style). */
function parseOp(input: Record<string, unknown>): { ok: true; op: GmailOp } | { ok: false; error: string } {
  const present = (["list", "search", "get"] as const).filter((key) => input[key] !== undefined);
  if (present.length !== 1) {
    return { ok: false, error: "gmail_read rejected: provide exactly one of list, search, or get" };
  }
  const key = present[0];
  if (key === "list") {
    if (input.list !== true) return { ok: false, error: "gmail_read rejected: list must be true" };
    return { ok: true, op: { kind: "list" } };
  }
  if (key === "search") {
    const q = typeof input.search === "string" ? input.search.trim() : "";
    if (q === "") return { ok: false, error: "gmail_read rejected: search must be a non-empty string" };
    return { ok: true, op: { kind: "search", q } };
  }
  const id = typeof input.get === "string" ? input.get.trim() : "";
  if (id === "") return { ok: false, error: "gmail_read rejected: get must be a non-empty message id" };
  return { ok: true, op: { kind: "get", id } };
}

function clampMax(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : GMAIL_LIST_DEFAULT;
  return Math.min(GMAIL_LIST_MAX, Math.max(1, n));
}

/** auth_failed is the EXPECTED failure (revoked refresh token) — always carry the runbook hint. */
function withOperatorHint(text: string): string {
  return text.includes(AUTH_FAILED_MARKER) ? `${text} ${OPERATOR_HINT}` : text;
}

function capResultText(text: string): string {
  const points = Array.from(text);
  return points.length > GOOGLE_RESULT_CHAR_CAP
    ? `${points.slice(0, GOOGLE_RESULT_CHAR_CAP).join("")}…`
    : text;
}

function headerValue(message: Record<string, unknown> | undefined, name: string): string {
  const payload = asRecord(message?.payload);
  const headers = payload?.headers;
  if (!Array.isArray(headers)) return "";
  for (const entry of headers) {
    const header = asRecord(entry);
    if (!header) continue;
    if (
      typeof header.name === "string" &&
      header.name.toLowerCase() === name.toLowerCase() &&
      typeof header.value === "string"
    ) {
      return header.value;
    }
  }
  return "";
}

/** Header/snippet lines are rendered inert for Telegram: hygiene THEN markdown-escape. */
function inertLine(value: string, cap: number): string {
  return escapeForTelegram(sanitizeVenueText(value, cap));
}

function extractIds(json: unknown): string[] {
  const messages = asRecord(json)?.messages;
  if (!Array.isArray(messages)) return [];
  const ids: string[] = [];
  for (const item of messages) {
    const id = asRecord(item)?.id;
    if (typeof id === "string" && id.trim() !== "") ids.push(id);
  }
  return ids;
}

/**
 * Deterministic navigation side-channel (ADR 0025): a positional id map, aligned with the reader
 * summary's message order (id N ↔ "message N"), so the planner can chain list/search → get without
 * improvising a non-id from a subject or RFC822 header.
 *
 * IDs are structured tokens (no free text, no verb) — verb-proof by construction. DEFENSE IN DEPTH:
 * the Gmail API response is untrusted, and extractIds does NOT validate charset, so a hostile/
 * malformed id could ride the messages[].id field into `ids`. Every id is re-validated here and
 * DROPPED if it fails MESSAGE_ID_RE — a hostile id must never enter this un-quarantined channel.
 * The whole line is hard-capped at GMAIL_TRUSTED_EXTRACT_CHAR_CAP; on overflow, keep as many
 * LEADING ids as fit (whole entries only — never a partial id). Absent when no valid ids remain.
 */
function buildIdTrustedExtract(ids: string[]): string | undefined {
  let line = TRUSTED_IDS_PREFIX;
  let count = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === undefined || !MESSAGE_ID_RE.test(id)) continue;
    const entry = ` ${i + 1}=${id}`;
    if (Array.from(line + entry).length > GMAIL_TRUSTED_EXTRACT_CHAR_CAP) break;
    line += entry;
    count += 1;
  }
  return count > 0 ? line : undefined;
}

function digestLine(message: unknown): string {
  const msg = asRecord(message);
  const snippet = typeof msg?.snippet === "string" ? msg.snippet : "";
  return [
    inertLine(headerValue(msg, "From"), HEADER_FIELD_CAP),
    inertLine(headerValue(msg, "Subject"), HEADER_FIELD_CAP),
    inertLine(headerValue(msg, "Date"), HEADER_FIELD_CAP),
    inertLine(snippet, SNIPPET_CAP)
  ].join(" — ");
}

async function runDigestList(
  opName: "list" | "search",
  q: string | undefined,
  max: number,
  deps: GoogleApiDeps,
  auth: GoogleAuthClient
): Promise<GmailReadResult> {
  const startMs = deps.now().getTime();
  const query: Record<string, string> = { maxResults: String(max), ...(q !== undefined ? { q } : {}) };
  const listResult = await googleApiGetJson(MESSAGES_PATH, query, deps, auth);
  if (!listResult.ok) {
    return { text: withOperatorHint(`gmail ${opName} failed: ${listResult.error}`) };
  }

  const ids = extractIds(listResult.json);
  const lines: string[] = [];
  let note: string | undefined;
  // Sequential fetches with the overall soft deadline checked between messages (bounty posture).
  for (const id of ids) {
    if (deps.now().getTime() - startMs > GMAIL_OP_DEADLINE_MS) {
      note = `deadline exceeded — digested ${lines.length} of ${ids.length} messages`;
      break;
    }
    const messageResult = await googleApiGetJson(`${MESSAGES_PATH}/${id}`, METADATA_QUERY, deps, auth);
    if (!messageResult.ok) {
      note = withOperatorHint(
        `message fetch failed (${messageResult.error}) — digested ${lines.length} of ${ids.length} messages`
      );
      break;
    }
    lines.push(digestLine(messageResult.json));
  }

  const partial = lines.length < ids.length ? ` of ${ids.length}` : "";
  const header = `gmail ${opName}: ${lines.length}${partial} message${lines.length === 1 ? "" : "s"}`;
  const parts = [header, ...lines];
  if (note !== undefined) parts.push(note);
  // ids are navigation, not verification material — ledger extracted_codes/links stay 0.
  const trustedExtract = buildIdTrustedExtract(ids);
  return {
    text: capResultText(parts.join("\n")),
    ...(trustedExtract !== undefined ? { trustedExtract } : {}),
    ledger: { service: "gmail", op: opName, count: lines.length, extracted_codes: 0, extracted_links: 0 }
  };
}

async function runGet(id: string, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<GmailReadResult> {
  const messageResult = await googleApiGetJson(`${MESSAGES_PATH}/${id}`, { format: "full" }, deps, auth);
  if (!messageResult.ok) {
    return { text: withOperatorHint(`gmail get failed: ${messageResult.error}`) };
  }
  const message = asRecord(messageResult.json);
  const rawBody = decodeMessageBody(message?.payload);
  // Extraction runs on the RAW decoded body BEFORE the digest cap: a code past the cap still surfaces.
  const { codes, links } = extractVerification(rawBody);

  const headerLine = [
    `from: ${inertLine(headerValue(message, "From"), HEADER_FIELD_CAP)}`,
    `subject: ${inertLine(headerValue(message, "Subject"), HEADER_FIELD_CAP)}`,
    `date: ${inertLine(headerValue(message, "Date"), HEADER_FIELD_CAP)}`
  ].join(" — ");
  // Body: hygiene only, NOT markdown-escaped (the planner sees it through the Q-LLM anyway).
  const body = sanitizeVenueText(rawBody, GMAIL_BODY_CHAR_CAP);
  const text = capResultText(`gmail get ${sanitizeVenueText(id, 100)}\n${headerLine}\n${body}`);

  const trusted =
    codes.length > 0 || links.length > 0
      ? sanitizeVenueText(
          `extracted (deterministic, data-only): codes=[${codes.join(", ")}] links=[${links.join(", ")}]`,
          GMAIL_TRUSTED_EXTRACT_CHAR_CAP
        )
      : undefined;
  return {
    text,
    ...(trusted !== undefined ? { trustedExtract: trusted } : {}),
    ledger: {
      service: "gmail",
      op: "get",
      count: 1,
      extracted_codes: codes.length,
      extracted_links: links.length
    }
  };
}

export async function runGmailRead(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  deps: GoogleApiDeps,
  auth: GoogleAuthClient
): Promise<GmailReadResult> {
  // Defense in depth: the manifest arming couple already gates exposure, but the op re-checks
  // its own flag so a stray invocation can never fetch.
  if (!resolveGoogleEnabled(env)) {
    return { text: "gmail_read is disabled (HOUGE_GOOGLE_ENABLED is off)." };
  }
  const parsed = parseOp(input);
  if (!parsed.ok) return { text: parsed.error };
  const op = parsed.op;
  if (op.kind === "get") return runGet(op.id, deps, auth);
  return runDigestList(
    op.kind,
    // {list} is default-scoped to the inbox; {search} passes the user's query VERBATIM.
    op.kind === "search" ? op.q : LIST_INBOX_QUERY,
    clampMax(input.max),
    deps,
    auth
  );
}
