import type { HttpFetchConfig, HttpFetchInput, HttpFetchOutcome } from "../web/http-fetch.js";
import { fetchUrl } from "../web/http-fetch.js";
import type { ProjectRow, RunStore } from "../run/run-store.js";
import type { ProjectState } from "../domain/types.js";

/**
 * Money-Work P2 (spec 2026-07-18): bounty venue intake + deterministic legitimacy
 * scoring. Read-only, identity-free, unauthenticated GETs against a hardcoded host
 * allowlist — charter-clean under ADR 0022. Deterministic code owns every scam signal
 * and all venue I/O; the model only narrates on top of the rendered table.
 *
 * ADR 0014 carve-out (spec §carve-out): this module's output is NOT routed through the
 * quarantine reader. It is a deterministically constructed digest of capped, sanitized,
 * schema-typed fields — the raw venue JSON never reaches any model. The invariant "no
 * venue string escapes except through the sanitizer" is enforced here and unit-tested.
 */

// --- env -----------------------------------------------------------------------

export function resolveBountyEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.HOUGE_BOUNTY_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export const BOUNTY_DEFAULT_MAX_CANDIDATES = 8;

export function resolveBountyMaxCandidates(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt((env.HOUGE_BOUNTY_MAX_CANDIDATES ?? "").trim(), 10);
  if (!Number.isInteger(raw) || raw < 1 || raw > 30) return BOUNTY_DEFAULT_MAX_CANDIDATES;
  return raw;
}

// --- venue I/O floor -----------------------------------------------------------

/** Exact-hostname allowlist — tighter than the general SSRF floor (spec §1). */
export const BOUNTY_VENUE_HOSTS: ReadonlySet<string> = new Set(["api.github.com", "algora.io"]);

export const BOUNTY_FETCH_TIMEOUT_MS = 8_000;
export const BOUNTY_FETCH_MAX_BYTES = 512_000;
/** Parsed deterministically, never enters a transcript — the 6k LLM cap doesn't apply. */
export const BOUNTY_FETCH_CHAR_CAP = 900_000;
export const BOUNTY_SCAN_DEADLINE_MS = 75_000;
export const BOUNTY_RESCAN_MIN_MS = 10 * 60_000;
const VENUE_CACHE_TTL_MS = 60 * 60_000;

export interface BountyIntakeDeps {
  fetchUrl: (input: HttpFetchInput, config?: HttpFetchConfig) => Promise<HttpFetchOutcome>;
  now: () => Date;
  /** Per-process TTL cache for slow-churn metadata (/repos, shields). */
  cache: Map<string, { at: number; json: unknown }>;
}

const processCache = new Map<string, { at: number; json: unknown }>();

export function defaultBountyIntakeDeps(): BountyIntakeDeps {
  return { fetchUrl, now: () => new Date(), cache: processCache };
}

export type VenueFetch =
  | { ok: true; json: unknown }
  | { ok: false; error: string; rateLimited: boolean };

/**
 * GET one allowlisted venue URL as JSON. Wraps `fetchUrl` (resolve-all + classify +
 * IP-pinned request, redirect-never-follow, byte cap) behind an exact-host check on
 * the WHATWG-normalized hostname. 3xx/4xx/5xx are venue failures (degrade, never
 * throw); 403/429 flags rateLimited so the scan stops spending its budget.
 */
export async function fetchVenueJson(
  rawUrl: string,
  deps: BountyIntakeDeps,
  options: { cache?: boolean } = {}
): Promise<VenueFetch> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "invalid url", rateLimited: false };
  }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (url.protocol !== "https:" || url.port !== "" || !BOUNTY_VENUE_HOSTS.has(host)) {
    return { ok: false, error: `host not allowlisted: ${host}`, rateLimited: false };
  }
  // WHATWG-normalized (lowercased, punycoded) — never the raw caller string.
  const target = url.toString();

  const cached = options.cache ? deps.cache.get(target) : undefined;
  if (cached && deps.now().getTime() - cached.at < VENUE_CACHE_TTL_MS) {
    return { ok: true, json: cached.json };
  }

  const outcome = await deps.fetchUrl(
    { url: target },
    { timeoutMs: BOUNTY_FETCH_TIMEOUT_MS, maxBytes: BOUNTY_FETCH_MAX_BYTES, charCap: BOUNTY_FETCH_CHAR_CAP, deny: [] }
  );
  if (!outcome.ok) return { ok: false, error: outcome.error, rateLimited: false };
  const { status, content, truncated } = outcome.result;
  if (status === 403 || status === 429) {
    return { ok: false, error: `venue rate limit (${status})`, rateLimited: true };
  }
  if (status !== 200) return { ok: false, error: `venue status ${status}`, rateLimited: false };
  if (truncated) return { ok: false, error: "venue payload truncated", rateLimited: false };
  try {
    const json: unknown = JSON.parse(content);
    if (options.cache) deps.cache.set(target, { at: deps.now().getTime(), json });
    return { ok: true, json };
  } catch {
    return { ok: false, error: "venue payload is not valid JSON", rateLimited: false };
  }
}

