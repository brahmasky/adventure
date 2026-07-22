# Google API Surface + Gmail Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Houge read access to his own Gmail (`wukong.houge@gmail.com`) plus a scope-bounded generic Google API GET tool, unblocking Earn-P3 venue registration.

**Architecture:** Shared OAuth refresh-token client (`google-auth.ts`) → deterministic GET-only allowlisted transport (`google-api.ts`) → ergonomic Gmail ops (`gmail-read.ts`). Two new tools (`gmail_read`, `google_api`) join `UNTRUSTED_READ_TOOLS` (ADR 0014 Q-LLM quarantine) and are armed only when `HOUGE_GOOGLE_ENABLED` AND `HOUGE_DUAL_LLM_ENABLED` are both on (both already on in prod). Secrets flow through the broker (ADR 0015), never `process.env` post-strip.

**Tech Stack:** TypeScript strict ESM (NodeNext — all imports need `.js` suffix), zero runtime deps, vitest, global `fetch`.

**Spec:** `docs/superpowers/specs/2026-07-22-google-api-gmail-read-design.md`
**Execution constraints (Paco):** subagent-first build → adversarial review subagent → live verification, all via subagents. Task dependency graph: T0, T1, T2, T3, T6 independent (parallel fan-out) → T4 (needs T2+T3) → T5 (needs T4) → T7 (needs all) → T8 → T9 → T10 → T11.

**Repo invariants that MUST hold (recon-verified 2026-07-22):**
- `exactOptionalPropertyTypes: true` — use `...(x ? { x } : {})` spread idiom, never pass `undefined` explicitly.
- Migration-count assertion `toBe(17)` in `tests/run/run-store-approvals.test.ts:585-592` stays untouched (no new table).
- `fetchUrl` (`src/web/http-fetch.ts`) never sends auth headers BY DESIGN — do not modify it; google-api gets its own pinned transport.
- `requiredPayloadFields` in `src/run/run-ledger.ts` has `satisfies Record<LedgerEventType, …>` — new event type without a fields entry = compile error (this is the exhaustiveness gate; no other switch exists).
- Env flags read LIVE per call (`manifestFor(..., process.env)`); tests must pin+restore env (PINNED_ENV pattern, `tests/capabilities/bounty-intake.test.ts:28-45`).

---

### Task 0: ADR 0025

**Files:**
- Create: `docs/decisions/0025-google-api-surface.md`
- Modify: `docs/decisions/README.md` (append index row)

