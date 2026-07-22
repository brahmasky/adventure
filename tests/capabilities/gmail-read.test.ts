import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GMAIL_BODY_CHAR_CAP,
  GMAIL_EXTRACT_MAX_CODES,
  GMAIL_EXTRACT_MAX_LINKS,
  GMAIL_LINK_CHAR_CAP,
  GMAIL_LIST_DEFAULT,
  GMAIL_LIST_MAX,
  GMAIL_OP_DEADLINE_MS,
  GMAIL_TRUSTED_EXTRACT_CHAR_CAP,
  decodeMessageBody,
  extractVerification,
  runGmailRead
} from "../../src/capabilities/gmail-read.js";
import type { GoogleApiDeps } from "../../src/capabilities/google-api.js";
import { GoogleAuthError, type GoogleAuthClient } from "../../src/capabilities/google-auth.js";

// HERMETICITY (PINNED_ENV cardinal rule): pin every flag this slice reads (delete = code default).
const PINNED_ENV = ["HOUGE_GOOGLE_ENABLED", "HOUGE_DUAL_LLM_ENABLED"] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of PINNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of PINNED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const TEST_TOKEN = "ya29.test";
const OPERATOR_HINT = "(operator: Gmail refresh token likely revoked — re-run scripts/gmail-auth.mjs)";

function enable(): void {
  process.env.HOUGE_GOOGLE_ENABLED = "1";
}

function fakeAuth(): GoogleAuthClient {
  return { getAccessToken: async () => TEST_TOKEN, invalidate: () => {} };
}

function failingAuth(kind: "auth_failed" | "unavailable", message: string): GoogleAuthClient {
  return {
    getAccessToken: async () => {
      throw new GoogleAuthError(kind, message);
    },
    invalidate: () => {}
  };
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function depsFor(impl: typeof fetch, now?: () => Date): GoogleApiDeps {
  return { fetchImpl: impl, now: now ?? (() => new Date("2026-07-22T00:00:00.000Z")) };
}

// ---------- Gmail fixture builders (realistic payload shapes) ----------

function listResponse(ids: string[]): unknown {
  return { messages: ids.map((id) => ({ id, threadId: `t-${id}` })), resultSizeEstimate: ids.length };
}

function metadataMessage(
  id: string,
  fields: { from?: string; subject?: string; date?: string; snippet?: string }
): unknown {
  return {
    id,
    threadId: `t-${id}`,
    snippet: fields.snippet ?? "",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: fields.from ?? "" },
        { name: "Subject", value: fields.subject ?? "" },
        { name: "Date", value: fields.date ?? "" }
      ]
    }
  };
}

function textPart(mimeType: string, text: string): unknown {
  return { mimeType, body: { data: Buffer.from(text, "utf8").toString("base64url"), size: text.length } };
}

function fullMessage(
  id: string,
  payload: { parts?: unknown[]; mimeType?: string; bodyText?: string; headers?: Array<{ name: string; value: string }> }
): unknown {
  const headers = payload.headers ?? [
    { name: "From", value: "sender@example.com" },
    { name: "Subject", value: "Test subject" },
    { name: "Date", value: "Tue, 22 Jul 2026 10:00:00 +1000" }
  ];
  if (payload.parts) {
    return { id, threadId: `t-${id}`, payload: { mimeType: payload.mimeType ?? "multipart/alternative", headers, parts: payload.parts } };
  }
  return {
    id,
    threadId: `t-${id}`,
    payload: {
      mimeType: payload.mimeType ?? "text/plain",
      headers,
      body: { data: Buffer.from(payload.bodyText ?? "", "utf8").toString("base64url") }
    }
  };
}