// --- hygiene (spec §3 — the ONLY gate venue strings pass to reach a transcript) --

// C0/C1 controls, bidi overrides/isolates, zero-width + BOM.
const STRIP_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g;

export function sanitizeVenueText(raw: unknown, maxChars: number): string {
  if (typeof raw !== "string") return "";
  const flat = raw.replace(/[\r\n\t\u2028\u2029\u0085]+/g, " ").replace(STRIP_RE, "").replace(/\s{2,}/g, " ").trim();
  const points = Array.from(flat);
  return points.length > maxChars ? `${points.slice(0, maxChars).join("")}…` : flat;
}

export const BOUNTY_AMOUNT_MIN_USD = 1;
export const BOUNTY_AMOUNT_MAX_USD = 100_000;

/** Whole USD from a `$500` / `$1k` / `$1,250` label; out-of-bounds ⇒ null (claimed, never verified). */
export function parseAmountUsd(text: string): number | null {
  const match = /\$\s*([\d,]+(?:\.\d+)?)\s*(k)?/i.exec(text);
  if (!match) return null;
  const base = Number.parseFloat(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const dollars = Math.round(match[2] ? base * 1_000 : base);
  if (dollars < BOUNTY_AMOUNT_MIN_USD || dollars > BOUNTY_AMOUNT_MAX_USD) return null;
  return dollars;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

/** Strict `https://github.com/<owner>/<repo>/issues/<n>` (the project_track anchor grammar). */
export function parseIssueUrl(raw: string): { owner: string; repo: string; issue: number } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.replace(/\.$/, "").toLowerCase() !== "github.com") return null;
  if (url.port !== "" || url.search !== "" || url.hash !== "") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "issues") return null;
  const [owner, repo] = [parts[0]!, parts[1]!];
  const issue = Number.parseInt(parts[3]!, 10);
  if (!isValidOwner(owner) || !isValidRepo(repo) || !Number.isInteger(issue) || issue < 1) return null;
  if (String(issue) !== parts[3]) return null;
  return { owner, repo, issue };
}

// --- candidate model -----------------------------------------------------------

export type BountyVerdict = "candidate" | "scam_suspect" | "unverified";

export interface BountyCandidate {
  issue_url: string;
  owner: string;
  repo: string;
  title: string;
  labels: string[];
  amount_usd: number | null;
  issue_created_at: string | null;
  comments: number;
  bot_verified: boolean;
  /** Whether bot_verified was determinable inside the fetched window (spec MAJOR 5). */
  bot_window_covered: boolean;
  rewarded_sibling: boolean;
  enrich?: {
    fork: boolean;
    org_owner: boolean;
    repo_created_at: string | null;
    pushed_at: string | null;
    stars: number;
    forks: number;
    merged_pr_in_window: boolean;
    /** null = shields unknown (404/keying mismatch) — score-neutral, never negative. */
    shields_completed_total: number | null;
  };
  score: number;
  verdict: BountyVerdict;
  reject_reasons: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export const BOUNTY_LABEL_MAX = 10;
export const BOUNTY_LABEL_CHAR_MAX = 50;
export const BOUNTY_TITLE_CHAR_MAX = 120;

/**
 * Normalize one GitHub search item. Tolerant shape-check: wrong type ⇒ drop field,
 * never throw (CLAUDE.md "never trust shape/type"). The issue BODY is present in the
 * payload and is deliberately never read — discarded at this parse boundary.
 */
export function normalizeSearchItem(item: unknown): BountyCandidate | null {
  const record = asRecord(item);
  if (!record) return null;
  const parsed = parseIssueUrl(asString(record.html_url) ?? "");
  if (!parsed) return null;
  const labels = asArray(record.labels)
    .map((entry) => sanitizeVenueText(asRecord(entry)?.name, BOUNTY_LABEL_CHAR_MAX))
    .filter((name) => name.length > 0)
    .slice(0, BOUNTY_LABEL_MAX);
  const labelAmount = labels.map(parseAmountUsd).find((amount) => amount !== null) ?? null;
  return {
    issue_url: `https://github.com/${parsed.owner}/${parsed.repo}/issues/${parsed.issue}`,
    owner: parsed.owner,
    repo: parsed.repo,
    title: sanitizeVenueText(record.title, BOUNTY_TITLE_CHAR_MAX),
    labels,
    amount_usd: labelAmount,
    issue_created_at: asString(record.created_at),
    comments: asNumber(record.comments) ?? 0,
    bot_verified: false,
    bot_window_covered: false,
    rewarded_sibling: false,
    score: 0,
    verdict: "unverified",
    reject_reasons: []
  };
}

// --- venue adapters ------------------------------------------------------------

const GITHUB_SEARCH_BASE = "https://api.github.com/search/issues";
export const BOUNTY_SEARCH_PER_PAGE = 30;

function searchUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    sort: "created",
    order: "desc",
    per_page: String(BOUNTY_SEARCH_PER_PAGE)
  });
  return `${GITHUB_SEARCH_BASE}?${params.toString()}`;
}

