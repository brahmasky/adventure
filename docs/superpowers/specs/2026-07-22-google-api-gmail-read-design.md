# Google API surface + Gmail read — design (2026-07-22)

**Status:** approved design, pre-implementation
**Charter:** ADR 0008 (Houge identity, authenticated read), ADR 0022 (money fork — registration
is the consumer), ADR 0014 (dual-LLM quarantine), ADR 0015 (secrets firewall). A new **ADR 0025**
records the Google API surface decision and the S33 (2026-07-19) amendment authorizing Houge to
use his own inbox for venue registration.

## Why

Earn P3's first blocker was the Google identity. The OAuth bootstrap is DONE (2026-07-22):
`scripts/gmail-auth.mjs` ran, `wukong.houge@gmail.com` authorized `gmail.readonly`, and
`HOUGE_GMAIL_CLIENT_ID` / `HOUGE_GMAIL_CLIENT_SECRET` / `HOUGE_GMAIL_REFRESH_TOKEN` sit in the
mini's `.env`. This spec gives Houge the read path: general inbox reading (Paco's scope pick)
plus a scope-bounded generic Google API GET surface, so later Google services (Calendar, Drive)
reuse the machinery behind new grants instead of new plumbing.

**Registration loop this unblocks:** Houge signs up on a venue → verification email lands in his
inbox → he reads the code/link → completes registration (the acting step stays human-gated per
ADR 0001/0008).

## Decisions locked with Paco (this session)

1. **General inbox read** — not verification-only, not deterministic-only.
2. **Generic layer** — shared OAuth machinery AND a generic `google_api` GET tool.
3. Blast-radius containment: the token's OAuth scope (`gmail.readonly` only, today) bounds
   everything; the tool adds deterministic guards on top (GET-only, endpoint allowlist).

## Components

### 1. `src/capabilities/google-auth.ts` — service-agnostic OAuth client
- Inputs via injection (no ambient env reads): `clientId` (plain env `HOUGE_GMAIL_CLIENT_ID` —
  not a secret), `clientSecret()` + `refreshToken()` broker getters.
- `getAccessToken()`: POST `https://oauth2.googleapis.com/token` (refresh grant) → cache token
  in closure with expiry (issued `expires_in` minus 5-min safety margin; Google default 3600 s
  → ~55 min effective) → single-flight (concurrent callers await one in-flight refresh).
- Access token NEVER leaves the module (not in digests, ledger, errors, or logs).
- 401/`invalid_grant` on refresh → typed `auth_failed` error (operator alert path: token revoked
  or 7-day-testing expiry — consent screen is published, so revocation is the expected cause).

### 2. `src/config/secret-broker.ts` — two new secrets
- `SECRET_ENV_NAMES` += `HOUGE_GMAIL_CLIENT_SECRET`, `HOUGE_GMAIL_REFRESH_TOKEN` (5 → 7).
- Getters `gmailClientSecret()`, `gmailRefreshToken()`; both values join `redact()`.
- Note: the `_SECRET`/`_TOKEN` suffix pattern ALREADY strips them at boot today — the broker
  addition is what makes them reachable at all. Update ADR 0015's "exact five" language.

### 3. `src/capabilities/google-api.ts` — deterministic GET-only wrapper
- **Allowlist registry** (code constant, no runtime config): rows of
  `{ host, pathPrefix, oauthScope }`. v1 single row:
  `{ host: "gmail.googleapis.com", pathPrefix: "/gmail/v1/users/me/", oauthScope: "gmail.readonly" }`.
- Deterministic rejects BEFORE any fetch: non-GET; host not in registry; normalized path
  (decode + collapse `..`/`//`) escaping the prefix; query params passed as a structured object
  and re-encoded (never string-concatenated).
- Response: JSON only, byte cap on read (reuse the pinned-fetch pattern from bounty-intake:
  `BOUNTY_FETCH_MAX_BYTES`-style constant), hygiene pass (see §5), char-capped digest.
- Timeout per call 8 s (matches `BOUNTY_FETCH_TIMEOUT_MS`); op deadline 75 s.
- Widening the registry = Paco grants the OAuth scope in console + code-reviewed registry row +
  ADR 0025 amendment. 1:1 scope↔row discipline (ADR 0008 §5).

### 4. `src/capabilities/gmail-read.ts` — ergonomic Gmail ops over google-api
- `{list}`: `users/me/messages?maxResults=N` + metadata fetches → per-message line
  (from, subject, date, snippet). Default 10, max 25.
- `{search:"q"}`: same shape, Gmail query syntax passed through as a query param (read-only;
  hostile q can only change what is read).
- `{get:"msgId"}`: full message → decode payload parts (base64url, multipart traversal,
  `text/plain` preferred, `text/html` tag-stripped fallback) → hygiene → ~4k chars/message cap.