/** Route by URL substring (bounty fakeDeps pattern): list vs per-message metadata vs full. */
function gmailResponder(fixtures: {
  list?: unknown;
  metadata?: Record<string, unknown>;
  full?: Record<string, unknown>;
}): (url: string) => Response {
  return (url: string): Response => {
    if (url.includes("/messages?")) return jsonResponse(fixtures.list ?? {});
    const match = url.match(/\/messages\/([^/?]+)/);
    const id = match?.[1] ?? "";
    if (url.includes("format=metadata")) return jsonResponse((fixtures.metadata ?? {})[id] ?? {});
    return jsonResponse((fixtures.full ?? {})[id] ?? {});
  };
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const METADATA_SUFFIX = "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
const TRUSTED_IDS_PREFIX = "message ids (use with gmail_read get):";
const TRUSTED_IDS_PREFIX_LEN = TRUSTED_IDS_PREFIX.length;

// ---------- constants ----------

describe("constants", () => {
  it("exports the pinned gmail caps", () => {
    expect(GMAIL_LIST_DEFAULT).toBe(10);
    expect(GMAIL_LIST_MAX).toBe(25);
    expect(GMAIL_BODY_CHAR_CAP).toBe(4_000);
    expect(GMAIL_OP_DEADLINE_MS).toBe(75_000);
    expect(GMAIL_EXTRACT_MAX_CODES).toBe(5);
    expect(GMAIL_EXTRACT_MAX_LINKS).toBe(10);
    expect(GMAIL_LINK_CHAR_CAP).toBe(300);
    expect(GMAIL_TRUSTED_EXTRACT_CHAR_CAP).toBe(600);
  });
});

// ---------- extractVerification (deterministic trust anchor) ----------

describe("extractVerification", () => {
  it("extracts a numeric code and a link byte-exact", () => {
    const body = "Welcome!\nYour verification code is 482913.\nConfirm: https://venue.example/verify?token=xyz\nThanks";
    const { codes, links } = extractVerification(body);
    expect(codes).toContain("482913");
    expect(links).toContain("https://venue.example/verify?token=xyz");
  });

  it("extracts an alphanumeric OTP shape", () => {
    const { codes } = extractVerification("Your code: XK7Q9P — expires soon.");
    expect(codes).toContain("XK7Q9P");
  });

  it("keeps links byte-exact including underscore and asterisk (never escapeForTelegram'd)", () => {
    const link = "https://venue.example/confirm?token=a_b*c";
    const { links } = extractVerification(`Click ${link} now`);
    expect(links[0]).toBe(link);
  });

  it("proximity ranking: six decoy numbers BEFORE the real code cannot evict it", () => {
    const body = [
      "Season 2026 pricing update for your account, effective immediately across all regions and plans.",
      "Your plan renews at $1299 per year, shipped from our warehouse near zip 94103 with tracked delivery.",
      "The staging server now listens on port 8080 behind the load balancer, replacing the legacy endpoint.",
      "For questions call 4155 during business hours; reference order 88231007 in every correspondence with",
      "our support team so we can locate the shipment records quickly and respond within one business day.",
      "Your verification code is 482913 and it expires in ten minutes."
    ].join("\n");
    const { codes } = extractVerification(body);
    // Cap applied AFTER ranking: the keyword-near code ranks first despite six earlier decoys.
    expect(codes[0]).toBe("482913");
    expect(codes).toHaveLength(GMAIL_EXTRACT_MAX_CODES);
    expect(codes).toContain("482913");
  });

  it("ranks a keyword-near candidate above an earlier far decoy (case-insensitive keyword)", () => {
    const pad = "x".repeat(120);
    const { codes } = extractVerification(`ref 20260101 ${pad} your OTP is 7715`);
    expect(codes[0]).toBe("7715");
  });

  it("dedupes repeated codes and links", () => {
    const { codes, links } = extractVerification(
      "code 482913 then again 482913 and https://a.example/x plus https://a.example/x"
    );
    expect(codes.filter((c) => c === "482913")).toHaveLength(1);
    expect(links).toEqual(["https://a.example/x"]);
  });

  it("caps codes at 5 and links at 10, links length-capped at 300 chars", () => {
    const manyLinks = Array.from({ length: 12 }, (_, i) => `https://example.com/p${i}`).join(" ");
    const longLink = `https://example.com/${"a".repeat(400)}`;
    const { links } = extractVerification(`${manyLinks} ${longLink}`);
    expect(links.length).toBeLessThanOrEqual(GMAIL_EXTRACT_MAX_LINKS);
    const { links: capped } = extractVerification(longLink);
    expect(Array.from(capped[0] ?? "").length).toBeLessThanOrEqual(GMAIL_LINK_CHAR_CAP + 1);
  });

  it("returns empty arrays for a body with no candidates", () => {
    expect(extractVerification("hello there, nothing to see")).toEqual({ codes: [], links: [] });
  });
});

// ---------- decodeMessageBody ----------

describe("decodeMessageBody", () => {
  it("prefers text/plain in a nested multipart tree", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [textPart("text/plain", "plain body wins"), textPart("text/html", "<p>html body</p>")]
        }
      ]
    };
    const body = decodeMessageBody(payload);
    expect(body).toContain("plain body wins");
    expect(body).not.toContain("html body");
  });

  it("falls back to text/html with style/script blocks removed then tags to spaces", () => {
    const html = "<style>bad{color:red}</style><script>alert(1)</script><p>Hello <b>World</b></p>";
    const payload = { mimeType: "multipart/alternative", parts: [textPart("text/html", html)] };
    const body = decodeMessageBody(payload);
    expect(body).toContain("Hello");
    expect(body).toContain("World");
    expect(body).not.toContain("alert(1)");
    expect(body).not.toContain("bad{color:red}");
    expect(body).not.toContain("<p>");
  });

  it("decodes base64url edge chars (- and _)", () => {
    const raw = "?>?>?>"; // base64 of this contains + and /, so base64url must use - and _
    const data = Buffer.from(raw, "utf8").toString("base64url");
    expect(data).toMatch(/[-_]/);
    const payload = { mimeType: "text/plain", body: { data } };
    expect(decodeMessageBody(payload)).toBe(raw);
  });

  it("reads a single-part message body from the payload itself", () => {
    const payload = { mimeType: "text/plain", body: { data: Buffer.from("solo body", "utf8").toString("base64url") } };
    expect(decodeMessageBody(payload)).toBe("solo body");
  });

  it("returns empty string for malformed payloads", () => {
    expect(decodeMessageBody(undefined)).toBe("");
    expect(decodeMessageBody(null)).toBe("");
    expect(decodeMessageBody({ mimeType: "text/plain" })).toBe("");
  });
});