export interface VenueListing {
  candidates: BountyCandidate[];
  degraded: string[];
  rateLimited: boolean;
  /** True when the broad listing search itself succeeded (budget genuinely spent). */
  listingOk: boolean;
}

/**
 * The listing spine (spec §venue reality): 2 search calls — the broad `💎 Bounty`
 * window + the `commenter:algora-pbc` bot-verified window. bot_verified is only
 * asserted for issues the second window actually covered.
 */
export async function listGithubCandidates(deps: BountyIntakeDeps): Promise<VenueListing> {
  const degraded: string[] = [];
  const broad = await fetchVenueJson(searchUrl('label:"💎 Bounty" is:issue state:open'), deps);
  if (!broad.ok) {
    return {
      candidates: [],
      degraded: [`github-search: ${broad.error}`],
      rateLimited: broad.rateLimited,
      listingOk: false
    };
  }
  const items = asArray(asRecord(broad.json)?.items);
  const byUrl = new Map<string, BountyCandidate>();
  for (const item of items) {
    const candidate = normalizeSearchItem(item);
    if (candidate && !byUrl.has(candidate.issue_url)) byUrl.set(candidate.issue_url, candidate);
  }

  const rewardedRepos = new Set<string>();
  for (const candidate of byUrl.values()) {
    if (candidate.labels.some((label) => label.includes("💰") || /rewarded/i.test(label))) {
      rewardedRepos.add(`${candidate.owner}/${candidate.repo}`);
    }
  }
  for (const candidate of byUrl.values()) {
    candidate.rewarded_sibling = rewardedRepos.has(`${candidate.owner}/${candidate.repo}`);
  }

  const verified = await fetchVenueJson(searchUrl("commenter:algora-pbc is:issue state:open"), deps);
  let rateLimited = false;
  if (verified.ok) {
    const verifiedItems = asArray(asRecord(verified.json)?.items);
    const verifiedUrls = new Set(
      verifiedItems
        .map((item) => normalizeSearchItem(item)?.issue_url)
        .filter((url): url is string => typeof url === "string")
    );
    // Coverage is only claimable when the bot window was exhaustive (returned fewer than
    // a full page) or the candidate itself is in it — a truncated window must not turn
    // "outside the page" into "no bot comment" (spec MAJOR 5 / verifier MINOR 10).
    const windowExhaustive = verifiedItems.length < BOUNTY_SEARCH_PER_PAGE;
    for (const candidate of byUrl.values()) {
      candidate.bot_verified = verifiedUrls.has(candidate.issue_url);
      candidate.bot_window_covered = windowExhaustive || candidate.bot_verified;
    }
  } else {
    degraded.push(`github-bot-window: ${verified.error}`);
    rateLimited = verified.rateLimited;
  }
  return { candidates: [...byUrl.values()], degraded, rateLimited, listingOk: true };
}

/**
 * Enrich one candidate: /repos meta + closed-PR window + Algora shields. Keyed by the
 * GitHub org login — the Algora handle may differ, so a shields 404 is `unknown`
 * (score-neutral), never negative. rateLimited bubbles so the scan stops spending.
 */
