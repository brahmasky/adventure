import { describe, expect, it, vi } from "vitest";
import {
  createGoogleAuthClient,
  GoogleAuthError,
  GOOGLE_TOKEN_ENDPOINT,
  TOKEN_EXPIRY_MARGIN_MS
} from "../../src/capabilities/google-auth.js";

function okToken(token: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }),
    { status: 200 }
  );
}

const CONFIG = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: () => "GOCSPX-fake",
  refreshToken: () => "1//fake"
};

async function captureError(promise: Promise<unknown>): Promise<GoogleAuthError> {
  const outcome = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(outcome).toBeInstanceOf(GoogleAuthError);
  return outcome as GoogleAuthError;
}

describe("createGoogleAuthClient", () => {
  it("mints an access token via the refresh grant (endpoint, form body, no token in errors)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okToken("ya29.first"));
    const t = 1_000_000;
    const client = createGoogleAuthClient(CONFIG, { fetchImpl, now: () => t });

    expect(await client.getAccessToken()).toBe("ya29.first");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(GOOGLE_TOKEN_ENDPOINT);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    const body = String(init.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=1%2F%2Ffake");
    expect(body).toContain("client_id=cid.apps.googleusercontent.com");
  });

  it("caches until expiry margin, re-mints after", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(okToken("ya29.a")).mockResolvedValueOnce(okToken("ya29.b"));
    let t = 1_000_000;
    const client = createGoogleAuthClient(CONFIG, { fetchImpl, now: () => t });

    // Two calls at the same instant: one mint, cached second read.
    expect(await client.getAccessToken()).toBe("ya29.a");
    expect(await client.getAccessToken()).toBe("ya29.a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Just before the margin-adjusted expiry: still cached.
    t += 3600 * 1000 - TOKEN_EXPIRY_MARGIN_MS - 1;
    expect(await client.getAccessToken()).toBe("ya29.a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // At the margin-adjusted expiry: stale, re-mint.
    t += 1;
    expect(await client.getAccessToken()).toBe("ya29.b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("single-flight: concurrent callers share one in-flight refresh", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const client = createGoogleAuthClient(CONFIG, { fetchImpl, now: () => 1_000_000 });

    const first = client.getAccessToken();
    const second = client.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveFetch(okToken("ya29.shared"));
    expect(await first).toBe("ya29.shared");
    expect(await second).toBe("ya29.shared");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("invalid_grant → GoogleAuthError kind auth_failed, message NEVER contains the refresh token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );
    const client = createGoogleAuthClient(CONFIG, { fetchImpl, now: () => 1_000_000 });

    const error = await captureError(client.getAccessToken());
    expect(error.kind).toBe("auth_failed");
    expect(error.message).not.toContain("1//fake");
    expect(error.message).not.toContain("GOCSPX-fake");
    // The response body ("invalid_grant" payload) must not be echoed either — status only.
    expect(error.message).not.toContain("invalid_grant");
  });

  it("network failure → kind unavailable and does not poison the cache (next call retries)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(okToken("ya29.recovered"));
    const client = createGoogleAuthClient(CONFIG, { fetchImpl, now: () => 1_000_000 });

    const error = await captureError(client.getAccessToken());
    expect(error.kind).toBe("unavailable");

    // The failed mint left nothing cached and no stuck in-flight promise: retry succeeds.
    expect(await client.getAccessToken()).toBe("ya29.recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("missing clientSecret/refreshToken → auth_failed without any fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const missingSecret = createGoogleAuthClient(
      { ...CONFIG, clientSecret: () => undefined },
      { fetchImpl, now: () => 1_000_000 }
    );
    const secretError = await captureError(missingSecret.getAccessToken());
    expect(secretError.kind).toBe("auth_failed");

    const missingRefresh = createGoogleAuthClient(
      { ...CONFIG, refreshToken: () => undefined },
      { fetchImpl, now: () => 1_000_000 }
    );
    const refreshError = await captureError(missingRefresh.getAccessToken());
    expect(refreshError.kind).toBe("auth_failed");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("invalidate() clears the cache so the next getAccessToken re-mints (401-recovery seam)", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(okToken("ya29.a")).mockResolvedValueOnce(okToken("ya29.b"));
    const t = 1_000_000;
    const client = createGoogleAuthClient(CONFIG, { fetchImpl, now: () => t });

    // Fresh token cached: same-instant re-read does not re-mint.
    expect(await client.getAccessToken()).toBe("ya29.a");
    expect(await client.getAccessToken()).toBe("ya29.a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Mid-window revocation recovery: invalidate forces a re-mint despite unexpired cache.
    client.invalidate();
    expect(await client.getAccessToken()).toBe("ya29.b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
