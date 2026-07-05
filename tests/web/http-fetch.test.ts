import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  classifyFetchIp,
  fetchUrl,
  hostDenied,
  htmlToText,
  HTTP_FETCH_CONTENT_CHAR_CAP,
  HTTP_FETCH_DEFAULT_MAX_BYTES,
  HTTP_FETCH_DEFAULT_TIMEOUT_MS,
  resolveHttpFetchDeny,
  resolveHttpFetchEnabled,
  resolveHttpFetchMaxBytes,
  resolveHttpFetchTimeoutMs,
  validateFetchTarget
} from "../../src/web/http-fetch.js";
import type { FetchRequestLike, FetchRequestOptions, FetchResponseLike, HttpFetchRequestImpl } from "../../src/web/http-fetch.js";

// --- fakes (no real network/DNS anywhere in this suite) ---

const PUBLIC_IP = "93.184.216.34";

class FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  destroyed = false;
  constructor(statusCode: number, headers: Record<string, string | string[] | undefined> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }
  destroy(): void {
    this.destroyed = true;
  }
  /** Emit body chunks then end (listeners are wired synchronously on deliver). */
  sendBody(...chunks: Buffer[]): void {
    for (const chunk of chunks) this.emit("data", chunk);
    this.emit("end");
  }
}