export async function enrichCandidate(
  candidate: BountyCandidate,
  deps: BountyIntakeDeps
): Promise<{ rateLimited: boolean }> {
  const repoUrl = `https://api.github.com/repos/${candidate.owner}/${candidate.repo}`;
  const repoMeta = await fetchVenueJson(repoUrl, deps, { cache: true });
  if (!repoMeta.ok) return { rateLimited: repoMeta.rateLimited };
  const meta = asRecord(repoMeta.json);
  if (!meta) return { rateLimited: false };

  let mergedInWindow = false;
  const pulls = await fetchVenueJson(`${repoUrl}/pulls?state=closed&per_page=30`, deps, { cache: true });
  if (pulls.ok) {
    mergedInWindow = asArray(pulls.json).some((pull) => asString(asRecord(pull)?.merged_at) !== null);
  } else if (pulls.rateLimited) {
    return { rateLimited: true };
  }

  let shieldsTotal: number | null = null;
  const shields = await fetchVenueJson(
    `https://algora.io/api/shields/${candidate.owner}/bounties?status=completed`,
    deps,
    { cache: true }
  );
  if (shields.ok) {
    const message = asString(asRecord(shields.json)?.message) ?? "";
    const amount = parseAmountUsd(message);
    shieldsTotal = amount ?? (/\$\s*0\b/.test(message) ? 0 : null);
  }

  candidate.enrich = {
    fork: meta.fork === true,
    org_owner: asString(asRecord(meta.owner)?.type) === "Organization",
    repo_created_at: asString(meta.created_at),
    pushed_at: asString(meta.pushed_at),
    stars: asNumber(meta.stargazers_count) ?? 0,
    forks: asNumber(meta.forks_count) ?? 0,
    merged_pr_in_window: mergedInWindow,
    shields_completed_total: shieldsTotal
  };
  return { rateLimited: false };
}

// --- scorer (spec §2 — exported constants, lessons rule) -------------------------

export const BOUNTY_SCORE_WEIGHTS = {
  org_owner: 10,
  repo_age_1y: 15,
  pushed_30d: 15,
  merged_pr_in_window: 15,
  star_fork_sane: 10,
  rewarded_sibling: 10,
  shields_paid: 15,
  bot_verified: 10
} as const;

export const BOUNTY_YOUNG_REPO_DAYS = 90;

function daysBetween(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (now.getTime() - then) / 86_400_000;
}

/**
 * Deterministic verdict + score. Hard rejects (spec §2): fork-with-bounty-label is
 * unconditional; the rest fire ONLY when strong verification is absent (no bot
 * comment AND no shields paid history) — a legit young escrow-backed org must not be
 * false-rejected. The LLM can narrate around the score but never move a candidate
 * across this line: verdict/score are rendered outside the model.
 */
export function scoreCandidate(candidate: BountyCandidate, now: Date): void {
  const enrich = candidate.enrich;
  if (!enrich) {
    candidate.verdict = "unverified";
    candidate.score = 0;
    return;
  }
  const reasons: string[] = [];
  if (enrich.fork) reasons.push("fork carrying bounty labels");

  const stronglyVerified =
    candidate.bot_verified || (enrich.shields_completed_total !== null && enrich.shields_completed_total > 0);
  if (!stronglyVerified) {
    const age = daysBetween(enrich.repo_created_at, now);
    if (age !== null && age < BOUNTY_YOUNG_REPO_DAYS) reasons.push("repo younger than 90 days");
    if (!enrich.merged_pr_in_window) reasons.push("no merged PR in window");
    if (candidate.amount_usd !== null && !candidate.bot_verified && candidate.bot_window_covered) {
      reasons.push("$-amount only via label, no bot comment");
    }
  }

  if (reasons.length > 0) {
    candidate.verdict = "scam_suspect";
    candidate.reject_reasons = reasons;
    candidate.score = 0;
    return;
  }

  const weights = BOUNTY_SCORE_WEIGHTS;
  let score = 0;
  if (enrich.org_owner) score += weights.org_owner;
  const age = daysBetween(enrich.repo_created_at, now);
  if (age !== null && age >= 365) score += weights.repo_age_1y;
  const pushed = daysBetween(enrich.pushed_at, now);
  if (pushed !== null && pushed <= 30) score += weights.pushed_30d;
  if (enrich.merged_pr_in_window) score += weights.merged_pr_in_window;
  if (enrich.stars >= Math.max(1, enrich.forks / 4)) score += weights.star_fork_sane;
  if (candidate.rewarded_sibling) score += weights.rewarded_sibling;
  if (enrich.shields_completed_total !== null && enrich.shields_completed_total > 0) score += weights.shields_paid;
  if (candidate.bot_verified) score += weights.bot_verified;
  candidate.score = score;
  candidate.verdict = "candidate";
}

