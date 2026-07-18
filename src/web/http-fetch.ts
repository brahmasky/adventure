import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/**
 * Direct URL read for the inner loop (`http_fetch`, Phase 3.6 step ③) — zero runtime
 * deps, node: builtins only. Safety posture "A + IP-block floor": ANY public URL, no
 * domain allowlist, but a hard SSRF floor —
 *   - scheme http/https only · GET/HEAD only · credentials-in-URL refused;
 *   - resolve-and-PIN: `dns.promises.lookup(all:true)` ONCE, classify EVERY address
 *     (ANY private/reserved ⇒ reject the whole fetch — mixed public+private is the
 *     classic rebinding shape), then connect via a pinned `lookup` closure that only
 *     ever yields the pre-validated address (one resolution per fetch by construction;
 *     Host/SNI/cert checks stay hostname-based). `agent: false` prevents keep-alive
 *     socket reuse from bypassing a later fetch's pin;
 *   - redirects NEVER followed: a 3xx returns `{status, location}` — the next fetch is
 *     a fresh, fully-validated fetch (internal following re-imports the bypass class);
 *   - byte cap binds the DECOMPRESSED body (zip-bomb guard) + overall wall-clock timer.
 * SSRF refusals carry a distinct `"refused: "` prefix (policy vs network failure);
 * errors never echo env config.
 *
 * ACCEPTED Posture-A residuals (documented, not solved — secrets firewall is the NEXT
 * /goal): GET query-string exfil to public hosts; internal-ish services on PUBLIC IPs;
 * no JS execution (static tier only). No auth headers are ever sent. No proxy support
 * (node:http ignores HTTP_PROXY) — a future proxy must land inside this chokepoint.
 */

/** Max chars of fetched content shipped to the model (the transcript re-sends per step). */
export const HTTP_FETCH_CONTENT_CHAR_CAP = 6_000;

export const HTTP_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const HTTP_FETCH_DEFAULT_MAX_BYTES = 1_000_000;

/** Whether `http_fetch` is armed (`HOUGE_HTTPFETCH_ENABLED`). DEFAULT OFF — the tool is
 *  unlisted (unreachable) unless this is truthy (armed-listing, like self_write_propose).
 *  Accepts 1/true/yes/on. */
export function resolveHttpFetchEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_HTTPFETCH_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Wall-clock cap per fetch (`HOUGE_HTTPFETCH_TIMEOUT_MS`) — catches slow-trickle bodies. */
export function resolveHttpFetchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_HTTPFETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HTTP_FETCH_DEFAULT_TIMEOUT_MS;
}