class FakeRequest extends EventEmitter {
  ended = false;
  destroyed = false;
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

interface TransportCall {
  url: URL;
  options: FetchRequestOptions;
  req: FakeRequest;
}

/** A recording transport; `respond` (if given) runs on a microtask after wiring. */
function fakeTransport(
  respond?: (call: TransportCall, deliver: (res: FakeResponse) => void) => void
): { calls: TransportCall[]; requestImpl: HttpFetchRequestImpl } {
  const calls: TransportCall[] = [];
  const requestImpl: HttpFetchRequestImpl = (url, options, onResponse) => {
    const req = new FakeRequest();
    const call = { url, options, req };
    calls.push(call);
    if (respond) {
      queueMicrotask(() => respond(call, (res) => onResponse(res as unknown as FetchResponseLike)));
    }
    return req as unknown as FetchRequestLike;
  };
  return { calls, requestImpl };
}

/** A transport that always answers with one response (+ optional body). */
function respondWith(
  status: number,
  headers: Record<string, string | string[] | undefined> = {},
  body?: Buffer | string
): { calls: TransportCall[]; requestImpl: HttpFetchRequestImpl; responses: FakeResponse[] } {
  const responses: FakeResponse[] = [];
  const transport = fakeTransport((_call, deliver) => {
    const res = new FakeResponse(status, headers);
    responses.push(res);
    deliver(res);
    res.sendBody(...(body === undefined ? [] : [Buffer.from(body)]));
  });
  return { ...transport, responses };
}

/** A recording resolver that always yields the same address list. */
function resolver(...addresses: string[]): {
  calls: string[];
  resolveAll: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
} {
  const calls: string[] = [];
  return {
    calls,
    resolveAll: async (hostname: string) => {
      calls.push(hostname);
      return addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
    }
  };
}

/** A resolver whose Nth call yields the Nth script entry (rebinding scripts). */
function scriptedResolver(script: string[][]): {
  calls: string[];
  resolveAll: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
} {
  const calls: string[] = [];
  return {
    calls,
    resolveAll: async (hostname: string) => {
      const addresses = script[Math.min(calls.length, script.length - 1)]!;
      calls.push(hostname);
      return addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
    }
  };
}

const CONFIG = { timeoutMs: 5_000, maxBytes: 1_000_000, deny: [] as string[] };

type LookupResult = { err: unknown; address: unknown; family: unknown };
function invokeLookup(options: FetchRequestOptions, lookupOptions: unknown): LookupResult {
  let captured: LookupResult = { err: "never called", address: undefined, family: undefined };
  options.lookup("irrelevant.example", lookupOptions, (err: unknown, address: unknown, family: unknown) => {
    captured = { err, address, family };
  });
  return captured;
}

// --- env resolvers (explicit env objects only — hermetic by construction) ---

describe("http_fetch env resolvers", () => {
  it("resolveHttpFetchEnabled defaults OFF and accepts the truthy spellings", () => {
    expect(resolveHttpFetchEnabled({})).toBe(false);
    expect(resolveHttpFetchEnabled({ HOUGE_HTTPFETCH_ENABLED: "1" })).toBe(true);
    expect(resolveHttpFetchEnabled({ HOUGE_HTTPFETCH_ENABLED: "true" })).toBe(true);
    expect(resolveHttpFetchEnabled({ HOUGE_HTTPFETCH_ENABLED: "yes" })).toBe(true);
    expect(resolveHttpFetchEnabled({ HOUGE_HTTPFETCH_ENABLED: "on" })).toBe(true);
    expect(resolveHttpFetchEnabled({ HOUGE_HTTPFETCH_ENABLED: "0" })).toBe(false);
    expect(resolveHttpFetchEnabled({ HOUGE_HTTPFETCH_ENABLED: "off" })).toBe(false);
  });

  it("timeout / max-bytes resolve overrides and fall back to code defaults on junk", () => {
    expect(resolveHttpFetchTimeoutMs({})).toBe(HTTP_FETCH_DEFAULT_TIMEOUT_MS);
    expect(resolveHttpFetchTimeoutMs({ HOUGE_HTTPFETCH_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(resolveHttpFetchTimeoutMs({ HOUGE_HTTPFETCH_TIMEOUT_MS: "banana" })).toBe(HTTP_FETCH_DEFAULT_TIMEOUT_MS);
    expect(resolveHttpFetchTimeoutMs({ HOUGE_HTTPFETCH_TIMEOUT_MS: "-5" })).toBe(HTTP_FETCH_DEFAULT_TIMEOUT_MS);
    expect(resolveHttpFetchMaxBytes({})).toBe(HTTP_FETCH_DEFAULT_MAX_BYTES);
    expect(resolveHttpFetchMaxBytes({ HOUGE_HTTPFETCH_MAX_BYTES: "2048" })).toBe(2_048);
    expect(resolveHttpFetchMaxBytes({ HOUGE_HTTPFETCH_MAX_BYTES: "0" })).toBe(HTTP_FETCH_DEFAULT_MAX_BYTES);
  });

  it("deny parses comma-separated hosts, trimmed + lowercased, empties dropped", () => {
    expect(resolveHttpFetchDeny({})).toEqual([]);
    expect(resolveHttpFetchDeny({ HOUGE_HTTPFETCH_DENY: " Evil.test ,, other.example " })).toEqual([
      "evil.test",
      "other.example"
    ]);
  });
});

// --- classifier tables ---

describe("classifyFetchIp — IPv4 blocked-range boundaries", () => {
  const BLOCKED = [
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.0",
    "10.255.255.255",
    "100.64.0.0",
    "100.127.255.255",
    "127.0.0.0",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.0.0",
    "169.254.169.254", // the cloud metadata endpoint
    "169.254.255.255",
    "172.16.0.0",
    "172.31.255.255",
    "192.0.0.0",
    "192.0.0.255",
    "192.168.0.0",
    "192.168.255.255",
    "198.18.0.0",
    "198.19.255.255",
    "224.0.0.0",
    "239.255.255.255",
    "240.0.0.0",
    "255.255.255.255"
  ];
  const PUBLIC = [
    "1.0.0.0",
    "8.8.8.8",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.1", // one past 172.16/12
    "192.0.1.0", // one past 192.0.0/24
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255" // last address before multicast
  ];

  it("blocks every reserved range boundary (first + last address in)", () => {
    for (const ip of BLOCKED) expect(classifyFetchIp(ip), ip).toBe("blocked");
  });

  it("allows the addresses just outside every blocked range", () => {
    for (const ip of PUBLIC) expect(classifyFetchIp(ip), ip).toBe("public");
  });
});

describe("classifyFetchIp — IPv6, embedded IPv4, fail-closed", () => {
  it("blocks unspecified/loopback/ULA/link-local boundaries; allows just outside", () => {
    const blocked = ["::", "::1", "fc00::", "fd00::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::", "fe80::1", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"];
    for (const ip of blocked) expect(classifyFetchIp(ip), ip).toBe("blocked");
    const publicV6 = ["2001:4860:4860::8888", "fbff:ffff::1", "fe00::1", "fec0::1"];
    for (const ip of publicV6) expect(classifyFetchIp(ip), ip).toBe("public");
  });

  it("decodes IPv4-mapped addresses in BOTH spellings and re-checks as IPv4", () => {
    expect(classifyFetchIp("::ffff:127.0.0.1")).toBe("blocked"); // dotted-quad spelling
    expect(classifyFetchIp("::ffff:7f00:1")).toBe("blocked"); // hex spelling of 127.0.0.1
    expect(classifyFetchIp("::ffff:10.0.0.1")).toBe("blocked");
    expect(classifyFetchIp("::ffff:a00:1")).toBe("blocked");
    expect(classifyFetchIp("::ffff:8.8.8.8")).toBe("public");
    expect(classifyFetchIp("::ffff:808:808")).toBe("public");
  });

  it("decodes NAT64 (64:ff9b::/96) and IPv4-compatible (::/96) embeddings", () => {
    expect(classifyFetchIp("64:ff9b::10.0.0.1")).toBe("blocked");
    expect(classifyFetchIp("64:ff9b::a00:1")).toBe("blocked");
    expect(classifyFetchIp("64:ff9b::8.8.8.8")).toBe("public");
    expect(classifyFetchIp("::169.254.169.254")).toBe("blocked");
    expect(classifyFetchIp("::10.0.0.1")).toBe("blocked");
  });

  it("fails closed on unparseable input", () => {
    expect(classifyFetchIp("banana")).toBe("blocked");
    expect(classifyFetchIp("")).toBe("blocked");
    expect(classifyFetchIp("999.1.1.1")).toBe("blocked");
  });
});

describe("hostDenied", () => {
  it("matches exact hosts and subdomains (dot-suffix), never substrings", () => {
    expect(hostDenied("evil.test", ["evil.test"])).toBe(true);
    expect(hostDenied("a.evil.test", ["evil.test"])).toBe(true);
    expect(hostDenied("deep.a.evil.test", ["evil.test"])).toBe(true);
    expect(hostDenied("notevil.test", ["evil.test"])).toBe(false);
    expect(hostDenied("evil.test.example", ["evil.test"])).toBe(false);
    expect(hostDenied("anything.example", [])).toBe(false);
  });

  it("a trailing FQDN dot does not evade the deny check (exact or subdomain)", () => {
    expect(hostDenied("evil.test.", ["evil.test"])).toBe(true);
    expect(hostDenied("a.evil.test.", ["evil.test"])).toBe(true);
    expect(hostDenied("evil.test", ["evil.test."])).toBe(true);
  });
});

// --- validateFetchTarget ---

describe("validateFetchTarget", () => {
  it("rejects non-http(s) schemes, bad methods, credentials, and junk URLs — all 'refused:'", () => {
    const cases = [
      validateFetchTarget("ftp://example.com/", "GET", []),
      validateFetchTarget("file:///etc/passwd", "GET", []),
      validateFetchTarget("javascript:alert(1)", "GET", []),
      validateFetchTarget("https://example.com/", "POST", []),
      validateFetchTarget("https://example.com/", "DELETE", []),
      validateFetchTarget("https://user:pass@example.com/", "GET", []),
      validateFetchTarget("https://user@example.com/", "GET", []),
      validateFetchTarget("not a url", "GET", [])
    ];
    for (const result of cases) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.startsWith("refused: ")).toBe(true);
    }
  });

  it("accepts GET/HEAD (case-insensitive) on plain public URLs", () => {
    expect(validateFetchTarget("https://example.com/page?q=1", "GET", []).ok).toBe(true);
    expect(validateFetchTarget("http://example.com/", "head", []).ok).toBe(true);
    const r = validateFetchTarget("https://example.com/", "get", []);
    if (r.ok) expect(r.target.method).toBe("GET");
  });

  it("refuses literal-IP hosts in blocked ranges (never skips validation)", () => {
    for (const url of ["http://127.0.0.1/", "http://10.1.2.3/x", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[fd00::1]/"]) {
      const result = validateFetchTarget(url, "GET", []);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.error.startsWith("refused: ")).toBe(true);
    }
    expect(validateFetchTarget("http://8.8.8.8/", "GET", []).ok).toBe(true);
  });

  it("locks WHATWG normalization: obfuscated IPv4 literals canonicalize and are refused", () => {
    // octal / decimal / hex spellings of 127.0.0.1 — `new URL` canonicalizes them all.
    for (const url of ["http://0177.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://0x7f.0.0.1/"]) {
      const result = validateFetchTarget(url, "GET", []);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.error).toContain("127.0.0.1");
    }
  });

  it("denylist: exact + subdomain refuse; unrelated hosts pass; IDNs match in punycode form", () => {
    const deny = ["evil.test", "xn--bcher-kva.example"];
    expect(validateFetchTarget("https://evil.test/", "GET", deny).ok).toBe(false);
    expect(validateFetchTarget("https://a.evil.test/x", "GET", deny).ok).toBe(false);
    expect(validateFetchTarget("https://notevil.test/", "GET", deny).ok).toBe(true);
    // WHATWG punycodes the IDN host before the denylist sees it.
    expect(validateFetchTarget("https://bücher.example/katalog", "GET", deny).ok).toBe(false);
  });
});

// --- htmlToText ---

describe("htmlToText", () => {
  it("strips script/style/comments/tags, decodes entities, collapses whitespace", () => {
    const html = [
      "<html><head><style>body { color: red }</style>",
      '<script type="text/javascript">alert("evil & nasty")</script></head>',
      "<body><!-- hidden comment --><h1>Title</h1>",
      "<p>A &amp; B &lt;ok&gt;   &#20320;&#x597d; &nbsp;end</p></body></html>"
    ].join("\n");
    const text = htmlToText(html);
    expect(text).toBe("Title A & B <ok> 你好 end");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("hidden comment");
  });

  it("leaves unknown entities and stray ampersands alone", () => {
    expect(htmlToText("a &notarealentity; b & c")).toBe("a &notarealentity; b & c");
  });
});

// --- fetchUrl with injected seams ---

describe("fetchUrl — pin + resolve discipline", () => {
  it("happy path: resolves once, pins the validated IP, sends identity encoding with agent:false", async () => {
    const dns = resolver(PUBLIC_IP);
    const transport = respondWith(200, { "content-type": "text/plain" }, "hello");
    const outcome = await fetchUrl({ url: "https://example.com/page" }, CONFIG, {
      resolveAll: dns.resolveAll,
      requestImpl: transport.requestImpl
    });

    expect(outcome).toEqual({
      ok: true,
      result: {
        url: "https://example.com/page",
        status: 200,
        content_type: "text/plain",
        content: "hello",
        truncated: false,
        bytes: 5
      }
    });
    // ONE resolution per fetch, by construction.
    expect(dns.calls).toEqual(["example.com"]);
    expect(transport.calls.length).toBe(1);
    const options = transport.calls[0]!.options;
    expect(options.agent).toBe(false);
    expect(options.headers["accept-encoding"]).toBe("identity");
    expect(options.method).toBe("GET");
    expect(transport.calls[0]!.req.ended).toBe(true);
    // The pinned lookup only ever yields the pre-validated address (both cb shapes).
    expect(invokeLookup(options, { family: 4 })).toEqual({ err: null, address: PUBLIC_IP, family: 4 });
    expect(invokeLookup(options, { all: true })).toEqual({
      err: null,
      address: [{ address: PUBLIC_IP, family: 4 }],
      family: undefined
    });
  });

  it("rebinding script: the second resolution is never consulted within a fetch; a fresh fetch re-resolves and is refused", async () => {
    const dns = scriptedResolver([[PUBLIC_IP], ["10.0.0.1"]]);
    const transport = respondWith(200, { "content-type": "text/plain" }, "ok");

    const first = await fetchUrl({ url: "http://rebind.test/" }, CONFIG, {
      resolveAll: dns.resolveAll,
      requestImpl: transport.requestImpl
    });
    expect(first.ok).toBe(true);
    expect(dns.calls.length).toBe(1);
    // Even repeated socket lookups inside the fetch answer with the PINNED address —
    // the attacker's second DNS answer (10.0.0.1) is unreachable by construction.
    const options = transport.calls[0]!.options;
    expect(invokeLookup(options, { family: 4 }).address).toBe(PUBLIC_IP);
    expect(invokeLookup(options, { family: 4 }).address).toBe(PUBLIC_IP);

    const second = await fetchUrl({ url: "http://rebind.test/" }, CONFIG, {
      resolveAll: dns.resolveAll,
      requestImpl: transport.requestImpl
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.startsWith("refused: ")).toBe(true);
    expect(dns.calls.length).toBe(2);
    expect(transport.calls.length).toBe(1); // the refused fetch never reached the transport
  });

  it("mixed public+private resolution rejects the WHOLE fetch before the transport is touched", async () => {
    const dns = resolver(PUBLIC_IP, "10.0.0.1");
    const transport = fakeTransport();
    const outcome = await fetchUrl({ url: "https://mixed.test/" }, CONFIG, {
      resolveAll: dns.resolveAll,
      requestImpl: transport.requestImpl
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.startsWith("refused: ")).toBe(true);
      expect(outcome.error).toContain("10.0.0.1");
    }
    expect(transport.calls.length).toBe(0);
  });

  it("literal-IP hosts skip DNS entirely: blocked literals refused, public literals pinned to themselves", async () => {
    const dns = resolver(PUBLIC_IP);
    const transport = respondWith(200, { "content-type": "text/plain" }, "ok");

    for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://[::ffff:169.254.169.254]/", "http://[fe80::1]/"]) {
      const refusedOutcome = await fetchUrl({ url }, CONFIG, { resolveAll: dns.resolveAll, requestImpl: transport.requestImpl });
      expect(refusedOutcome.ok, url).toBe(false);
      if (!refusedOutcome.ok) expect(refusedOutcome.error.startsWith("refused: ")).toBe(true);
    }
    expect(dns.calls.length).toBe(0);
    expect(transport.calls.length).toBe(0);

    const ok = await fetchUrl({ url: "http://8.8.8.8/status" }, CONFIG, {
      resolveAll: dns.resolveAll,
      requestImpl: transport.requestImpl
    });
    expect(ok.ok).toBe(true);
    expect(dns.calls.length).toBe(0); // literal host — DNS never consulted
    expect(invokeLookup(transport.calls[0]!.options, { family: 4 }).address).toBe("8.8.8.8");
  });

  it("a DNS failure is a plain error (no 'refused:' policy prefix)", async () => {
    const outcome = await fetchUrl({ url: "https://gone.test/" }, CONFIG, {
      resolveAll: async () => {
        throw new Error("ENOTFOUND gone.test");
      },
      requestImpl: fakeTransport().requestImpl
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.startsWith("refused: ")).toBe(false);
      expect(outcome.error).toContain("DNS lookup failed");
    }
  });
});

describe("fetchUrl — transport behavior", () => {
  const deps = (transport: { requestImpl: HttpFetchRequestImpl }) => ({
    resolveAll: resolver(PUBLIC_IP).resolveAll,
    requestImpl: transport.requestImpl
  });

  it("caps the body at maxBytes: keeps the prefix, sets truncated, destroys the response", async () => {
    const transport = respondWith(200, { "content-type": "text/plain" }, "0123456789ABCDEF");
    const outcome = await fetchUrl({ url: "https://big.test/" }, { ...CONFIG, maxBytes: 10 }, deps(transport));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.content).toBe("0123456789");
      expect(outcome.result.truncated).toBe(true);
      expect(outcome.result.bytes).toBe(10);
    }
    expect(transport.responses[0]!.destroyed).toBe(true);
  });

  it("a body exactly at the cap is NOT marked truncated", async () => {
    const transport = respondWith(200, { "content-type": "text/plain" }, "0123456789");
    const outcome = await fetchUrl({ url: "https://exact.test/" }, { ...CONFIG, maxBytes: 10 }, deps(transport));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toMatchObject({ content: "0123456789", truncated: false, bytes: 10 });
  });

  it("wall-clock timeout: a never-responding transport settles as a timeout error and destroys the request", async () => {
    const transport = fakeTransport(); // never responds
    const outcome = await fetchUrl({ url: "https://slow.test/" }, { ...CONFIG, timeoutMs: 25 }, deps(transport));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("timed out after 25ms");
      expect(outcome.error.startsWith("refused: ")).toBe(false);
    }
    expect(transport.calls[0]!.req.destroyed).toBe(true);
  });

