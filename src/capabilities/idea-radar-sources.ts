import type { HttpFetchConfig, HttpFetchInput, HttpFetchOutcome } from "../web/http-fetch.js";
import { fetchUrl } from "../web/http-fetch.js";
import { stripHostileChars } from "./text-hygiene.js";

/**
 * Idea Radar R1 (spec 2026-07-24) — the code-owned source registry + deterministic
 * slimmers, the radar's FIRST trust boundary. The model never picks a URL: every entry
 * is a hardcoded public JSON GET, fetched through `fetchUrl` (SSRF floor, pinned
 * request, streamed byte cap, no redirects, no auth headers) with the B1 `charCap`
 * override (bounty-intake precedent — the 6k default would truncate every JSON body
 * mid-document). Slimmers are pure `(body) => RadarItem[]`: at most
 * {@link RADAR_MAX_ITEMS_PER_SOURCE} items, every field char-capped, ids charset-locked
 * and namespaced `<key>:<native>`, and every stored URL either code-constructed from a
 * validated native id or host-checked against the source's own content hosts — a
 * hostile payload can drop items, never smuggle one.
 */

export type RadarItem = { id: string; title: string; url: string; meta: string };

export type RadarSource = {
  key: string;
  /** Exact GET URL (gh_new interpolates a code-computed date from the injected now). */
  url: string;
  /** Per-source fetch cap — also the charCap (B1), so JSON never truncates mid-document. */
  maxBytes: number;
  /** Deterministic parser, pure; throws → the SOURCE failed (isolated by the fetch helper). */
  slim: (body: string) => RadarItem[];
  /** Reddit/X placeholders — never fetched while dormant (R1.5 broker approvals pending). */
  dormant?: boolean;
};

/** Slimmer output cap per source (spec §3 constants). */
export const RADAR_MAX_ITEMS_PER_SOURCE = 25;

/** Per-source fetch byte cap AND char cap (B1: charCap must equal maxBytes). */
export const RADAR_SOURCE_MAX_BYTES = 262_144;

/** Wall-clock cap per source fetch (mirrors BOUNTY_FETCH_TIMEOUT_MS — structured JSON APIs). */
export const RADAR_FETCH_TIMEOUT_MS = 8_000;

/** Item field caps (spec §1): id validated then length-checked, title/meta sliced. */
export const RADAR_ITEM_ID_MAX_CHARS = 64;
export const RADAR_ITEM_TITLE_MAX_CHARS = 160;
/** L1: the one field the spec left un-capped — an over-length URL drops the item whole. */
export const RADAR_ITEM_URL_MAX_CHARS = 512;
export const RADAR_ITEM_META_MAX_CHARS = 120;

/** Namespaced id charset — path-safe, no whitespace/quotes/markup can survive into an id. */
const RADAR_ITEM_ID_RE = /^[A-Za-z0-9_:\-\/\.]+$/;

// --- item floor -----------------------------------------------------------------

/**
 * Flatten every line-break class + collapse runs — titles/metas render into prompts and
 * Telegram. Strips the shared hostile-char class BEFORE capping (M1: C0/C1 controls incl.
 * ESC, bidi overrides/isolates, zero-width/BOM — the same class sanitizeVenueText strips)
 * and caps on code points (L6: a naive .slice can shear a surrogate pair in half and
 * store a lone surrogate).
 */
function flatCap(value: string, cap: number): string {
  const flat = stripHostileChars(value).replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, cap).join("").trim();
}

/** Exact host or dot-suffix subdomain match against the source's allowed content hosts. */
function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  return allowed.some((base) => host === base || host.endsWith(`.${base}`));
}

/**
 * Build ONE validated item or drop it (undefined): namespaced id must pass the charset
 * + length locks; title must be a non-empty string (capped); the url must parse, be
 * https, and stay on an allowed host — whether it came from the payload or was
 * code-constructed (uniform floor, no trusted path).
 */
function radarItem(input: {
  key: string;
  nativeId: unknown;
  title: unknown;
  url: string;
  meta: string;
  hosts: readonly string[];
  idPattern: RegExp;
}): RadarItem | undefined {
  if (typeof input.nativeId !== "string" && typeof input.nativeId !== "number") return undefined;
  // L2: per-source native-id shape lock BEFORE namespacing — the global charset alone
  // admits `.`/`/`, which lets a hostile `../..`-style id steer a code-constructed URL
  // to an arbitrary path on the allowed host (inert in R1, a stored-URL bomb for R2).
  const native = String(input.nativeId);
  if (!input.idPattern.test(native) || /\.\.|\/\//.test(native)) return undefined;
  const id = `${input.key}:${native}`;
  if (!RADAR_ITEM_ID_RE.test(id) || id.length > RADAR_ITEM_ID_MAX_CHARS) return undefined;

  if (typeof input.title !== "string") return undefined;
  const title = flatCap(input.title, RADAR_ITEM_TITLE_MAX_CHARS);
  if (title.length === 0) return undefined;

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.port !== "" || !hostAllowed(url.hostname, input.hosts)) {
    return undefined;
  }
  // L5: userinfo would smuggle a foreign-looking origin past a casual reader; L1: an
  // over-length URL is dropped whole — truncating one just stores garbage.
  if (url.username !== "" || url.password !== "") return undefined;
  const urlText = url.toString();
  if (urlText.length > RADAR_ITEM_URL_MAX_CHARS) return undefined;

  return { id, title, url: urlText, meta: flatCap(input.meta, RADAR_ITEM_META_MAX_CHARS) };
}