// ---------- gate + exactly-one-op validation ----------

describe("runGmailRead — gate + validation (no fetch on invalid)", () => {
  it("reports disabled and never fetches when HOUGE_GOOGLE_ENABLED is unset", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const result = await runGmailRead({ list: true }, process.env, depsFor(impl), fakeAuth());
    expect(result.text).toContain("disabled");
    expect(result.ledger).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["zero ops", {}],
    ["list+get", { list: true, get: "abc" }],
    ["list+search", { list: true, search: "x" }],
    ["all three", { list: true, search: "x", get: "abc" }]
  ])("rejects %s without fetching", async (_label, input) => {
    enable();
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const result = await runGmailRead(input as Record<string, unknown>, process.env, depsFor(impl), fakeAuth());
    expect(result.text).toContain("exactly one");
    expect(result.ledger).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["list not true", { list: "yes" }],
    ["empty search", { search: "" }],
    ["non-string get", { get: 42 }],
    ["whitespace get", { get: "   " }]
  ])("rejects malformed op value (%s) without fetching", async (_label, input) => {
    enable();
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const result = await runGmailRead(input as Record<string, unknown>, process.env, depsFor(impl), fakeAuth());
    expect(result.text).toContain("rejected");
    expect(result.ledger).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

// ---------- list ----------

describe("runGmailRead — list", () => {
  it("fetches the list then per-id metadata and digests one line per message", async () => {
    enable();
    const { impl, calls } = fakeFetch(
      gmailResponder({
        list: listResponse(["m1", "m2"]),
        metadata: {
          m1: metadataMessage("m1", {
            from: "alice@example.com",
            subject: "Hello",
            date: "Tue, 22 Jul 2026 10:00:00 +1000",
            snippet: "first snippet"
          }),
          m2: metadataMessage("m2", {
            from: "bob@example.com",
            subject: "Re: Hello",
            date: "Tue, 22 Jul 2026 11:00:00 +1000",
            snippet: "second snippet"
          })
        }
      })
    );
    const result = await runGmailRead({ list: true }, process.env, depsFor(impl), fakeAuth());
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(`${BASE}?maxResults=10&q=in%3Ainbox`);
    expect(calls[1]!.url).toBe(`${BASE}/m1${METADATA_SUFFIX}`);
    expect(calls[2]!.url).toBe(`${BASE}/m2${METADATA_SUFFIX}`);
    expect(result.text).toContain("alice@example.com — Hello — Tue, 22 Jul 2026 10:00:00 +1000 — first snippet");
    expect(result.text).toContain("bob@example.com — Re: Hello — Tue, 22 Jul 2026 11:00:00 +1000 — second snippet");
    expect(result.ledger).toEqual({ service: "gmail", op: "list", count: 2, extracted_codes: 0, extracted_links: 0 });
    // Navigation side-channel: positional id map aligned with the digest order (id N ↔ message N).
    expect(result.trustedExtract).toBe("message ids (use with gmail_read get): 1=m1 2=m2");
    expect(result.text).not.toContain(TEST_TOKEN);
  });

  it("clamps max to GMAIL_LIST_MAX and floor 1", async () => {
    enable();
    for (const [max, expected] of [
      [100, "25"],
      [0, "1"],
      [-3, "1"]
    ] as const) {
      const { impl, calls } = fakeFetch(gmailResponder({ list: listResponse([]) }));
      await runGmailRead({ list: true, max }, process.env, depsFor(impl), fakeAuth());
      expect(calls[0]!.url).toBe(`${BASE}?maxResults=${expected}&q=in%3Ainbox`);
    }
  });

  it("digests an empty inbox with a zero-count ledger", async () => {
    enable();
    const { impl, calls } = fakeFetch(gmailResponder({ list: listResponse([]) }));
    const result = await runGmailRead({ list: true }, process.env, depsFor(impl), fakeAuth());
    expect(calls).toHaveLength(1);
    expect(result.text).toContain("0 message");
    expect(result.ledger).toEqual({ service: "gmail", op: "list", count: 0, extracted_codes: 0, extracted_links: 0 });
    // Empty result → navigation side-channel absent (same absent-when-empty rule as {get}).
    expect("trustedExtract" in result).toBe(false);
  });

  it("default-scopes {list} to the inbox (q=in:inbox), never touching Sent/Drafts", async () => {
    enable();
    const { impl, calls } = fakeFetch(gmailResponder({ list: listResponse([]) }));
    await runGmailRead({ list: true }, process.env, depsFor(impl), fakeAuth());
    expect(calls[0]!.url).toBe(`${BASE}?maxResults=10&q=in%3Ainbox`);
  });

  it("drops a hostile/malformed message id from the trusted line (untrusted API response)", async () => {
    enable();
    // The Gmail API response is untrusted: a hostile id rides messages[].id into `ids`. The first
    // id digests fine; the hostile one (contains '/') is dropped from the un-quarantined channel.
    const { impl } = fakeFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listResponse(["m1", "ev/il"]));
      if (url.includes("/messages/m1")) {
        return jsonResponse(metadataMessage("m1", { from: "a@x.io", subject: "ok", date: "d", snippet: "s" }));
      }
      // Never reached for the hostile id in practice (transport rejects '/'), but be defensive.
      return jsonResponse({}, 500);
    });
    const result = await runGmailRead({ list: true }, process.env, depsFor(impl), fakeAuth());
    expect(result.trustedExtract).toContain("1=m1");
    expect(result.trustedExtract).not.toContain("ev/il");
    expect(result.trustedExtract).not.toMatch(/2=/);
  });

  it("hard-caps the trusted line at GMAIL_TRUSTED_EXTRACT_CHAR_CAP with whole leading entries only", async () => {
    enable();
    // Many long ids: the trusted line must truncate to whole leading entries — never a partial id.
    const ids = Array.from({ length: 40 }, (_, i) => `id${String(i).padStart(3, "0")}${"z".repeat(20)}`);
    const metadata: Record<string, unknown> = {};
    for (const id of ids) metadata[id] = metadataMessage(id, { from: "a@x.io", subject: "s", date: "d", snippet: "n" });
    const { impl } = fakeFetch(gmailResponder({ list: listResponse(ids), metadata }));
    const result = await runGmailRead({ list: true, max: 25 }, process.env, depsFor(impl), fakeAuth());
    const trusted = result.trustedExtract ?? "";
    expect(Array.from(trusted).length).toBeLessThanOrEqual(GMAIL_TRUSTED_EXTRACT_CHAR_CAP);
    // No partial id: every "N=<id>" entry present is a complete, valid token from the fixture.
    for (const entry of trusted.slice(TRUSTED_IDS_PREFIX_LEN).trim().split(" ")) {
      const [, id] = entry.split("=");
      if (id !== undefined && id !== "") expect(ids).toContain(id);
    }
    // At least one id fit, and it truncated (not all 40 leading ids present).
    expect(trusted).toContain("1=");
    expect(trusted).not.toContain("40=");
  });

  it("renders a hostile markdown-spoof subject inert (escapeForTelegram on header lines)", async () => {
    enable();
    const { impl } = fakeFetch(
      gmailResponder({
        list: listResponse(["m1"]),
        metadata: {
          m1: metadataMessage("m1", {
            from: "evil@example.com",
            subject: "[click here](https://evil) ‮hostile​",
            date: "Tue, 22 Jul 2026 10:00:00 +1000",
            snippet: "HOSTILE-MARKER  frame"
          })
        }
      })
    );
    const result = await runGmailRead({ list: true }, process.env, depsFor(impl), fakeAuth());
    expect(result.text).toContain("click here");
    expect(result.text).not.toMatch(/\[click here\]\(/);
    expect(result.text).toContain("HOSTILE-MARKER");
    expect(result.text).not.toMatch(/[\u202E\u200B\u2028]/);
  });

  it("bails between messages when GMAIL_OP_DEADLINE_MS is exceeded (partial digest + note)", async () => {
    enable();
    let t = 0;
    const now = (): Date => new Date((t += 30_000));
    const { impl, calls } = fakeFetch(
      gmailResponder({
        list: listResponse(["m1", "m2", "m3", "m4"]),
        metadata: {
          m1: metadataMessage("m1", { from: "a@x.io", subject: "s1", date: "d1", snippet: "n1" }),
          m2: metadataMessage("m2", { from: "b@x.io", subject: "s2", date: "d2", snippet: "n2" }),
          m3: metadataMessage("m3", { from: "c@x.io", subject: "s3", date: "d3", snippet: "n3" }),
          m4: metadataMessage("m4", { from: "d@x.io", subject: "s4", date: "d4", snippet: "n4" })
        }
      })
    );
    const result = await runGmailRead({ list: true }, process.env, depsFor(impl, now), fakeAuth());
    // start + 2 ok checks + 1 over-deadline check: only m1 and m2 were fetched.
    expect(calls).toHaveLength(3);
    expect(result.text).toContain("a@x.io");
    expect(result.text).toContain("b@x.io");
    expect(result.text).not.toContain("c@x.io");
    expect(result.text).toContain("deadline");
    expect(result.text).toContain("2 of 4");
    expect(result.ledger).toEqual({ service: "gmail", op: "list", count: 2, extracted_codes: 0, extracted_links: 0 });
  });

  it("surfaces a mid-list transport error as a note with the partial count in the ledger", async () => {
    enable();
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("/messages?")) return jsonResponse(listResponse(["m1", "m2"]));
      if (url.includes("/messages/m1")) {
        return jsonResponse(metadataMessage("m1", { from: "a@x.io", subject: "ok", date: "d", snippet: "s" }));
      }
      return jsonResponse({ error: "boom" }, 500);
    });
    const result = await runGmailRead({ list: true }, process.env, depsFor(impl), fakeAuth());
    expect(calls).toHaveLength(3);
    expect(result.text).toContain("a@x.io");
    expect(result.text).toContain("HTTP 500");
    expect(result.text).toContain("1 of 2");
    expect(result.ledger).toEqual({ service: "gmail", op: "list", count: 1, extracted_codes: 0, extracted_links: 0 });
  });

  it("surfaces an initial list failure as error text with no ledger and no throw", async () => {
    enable();
    const { impl, calls } = fakeFetch(() => jsonResponse({ error: "quota" }, 429));
    const result = await runGmailRead({ list: true }, process.env, depsFor(impl), fakeAuth());
    expect(calls).toHaveLength(1);
    expect(result.text).toContain("failed");
    expect(result.text).toContain("429");
    expect(result.ledger).toBeUndefined();
  });
});