  it("wall-clock timeout binds the BODY too (slow-trickle: headers arrive, body never ends)", async () => {
    const transport = fakeTransport((_call, deliver) => {
      const res = new FakeResponse(200, { "content-type": "text/plain" });
      deliver(res);
      res.emit("data", Buffer.from("drip")); // then silence — no end
    });
    const outcome = await fetchUrl({ url: "https://trickle.test/" }, { ...CONFIG, timeoutMs: 25 }, deps(transport));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("timed out");
  });

  it("3xx: no body, absolute-resolved location, never followed", async () => {
    const transport = fakeTransport((_call, deliver) => {
      const res = new FakeResponse(301, { location: "/moved/here" });
      deliver(res);
      // A body after the redirect headers must never surface.
      res.sendBody(Buffer.from("<html>Moved</html>"));
    });
    const outcome = await fetchUrl({ url: "https://example.com/old" }, CONFIG, deps(transport));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe(301);
      expect(outcome.result.location).toBe("https://example.com/moved/here");
      expect(outcome.result.content).toBe("");
      expect(outcome.result.bytes).toBe(0);
      expect(outcome.result.note).toBeDefined();
    }
    expect(transport.calls.length).toBe(1); // the redirect target was NOT fetched
  });

  it("HEAD: sends HEAD, returns headers-only metadata with an empty body", async () => {
    const transport = respondWith(200, { "content-type": "application/json" });
    const outcome = await fetchUrl({ url: "https://example.com/api", method: "HEAD" }, CONFIG, deps(transport));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toMatchObject({ status: 200, content_type: "application/json", content: "", bytes: 0 });
    }
    expect(transport.calls[0]!.options.method).toBe("HEAD");
  });

  it("gzip-anyway: decompresses despite identity, and the byte cap binds DECOMPRESSED bytes", async () => {
    const bomb = gzipSync(Buffer.from("x".repeat(5_000))); // ~compresses tiny, inflates big
    const transport = respondWith(200, { "content-type": "text/plain", "content-encoding": "gzip" }, bomb);
    const outcome = await fetchUrl({ url: "https://gz.test/" }, { ...CONFIG, maxBytes: 100 }, deps(transport));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.content).toBe("x".repeat(100));
      expect(outcome.result.truncated).toBe(true);
      expect(outcome.result.bytes).toBe(100); // decompressed bytes, not the wire size
    }
  });

  it("gzip under the cap decodes fully", async () => {
    const transport = respondWith(200, { "content-type": "text/plain", "content-encoding": "gzip" }, gzipSync(Buffer.from("hello world")));
    const outcome = await fetchUrl({ url: "https://gz2.test/" }, CONFIG, deps(transport));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toMatchObject({ content: "hello world", truncated: false, bytes: 11 });
  });

  it("decodes the declared charset with a utf-8 fallback for unknown labels", async () => {
    const latin = respondWith(200, { "content-type": "text/plain; charset=iso-8859-1" }, Buffer.from([0xe9]));
    const a = await fetchUrl({ url: "https://charset.test/" }, CONFIG, deps(latin));
    if (a.ok) expect(a.result.content).toBe("é");

    const junk = respondWith(200, { "content-type": "text/plain; charset=not-a-charset" }, "plain");
    const b = await fetchUrl({ url: "https://charset2.test/" }, CONFIG, deps(junk));
    if (b.ok) expect(b.result.content).toBe("plain");
  });

  it("binary content ships metadata only — never raw bytes", async () => {
    const transport = respondWith(200, { "content-type": "image/png" }, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const outcome = await fetchUrl({ url: "https://img.test/logo.png" }, CONFIG, deps(transport));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.content).toBe("");
      expect(outcome.result.bytes).toBe(4);
      expect(outcome.result.note).toContain("binary");
    }
  });

  it("caps shipped content at HTTP_FETCH_CONTENT_CHAR_CAP chars and flags truncation", async () => {
    const transport = respondWith(200, { "content-type": "text/plain" }, "z".repeat(HTTP_FETCH_CONTENT_CHAR_CAP + 1_000));
    const outcome = await fetchUrl({ url: "https://long.test/" }, CONFIG, deps(transport));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.content.length).toBe(HTTP_FETCH_CONTENT_CHAR_CAP);
      expect(outcome.result.truncated).toBe(true);
      expect(outcome.result.bytes).toBe(HTTP_FETCH_CONTENT_CHAR_CAP + 1_000);
    }
  });

  it("a transport error is a plain error (no policy prefix)", async () => {
    const transport = fakeTransport((call) => {
      call.req.emit("error", new Error("ECONNRESET"));
    });
    const outcome = await fetchUrl({ url: "https://reset.test/" }, CONFIG, deps(transport));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("ECONNRESET");
      expect(outcome.error.startsWith("refused: ")).toBe(false);
    }
  });
});
