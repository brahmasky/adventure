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
  constructor(
    public readonly kind: GoogleAuthErrorKind,
    message: string
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export interface GoogleAuthClient {
  getAccessToken(): Promise<string>;
  /** Drop the cached access token (does NOT abort an in-flight mint). Callers use this on a
   * 401 so the single retry re-mints instead of replaying the same dead token. */
  invalidate(): void;
}

export function createGoogleAuthClient(
  config: GoogleAuthConfig,
  deps: GoogleAuthDeps = {}
): GoogleAuthClient {
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
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token"
        }).toString(),
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
    const token =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).access_token
        : undefined;
    const expiresIn =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).expires_in
        : undefined;
    if (typeof token !== "string" || token.length === 0) {
      throw new GoogleAuthError("auth_failed", "google token response missing access_token");
    }
    const ttlMs = (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600) * 1000;
    cached = { token, expiresAt: now() + Math.max(ttlMs - TOKEN_EXPIRY_MARGIN_MS, 60_000) };
    return token;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (cached && cached.expiresAt > now()) return cached.token;
      if (!inflight) {
        inflight = mint().finally(() => {
          inflight = undefined;
        });
      }
      return inflight;
    },
    invalidate(): void {
      cached = undefined;
    }
  };
}
