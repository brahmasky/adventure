/**
 * Deterministic GET-only allowlisted Google API transport (ADR 0025). The registry below is the
 * complete reachable surface: one row per GRANTED OAuth scope — widening it means a console
 * grant + a new row + an ADR amendment. Paths are validated by charset allowlist (encoding
 * tricks are rejected, never decoded), the host always comes from the matched registry row,
 * and the access token stays inside the auth closure — no result or error string carries it.
 *
 * The arming couple (HOUGE_GOOGLE_ENABLED AND HOUGE_DUAL_LLM_ENABLED) is composed in
 * tool-manifest.ts — this module only exposes `resolveGoogleEnabled` to avoid the codebase's
 * first `capabilities/ → core/` import edge.
 */
import { sanitizeVenueText } from "./text-hygiene.js";
import type { GoogleAuthClient } from "./google-auth.js";
import { GoogleAuthError } from "./google-auth.js";

/** One row per granted OAuth scope (ADR 0025: widening = console grant + row + ADR amendment). */
export const GOOGLE_API_REGISTRY: ReadonlyArray<{
  host: string;
  pathPrefix: string;
  oauthScope: string;
}> = [{ host: "gmail.googleapis.com", pathPrefix: "/gmail/v1/users/me/", oauthScope: "gmail.readonly" }];

export const GOOGLE_API_TIMEOUT_MS = 8_000;
export const GOOGLE_API_MAX_BYTES = 512_000;
/** Single digest cap for BOTH tools (gmail-read reuses it). MUST stay comfortably under the
 * Q-LLM READER_INPUT_CHAR_CAP (8_000, src/core/quarantine.ts) — the trusted_extract block is
 * appended post-reader so it is not at risk, but the body digest must fit the reader window. */
export const GOOGLE_RESULT_CHAR_CAP = 6_000;

/** Path charset: segments of unreserved chars only — encoding tricks are rejected, not decoded. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

export function resolveGoogleEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.HOUGE_GOOGLE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface GoogleApiDeps {
  fetchImpl: typeof fetch;
  now: () => Date;
}

export function defaultGoogleApiDeps(): GoogleApiDeps {
  return { fetchImpl: fetch, now: () => new Date() };
}

export function validateGoogleApiPath(
  rawPath: unknown
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, error: "path must be a non-empty string" };
  }
  // Reject encoding/marker characters outright — we never decode, we refuse.
  if (/[%?#\\]/.test(rawPath)) {
    return { ok: false, error: "path contains a forbidden character (%, ?, #, or backslash)" };
  }
  const candidate = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  for (const segment of candidate.slice(1).split("/")) {
    if (segment === "") return { ok: false, error: "path contains an empty segment" };
    if (segment === "." || segment === "..") return { ok: false, error: "path contains a dot segment" };
    if (!PATH_SEGMENT_RE.test(segment)) {
      return { ok: false, error: "path segment contains characters outside the allowlist" };
    }
    // v1: attachment bytes unreachable even via the escape hatch (spec: attachments ignored entirely).
    if (segment === "attachments") {
      return { ok: false, error: "attachment paths are not reachable via google_api" };
    }
  }
  if (!GOOGLE_API_REGISTRY.some((row) => candidate.startsWith(row.pathPrefix))) {
    return { ok: false, error: "path is outside the granted Google API registry" };
  }
  return { ok: true, path: candidate };
}

export interface GoogleApiResult {
  text: string;
  ledger?: { service: string; op: string; count: number };
}

type CoreOutcome =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "truncated"; status: number; bodyText: string }
  | { kind: "failure"; error: string; fetched: boolean };

function describeError(error: unknown): string {
  return error instanceof Error ? sanitizeVenueText(error.message, 200) : "unknown error";
}

function renderAuthError(error: unknown): string {
  // GoogleAuthError messages never carry secrets (google-auth.ts contract) — kind + message only.
  return error instanceof GoogleAuthError
    ? `google auth ${error.kind}: ${error.message}`
    : `google auth error: ${describeError(error)}`;
}

/** Read the body STREAMED with a running byte cap — never arrayBuffer (an oversized body would
 * be fully buffered before capping). Loop shape mirrors src/web/http-fetch.ts byte-cap loop. */