/** Byte cap on the DECOMPRESSED body (`HOUGE_HTTPFETCH_MAX_BYTES`) — the zip-bomb guard. */
export function resolveHttpFetchMaxBytes(env: NodeJS.ProcessEnv): number {
  const n = Number(env.HOUGE_HTTPFETCH_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HTTP_FETCH_DEFAULT_MAX_BYTES;
}

/** Optional host denylist (`HOUGE_HTTPFETCH_DENY`): comma-separated, punycode form;
 *  each entry matches the exact host and every subdomain (dot-suffix). */
export function resolveHttpFetchDeny(env: NodeJS.ProcessEnv): string[] {
  return (env.HOUGE_HTTPFETCH_DENY ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

// The blocked ranges (code-owned, NOT configurable): every private/reserved/special
// range plus the safe supersets — CGNAT 100.64/10, 192.0.0/24, benchmarking 198.18/15,
// multicast 224/4, reserved 240/4 (incl. broadcast). IPv6: unspecified/loopback, ULA
// fc00::/7, link-local fe80::/10; embedded IPv4 is decoded and re-checked as IPv4.
const BLOCKED_RANGES = new BlockList();
BLOCKED_RANGES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_RANGES.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_RANGES.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_RANGES.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_RANGES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_RANGES.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_RANGES.addSubnet("192.0.0.0", 24, "ipv4");
BLOCKED_RANGES.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_RANGES.addSubnet("198.18.0.0", 15, "ipv4");
BLOCKED_RANGES.addSubnet("224.0.0.0", 4, "ipv4");
BLOCKED_RANGES.addSubnet("240.0.0.0", 4, "ipv4");
BLOCKED_RANGES.addSubnet("::", 128, "ipv6");
BLOCKED_RANGES.addAddress("::1", "ipv6");
BLOCKED_RANGES.addSubnet("fc00::", 7, "ipv6");
BLOCKED_RANGES.addSubnet("fe80::", 10, "ipv6");

/** Expand an IPv6 literal into its 8 16-bit words (dotted-quad tail folded in first). */
function expandIpv6(ip: string): number[] | undefined {
  if (ip.includes("%")) return undefined; // zone index never appears in a URL host
  let head = ip;
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const parts = tail.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
    const hi = ((parts[0]! << 8) | parts[1]!).toString(16);
    const lo = ((parts[2]! << 8) | parts[3]!).toString(16);
    head = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return undefined;
  const words = [...left, ...Array<string>(fill).fill("0"), ...right];
  if (words.length !== 8) return undefined;
  const nums = words.map((w) => (/^[0-9a-fA-F]{1,4}$/.test(w) ? Number.parseInt(w, 16) : Number.NaN));
  return nums.some(Number.isNaN) ? undefined : nums;
}

/** The IPv4 embedded in an IPv6 transition address (`::ffff:0:0/96` both spellings,
 *  IPv4-compatible `::/96`, NAT64 `64:ff9b::/96`), or undefined for plain IPv6. */
function embeddedIpv4(ip: string): string | undefined {
  const w = expandIpv6(ip);
  if (!w) return undefined;
  const zero5 = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
  const mappedOrCompat = zero5 && (w[5] === 0xffff || w[5] === 0);
  const nat64 = w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0;
  if (!mappedOrCompat && !nat64) return undefined;
  return `${w[6]! >> 8}.${w[6]! & 0xff}.${w[7]! >> 8}.${w[7]! & 0xff}`;
}

/**
 * Classify one resolved address against the block tables. Pure and table-testable.
 * IPv6 transition addresses are decoded and re-checked as their embedded IPv4 (an
 * `::ffff:127.0.0.1` must never reach loopback). Unparseable ⇒ blocked (fail closed).
 */
export function classifyFetchIp(ip: string): "public" | "blocked" {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_RANGES.check(ip, "ipv4") ? "blocked" : "public";
  if (family === 6) {
    const embedded = embeddedIpv4(ip);
    if (embedded !== undefined) return classifyFetchIp(embedded);
    return BLOCKED_RANGES.check(ip, "ipv6") ? "blocked" : "public";
  }
  return "blocked";
}

/**
 * True when `host` matches a deny entry exactly or as a subdomain (dot-suffix).
 * A trailing FQDN dot is stripped first — WHATWG keeps it on DNS-name hosts
 * (`blocked.example.`), and it must not let a denied host slip the check.
 */
export function hostDenied(host: string, deny: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return deny.some((entry) => {
    const e = entry.toLowerCase().replace(/\.$/, "");
    return h === e || h.endsWith(`.${e}`);
  });
}

export interface ValidatedFetchTarget {
  url: URL;
  method: "GET" | "HEAD";
}

export type FetchTargetValidation = { ok: true; target: ValidatedFetchTarget } | { ok: false; error: string };

function refused(message: string): FetchTargetValidation {
  return { ok: false, error: `refused: ${message}` };
}

/** The URL's hostname with IPv6 brackets stripped (URL keeps them: `[::1]`). */
function bareHostname(url: URL): string {
  const h = url.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/**
 * Pure policy gate for one fetch target. WHATWG `new URL` canonicalizes obfuscated
 * IPv4 literals (`0177.0.0.1` / `2130706433` / `0x7f.1` → `127.0.0.1`) and punycodes
 * IDNs, so the denylist and the literal-IP classification see the normalized host.
 */
export function validateFetchTarget(rawUrl: string, method: string, deny: string[]): FetchTargetValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refused("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refused(`scheme "${url.protocol.replace(/:$/, "")}" is not allowed (http/https only)`);
  }
  const m = method.trim().toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    return refused(`method "${method}" is not allowed (GET/HEAD only)`);
  }
  if (url.username !== "" || url.password !== "") {
    return refused("credentials in the URL are not allowed");
  }
  const host = bareHostname(url);
  if (host.length === 0) return refused("the URL has no host");
  if (hostDenied(url.hostname, deny)) return refused(`host "${url.hostname}" is denylisted`);
  // Literal-IP hosts skip DNS but never skip validation.
  if (isIP(host) !== 0 && classifyFetchIp(host) === "blocked") {
    return refused(`address ${host} is in a blocked range`);
  }
  return { ok: true, target: { url, method: m } };
}

// --- zero-dep html → text ---

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  copy: "©",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”"
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code)) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strip script/style/comments/tags, decode entities, collapse whitespace. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-zA-Z!][^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

// --- the fetch itself ---

export interface HttpFetchInput {
  url: string;
  method?: string;
}

export interface HttpFetchConfig {
  timeoutMs?: number;
  maxBytes?: number;
  deny?: string[];
  /**
   * Content char cap override (default HTTP_FETCH_CONTENT_CHAR_CAP). P2 venue adapters
   * raise it for structured API JSON they parse deterministically — the 6k default
   * exists to bound what enters an LLM transcript, which that path never does.
   */
  charCap?: number;
}

/** Minimal request/response shapes (satisfied by node:http, fakeable without sockets). */
export interface FetchResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy(): unknown;
}