// --- slimmers ---------------------------------------------------------------------

/** Parse the body as JSON and demand an array at `pick(json)` — anything else throws (source failed). */
function requireArray(body: string, pick: (json: unknown) => unknown): unknown[] {
  const json: unknown = JSON.parse(body);
  const arr = pick(json);
  if (!Array.isArray(arr)) throw new Error("unexpected payload shape");
  return arr;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Both HN sources share the Algolia shape; the item URL is CONSTRUCTED from the story id. */
function slimAlgolia(key: string): (body: string) => RadarItem[] {
  return (body) => {
    const items: RadarItem[] = [];
    for (const raw of requireArray(body, (j) => asRecord(j)?.hits)) {
      if (items.length >= RADAR_MAX_ITEMS_PER_SOURCE) break;
      const hit = asRecord(raw);
      if (!hit || typeof hit.objectID !== "string") continue;
      const item = radarItem({
        key,
        nativeId: hit.objectID,
        idPattern: /^\d+$/,
        title: hit.title,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        meta: `${num(hit.points)} points · ${num(hit.num_comments)} comments`,
        hosts: ["news.ycombinator.com"]
      });
      if (item) items.push(item);
    }
    return items;
  };
}

/** HuggingFace daily papers: top-level array; URL constructed from the paper id. */
function slimHfPapers(body: string): RadarItem[] {
  const items: RadarItem[] = [];
  for (const raw of requireArray(body, (j) => j)) {
    if (items.length >= RADAR_MAX_ITEMS_PER_SOURCE) break;
    const paper = asRecord(asRecord(raw)?.paper);
    if (!paper || typeof paper.id !== "string") continue;
    const item = radarItem({
      key: "hf_papers",
      nativeId: paper.id,
      idPattern: /^\d{4}\.\d{4,5}(v\d+)?$/,
      title: paper.title,
      url: `https://huggingface.co/papers/${paper.id}`,
      meta: `${num(paper.upvotes)} upvotes`,
      hosts: ["huggingface.co"]
    });
    if (item) items.push(item);
  }
  return items;
}

/** Devpost open hackathons: the payload URL is kept, but ONLY on a devpost.com host. */
function slimDevpost(body: string): RadarItem[] {
  const items: RadarItem[] = [];
  for (const raw of requireArray(body, (j) => asRecord(j)?.hackathons)) {
    if (items.length >= RADAR_MAX_ITEMS_PER_SOURCE) break;
    const hackathon = asRecord(raw);
    if (!hackathon || typeof hackathon.url !== "string") continue;
    const item = radarItem({
      key: "devpost",
      nativeId: hackathon.id,
      idPattern: /^\d+$/,
      title: hackathon.title,
      url: hackathon.url,
      meta: `open · ${num(hackathon.registrations_count)} registrations`,
      hosts: ["devpost.com"]
    });
    if (item) items.push(item);
  }
  return items;
}

/** GitHub new-repo search: html_url must stay on github.com; description folds into the title. */
function slimGhNew(body: string): RadarItem[] {
  const items: RadarItem[] = [];
  for (const raw of requireArray(body, (j) => asRecord(j)?.items)) {
    if (items.length >= RADAR_MAX_ITEMS_PER_SOURCE) break;
    const repo = asRecord(raw);
    if (!repo || typeof repo.full_name !== "string" || typeof repo.html_url !== "string") continue;
    const description = typeof repo.description === "string" ? repo.description.trim() : "";
    const item = radarItem({
      key: "gh_new",
      nativeId: repo.full_name,
      idPattern: /^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/,
      title: description ? `${repo.full_name} — ${description}` : repo.full_name,
      url: repo.html_url,
      meta: `${num(repo.stargazers_count)} stars`,
      hosts: ["github.com"]
    });
    if (item) items.push(item);
  }
  return items;
}

/** lobste.rs hottest: top-level array; the story URL is constructed from short_id. */
function slimLobsters(body: string): RadarItem[] {
  const items: RadarItem[] = [];
  for (const raw of requireArray(body, (j) => j)) {
    if (items.length >= RADAR_MAX_ITEMS_PER_SOURCE) break;
    const story = asRecord(raw);
    if (!story || typeof story.short_id !== "string") continue;
    const item = radarItem({
      key: "lobsters",
      nativeId: story.short_id,
      idPattern: /^[A-Za-z0-9]+$/,
      title: story.title,
      url: `https://lobste.rs/s/${story.short_id}`,
      meta: `${num(story.score)} points · ${num(story.comment_count)} comments`,
      hosts: ["lobste.rs"]
    });
    if (item) items.push(item);
  }
  return items;
}

/** A dormant slimmer must never run — being called at all is a wiring bug. */
function slimDormant(): RadarItem[] {
  throw new Error("dormant source must never be fetched or slimmed");
}

// --- registry -----------------------------------------------------------------------

/** `YYYY-MM-DD` seven days before the injected now — the gh_new search window. */
function ghCreatedSince(now: string): string {
  return new Date(Date.parse(now) - 7 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The launch registry (spec §1). URLs are recorded at their FINAL post-redirect form
 * (W2 — `fetchUrl` never follows a 3xx); the §7 live dry-run gate re-verifies them.
 * gh_new's query is URL-encoded (`created:%3E<date>`) and star-sorted (W4).
 */
export function buildRadarSources(now: string): RadarSource[] {
  return [
    {
      key: "hn_front",
      url: "https://hn.algolia.com/api/v1/search?tags=front_page",
      maxBytes: RADAR_SOURCE_MAX_BYTES,
      slim: slimAlgolia("hn_front")
    },
    {
      key: "hn_show",
      url: "https://hn.algolia.com/api/v1/search?tags=show_hn",
      maxBytes: RADAR_SOURCE_MAX_BYTES,
      slim: slimAlgolia("hn_show")
    },
    {
      key: "hf_papers",
      url: "https://huggingface.co/api/daily_papers",
      maxBytes: RADAR_SOURCE_MAX_BYTES,
      slim: slimHfPapers
    },
    {
      key: "devpost",
      url: "https://devpost.com/api/hackathons?status%5B%5D=open",
      maxBytes: RADAR_SOURCE_MAX_BYTES,
      slim: slimDevpost
    },
    {
      key: "gh_new",
      url: `https://api.github.com/search/repositories?q=created:%3E${ghCreatedSince(now)}&sort=stars&order=desc`,
      maxBytes: RADAR_SOURCE_MAX_BYTES,
      slim: slimGhNew
    },
    {
      key: "lobsters",
      url: "https://lobste.rs/hottest.json",
      maxBytes: RADAR_SOURCE_MAX_BYTES,
      slim: slimLobsters
    },
    // Dormant rows (spec §1): Reddit needs an approved API app + broker-held secret and
    // X needs a paid API tier — both are the R1.5 transport slice. Registered here so the
    // registry names the whole intended constellation, but NEVER fetched while dormant.
    { key: "reddit", url: "", maxBytes: RADAR_SOURCE_MAX_BYTES, slim: slimDormant, dormant: true },
    { key: "x", url: "", maxBytes: RADAR_SOURCE_MAX_BYTES, slim: slimDormant, dormant: true }
  ];
}

// --- fetch helper ---------------------------------------------------------------------

export interface RadarSourcesResult {
  ok: Array<{ key: string; items: RadarItem[] }>;
  failed: string[];
}

/**
 * Fetch + slim every non-dormant source with per-source failure isolation (spec §1):
 * fetch error, non-200, truncated body, or a slimmer throw all record the source in
 * `failed` and the pass continues. Every fetch carries the FULL config — timeout,
 * byte cap, `charCap: maxBytes` (B1), empty deny (the SSRF floor still applies).
 */
export async function fetchRadarSources(input: {
  fetch?: (i: HttpFetchInput, c?: HttpFetchConfig) => Promise<HttpFetchOutcome>;
  now: string;
}): Promise<RadarSourcesResult> {
  const doFetch = input.fetch ?? fetchUrl;
  const ok: Array<{ key: string; items: RadarItem[] }> = [];
  const failed: string[] = [];

  for (const source of buildRadarSources(input.now)) {
    if (source.dormant) continue;
    try {
      const outcome = await doFetch(
        { url: source.url },
        { timeoutMs: RADAR_FETCH_TIMEOUT_MS, maxBytes: source.maxBytes, charCap: source.maxBytes, deny: [] }
      );
      if (!outcome.ok || outcome.result.status !== 200 || outcome.result.truncated) {
        failed.push(source.key);
        continue;
      }
      ok.push({ key: source.key, items: source.slim(outcome.result.content) });
    } catch {
      failed.push(source.key);
    }
  }
  return { ok, failed };
}