// ---------- search ----------

describe("runGmailRead — search", () => {
  it("adds a percent-encoded q param and ledgers op=search", async () => {
    enable();
    const { impl, calls } = fakeFetch(
      gmailResponder({
        list: listResponse(["m1"]),
        metadata: { m1: metadataMessage("m1", { from: "hi@algora.io", subject: "Bounty", date: "d", snippet: "s" }) }
      })
    );
    const result = await runGmailRead({ search: "from:algora.io" }, process.env, depsFor(impl), fakeAuth());
    expect(calls[0]!.url).toBe(`${BASE}?maxResults=10&q=from%3Aalgora.io`);
    expect(calls[0]!.url).not.toContain("from:algora.io");
    expect(calls[1]!.url).toBe(`${BASE}/m1${METADATA_SUFFIX}`);
    expect(result.text).toContain("hi@algora.io");
    expect(result.ledger).toEqual({ service: "gmail", op: "search", count: 1, extracted_codes: 0, extracted_links: 0 });
    // Search exposes the same positional id map for list→get chaining.
    expect(result.trustedExtract).toBe("message ids (use with gmail_read get): 1=m1");
  });

  it("passes the user's query VERBATIM — never injects in:inbox (may target Sent, a label, a category)", async () => {
    enable();
    const { impl, calls } = fakeFetch(
      gmailResponder({
        list: listResponse(["m1"]),
        metadata: { m1: metadataMessage("m1", { from: "promo@x.io", subject: "Sale", date: "d", snippet: "s" }) }
      })
    );
    await runGmailRead({ search: "category:promotions" }, process.env, depsFor(impl), fakeAuth());
    expect(calls[0]!.url).toBe(`${BASE}?maxResults=10&q=category%3Apromotions`);
    expect(calls[0]!.url).not.toContain("in%3Ainbox");
    expect(calls[0]!.url).not.toContain("in:inbox");
  });
});