export interface FetchRequestLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  end(): unknown;
  destroy(error?: Error): unknown;
}

export interface FetchRequestOptions {
  method: string;
  headers: Record<string, string>;
  /** Always false: keep-alive socket reuse must never bypass a later fetch's pin. */
  agent: false;
  /** The pinned resolver — only ever yields the single pre-validated address. */
  lookup: (hostname: string, options: unknown, callback?: unknown) => void;
}

export type HttpFetchRequestImpl = (
  url: URL,
  options: FetchRequestOptions,
  onResponse: (res: FetchResponseLike) => void
) => FetchRequestLike;

/** Injectable seams (mirrors WebSearchAdapterConfig): DNS + transport, no real network in tests. */
export interface HttpFetchDeps {
  resolveAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  requestImpl?: HttpFetchRequestImpl;
}

export interface HttpFetchResult {
  url: string;
  status: number;
  content_type: string;
  content: string;
  truncated: boolean;
  bytes: number;
  /** 3xx only: the absolute redirect target (never followed here). */
  location?: string;
  note?: string;
}

export type HttpFetchOutcome = { ok: true; result: HttpFetchResult } | { ok: false; error: string };

const defaultResolveAll = (hostname: string): Promise<Array<{ address: string; family: number }>> =>
  lookup(hostname, { all: true });

// Boundary cast: ClientRequest/IncomingMessage satisfy the *Like shapes structurally,
// but their overloaded `on` signatures defeat the narrower listener type.
const defaultRequestImpl: HttpFetchRequestImpl = (url, options, onResponse) => {
  const impl = url.protocol === "https:" ? httpsRequest : httpRequest;
  const req = impl(url, options as RequestOptions, (res) => onResponse(res as unknown as FetchResponseLike));
  return req as unknown as FetchRequestLike;
};