- [ ] **Step 1: Write ADR** — status accepted, decider Paco (2026-07-22 session). Must contain: (a) the S33 2026-07-19 amendment made durable: Houge is authorized to use `wukong.houge@gmail.com` for venue registration, reading his own inbox for verification codes/links; (b) general inbox read + generic GET surface decision with blast-radius argument (OAuth scope `gmail.readonly` bounds everything; tool adds GET-only + exact allowlist registry); (c) scope-widening rule: new Google service = console OAuth grant (Paco) + registry row (code review) + ADR amendment, 1:1 scope↔row (ADR 0008 §5); (d) quarantine decision: both tools in `UNTRUSTED_READ_TOOLS`, NO bounty-style carve-out (mail bodies are free hostile text, not structured fields), plus the arming couple (tools require dual-LLM armed); (e) residual risk recorded honestly: email→http_fetch chain (lethal-trifecta shape) accepted for v1 — mitigations: Q-LLM quarantine, env stripped of secrets, external_write/paid human-gated; (f) broker extension note amending ADR 0015's "exact five" to seven, including two recorded exceptions: the firewall-OFF env fallback in the core-worker getters (same idiom as `llm/registry.ts:122`) and ACCESS-token containment being closure-only (the runtime-minted `ya29.*` never joins the boot redactor — unit tests + T9 adversarial probe are the compensating controls); (g) the `trusted_extract` post-quarantine side-channel decision: deterministic code-built codes/links line appended AFTER the reader digest — same trust argument as `time_claims` (structured, hygiened, hard-capped, no free text, no verb); links remain attacker-controlled DATA under the already-accepted (e) residual; (h) no per-run throttle (unlike bounty's 10-min window) is a DECISION: bounded by `max_tool_calls` 14/turn, ≤26 sequential fetches/op, 75 s deadline, 429→halt; revisit if Gmail polling ever becomes a schedule cadence.
- [ ] **Step 2: Add row to `docs/decisions/README.md` index** (follow 0024's row format).
- [ ] **Step 3: Commit** — `docs(adr): ADR 0025 — Google API surface + Gmail read, S33 registration authorization made durable`

---

### Task 1: Secret broker — two Gmail secrets

**Files:**
- Modify: `src/config/secret-broker.ts`
- Test: `tests/config/secret-broker.test.ts`

- [ ] **Step 1: Extend tests first.** In `tests/config/secret-broker.test.ts`: add to `FAKE`:
```ts
  HOUGE_GMAIL_CLIENT_SECRET: "GOCSPX-fake-gmail-client-secret-123",
  HOUGE_GMAIL_REFRESH_TOKEN: "1//fake-gmail-refresh-token-456789"
```
Add to the getter test: `expect(b.gmailClientSecret()).toBe(FAKE.HOUGE_GMAIL_CLIENT_SECRET);` and same for `gmailRefreshToken()`. In the redact test, assert a string containing both values comes back with both replaced by `REDACTED_PLACEHOLDER`. Update the strip test title `"deletes the exact five secret names"` → `"deletes the exact seven secret names"` (body is loop-driven over `SECRET_ENV_NAMES`, already covers them).
- [ ] **Step 2: Run** `npx vitest run tests/config/secret-broker.test.ts` — expect FAIL (`gmailClientSecret is not a function`).
- [ ] **Step 3: Implement.** In `src/config/secret-broker.ts`:
  - `SECRET_ENV_NAMES` += `"HOUGE_GMAIL_CLIENT_SECRET"`, `"HOUGE_GMAIL_REFRESH_TOKEN"` (update doc comments: "five" → "seven", both in the file header and above the const).
  - `SecretBroker` interface += `gmailClientSecret(): string | undefined;` and `gmailRefreshToken(): string | undefined;`
  - In `createSecretBroker`: capture `const gmailClientSecret = env.HOUGE_GMAIL_CLIENT_SECRET;` / `const gmailRefreshToken = env.HOUGE_GMAIL_REFRESH_TOKEN;`, add both to the `redactable` array filter input, add both getters to the returned object.
- [ ] **Step 4: Run** the test file — expect PASS. Also run `npx vitest run tests/config/` (firewall wiring suite must stay green).
- [ ] **Step 5: Commit** — `feat(firewall): broker getters for the two Gmail OAuth secrets (ADR 0015 five→seven)`

---

### Task 2: Extract shared text hygiene

**Files:**
- Create: `src/capabilities/text-hygiene.ts`
- Modify: `src/capabilities/bounty-intake.ts` (import instead of define; re-export `sanitizeVenueText` so existing importers/tests are untouched)
- Test: existing `tests/capabilities/bounty-intake.test.ts` MUST stay green unchanged (that is the acceptance test)

- [ ] **Step 1: Create `src/capabilities/text-hygiene.ts`** — move VERBATIM from `bounty-intake.ts` (behavior byte-identical):
```ts
/**
 * Shared text hygiene for external/hostile strings (extracted verbatim from bounty-intake,
 * spec 2026-07-22 §5). Every string derived from an external venue, API response, or mail
 * body passes through here before entering any digest, ledger line, or Telegram render.
 */

// C0/C1 controls, bidi overrides/isolates, zero-width + BOM.
// CRITICAL: move STRIP_RE, the newline-flatten regex, and this whole function
// CHARACTER-FOR-CHARACTER from src/capabilities/bounty-intake.ts lines 114-121.
// The escape forms are: STRIP_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g
// and flatten = /[\r\n\t\u2028\u2029\u0085]+/g. Do NOT retype from this plan --
// cut the source lines so the bytes cannot drift (the U+2028 tests will catch drift anyway).
const STRIP_RE = /* moved verbatim from bounty-intake.ts */;

export function sanitizeVenueText(raw: unknown, maxChars: number): string {
  /* moved verbatim from bounty-intake.ts */
}

export function escapeForTelegram(text: string): string {
  // External strings are rendered inert: no markdown/link spoofing.
  return text.replace(/([[\]()*_`~])/g, "");
}
```
- [ ] **Step 2: In `bounty-intake.ts`:** delete the two definitions + `STRIP_RE`; add `import { escapeForTelegram, sanitizeVenueText } from "./text-hygiene.js";` and `export { sanitizeVenueText };` (keeps `tests/capabilities/bounty-intake.test.ts:20` import path working).
- [ ] **Step 3: Run** `npx vitest run tests/capabilities/bounty-intake.test.ts` — expect PASS with ZERO test edits (hygiene tests at lines 152/159/487 are the extraction guard).
- [ ] **Step 4: Run** `npm run typecheck` — expect clean.
- [ ] **Step 5: Commit** — `refactor(hygiene): extract sanitizeVenueText/escapeForTelegram to shared text-hygiene module (byte-identical)`

---

### Task 3: `google-auth.ts` — OAuth refresh client

**Files:**
- Create: `src/capabilities/google-auth.ts`
- Test: `tests/capabilities/google-auth.test.ts`

- [ ] **Step 1: Write failing tests** (`tests/capabilities/google-auth.test.ts`). Conventions: fake `fetchImpl` via `vi.fn()`, deterministic `now`, no wall-clock waits. Cases:
```ts
import { describe, expect, it, vi } from "vitest";
import { createGoogleAuthClient, GOOGLE_TOKEN_ENDPOINT, TOKEN_EXPIRY_MARGIN_MS } from "../../src/capabilities/google-auth.js";

function okToken(token: string, expiresIn = 3600) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }), { status: 200 });
}
const CONFIG = { clientId: "cid.apps.googleusercontent.com", clientSecret: () => "GOCSPX-fake", refreshToken: () => "1//fake" };