async function readBodyCapped(
  response: Response
): Promise<{ ok: true; bodyText: string; truncated: boolean } | { ok: false; error: string }> {
  const body = response.body;
  if (!body) return { ok: true, bodyText: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > GOOGLE_API_MAX_BYTES) {
        chunks.push(value.subarray(0, value.byteLength - (bytes - GOOGLE_API_MAX_BYTES)));
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, error: `google api body read failed: ${describeError(error)}` };
  }
  return { ok: true, bodyText: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function performGet(
  path: string,
  host: string,
  query: GoogleApiQuery | undefined,
  deps: GoogleApiDeps,
  auth: GoogleAuthClient
): Promise<CoreOutcome> {
  let token: string;
  try {
    token = await auth.getAccessToken();
  } catch (error) {
    return { kind: "failure", error: renderAuthError(error), fetched: false };
  }

  // Host ALWAYS from the matched registry row; query values re-encoded, never concatenated.
  const url = new URL(path, `https://${host}`);
  url.search = new URLSearchParams(
    query === undefined ? {} : isPairSequence(query) ? query.map(([k, v]) => [k, v]) : query
  ).toString();

  const attempt = (bearer: string): Promise<Response> =>
    deps.fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
      signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS)
    });

  let response: Response;
  try {
    response = await attempt(token);
  } catch (error) {
    return { kind: "failure", error: `google api request failed: ${describeError(error)}`, fetched: true };
  }

  if (response.status === 401) {
    // Dead token: drop the cache so the single retry re-mints instead of replaying it.
    auth.invalidate();
    try {
      token = await auth.getAccessToken();
    } catch (error) {
      return { kind: "failure", error: renderAuthError(error), fetched: true };
    }
    try {
      response = await attempt(token);
    } catch (error) {
      return { kind: "failure", error: `google api request failed: ${describeError(error)}`, fetched: true };
    }
    if (response.status === 401) {
      return { kind: "failure", error: "google api auth rejected (HTTP 401 after token refresh)", fetched: true };
    }
  }

  if (response.status >= 300 && response.status < 400) {
    return { kind: "failure", error: `redirect refused (HTTP ${response.status})`, fetched: true };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "failure", error: `google api returned HTTP ${response.status}`, fetched: true };
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return {
      kind: "failure",
      error: `google api returned unexpected content-type: ${sanitizeVenueText(contentType, 100) || "(none)"}`,
      fetched: true
    };
  }

  const read = await readBodyCapped(response);
  if (!read.ok) return { kind: "failure", error: read.error, fetched: true };
  if (read.truncated) return { kind: "truncated", status: response.status, bodyText: read.bodyText };

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bodyText === "" ? "null" : read.bodyText);
  } catch {
    return { kind: "failure", error: "google api response was not valid JSON", fetched: true };
  }
  return { kind: "ok", status: response.status, json: parsed };
}

// Array.isArray alone cannot narrow ReadonlyArray out of the record branch of the union.
function isPairSequence(q: GoogleApiQuery): q is ReadonlyArray<[string, string]> {
  return Array.isArray(q);
}

function findRegistryRow(path: string): { host: string; pathPrefix: string; oauthScope: string } | undefined {
  return GOOGLE_API_REGISTRY.find((row) => path.startsWith(row.pathPrefix));
}

function normalizeQuery(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A query is a plain record, or a pair sequence when a param repeats (e.g. metadataHeaders). */
export type GoogleApiQuery = Record<string, string> | ReadonlyArray<[string, string]>;

/** Internal shared GET used by gmail-read too. 401 → one re-mint+retry; else single attempt. */
export async function googleApiGetJson(
  path: string,
  query: GoogleApiQuery | undefined,
  deps: GoogleApiDeps,
  auth: GoogleAuthClient
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const validated = validateGoogleApiPath(path);
  if (!validated.ok) return { ok: false, error: validated.error };
  const row = findRegistryRow(validated.path);
  if (!row) return { ok: false, error: "path is outside the granted Google API registry" };
  const outcome = await performGet(validated.path, row.host, query, deps, auth);
  if (outcome.kind === "ok") return { ok: true, json: outcome.json };
  if (outcome.kind === "truncated") {
    return { ok: false, error: `google api response truncated at ${GOOGLE_API_MAX_BYTES} bytes` };
  }
  return { ok: false, error: outcome.error };
}

export async function runGoogleApi(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  deps: GoogleApiDeps,
  auth: GoogleAuthClient
): Promise<GoogleApiResult> {
  if (!resolveGoogleEnabled(env)) {
    return { text: "google_api is disabled (HOUGE_GOOGLE_ENABLED is off)." };
  }
  const validated = validateGoogleApiPath(input.path);
  if (!validated.ok) return { text: `google_api rejected: ${validated.error}` };
  const row = findRegistryRow(validated.path);
  if (!row) return { text: "google_api rejected: path is outside the granted Google API registry" };

  const outcome = await performGet(validated.path, row.host, normalizeQuery(input.query), deps, auth);
  const service = row.oauthScope.split(".")[0] ?? "google";
  const ledger = { service, op: "google_api", count: 1 };
  const prefix = (status: number): string => `google_api GET ${validated.path} → HTTP ${status}`;

  if (outcome.kind === "ok") {
    return {
      text: `${prefix(outcome.status)}\n${sanitizeVenueText(JSON.stringify(outcome.json), GOOGLE_RESULT_CHAR_CAP)}`,
      ledger
    };
  }
  if (outcome.kind === "truncated") {
    return {
      text: `${prefix(outcome.status)} (truncated at ${GOOGLE_API_MAX_BYTES} bytes)\n${sanitizeVenueText(
        outcome.bodyText,
        GOOGLE_RESULT_CHAR_CAP
      )}`,
      ledger
    };
  }
  // Ledger fragment only when a fetch was genuinely performed (never on validation/auth-mint rejects).
  const text = `google_api GET ${validated.path} failed: ${outcome.error}`;
  return outcome.fetched ? { text, ledger } : { text };
}