// ---------- get ----------

describe("runGmailRead — get", () => {
  it("fetches format=full, prefers text/plain, and escapes header lines", async () => {
    enable();
    const { impl, calls } = fakeFetch(
      gmailResponder({
        full: {
          abc123: fullMessage("abc123", {
            headers: [
              { name: "From", value: "venue@example.com" },
              { name: "Subject", value: "[click here](https://evil) welcome" },
              { name: "Date", value: "Tue, 22 Jul 2026 10:00:00 +1000" }
            ],
            parts: [textPart("text/plain", "plain body here"), textPart("text/html", "<p>html body here</p>")]
          })
        }
      })
    );
    const result = await runGmailRead({ get: "abc123" }, process.env, depsFor(impl), fakeAuth());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/abc123?format=full`);
    expect(result.text).toContain("venue@example.com");
    expect(result.text).toContain("plain body here");
    expect(result.text).not.toContain("html body here");
    expect(result.text).toContain("click here");
    expect(result.text).not.toMatch(/\[click here\]\(/);
    expect(result.ledger).toEqual({ service: "gmail", op: "get", count: 1, extracted_codes: 0, extracted_links: 0 });
  });

  it("strips tags from an HTML-only message", async () => {
    enable();
    const html = "<style>x{}</style><script>alert(1)</script><div>Visible <em>content</em></div>";
    const { impl } = fakeFetch(
      gmailResponder({ full: { m9: fullMessage("m9", { parts: [textPart("text/html", html)] }) } })
    );
    const result = await runGmailRead({ get: "m9" }, process.env, depsFor(impl), fakeAuth());
    expect(result.text).toContain("Visible");
    expect(result.text).toContain("content");
    expect(result.text).not.toContain("alert(1)");
    expect(result.text).not.toContain("<div>");
  });

  it("decodes base64url bodies with - and _ correctly", async () => {
    enable();
    const raw = "marker ?>?>?> end";
    const { impl } = fakeFetch(
      gmailResponder({ full: { m1: fullMessage("m1", { bodyText: raw }) } })
    );
    expect(Buffer.from(raw, "utf8").toString("base64url")).toMatch(/[-_]/);
    const result = await runGmailRead({ get: "m1" }, process.env, depsFor(impl), fakeAuth());
    expect(result.text).toContain("marker ?>?>?> end");
  });

  it("keeps markdown characters in the body (hygiene only — body text is NOT escapeForTelegram'd)", async () => {
    enable();
    const raw = "snake_case stays and *stars* stay [brackets too] (parens as well)";
    const { impl } = fakeFetch(
      gmailResponder({ full: { m1: fullMessage("m1", { bodyText: raw }) } })
    );
    const result = await runGmailRead({ get: "m1" }, process.env, depsFor(impl), fakeAuth());
    expect(result.text).toContain(raw);
  });

  it("returns trustedExtract as a separate sanitized field with byte-exact links", async () => {
    enable();
    const body = "Your verification code is 482913.\nConfirm: https://venue.example/verify?token=x_y*1 now";
    const { impl } = fakeFetch(
      gmailResponder({ full: { m1: fullMessage("m1", { bodyText: body }) } })
    );
    const result = await runGmailRead({ get: "m1" }, process.env, depsFor(impl), fakeAuth());
    expect(result.trustedExtract).toBe(
      "extracted (deterministic, data-only): codes=[482913] links=[https://venue.example/verify?token=x_y*1]"
    );
    expect(result.ledger).toEqual({ service: "gmail", op: "get", count: 1, extracted_codes: 1, extracted_links: 1 });
  });

  it("omits trustedExtract entirely when extraction is empty", async () => {
    enable();
    const { impl } = fakeFetch(
      gmailResponder({ full: { m1: fullMessage("m1", { bodyText: "no secrets in here at all" }) } })
    );
    const result = await runGmailRead({ get: "m1" }, process.env, depsFor(impl), fakeAuth());
    expect("trustedExtract" in result).toBe(false);
  });

  it("caps the body at GMAIL_BODY_CHAR_CAP but extracts from the RAW body BEFORE the cap", async () => {
    enable();
    const filler = "lorem ipsum dolor sit amet ".repeat(200); // > 5_000 chars, no digits
    const body = `${filler}Your verification code is 482913 https://venue.example/verify?token=late`;
    const { impl } = fakeFetch(
      gmailResponder({ full: { m1: fullMessage("m1", { bodyText: body }) } })
    );
    const result = await runGmailRead({ get: "m1" }, process.env, depsFor(impl), fakeAuth());
    expect(result.text).not.toContain("482913");
    expect(Array.from(result.text).length).toBeLessThan(GMAIL_BODY_CHAR_CAP + 300);
    expect(result.trustedExtract).toContain("482913");
    expect(result.trustedExtract).toContain("https://venue.example/verify?token=late");
    expect(result.ledger).toEqual({ service: "gmail", op: "get", count: 1, extracted_codes: 1, extracted_links: 1 });
  });

  it("hard-caps trustedExtract at GMAIL_TRUSTED_EXTRACT_CHAR_CAP", async () => {
    enable();
    const links = Array.from({ length: 10 }, (_, i) => `https://example.com/${String(i).repeat(3)}/${"z".repeat(120)}`);
    const body = `verification code 482913 ${links.join(" ")}`;
    const { impl } = fakeFetch(
      gmailResponder({ full: { m1: fullMessage("m1", { bodyText: body }) } })
    );
    const result = await runGmailRead({ get: "m1" }, process.env, depsFor(impl), fakeAuth());
    expect(result.trustedExtract).toBeDefined();
    expect(Array.from(result.trustedExtract ?? "").length).toBeLessThanOrEqual(GMAIL_TRUSTED_EXTRACT_CHAR_CAP + 1);
  });

  it("strips U+2028 and bidi controls from hostile bodies (text AND trustedExtract)", async () => {
    enable();
    const body = "line one line two ‮evil‬ ​zw code 771534 https://ok.example/a​b";
    const { impl } = fakeFetch(
      gmailResponder({ full: { m1: fullMessage("m1", { bodyText: body }) } })
    );
    const result = await runGmailRead({ get: "m1" }, process.env, depsFor(impl), fakeAuth());
    expect(result.text).not.toMatch(/[\u2028\u202E\u200B]/);
    expect(result.trustedExtract ?? "").not.toMatch(/[\u2028\u202E\u200B]/);
    expect(result.text).toContain("line one line two");
  });

  it("surfaces a transport failure as error text with no ledger and no throw", async () => {
    enable();
    const { impl } = fakeFetch(() => jsonResponse({ error: "gone" }, 404));
    const result = await runGmailRead({ get: "m1" }, process.env, depsFor(impl), fakeAuth());
    expect(result.text).toContain("failed");
    expect(result.text).toContain("404");
    expect(result.ledger).toBeUndefined();
  });

  it("rejects a hostile message id at the transport allowlist without fetching", async () => {
    enable();
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const result = await runGmailRead({ get: "../../admin" }, process.env, depsFor(impl), fakeAuth());
    expect(calls).toHaveLength(0);
    expect(result.text).toContain("failed");
    expect(result.ledger).toBeUndefined();
  });
});

