/**
 * The secrets firewall (ADR 0015, Phase 1 — in-process broker).
 *
 * After boot loads `.env` into `process.env`, the seven real secrets are lifted into a
 * {@link SecretBroker} — a PRIVATE closure with narrow typed getters — and then DELETED from
 * `process.env` (see {@link stripSecretsFromEnv}). For the rest of the process lifetime the
 * ambient environment holds no credential, so a self-written `process.env.KIMI_API_KEY` reads
 * `undefined`. The broker is NOT a module-level singleton export; it is constructed once at boot
 * and *injected* into exactly the factories that need it (the provider chain builders, the
 * Telegram client) plus the redactor seam. There is no generic `get(name)` accessor.
 *
 * Flag-gated (`HOUGE_SECRETS_FIREWALL_ENABLED`, default OFF): when OFF, no broker is built and
 * nothing is stripped, so behavior is byte-for-byte identical to before the firewall existed.
 */

/** The exact seven real secrets the daemon holds (ADR 0015 §Context). */
export const SECRET_ENV_NAMES = [
  "KIMI_API_KEY",
  "GEMINI_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "HOUGE_TELEGRAM_BOT_TOKEN",
  "HOUGE_GMAIL_CLIENT_SECRET",
  "HOUGE_GMAIL_REFRESH_TOKEN"
] as const;

/**
 * A future operator credential is stripped by default too: any env var whose NAME matches one of
 * these credential-shaped suffixes is removed by {@link stripSecretsFromEnv}. (The identity
 * allowlist `HOUGE_TELEGRAM_USER_ID`/`_CHAT_ID` does NOT match — those are not secrets.)
 */
const SECRET_NAME_PATTERN = /_API_KEY$|_TOKEN$|_SECRET$/;

/**
 * Replacement placeholder for a redacted secret value in any outbound string (chat reply, ledger
 * payload, error text). Code-owned user-facing constant (never inline the literal elsewhere).
 */
export const REDACTED_PLACEHOLDER = "«redacted»";

/**
 * Values shorter than this are NOT used for redaction — a 1–2 char secret value would mask
 * ordinary prose (e.g. every "a") and effectively redact everything, which is worse than not
 * redacting. Real API keys and Telegram tokens are always far longer (32+ chars), so this guard
 * costs nothing in practice; it only defends the degenerate/misconfigured case.
 */
export const MIN_REDACTABLE_SECRET_LENGTH = 6;

export interface SecretBroker {
  kimiKey(): string | undefined;
  geminiKey(): string | undefined;
  tavilyKey(): string | undefined;
  firecrawlKey(): string | undefined;
  telegramToken(): string | undefined;
  gmailClientSecret(): string | undefined;
  gmailRefreshToken(): string | undefined;
  /**
   * Replace every known NON-EMPTY secret VALUE with {@link REDACTED_PLACEHOLDER}. Safe on empty/
   * undefined input (returned unchanged) and never masks everything (short values are ignored per
   * {@link MIN_REDACTABLE_SECRET_LENGTH}). A pure closure — safe to pass unbound.
   */
  redact(text: string): string;
}

/**
 * Build the broker from a snapshot of the loaded env. The seven values are captured into a private
 * closure at construction; the getters return those captured values, so the broker keeps working
 * after the env is stripped. `redact` masks the captured values (longest-first, so a value that is
 * a substring of another is handled after the longer one).
 */
export function createSecretBroker(env: NodeJS.ProcessEnv): SecretBroker {
  const kimi = env.KIMI_API_KEY;
  const gemini = env.GEMINI_API_KEY;
  const tavily = env.TAVILY_API_KEY;
  const firecrawl = env.FIRECRAWL_API_KEY;
  const telegram = env.HOUGE_TELEGRAM_BOT_TOKEN;
  const gmailClientSecret = env.HOUGE_GMAIL_CLIENT_SECRET;
  const gmailRefreshToken = env.HOUGE_GMAIL_REFRESH_TOKEN;

  const redactable = [
    kimi,
    gemini,
    tavily,
    firecrawl,
    telegram,
    gmailClientSecret,
    gmailRefreshToken
  ]
    .filter((v): v is string => typeof v === "string" && v.length >= MIN_REDACTABLE_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

  return {
    kimiKey: () => kimi,
    geminiKey: () => gemini,
    tavilyKey: () => tavily,
    firecrawlKey: () => firecrawl,
    telegramToken: () => telegram,
    gmailClientSecret: () => gmailClientSecret,
    gmailRefreshToken: () => gmailRefreshToken,
    redact: (text: string): string => {
      if (typeof text !== "string" || text.length === 0) return text;
      let out = text;
      for (const value of redactable) {
        // split/join (not RegExp) so secret values with regex-special chars are matched literally.
        out = out.split(value).join(REDACTED_PLACEHOLDER);
      }
      return out;
    }
  };
}

/**
 * Delete every credential from `env`, in place: the exact five names AND any key whose name matches
 * the credential-shaped suffix pattern. Returns the names that were stripped (for logging/tests).
 * Non-secret vars (base URLs, models, timeouts, the Telegram identity allowlist) are untouched.
 */
export function stripSecretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const exact = new Set<string>(SECRET_ENV_NAMES);
  const stripped: string[] = [];
  for (const key of Object.keys(env)) {
    if (exact.has(key) || SECRET_NAME_PATTERN.test(key)) {
      delete env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

/**
 * Whether the secrets firewall is armed (`HOUGE_SECRETS_FIREWALL_ENABLED`). DEFAULT OFF — the strip
 * must be proven not to starve a live provider before it becomes the default. Accepts
 * `1`/`true`/`yes`/`on` (case-insensitive), matching the other arming flags.
 */
export function resolveSecretsFirewallEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HOUGE_SECRETS_FIREWALL_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