// --- scan orchestrator -----------------------------------------------------------

export interface BountyScanResult {
  /** Always ok — degradation is content, not failure (a failed tool burns FAILURE_CAP). */
  text: string;
  stats: { venue_count: number; candidates: number; scam_suspects: number; new_sightings: number };
  throttled: boolean;
  /** False when the listing spine failed outright — such a pass is NOT ledgered as a scan
   *  (verifier MAJOR 5: a transient 403 must not burn the 10-min re-scan window). */
  spentBudget: boolean;
}

let scanInFlight = false;

function escapeForTelegram(text: string): string {
  // Venue-derived strings are rendered inert (spec §3): no markdown/link spoofing.
  return text.replace(/([[\]()*_`~])/g, "");
}

function renderTable(ranked: BountyCandidate[], newUrls: Set<string>): string {
  const lines = ranked.map((candidate, index) => {
    // owner/repo/issue_url are grammar-validated ([A-Za-z0-9._-]) — only the free-text
    // title needs metachar escaping. If the grammar ever loosens, escape those too.
    const flag = newUrls.has(candidate.issue_url) ? " NEW" : "";
    const amount = candidate.amount_usd !== null ? `$${candidate.amount_usd} (claimed)` : "$?";
    const verified = candidate.bot_verified ? "bot-verified" : candidate.verdict;
    return `${index + 1}. [${candidate.score}] ${amount} ${verified}${flag} ${candidate.owner}/${candidate.repo}#${candidate.issue_url.split("/").pop()} — ${escapeForTelegram(candidate.title)}\n   ${candidate.issue_url}`;
  });
  return lines.join("\n");
}

/**
 * One full scan: throttle → list → enrich (budget/deadline-capped) → score → sightings
 * → render. Every failure degrades into the text; the tool result is always ok:true.
 */
export async function runBountyScan(
  store: RunStore,
  env: NodeJS.ProcessEnv,
  deps: BountyIntakeDeps = defaultBountyIntakeDeps()
): Promise<BountyScanResult> {
  const emptyStats = { venue_count: 2, candidates: 0, scam_suspects: 0, new_sightings: 0 };
  const now = deps.now();

  const lastScan = store.latestBountyScanAt();
  if (lastScan && now.getTime() - Date.parse(lastScan) < BOUNTY_RESCAN_MIN_MS) {
    const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(lastScan)) / 60_000));
    return {
      text: `Bounty scan throttled: last scan was ${minutes} min ago (min interval 10 min, shared per-IP API budget). Ask again shortly or use the previous plan.`,
      stats: emptyStats,
      throttled: true,
      spentBudget: false
    };
  }
  if (scanInFlight) {
    return { text: "Bounty scan already in progress.", stats: emptyStats, throttled: true, spentBudget: false };
  }

  scanInFlight = true;
  try {
    const deadline = now.getTime() + BOUNTY_SCAN_DEADLINE_MS;
    const maxCandidates = resolveBountyMaxCandidates(env);
    const listing = await listGithubCandidates(deps);
    const degraded = [...listing.degraded];

    if (listing.candidates.length === 0) {
      const status = degraded.length > 0 ? `\nVenue status: ${degraded.join("; ")}` : "";
      return {
        text: `Bounty scan: no open candidates found.${status}`,
        stats: emptyStats,
        throttled: false,
        spentBudget: listing.listingOk
      };
    }

    // Enrich the newest window first; stop on rate limit or deadline (degrade, don't fail).
    const top = listing.candidates.slice(0, maxCandidates);
    let budgetStopped = listing.rateLimited;
    for (const candidate of top) {
      if (budgetStopped || deps.now().getTime() > deadline) break;
      const { rateLimited } = await enrichCandidate(candidate, deps);
      if (rateLimited) budgetStopped = true;
    }
    for (const candidate of top) scoreCandidate(candidate, now);

    const newUrls = new Set<string>();
    for (const candidate of top) {
      const { isNew } = store.upsertBountySighting({
        issue_url: candidate.issue_url,
        score: candidate.verdict === "unverified" ? null : candidate.score,
        verdict: candidate.verdict,
        now: now.toISOString()
      });
      if (isNew) newUrls.add(candidate.issue_url);
    }

    const ranked = top
      .filter((candidate) => candidate.verdict === "candidate")
      .sort((a, b) => b.score - a.score);
    const unverified = top.filter((candidate) => candidate.verdict === "unverified");
    const suspects = top.filter((candidate) => candidate.verdict === "scam_suspect");

    const sections: string[] = [];
    sections.push(
      `Bounty scan (${listing.candidates.length} open in window, top ${top.length} checked; NEW = newly entered the fetched window):`
    );
    sections.push(ranked.length > 0 ? renderTable(ranked, newUrls) : "No candidates passed the legitimacy floor.");
    if (unverified.length > 0) {
      sections.push(
        `Not verified (budget, deadline, or venue error before checks): ${unverified
          .map((candidate) => `${candidate.owner}/${candidate.repo}`)
          .join(", ")}`
      );
    }
    sections.push(
      `Scam-filtered: ${suspects.length} (${suspects.map((s) => `${s.owner}/${s.repo}: ${s.reject_reasons.join(", ") || "?"}`).join("; ") || "none"})`
    );
    if (degraded.length > 0 || budgetStopped) {
      sections.push(`Venue status: ${[...degraded, ...(budgetStopped ? ["API budget stopped early"] : [])].join("; ")}`);
    }

    return {
      text: sections.join("\n\n"),
      stats: {
        venue_count: 2,
        candidates: ranked.length,
        scam_suspects: suspects.length,
        new_sightings: newUrls.size
      },
      throttled: false,
      spentBudget: true
    };
  } finally {
    scanInFlight = false;
  }
}