// ---------- auth_failed operator hint ----------

describe("runGmailRead — auth failure runbook hint", () => {
  it("auth_failed on list: text ends with the operator hint, no ledger", async () => {
    enable();
    const { impl, calls } = fakeFetch(() => jsonResponse({}));
    const result = await runGmailRead(
      { list: true },
      process.env,
      depsFor(impl),
      failingAuth("auth_failed", "google token refresh rejected (HTTP 400)")
    );
    expect(calls).toHaveLength(0);
    expect(result.text.endsWith(OPERATOR_HINT)).toBe(true);
    expect(result.ledger).toBeUndefined();
  });

  it("auth_failed on get: text ends with the operator hint", async () => {
    enable();
    const { impl } = fakeFetch(() => jsonResponse({}));
    const result = await runGmailRead(
      { get: "m1" },
      process.env,
      depsFor(impl),
      failingAuth("auth_failed", "google oauth credentials not configured")
    );
    expect(result.text.endsWith(OPERATOR_HINT)).toBe(true);
  });

  it("unavailable does NOT get the revoked-token hint", async () => {
    enable();
    const { impl } = fakeFetch(() => jsonResponse({}));
    const result = await runGmailRead(
      { list: true },
      process.env,
      depsFor(impl),
      failingAuth("unavailable", "google token endpoint unreachable")
    );
    expect(result.text).toContain("unavailable");
    expect(result.text.endsWith(OPERATOR_HINT)).toBe(false);
  });
});