- **Deterministic extraction pass** (registration trust anchor): regexes over the RAW decoded
  body for OTP codes (4–8 digit / common alphanumeric formats) and verification URLs; results
  attached as a structured `extracted: { codes: [], links: [] }` block in the tool result,
  each entry hygiened + length-capped. The planner can use a code without quoting hostile
  body text. Links are DATA — following one still goes through `http_fetch` and its policy.
- Attachments: v1 ignores them entirely (names not listed, bodies not fetched).

### 5. Hygiene (shared)
- Extract the P2 hygiene table (`sanitizeVenueText` and friends in `bounty-intake.ts`) into a
  shared module (e.g. `src/capabilities/text-hygiene.ts`); bounty-intake re-exports/imports —
  behavior byte-identical, its tests keep passing unchanged.
- Applied to every mail/API-derived string: C0/bidi/zero-width strip, U+2028/U+2029/NEL
  flatten, code-point truncation.

### 6. Tools (both `external_read`, registered in tool-manifest + policy)
- `gmail_read` — `{ list?: true, search?: string, get?: string, max?: number }` (exactly one op).
- `google_api` — `{ path: string, query?: Record<string,string> }`, GET-only.
- **Both join `UNTRUSTED_READ_TOOLS` (ADR 0014):** when dual-LLM is armed, raw output routes
  through the Q-LLM reader like `http_fetch` — email bodies are free-text hostile input, the
  exact class the quarantine exists for (NO bounty_scan-style carve-out: that carve-out's
  justification was digests built deterministically from structured fields, which does not hold
  for mail bodies). The deterministic `extracted` block bypasses quarantine as structured
  trusted-shape data (same pattern as `time_claims`).
- Digest carve-out: 6k total (matches bounty_scan).
- Flag: `HOUGE_GOOGLE_ENABLED` (default OFF), added to `DISARM_FLAGS` — `/disarm` and the kill
  posture cover it.
- Ledger: `google_api_call_completed` `{ service, op, count }` — counts/ids only, never mail
  content, never tokens. Extend `requiredPayloadFields` for the new event type (lesson #5291).

## Failure modes
- 401 mid-op → one access-token re-mint + single retry → then typed `auth_failed`.
- 429/5xx → no retry loop; surface the failure, op halts (matches bounty-intake posture).
- Refresh endpoint unreachable → tool errors cleanly; daemon and other tools unaffected.

## Residual risk, recorded honestly (goes in ADR 0025)
- **Email → fetch chain (lethal-trifecta shape):** a hostile mail can ask the planner to fetch
  an attacker URL. Not a new channel — any fetched page can do the same — and mitigated by: Q-LLM
  quarantine on the mail body, secrets stripped from env (nothing to exfiltrate via GET params),
  `external_write`/`paid` human-gated. Accepted for v1, revisit if/when send-scope arrives.
- **Scope creep via registry:** guarded by 1:1 scope↔row + ADR amendment requirement.

## Tests (vitest, fixtures only — no live creds in tests)
- google-auth: refresh happy path, cache hit, expiry re-mint, single-flight, `invalid_grant`.
- google-api: allowlist denies (POST, off-host, off-prefix, `..` traversal, encoded traversal),
  query re-encoding, byte cap, JSON-only enforcement.
- gmail-read: multipart/base64url decode fixtures, HTML-strip fallback, per-message cap,
  extraction regexes (codes/links, hostile fixtures), U+2028 frame-forgery + bidi corpus reuse.
- Broker: new getters, redaction of both values, strip still covers the names.
- Contract: tool registration, `UNTRUSTED_READ_TOOLS` membership, disarm flag, one-op-only
  validation, ledger event payload fields.
- Existing suites stay green: hygiene extraction is import-move only; migration count untouched
  (no new table).

## Rollout
1. ADR 0025 written first (house rule), including the S33 registration authorization.
2. Implement behind `HOUGE_GOOGLE_ENABLED=false`; full suite green; commit.
3. Flip flag on the mini, daemon reload.
4. **Live gate:** Telegram 「检查一下你的邮箱」→ digest of the real inbox (22 messages at
   bootstrap), zero secret material in output, `google_api_call_completed` in ledger; then a
   `{get}` on one message with a link → `extracted` block populated.
5. Flip `tasks/todo.md` Earn-blocker line; registration becomes the next Earn move.

## Build execution note (Paco, this session)
Implementation runs subagent-first: independent modules (google-auth, hygiene extraction,
google-api, gmail-read, broker change) fan out to parallel subagents where dependencies allow;
integration (manifest/policy/daemon wiring) lands sequentially after. Plan doc will carve tasks
accordingly.