/** Test seam: reset module-level scan state (mutex + cache). */
export function resetBountyIntakeStateForTests(): void {
  scanInFlight = false;
  processCache.clear();
}

// --- project tools (code-rendered digests + error constants, schedule_task style) --

export const PROJECT_TRACK_INVALID_URL_ERROR =
  "project_track requires source_url in the exact form https://github.com/<owner>/<repo>/issues/<n>.";
export const PROJECT_TRACK_ANCHOR_ERROR =
  "project_track refused: that URL was never seen in a bounty scan and is not in the user's message. Run bounty_scan first, or ask the user to paste the issue URL.";
export const PROJECT_UPDATE_INVALID_ID_ERROR = "project_update requires a valid project_id (proj_...).";
export const PROJECT_UPDATE_INVALID_STATE_ERROR =
  "project_update state must be one of tracked|working|submitted|paid|dropped.";

export const PROJECT_STATES: ReadonlySet<ProjectState> = new Set([
  "tracked",
  "working",
  "submitted",
  "paid",
  "dropped"
]);

export function isProjectState(value: unknown): value is ProjectState {
  return typeof value === "string" && PROJECT_STATES.has(value as ProjectState);
}

export function buildProjectTrackedDigest(row: ProjectRow, created: boolean): string {
  const head = created ? "Project tracked" : "Already tracked (unchanged)";
  const amount = row.amount_usd !== null ? ` $${row.amount_usd} (claimed)` : "";
  return `${head}: ${row.project_id} [${row.state}]${amount} ${row.source_url}`;
}

export function buildProjectUpdatedDigest(row: ProjectRow, from: ProjectState): string {
  return `Project ${row.project_id}: ${from} → ${row.state}${row.state_reason ? ` (${row.state_reason})` : ""}`;
}

export function buildProjectListDigest(rows: ProjectRow[]): string {
  if (rows.length === 0) return "No tracked projects.";
  const lines = rows.map((row) => {
    const amount = row.amount_usd !== null ? ` $${row.amount_usd}` : "";
    const title = row.title ? ` — ${row.title}` : "";
    return `- ${row.project_id} [${row.state}]${amount}${title}\n  ${row.source_url}`;
  });
  return `Tracked projects (${rows.length}):\n${lines.join("\n")}`;
}

/** The transcript cap for bounty_scan's table (the http_fetch-style carve-out). */
export const BOUNTY_RESULT_CHAR_CAP = 6_000;