describe("createGoogleAuthClient", () => {
  it("mints an access token via the refresh grant (endpoint, form body, no token in errors)", async () => {
    const fetchImpl = vi.fn(async () => okToken("ya29.first"));
    let t = 1_000_000;
    const client = createGoogleAuthClient(CONFIG, { fetchImpl, now: () => t });
    expect(await client.getAccessToken()).toBe("ya29.first");
    expect(fetchImpl.mock.calls[0]![0]).toBe(GOOGLE_TOKEN_ENDPOINT);
    const body = String(fetchImpl.mock.calls[0]![1]!.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=1%2F%2Ffake");
  });
  it("caches until expiry margin, re-mints after", async () => { /* two getAccessToken calls same t => 1 fetch; advance t past (3600s - margin) => 2nd fetch */ });
  it("single-flight: concurrent callers share one in-flight refresh", async () => { /* deferred fetch promise, two parallel getAccessToken, resolve, assert fetchImpl called once */ });
  it("invalid_grant → GoogleAuthError kind auth_failed, message NEVER contains the refresh token", async () => { /* 400 {error:"invalid_grant"}; catch e; expect(e.kind).toBe("auth_failed"); expect(e.message).not.toContain("1//fake") */ });
  it("network failure → kind unavailable and does not poison the cache (next call retries)", async () => { /* first fetch rejects, second succeeds */ });
  it("missing clientSecret/refreshToken → auth_failed without any fetch", async () => { /* clientSecret: () => undefined; expect(fetchImpl).not.toHaveBeenCalled() */ });
  it("invalidate() clears the cache so the next getAccessToken re-mints (401-recovery seam)", async () => { /* mint "ya29.a", getAccessToken again same t => still 1 fetch; client.invalidate(); getAccessToken => 2nd fetch, "ya29.b" (SENIOR-REVIEW BLOCKER 2: without invalidate, a mid-window revocation bricks every op for ~55 min) */ });
});
```
Fill the sketched bodies out fully — each comment above is the complete behavior to assert.
- [ ] **Step 2: Run** `npx vitest run tests/capabilities/google-auth.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement `src/capabilities/google-auth.ts`:**
```ts
/**
 * Service-agnostic Google OAuth client (ADR 0025). Holds the refresh-token machinery ONCE so
 * later Google services (Calendar, Drive) reuse it behind new scope grants. The access token
 * lives and dies inside this closure — it is never returned in errors, digests, or ledger rows.
 * Secrets arrive as GETTERS (broker-fed when the firewall is armed, env-fallback otherwise).
 */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** Refresh this long before Google's stated expiry (defensive margin). */
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
export const TOKEN_FETCH_TIMEOUT_MS = 10_000;

export interface GoogleAuthConfig {
  clientId: string | undefined;
  clientSecret: () => string | undefined;
  refreshToken: () => string | undefined;
}
export interface GoogleAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}
export type GoogleAuthErrorKind = "auth_failed" | "unavailable";
export class GoogleAuthError extends Error {
  constructor(public readonly kind: GoogleAuthErrorKind, message: string) { super(message); this.name = "GoogleAuthError"; }
}
export interface GoogleAuthClient {
  getAccessToken(): Promise<string>;
  /** Drop the cached access token (does NOT abort an in-flight mint). Callers use this on a
   * 401 so the single retry re-mints instead of replaying the same dead token. */
  invalidate(): void;
}

export function createGoogleAuthClient(config: GoogleAuthConfig, deps: GoogleAuthDeps = {}): GoogleAuthClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const clientSecret = config.clientSecret();
    const refreshToken = config.refreshToken();
    if (!config.clientId || !clientSecret || !refreshToken) {
      throw new GoogleAuthError("auth_failed", "google oauth credentials not configured");
    }
    let response: Response;
    try {
      response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
        signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS)
      });
    } catch {
      throw new GoogleAuthError("unavailable", "google token endpoint unreachable");
    }
    // Never echo the response body on 4xx: it can quote our request params. Status only.
    if (!response.ok) {
      const kind: GoogleAuthErrorKind = response.status >= 500 ? "unavailable" : "auth_failed";
      throw new GoogleAuthError(kind, `google token refresh rejected (HTTP ${response.status})`);
    }
    const parsed: unknown = await response.json().catch(() => undefined);
    const token = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).access_token : undefined;
    const expiresIn = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).expires_in : undefined;
    if (typeof token !== "string" || token.length === 0) throw new GoogleAuthError("auth_failed", "google token response missing access_token");
    const ttlMs = (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600) * 1000;
    cached = { token, expiresAt: now() + Math.max(ttlMs - TOKEN_EXPIRY_MARGIN_MS, 60_000) };
    return token;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (cached && cached.expiresAt > now()) return cached.token;
      if (!inflight) inflight = mint().finally(() => { inflight = undefined; });
      return inflight;
    },
    invalidate(): void {
      cached = undefined;
    }
  };
}
```
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** — `feat(google): service-agnostic OAuth refresh client — cached, single-flight, secret-silent errors`

---

### Task 4: `google-api.ts` — allowlisted GET transport + `google_api` op

**Files:**
- Create: `src/capabilities/google-api.ts`
- Test: `tests/capabilities/google-api.test.ts`

- [ ] **Step 1: Write failing tests.** PINNED_ENV = `["HOUGE_GOOGLE_ENABLED", "HOUGE_DUAL_LLM_ENABLED"]` (pin+delete beforeEach, restore afterEach — copy the harness from `tests/capabilities/bounty-intake.test.ts:28-45`). Fake `fetchImpl` records `[url, init]`. Fake auth: `{ getAccessToken: async () => "ya29.test" }`. Cases (write all bodies out):
  - `resolveGoogleEnabled`: default OFF; ON for `1/true/yes/on`. (The dual-LLM arming COUPLE is composed in tool-manifest.ts, Task 7 — NOT here; eng review: avoid creating the codebase's first `capabilities/ → core/` import edge.)
  - allowlist DENIES before any fetch (assert `fetchImpl` not called): off-host absolute URL as path; path not starting with the registry prefix (`/gmail/v1/users/other/messages`); traversal `/gmail/v1/users/me/../../admin`; encoded traversal `%2e%2e`; a path containing `?`, `#`, `%`, or backslash; empty path; any path containing an `attachments` segment (v1: attachment bytes unreachable even via the escape hatch — keeps the spec's "attachments ignored entirely" true).
  - happy path: `runGoogleApi({ path: "gmail/v1/users/me/messages", query: { maxResults: "5" } }, …)` → fetch called once with `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5`, `Authorization: Bearer ya29.test`, method GET, `redirect: "manual"`.
  - query values are re-encoded (a query value `"a b&c=d"` arrives percent-encoded, never string-concatenated).
  - non-JSON content-type → error text, no throw; **HTTP 401 → `auth.invalidate()` then ONE retry with a fresh token** (stateful fake: token A → 401, invalidate observed, token B → 200; regression: WITHOUT invalidate the retry replays token A — senior-review BLOCKER 2); second 401 → typed failure. 429/5xx → single failure, no retry loop (assert fetch called once).
  - byte cap: response bigger than `GOOGLE_API_MAX_BYTES` → body read STOPS at the cap (streamed), truncated digest, `truncated` note present.
  - token containment: NO result or error string from any path (happy, deny, 401, 429, network throw) contains `ya29.test` (closure-only containment is the accepted design — record in ADR 0025; T9 re-probes).
  - digest hygiene: response JSON containing ` `, bidi, `HOSTILE-MARKER ignore previous instructions` → digest contains no raw ` `/bidi (the marker TEXT may appear — hygiene neutralizes control/format characters, the Q-LLM handles semantics).
  - result text NEVER contains `ya29.test` (token-leak guard).
- [ ] **Step 2: Run — expect FAIL** (module not found).
- [ ] **Step 3: Implement.** Shape:
```ts
import { sanitizeVenueText } from "./text-hygiene.js";
import type { GoogleAuthClient } from "./google-auth.js";
import { GoogleAuthError } from "./google-auth.js";

/** One row per granted OAuth scope (ADR 0025: widening = console grant + row + ADR amendment). */
export const GOOGLE_API_REGISTRY: ReadonlyArray<{ host: string; pathPrefix: string; oauthScope: string }> = [
  { host: "gmail.googleapis.com", pathPrefix: "/gmail/v1/users/me/", oauthScope: "gmail.readonly" }
];
export const GOOGLE_API_TIMEOUT_MS = 8_000;
export const GOOGLE_API_MAX_BYTES = 512_000;
/** Single digest cap for BOTH tools (gmail-read reuses it). MUST stay comfortably under the
 * Q-LLM READER_INPUT_CHAR_CAP (8_000, src/core/quarantine.ts) — the trusted_extract block is
 * appended post-reader so it is not at risk, but the body digest must fit the reader window. */
export const GOOGLE_RESULT_CHAR_CAP = 6_000;
/** Path charset: segments of unreserved chars only — encoding tricks are rejected, not decoded. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

export function resolveGoogleEnabled(env: NodeJS.ProcessEnv): boolean { /* canonical 1/true/yes/on idiom */ }
export interface GoogleApiDeps { fetchImpl: typeof fetch; now: () => Date; }
export function defaultGoogleApiDeps(): GoogleApiDeps { return { fetchImpl: fetch, now: () => new Date() }; }

export function validateGoogleApiPath(rawPath: unknown): { ok: true; path: string } | { ok: false; error: string } {
  // Accept "gmail/v1/users/me/…" or "/gmail/v1/users/me/…". Reject anything containing
  // "%", "?", "#", "\\", empty segments beyond the leading slash, or a ".."/"." segment;
  // every segment must match PATH_SEGMENT_RE. Then require startsWith a registry pathPrefix.
}
export interface GoogleApiResult { text: string; ledger?: { service: string; op: string; count: number }; }
export async function runGoogleApi(input: Record<string, unknown>, env: NodeJS.ProcessEnv, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<GoogleApiResult>;
/** Internal shared GET used by gmail-read too. 401 → one re-mint+retry; else single attempt. */
export async function googleApiGetJson(path: string, query: Record<string, string> | undefined, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<{ ok: true; json: unknown } | { ok: false; error: string }>;
```
Implementation notes (bind these exactly): host comes from the MATCHED REGISTRY ROW (never from input); URL built as `new URL(path, "https://" + row.host)` then `url.search = new URLSearchParams(query ?? {}).toString()`; fetch options `{ method: "GET", redirect: "manual", headers: { authorization: "Bearer " + token, accept: "application/json" }, signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS) }`; 3xx counts as failure (`redirect refused`); body read STREAMS via `response.body.getReader()` with a running byte count that STOPS at `GOOGLE_API_MAX_BYTES` (copy the loop shape from `src/web/http-fetch.ts:527-536` — `arrayBuffer()` would buffer a whole oversized body before capping; eng review); auth is ALWAYS the explicit last parameter of `runGoogleApi`/`googleApiGetJson` — never a deps field (one channel only); `runGoogleApi` digest = `sanitizeVenueText(JSON.stringify(parsed), GOOGLE_RESULT_CHAR_CAP)` prefixed by `"google_api GET <path> → HTTP <status>"`; `GoogleAuthError` is caught and rendered as its `kind` + message (which never carries secrets); ledger fragment `{ service: "gmail", op: "google_api", count: 1 }` only on a genuinely performed fetch (not on validation rejects).
- [ ] **Step 4: Run — expect PASS.** Also `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(google): GET-only allowlisted google-api transport + google_api op (registry = granted scopes)`

---

### Task 5: `gmail-read.ts` — list / search / get + verification extraction

**Files:**
- Create: `src/capabilities/gmail-read.ts`
- Test: `tests/capabilities/gmail-read.test.ts`

- [ ] **Step 1: Write failing tests.** Fixture builders: `listResponse(ids)`, `metadataMessage(id, {from, subject, date, snippet})`, `fullMessage(id, {parts})` with realistic Gmail payload shapes (base64url-encoded `body.data`, nested `multipart/alternative` parts). Fake deps route by URL substring (bounty `fakeDeps` pattern). Cases (write all bodies out):
  - `{list:true}`: fetches `messages?maxResults=10`, then per-id metadata (`format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`); digest = one line per message `from — subject — date — snippet`, all through hygiene; `max` clamped to `GMAIL_LIST_MAX` (25) and floor 1.
  - `{search:"from:algora.io"}`: same but with `q` param, asserted percent-encoded.
  - `{get:"abc123"}`: multipart fixture → prefers `text/plain` part; HTML-only fixture → tags stripped; body capped at `GMAIL_BODY_CHAR_CAP` code points; base64url decode correct for `-`/`_` chars.
  - extraction: body containing `Your verification code is 482913` and `https://venue.example/verify?token=xyz` -> `extracted` result lists code `482913` and the URL byte-exact; alphanumeric OTP shape (`Your code: XK7Q9P`) also extracted; **proximity ranking**: a candidate near a verification keyword (code|verification|verify|OTP|\u4e00\u6b21\u6027|\u9a8c\u8bc1\u7801, case-insensitive, within 80 chars) outranks decoys -- fixture with SIX decoy numbers (year, price, zip, port, phone fragment, order number) BEFORE the real code must still surface it within the cap; codes capped at 5 POST-ranking, links at 10, links length-capped at 300 chars, deduped; hostile body with U+2028 + bidi override chars -> no raw control chars anywhere.
  - `trusted_extract` side-channel (SENIOR-REVIEW BLOCKER 1): `{get}` returns `trustedExtract: "extracted (deterministic, data-only): codes=[482913] links=[https://...]"` as a SEPARATE field from `text` -- sanitized (NOT escapeForTelegram'd: links must stay byte-exact), hard-capped at `GMAIL_TRUSTED_EXTRACT_CHAR_CAP` (600). Empty extraction -> field absent.
  - Telegram inertness: from/subject/snippet lines in `text` pass `escapeForTelegram` (hostile subject `[click here](https://evil)` fixture renders without markdown link syntax). Body text: hygiene only (the planner sees it through the Q-LLM anyway).
  - exactly-one-op validation: zero ops or two ops → `{ ok: false }`-style error text, NO fetch.
  - hostile snippet/subject fixture (`HOSTILE-MARKER` + bidi in subject) → digest flattened/stripped (same guarantee as bounty `normalizeSearchItem` test at `bounty-intake.test.ts:187`).
  - error propagation: transport error string surfaces in text, no throw; ledger fragment `{ service:"gmail", op:"list"|"search"|"get", count:<messages fetched> }`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Shape:
```ts
import { sanitizeVenueText } from "./text-hygiene.js";
import { googleApiGetJson, type GoogleApiDeps } from "./google-api.js";
import type { GoogleAuthClient } from "./google-auth.js";

export const GMAIL_LIST_DEFAULT = 10;
export const GMAIL_LIST_MAX = 25;
export const GMAIL_BODY_CHAR_CAP = 4_000;
export const GMAIL_OP_DEADLINE_MS = 75_000; // exported — core-worker imports it (Task 7)
export const GMAIL_EXTRACT_MAX_CODES = 5;
export const GMAIL_EXTRACT_MAX_LINKS = 10;
export const GMAIL_LINK_CHAR_CAP = 300;
export const GMAIL_TRUSTED_EXTRACT_CHAR_CAP = 600;
// Digest cap: reuse GOOGLE_RESULT_CHAR_CAP from google-api.ts (single constant, one 6k number).

/**
 * Deterministic verification extraction — the registration trust anchor (spec §4).
 * Candidates: numeric 4-8 digits, or uppercase alphanumeric 6-10 chars containing >=1 digit.
 * Ranked by proximity to a verification keyword (code|verification|verify|OTP|一次性|验证码,
 * case-insensitive, within 80 chars) — keyword-near candidates first, then appearance order.
 * Caps applied AFTER ranking so decoy numbers (years, prices, zips) cannot evict a real code.
 */
export function extractVerification(rawBody: string): { codes: string[]; links: string[] };
export function decodeMessageBody(payload: unknown): string; // walk parts, prefer text/plain, fallback html tag-strip, base64url via Buffer.from(data, "base64url")
export interface GmailReadResult {
  text: string;
  /** Deterministic post-quarantine side-channel (ADR 0025): codes/links the planner may use
   * verbatim. Sanitized + capped; NEVER escapeForTelegram'd (links must stay byte-exact). */
  trustedExtract?: string;
  ledger?: { service: string; op: string; count: number; extracted_codes: number; extracted_links: number };
}
export async function runGmailRead(input: Record<string, unknown>, env: NodeJS.ProcessEnv, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<GmailReadResult>;
```
HTML strip order: remove `<style>…</style>` and `<script>…</script>` blocks first, then all tags → spaces, then hygiene. `{get}` layout: `text` = headers block (escapeForTelegram'd) + body (hygiened, capped at `GMAIL_BODY_CHAR_CAP`); `trustedExtract` = the codes/links block, computed from the RAW decoded body BEFORE the char cap (a code past the cap still surfaces). Exactly-one-op check mirrors schedule_task's verb validation style. All fetches sequential with the overall soft deadline `GMAIL_OP_DEADLINE_MS` checked between messages (bail with partial digest + note, matching bounty deadline posture). On `GoogleAuthError` kind `auth_failed`, the result text MUST end with the operator runbook hint: `"(operator: Gmail refresh token likely revoked — re-run scripts/gmail-auth.mjs)"` — this is the minimum alert path (senior review); documented in T10.
- [ ] **Step 4: Run — expect PASS.** `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `feat(gmail): gmail-read ops (list/search/get) with deterministic verification extraction`

---

### Task 6: Ledger event `google_api_call_completed`

**Files:**
- Modify: `src/run/run-ledger.ts` (union, line ~59 region; `requiredPayloadFields`, line ~194 region)
- Modify: `src/run/run-store.ts` (emitter next to `recordBountyScanCompleted`, line ~3299)
- Test: extend `tests/run/` alongside the existing bounty ledger tests (find `recordBountyScanCompleted` usages and mirror)

- [ ] **Step 1: Write failing test** — record a `google_api_call_completed` via the new `recordGoogleApiCallCompleted({ run_id, service: "gmail", op: "get", count: 1, extracted_codes: 1, extracted_links: 2 })`, read back the ledger row, assert event_type + payload fields; assert a payload MISSING `count` throws the validation error. (extracted_* counts are what make live-gate 3.2 verifiable from a persisted surface — senior review; they are ZERO for list/search/google_api ops.)
- [ ] **Step 2: Run — expect FAIL** (compile error is acceptable as the failure).
- [ ] **Step 3: Implement:** union member `| "google_api_call_completed"`; fields entry `google_api_call_completed: ["service", "op", "count", "extracted_codes", "extracted_links"],`; `RunStore.recordGoogleApiCallCompleted(input: { run_id: string; service: string; op: string; count: number; extracted_codes: number; extracted_links: number }): void` calling `this.appendRunLedgerEvent(input.run_id, "google_api_call_completed", "core", { service: input.service, op: input.op, count: input.count, extracted_codes: input.extracted_codes, extracted_links: input.extracted_links })`. The `satisfies` clause enforces exhaustiveness — if compile passes, the surface is complete (recon: no other switch exists).
- [ ] **Step 4: Run — expect PASS.** Full `tests/run/` green; migration count untouched.
- [ ] **Step 5: Commit** — `feat(ledger): google_api_call_completed event (counts/ids only — never mail content)`

---

### Task 7: Wire the two tools end-to-end

**Files:**
- Modify: `src/core/quarantine.ts:35` (`UNTRUSTED_READ_TOOLS`) — NOTE: marked Paco-hand-only for Houge's self-write; session edit is fine.
- Modify: `src/core/inner-loop.ts:481-487` (trusted_extract append seam — see Step 3)
- Modify: `src/core/tool-manifest.ts` (two descriptors + imports; the arming COUPLE is composed HERE)
- Modify: `src/contracts/task-contract.ts` (turnActions, line ~217)
- Modify: `src/config/disarm-posture.ts` (`DISARM_FLAGS` += `"HOUGE_GOOGLE_ENABLED"`)
- Modify: `src/core/core-worker.ts` (imports; trailing constructor deps; `loopToolExecute` branch; `loopToolTimeoutMs` cases; `resultCharCapFor`)
- Tests: `tests/core/tool-manifest.test.ts`, `tests/contracts/task-contract.test.ts:75-81`, `tests/core/core-worker-turn-loop.test.ts`, `tests/core/quarantine.test.ts`, **`tests/config/disarm-posture.test.ts:49` (ENG-REVIEW BLOCKER: exact-array assertion over `DISARM_FLAGS` — append `"HOUGE_GOOGLE_ENABLED"` to the expected list or Task 8 stalls)**

- [ ] **Step 1: Write failing tests first:**
  - manifest: `gmail_read`/`google_api` absent by default; present when BOTH `HOUGE_GOOGLE_ENABLED=1` and `HOUGE_DUAL_LLM_ENABLED=1`; absent when only one is set (three assertions — the couple is the point).
  - contract: add both names to the exact-array assertion (`task-contract.test.ts:75`); `max_tool_calls` stays 14.
  - turn-loop: `"gmail_read disarmed (default): unlisted in the manifest and denied when invoked anyway"` (copy the http_fetch disarm test pattern at `core-worker-turn-loop.test.ts:438`). NOTE for the THE-WALL/turn-loop cases: `googleDeps` is the LAST constructor positional — the test must thread `undefined` placeholders through the preceding optional args to inject it; do NOT mock global `fetch` (that would also intercept the token refresh and make the test lie).
  - quarantine THE-WALL: `UNTRUSTED_READ_TOOLS` contains `web_search`, `http_fetch`, `gmail_read`, `google_api` (`has()`-based, additive-safe); new case: armed `gmail_read` with a hostile mail fixture → injected body bytes NEVER survive into the planner digest, AND the `trusted_extract` block IS appended after the reader digest (both assertions in one test — the side-channel must not become a bypass for body text; only the code-built codes/links line rides it).
  - disarm-posture: expected exact array gains `"HOUGE_GOOGLE_ENABLED"`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement:**
  - `quarantine.ts:35`: `new Set(["web_search", "http_fetch", "gmail_read", "google_api"])` + one comment line citing ADR 0025 (mail/API bodies are free hostile text — no bounty-style carve-out).
  - `inner-loop.ts` trusted_extract seam (SENIOR-REVIEW BLOCKER 1 — the ~10-line version): in the quarantine branch at lines 481-487, after the reader summary is capped into `resultDigest`, append the deterministic side-channel if the tool provided one:
```ts
    if (deps.quarantineReader && input.quarantineReadActions?.(action.action)) {
      const summary = await deps.quarantineReader(action.action, result.output, input.objective);
      resultDigest = summary.length > stepCharCap ? `${summary.slice(0, stepCharCap)}…` : summary;
      // ADR 0025: deterministic post-quarantine side-channel. Code-built, hygiened, hard-capped
      // upstream (600 chars); carries verification codes/links VERBATIM because the Q-LLM may
      // not (same trust argument as time_claims: structured, no free text, no verb).
      const trusted = (result.output as Record<string, unknown>)["trusted_extract"];
      if (typeof trusted === "string" && trusted.length > 0) {
        resultDigest = `${resultDigest}\n${trusted.slice(0, 600)}`;
      }
    } else { …existing else branch unchanged… }
```
  - `tool-manifest.ts`: `import { resolveGoogleEnabled } from "../capabilities/google-api.js";` plus `resolveDualLlmEnabled` (already exported from `./quarantine.js` — core→core, no new cross-layer edge; eng review). The couple lives on the descriptors: `armed: (env) => resolveGoogleEnabled(env) && resolveDualLlmEnabled(env)`. Two descriptors:
```ts
  // ADR 0025: Houge's Google identity surface. Both are external READs quarantined by the
  // Q-LLM (UNTRUSTED_READ_TOOLS — mail is free hostile text, NOT a bounty-style deterministic
  // digest); armed only when HOUGE_GOOGLE_ENABLED and the dual-LLM reader are BOTH on.
  gmail_read: {
    name: "gmail_read",
    description:
      "Read Houge's own Gmail inbox (wukong.houge@gmail.com, read-only). Ops: list recent messages, search with Gmail query syntax, or get one message body. get returns an 'extracted' block of verification codes/links found deterministically — use those verbatim for registrations, never retype them from the body.",
    inputSketch: '{"list": true} | {"search": "<gmail query>"} | {"get": "<messageId>"} (+ optional "max": 1-25)',
    category: "tool",
    side_effect_level: "external_read",
    risk_level: "medium",
    output_limit_bytes: 200_000,
    armed: (env) => resolveGoogleEnabled(env) && resolveDualLlmEnabled(env)
  },
  google_api: {
    name: "google_api",
    description:
      "GET a Google API endpoint under Houge's own identity. Allowlisted paths only (today: gmail/v1/users/me/*). Returns the JSON response as a sanitized digest. Prefer gmail_read for mail — this is the raw escape hatch.",
    inputSketch: '{"path": "gmail/v1/users/me/…", "query": {"k": "v"}?}',
    category: "tool",
    side_effect_level: "external_read",
    risk_level: "medium",
    output_limit_bytes: 200_000,
    armed: (env) => resolveGoogleEnabled(env) && resolveDualLlmEnabled(env)
  },
```
  - `task-contract.ts` turnActions: `"gmail_read", "google_api",` after the bounty block with a `// ADR 0025` comment. Turn contract only (mirror bounty precedent).
  - `disarm-posture.ts`: append `"HOUGE_GOOGLE_ENABLED"` with comment `// ADR 0025: acts under Houge's own Google identity — the STOP switch must cover identity reads too.`
  - `core-worker.ts`: trailing constructor param `private readonly googleDeps: GoogleApiDeps = defaultGoogleApiDeps()`; lazy per-worker auth client built on first use:
```ts
  private googleAuth?: GoogleAuthClient;
  private googleAuthClient(): GoogleAuthClient {
    if (!this.googleAuth) {
      this.googleAuth = createGoogleAuthClient({
        clientId: process.env.HOUGE_GMAIL_CLIENT_ID,
        clientSecret: () => (this.broker ? this.broker.gmailClientSecret() : process.env.HOUGE_GMAIL_CLIENT_SECRET),
        refreshToken: () => (this.broker ? this.broker.gmailRefreshToken() : process.env.HOUGE_GMAIL_REFRESH_TOKEN)
      }, { fetchImpl: this.googleDeps.fetchImpl });
    }
    return this.googleAuth;
  }
```
    `loopToolExecute` branch:
```ts
    if (name === "gmail_read" || name === "google_api") {
      // ADR 0025: quarantined external reads of Houge's own Google identity. The ledger row
      // carries counts only — never mail content, never tokens.
      return async (input) => {
        const result = name === "gmail_read"
          ? await runGmailRead(input, process.env, this.googleDeps, this.googleAuthClient())
          : await runGoogleApi(input, process.env, this.googleDeps, this.googleAuthClient());
        if (result.ledger) this.runStore.recordGoogleApiCallCompleted({ run_id: claim.run_id, ...result.ledger });
        return { ok: true, output: { answer: result.text } };
      };
    }
```
    `loopToolTimeoutMs`: `case "gmail_read": case "google_api": return GMAIL_OP_DEADLINE_MS + 15_000;`
    `resultCharCapFor`: both names → `GOOGLE_RESULT_CHAR_CAP` (the single shared 6k constant from google-api.ts).
- [ ] **Step 4: Run** the four test files, then `npm run typecheck` — expect PASS/clean.
- [ ] **Step 5: Commit** — `feat(tools): gmail_read + google_api wired — quarantined, dual-LLM-coupled, disarm-covered (ADR 0025)`

---

### Task 8: Full green + push

- [ ] **Step 1:** `npm run build` — clean.
- [ ] **Step 2:** `npx vitest run` — ALL tests green (baseline was 1708; expect ~1750+). Any failure: fix forward within the task's file scope; if a fix crosses scope, stop and surface.
- [ ] **Step 3:** `git push` (feature is dark: `HOUGE_GOOGLE_ENABLED` unset in prod until Task 11).

---

### Task 9: Adversarial review (subagent) — gate before arming

- [ ] **Step 1: Dispatch an adversarial review subagent** with the spec + ADR 0025 + full diff (`git diff <pre-task-0>..HEAD`). Charge: try to BREAK it — verdict REJECT/SHIP with findings. Attack surfaces to probe explicitly: (a) path validation bypass (encodings, unicode normalization, absolute URLs, backslashes, host confusion via `new URL` base behavior); (b) token leak channels (error text, digest, ledger payload, redactor coverage of the ACCESS token — it is NOT in the boot-time redactable set, verify closure containment); (c) quarantine bypass (any path where mail bytes reach the planner un-quarantined while armed — including the `extracted` block: codes/links are attacker-controlled DATA, verify caps + hygiene make them inert); (d) U+2028 frame forgery + bidi in subject/snippet/body; (e) flag-couple bypass (tool callable with dual-LLM off via any contract path); (f) throttle/budget abuse (unbounded message fetch loops); (g) `extracted` links as an exfil/redirect lure (verify they are rendered inert for Telegram).
- [ ] **Step 2:** Every finding: fix + regression test (fresh subagent per fix), or written accept-rationale in the ADR. REJECT verdict = loop until SHIP.
- [ ] **Step 3:** Full suite green again; commit fixes — `fix(google): adversarial-review findings + regression tests`.

---

### Task 10: Docs sync

- [ ] **Step 1:** `docs/reference/configuration.md`: `HOUGE_GOOGLE_ENABLED` (+ the three `HOUGE_GMAIL_*` env vars, marked secret/broker-held) documented in the flags table; note the dual-LLM arming couple.
- [ ] **Step 2:** `README.md`: short "Google identity — gmail_read / google_api" section under capabilities (mirror the invariant-sweep section's tone) INCLUDING the operations runbook entry: symptom "Gmail ops fail with auth_failed" → cause "refresh token revoked" → fix "re-run `node scripts/gmail-auth.mjs <client_secret.json>` and update the mini's .env" (senior review: revocation is the EXPECTED failure); `CONTEXT.md`: add domain terms (google-auth, allowlist registry, verification extraction, arming couple); `docs/ROADMAP.md` handoff notes: ADR range 0001–0025.
- [ ] **Step 3:** `tasks/todo.md`: flip the Earn blocker line (Google setup DONE 2026-07-22; next Earn move = pick venue + register). Commit — `docs: sync for gmail_read/google_api ship`.

---

### Task 11: Live verification on the mini daemon (subagent-driven)

- [ ] **Step 1:** Preflight (read-only): `HOUGE_GMAIL_*` present in `/Users/xiaochuan/Projects/adventure/.env`; `HOUGE_SECRETS_FIREWALL_ENABLED=true`; `HOUGE_DUAL_LLM_ENABLED=true`; daemon PID alive.
- [ ] **Step 2:** Append `HOUGE_GOOGLE_ENABLED=true` to `.env`; reload daemon per the documented reload procedure (see `README.md` operations runbook — same procedure as the 2026-07-20 sweep reload).
- [ ] **Step 3: Live gate** — INVARIANTS, not point-in-time values (dispatch a verification subagent to drive + verify; Paco taps Telegram):
  1. Telegram 「检查一下你的邮箱」→ reply is a NON-EMPTY inbox digest; the run's `loop_step` ledger row for the gmail_read step has `reader_applied: true` (quarantine ran); exactly one `google_api_call_completed` row, payload = counts only.
  2. `{get}` on a message containing a link → that run's `google_api_call_completed` row has `extracted_links >= 1` (persisted proof — the reply text is reader-derived and not the check).
  3. Secret-silence: query the notifications/outbox table in `houge.sqlite` for the gate runs' reply texts AND grep the daemon log file (`logs/`) for `ya29`, `GOCSPX`, `1//0` — ZERO hits.
  4. `/disarm` → both tools vanish from the manifest (probe turn confirms denial); re-arm after; confirm `HOUGE_GOOGLE_ENABLED` restored.
- [ ] **Step 4:** Record live-gate results in `tasks/todo.md` + `sessions.md`; commit.

---

## Review history (plan-time)
- Self-review: spec coverage §1→T3, §2→T1, §3→T4, §4→T5, §5→T2, §6→T7, failure modes→T3/T4 tests, rollout→T0/T8/T10/T11, residual risk→T0+T9.
- **Eng review (REVISE) + senior spec review (BLOCKED) 2026-07-22 — all findings folded in:**
  - B1 (both reviews): `trusted_extract` post-quarantine side-channel now IMPLEMENTED (T5 result field, T7 inner-loop seam, T6 extracted_* ledger counts) — the original "rides through the Q-LLM" deferral reversed the spec and made live-gate 3.2 unobservable.
  - B2 (senior): `GoogleAuthClient.invalidate()` + 401→invalidate→single-retry + stateful-fake regression (T3/T4).
  - B3 (eng): `tests/config/disarm-posture.test.ts:49` exact-array added to T7.
  - Warnings adopted: arming couple composed in tool-manifest (no first capabilities→core edge); streamed byte cap (no arrayBuffer pre-buffer); `attachments` path segment denied; single auth channel (explicit param, no deps field); single `GOOGLE_RESULT_CHAR_CAP`; `GMAIL_OP_DEADLINE_MS` exported; alphanumeric OTP + keyword-proximity ranking + decoy fixture; links byte-exact (never escapeForTelegram'd) while header lines ARE escaped; auth_failed operator runbook hint in result text + T10 docs; THE-WALL test injection note (no global fetch mock); live-gate criteria restated as invariants (T11).
  - Warnings recorded-not-built (ADR 0025 carries the rationale): no per-run throttle (bounded by turn contract; revisit on cadence use); access-token closure-only containment (tests + T9 probe compensate; broker `addEphemeral` deferred); flag-couple silent-miss documented in configuration.md rather than a manifest-time log line (manifestFor is pure/hot — the couple is documented + testable, and `/incidents` visibility can come with sense slice B).
- Type consistency: `GoogleApiDeps` single deps type; auth always explicit last param; `GoogleAuthClient` built lazily once per worker; ledger fragment `{ service, op, count, extracted_codes, extracted_links }` identical in T5/T6/T7.
