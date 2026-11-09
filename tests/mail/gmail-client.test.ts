import { describe, expect, it } from "vitest";
import { getMetadata, historyRange, listInbox, profileHistoryId, sentTo } from "../../src/mail/gmail-client.js";
import { GoogleAuthError, type GoogleAuthClient } from "../../src/capabilities/google-auth.js";
import type { GoogleApiDeps } from "../../src/capabilities/google-api.js";

const auth: GoogleAuthClient = { getAccessToken: async () => "ya29.t", invalidate: () => undefined };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
/** Every request the client makes: a GET under the Gmail user root, never a full or raw body (brief Step 1, hoisted so every function is covered by construction). */
function setup(responder: (u: URL) => Response) {
  const urls: URL[] = [];
  const fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(i));
    expect(init?.method ?? "GET").toBe("GET");
    expect(u.pathname.startsWith("/gmail/v1/users/me/")).toBe(true);
    expect(["full", "raw"]).not.toContain(u.searchParams.get("format"));
    urls.push(u);
    return responder(u);
  }) as typeof fetch;
  return { urls, deps: { fetchImpl, now: () => new Date() } as GoogleApiDeps };
}

describe("historyRange", () => {
  it("follows pages, de-duplicates, keeps order, returns last historyId, never asks for full bodies", async () => {
    const { urls, deps } = setup((u) => u.searchParams.get("pageToken") === "p2"
      ? json({ history: [{ messagesAdded: [{ message: { id: "a", threadId: "ta" } }, { message: { id: "c", threadId: "tc" } }] }], historyId: "20" })
      : json({ history: [{ messagesAdded: [{ message: { id: "a", threadId: "ta" } }, { message: { id: "b", threadId: "tb" } }] }], historyId: "10", nextPageToken: "p2" }));
    const r = await historyRange("5", deps, auth);
    expect(r).toEqual({ ok: true, ids: [{ id: "a", threadId: "ta" }, { id: "b", threadId: "tb" }, { id: "c", threadId: "tc" }], historyId: "20", partial: false });
    expect(urls).toHaveLength(2);
    for (const u of urls) {
      expect(u.searchParams.get("maxResults")).toBe("500");
      expect(u.searchParams.get("historyTypes")).toBe("messageAdded");
      expect(u.searchParams.get("labelId")).toBe("INBOX");
      expect(u.searchParams.get("startHistoryId")).toBe("5");
    }
  });
  it("at the 50-page cap it returns the consumed ids with the LAST RECORD's id as a resumable cursor, partial: true (review I1)", async () => {
    // 51 pages of one record each: page n carries record id 100+n; the response historyId (the mailbox's current id) must never be the cursor
    const { urls, deps } = setup((u) => {
      const n = Number(u.searchParams.get("pageToken") ?? "0");
      return json({ history: [{ id: String(100 + n), messagesAdded: [{ message: { id: `m${n}`, threadId: `t${n}` } }] }], historyId: "999999", nextPageToken: String(n + 1) });
    });
    const r = await historyRange("5", deps, auth);
    expect(urls).toHaveLength(50);
    expect(r).toMatchObject({ ok: true, partial: true, historyId: "149" });
    expect((r as { ids: unknown[] }).ids).toHaveLength(50);
  });
  it("a full read without a response historyId falls back to the last record id", async () => {
    const { deps } = setup(() => json({ history: [{ id: "77", messagesAdded: [{ message: { id: "a", threadId: "ta" } }] }] }));
    expect(await historyRange("5", deps, auth)).toMatchObject({ ok: true, historyId: "77", partial: false });
  });
});

describe("getMetadata", () => {
  it("asks for metadata with three headers", async () => {
    const { urls, deps } = setup(() => json({ id: "a", threadId: "ta" }));
    expect((await getMetadata("a", deps, auth)).ok).toBe(true);
    expect(urls[0]!.searchParams.get("format")).toBe("metadata");
    expect(urls[0]!.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Date"]);
  });
  it("maps 404 to not_found, 401 to auth, 403 (Gmail's rate-limit status) and 500 to unavailable", async () => {
    for (const [status, kind] of [[404, "not_found"], [401, "auth"], [403, "unavailable"], [500, "unavailable"]] as const) {
      const { deps } = setup(() => json({}, status));
      expect(await getMetadata("a", deps, auth)).toMatchObject({ ok: false, kind, status });
    }
  });
  it("maps a token mint failure to auth and a transient mint failure to unavailable", async () => {
    const { deps } = setup(() => json({}));
    const bad: GoogleAuthClient = { getAccessToken: async () => { throw new GoogleAuthError("auth_failed", "rejected"); }, invalidate: () => undefined };
    expect(await getMetadata("a", deps, bad)).toEqual({ ok: false, kind: "auth" });
    const flaky: GoogleAuthClient = { getAccessToken: async () => { throw new GoogleAuthError("unavailable", "down"); }, invalidate: () => undefined };
    expect(await getMetadata("a", deps, flaky)).toEqual({ ok: false, kind: "unavailable" });
  });
});

describe("profileHistoryId / listInbox / sentTo", () => {
  it("reads the profile history id", async () => {
    const { urls, deps } = setup(() => json({ historyId: "77" }));
    expect(await profileHistoryId(deps, auth)).toEqual({ ok: true, historyId: "77" });
    expect(urls[0]!.pathname).toBe("/gmail/v1/users/me/profile");
  });
  it("listInbox stops at the cap and reports more", async () => {
    const { deps } = setup(() => json({ messages: [1, 2, 3].map((n) => ({ id: `m${n}`, threadId: `t${n}` })) }));
    const r = await listInbox("newer_than:1d", 2, deps, auth);
    expect(r).toEqual({ ok: true, ids: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }], more: true });
  });
  it("listInbox reports no more when under the cap", async () => {
    const { deps } = setup(() => json({ messages: [{ id: "m1", threadId: "t1" }] }));
    expect(await listInbox("x", 5, deps, auth)).toMatchObject({ ok: true, more: false });
  });
  it("sentTo refuses an unsafe address without any request", async () => {
    const { urls, deps } = setup(() => json({}));
    expect(await sentTo("a b@example.com", deps, auth)).toEqual({ ok: true, found: false });
    expect(urls).toHaveLength(0);
  });
  it("sentTo queries in:sent to:\"addr\" and reports found", async () => {
    const { urls, deps } = setup(() => json({ messages: [{ id: "x", threadId: "y" }] }));
    expect(await sentTo("ann@example.com", deps, auth)).toEqual({ ok: true, found: true });
    expect(urls[0]!.searchParams.get("q")).toBe('in:sent to:"ann@example.com"');
    expect(urls[0]!.searchParams.get("maxResults")).toBe("1");
  });
});