type LookupCallback = (
  err: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

/** The pin: a lookup closure that answers every socket resolution with the ONE
 *  pre-validated address — DNS is consulted exactly once per fetch, by construction. */
function pinnedLookup(address: string, family: number): FetchRequestOptions["lookup"] {
  return (_hostname, options, callback) => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

function headerValue(headers: FetchResponseLike["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Textual payloads pass through (or strip, for html); anything else is metadata-only. */
function isTextualMime(mime: string): boolean {
  return (
    mime === "" ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function decodeBody(body: Buffer, contentType: string): string {
  const match = /charset=["']?([\w.-]+)["']?/i.exec(contentType);
  if (match) {
    try {
      return new TextDecoder(match[1]!.toLowerCase()).decode(body);
    } catch {
      // unknown charset label → utf-8 fallback
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

/** Shape a finished body: html → text, textual passthrough, binary → metadata-only note. */
function shapeBody(
  url: URL,
  status: number,
  contentType: string,
  body: Buffer,
  truncatedBytes: boolean,
  charCap: number = HTTP_FETCH_CONTENT_CHAR_CAP
): HttpFetchResult {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (!isTextualMime(mime)) {
    return {
      url: url.toString(),
      status,
      content_type: contentType,
      content: "",
      truncated: truncatedBytes,
      bytes: body.length,
      note: `binary content (${mime}) — bytes not shown`
    };
  }
  const text = decodeBody(body, contentType);
  const shaped = mime === "text/html" || mime === "application/xhtml+xml" ? htmlToText(text) : text;
  const overCap = shaped.length > charCap;
  return {
    url: url.toString(),
    status,
    content_type: contentType,
    content: overCap ? shaped.slice(0, charCap) : shaped,
    truncated: truncatedBytes || overCap,
    bytes: body.length
  };
}

/**
 * Fetch ONE validated public URL. Validation → resolve-all → classify EVERY address →
 * pinned request → streamed, capped, optionally-decompressed body. Never follows a
 * redirect; never sends auth headers; never echoes env config in errors.
 */
export async function fetchUrl(
  input: HttpFetchInput,
  config: HttpFetchConfig = {},
  deps: HttpFetchDeps = {}
): Promise<HttpFetchOutcome> {
  const timeoutMs = config.timeoutMs ?? resolveHttpFetchTimeoutMs(process.env);
  const maxBytes = config.maxBytes ?? resolveHttpFetchMaxBytes(process.env);
  const deny = config.deny ?? resolveHttpFetchDeny(process.env);

  const validated = validateFetchTarget(input.url, input.method ?? "GET", deny);
  if (!validated.ok) return { ok: false, error: validated.error };
  const { url, method } = validated.target;
  const host = bareHostname(url);

  // Resolve ONCE; a literal-IP host skips DNS (already classified in validation).
  let addresses: Array<{ address: string; family: number }>;
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    addresses = [{ address: host, family: literalFamily }];
  } else {
    const resolveAll = deps.resolveAll ?? defaultResolveAll;
    try {
      addresses = await resolveAll(host);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `DNS lookup failed for ${host}: ${message}` };
    }
    if (addresses.length === 0) {
      return { ok: false, error: `DNS lookup returned no addresses for ${host}` };
    }
  }
  // ANY blocked address rejects the whole fetch (mixed public+private = rebinding shape).
  for (const candidate of addresses) {
    if (classifyFetchIp(candidate.address) === "blocked") {
      return { ok: false, error: `refused: ${host} resolves to a blocked address (${candidate.address})` };
    }
  }
  const pinned = addresses[0]!;

  const requestImpl = deps.requestImpl ?? defaultRequestImpl;
  return await new Promise<HttpFetchOutcome>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (outcome: HttpFetchOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    const req = requestImpl(
      url,
      {
        method,
        // identity: the byte cap must bind real output; a server that gzips anyway is
        // decompressed below so the cap still binds DECOMPRESSED bytes.
        headers: { accept: "*/*", "accept-encoding": "identity", "user-agent": "houge-http-fetch/1.0" },
        agent: false,
        lookup: pinnedLookup(pinned.address, pinned.family)
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = headerValue(res.headers, "content-type") ?? "";

        // NO-FOLLOW: report the absolute target; the next fetch revalidates from scratch.
        if (status >= 300 && status < 400) {
          const location = headerValue(res.headers, "location");
          res.destroy();
          const result: HttpFetchResult = {
            url: url.toString(),
            status,
            content_type: contentType,
            content: "",
            truncated: false,
            bytes: 0,
            note: "redirect not followed — fetch the reported location as a separate step if needed"
          };
          if (location !== undefined) {
            try {
              result.location = new URL(location, url).toString();
            } catch {
              // unparseable location header → omitted
            }
          }
          settle({ ok: true, result });
          return;
        }

        if (method === "HEAD") {
          res.destroy();
          settle({
            ok: true,
            result: { url: url.toString(), status, content_type: contentType, content: "", truncated: false, bytes: 0 }
          });
          return;
        }

        // Stream the body under the byte cap; decompress-if-gzipped so the cap binds
        // decompressed output (zip-bomb guard). Cap hit → destroy, keep the prefix.
        const encoding = (headerValue(res.headers, "content-encoding") ?? "").trim().toLowerCase();
        const decoder =
          encoding === "gzip" || encoding === "x-gzip"
            ? createGunzip()
            : encoding === "deflate"
              ? createInflate()
              : encoding === "br"
                ? createBrotliDecompress()
                : undefined;

        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncatedBytes = false;
        const finish = (): void => {
          if (settled) return;
          settle({ ok: true, result: shapeBody(url, status, contentType, Buffer.concat(chunks), truncatedBytes, config.charCap) });
        };
        const onChunk = (chunk: Buffer): void => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (bytes - maxBytes)));
            truncatedBytes = true;
            finish();
            res.destroy();
            decoder?.destroy();
            return;
          }
          chunks.push(chunk);
        };
        const onStreamError = (error: Error): void =>
          settle({ ok: false, error: `http_fetch body read failed: ${error.message}` });

        if (decoder) {
          decoder.on("data", onChunk);
          decoder.on("end", finish);
          decoder.on("error", onStreamError);
          res.on("data", (chunk: Buffer) => {
            decoder.write(chunk);
          });
          res.on("end", () => {
            decoder.end();
          });
          res.on("error", onStreamError);
        } else {
          res.on("data", onChunk);
          res.on("end", finish);
          res.on("error", onStreamError);
        }
      }
    );

    // Overall wall clock (catches slow-trickle, not just connect).
    timer = setTimeout(() => {
      settle({ ok: false, error: `http_fetch timed out after ${timeoutMs}ms` });
      req.destroy();
    }, timeoutMs);

    req.on("error", (error: Error) => {
      settle({ ok: false, error: `http_fetch request failed: ${error.message}` });
    });
    req.end();
  });
}
