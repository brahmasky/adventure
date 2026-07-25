import { describe, expect, it } from "vitest";
import {
  createSecretBroker,
  MIN_REDACTABLE_SECRET_LENGTH,
  REDACTED_PLACEHOLDER,
  resolveSecretsFirewallEnabled,
  SECRET_ENV_NAMES,
  stripSecretsFromEnv
} from "../../src/config/secret-broker.js";

// Realistic-length fake secrets (real keys/tokens are always long; the broker ignores values
// shorter than MIN_REDACTABLE_SECRET_LENGTH so a degenerate short value can't mask everything).
const FAKE = {
  KIMI_API_KEY: "kimi-secret-abc123456",
  GEMINI_API_KEY: "gemini-secret-def456789",
  TAVILY_API_KEY: "tvly-secret-ghi012345",
  FIRECRAWL_API_KEY: "fc-secret-jkl678901",
  HOUGE_TELEGRAM_BOT_TOKEN: "111222333:bot-token-secret-value",
  HOUGE_GMAIL_CLIENT_SECRET: "GOCSPX-fake-gmail-client-secret-123",
  HOUGE_GMAIL_REFRESH_TOKEN: "1//fake-gmail-refresh-token-456789",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fake-chair-token-987654"
};

function fakeEnv(): NodeJS.ProcessEnv {
  return { ...FAKE } as NodeJS.ProcessEnv;
}

describe("createSecretBroker — typed getters over a private closure", () => {
  it("returns each captured secret through its narrow getter", () => {
    const b = createSecretBroker(fakeEnv());
    expect(b.kimiKey()).toBe(FAKE.KIMI_API_KEY);
    expect(b.geminiKey()).toBe(FAKE.GEMINI_API_KEY);
    expect(b.tavilyKey()).toBe(FAKE.TAVILY_API_KEY);
    expect(b.firecrawlKey()).toBe(FAKE.FIRECRAWL_API_KEY);
    expect(b.telegramToken()).toBe(FAKE.HOUGE_TELEGRAM_BOT_TOKEN);
    expect(b.gmailClientSecret()).toBe(FAKE.HOUGE_GMAIL_CLIENT_SECRET);
    expect(b.gmailRefreshToken()).toBe(FAKE.HOUGE_GMAIL_REFRESH_TOKEN);
    expect(b.claudeOauthToken()).toBe(FAKE.CLAUDE_CODE_OAUTH_TOKEN);
  });

  it("SECRET_ENV_NAMES is the exact eight-name list (ADR 0027: seven becomes eight)", () => {
    expect([...SECRET_ENV_NAMES]).toEqual([
      "KIMI_API_KEY",
      "GEMINI_API_KEY",
      "TAVILY_API_KEY",
      "FIRECRAWL_API_KEY",
      "HOUGE_TELEGRAM_BOT_TOKEN",
      "HOUGE_GMAIL_CLIENT_SECRET",
      "HOUGE_GMAIL_REFRESH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN"
    ]);
  });

  it("getters keep working AFTER the env is stripped (values live in the closure, not env)", () => {
    const env = fakeEnv();
    const b = createSecretBroker(env);
    stripSecretsFromEnv(env);
    // env is now empty of secrets, but the broker still holds the captured values.
    expect(env.KIMI_API_KEY).toBeUndefined();
    expect(b.kimiKey()).toBe(FAKE.KIMI_API_KEY);
    expect(b.telegramToken()).toBe(FAKE.HOUGE_TELEGRAM_BOT_TOKEN);
  });

  it("returns undefined for a secret that was not set", () => {
    const b = createSecretBroker({ KIMI_API_KEY: FAKE.KIMI_API_KEY } as NodeJS.ProcessEnv);
    expect(b.kimiKey()).toBe(FAKE.KIMI_API_KEY);
    expect(b.geminiKey()).toBeUndefined();
    expect(b.tavilyKey()).toBeUndefined();
  });

  it("claudeOauthToken() returns null (not undefined) when unset — the chair's no-spawn signal", () => {
    const b = createSecretBroker({} as NodeJS.ProcessEnv);
    expect(b.claudeOauthToken()).toBeNull();
  });
});

describe("broker.redact — masks secret VALUES only", () => {
  it("masks every known secret value that appears in a string", () => {
    const b = createSecretBroker(fakeEnv());
    const text = `key=${FAKE.KIMI_API_KEY} tok=${FAKE.HOUGE_TELEGRAM_BOT_TOKEN}`;
    const out = b.redact(text);
    expect(out).not.toContain(FAKE.KIMI_API_KEY);
    expect(out).not.toContain(FAKE.HOUGE_TELEGRAM_BOT_TOKEN);
    expect(out).toContain(REDACTED_PLACEHOLDER);
    expect(out).toBe(`key=${REDACTED_PLACEHOLDER} tok=${REDACTED_PLACEHOLDER}`);
  });

  it("masks the Claude Code OAuth token (eighth secret)", () => {
    const b = createSecretBroker(fakeEnv());
    const out = b.redact(`chair auth: ${FAKE.CLAUDE_CODE_OAUTH_TOKEN}`);
    expect(out).not.toContain(FAKE.CLAUDE_CODE_OAUTH_TOKEN);
    expect(out).toBe(`chair auth: ${REDACTED_PLACEHOLDER}`);
  });

  it("masks both Gmail OAuth secret values", () => {
    const b = createSecretBroker(fakeEnv());
    const text = `cs=${FAKE.HOUGE_GMAIL_CLIENT_SECRET} rt=${FAKE.HOUGE_GMAIL_REFRESH_TOKEN}`;
    const out = b.redact(text);
    expect(out).not.toContain(FAKE.HOUGE_GMAIL_CLIENT_SECRET);
    expect(out).not.toContain(FAKE.HOUGE_GMAIL_REFRESH_TOKEN);
    expect(out).toBe(`cs=${REDACTED_PLACEHOLDER} rt=${REDACTED_PLACEHOLDER}`);
  });

  it("leaves non-secret text untouched", () => {
    const b = createSecretBroker(fakeEnv());
    const text = "The capital of France is Paris. Nothing secret here.";
    expect(b.redact(text)).toBe(text);
  });

  it("is safe on empty and returns input unchanged (never masks everything)", () => {
    const b = createSecretBroker(fakeEnv());
    expect(b.redact("")).toBe("");
  });

  it("does not mask when the broker holds no secrets", () => {
    const b = createSecretBroker({} as NodeJS.ProcessEnv);
    const text = "aaaa bbbb cccc";
    expect(b.redact(text)).toBe(text);
  });

  it("ignores a degenerate SHORT secret value so it cannot redact ordinary prose", () => {
    // A 1-char "secret" would otherwise mask every occurrence of that char in normal text.
    const short = "a".repeat(MIN_REDACTABLE_SECRET_LENGTH - 1);
    const b = createSecretBroker({ KIMI_API_KEY: short } as NodeJS.ProcessEnv);
    const text = "a banana in a basket";
    expect(b.redact(text)).toBe(text); // untouched — short value not used for redaction
  });

  it("masks a value even when it contains regex-special characters (literal match)", () => {
    const tricky = "sk-.*(danger)+[abc]";
    const b = createSecretBroker({ KIMI_API_KEY: tricky } as NodeJS.ProcessEnv);
    expect(b.redact(`before ${tricky} after`)).toBe(`before ${REDACTED_PLACEHOLDER} after`);
  });
});

describe("stripSecretsFromEnv — empties ambient credentials in place", () => {
  it("deletes the exact eight secret names", () => {
    const env = fakeEnv();
    const stripped = stripSecretsFromEnv(env);
    for (const name of SECRET_ENV_NAMES) {
      expect(env[name]).toBeUndefined();
      expect(stripped).toContain(name);
    }
    // The eighth secret specifically: stripped both as an exact name and by the _TOKEN suffix.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(stripped).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("deletes any credential-shaped var by pattern (_API_KEY / _TOKEN / _SECRET)", () => {
    const env = {
      SOME_FUTURE_API_KEY: "x-future-key-1234",
      GITHUB_TOKEN: "ghp_future_token_5678",
      APP_SECRET: "app-secret-9012"
    } as NodeJS.ProcessEnv;
    stripSecretsFromEnv(env);
    expect(env.SOME_FUTURE_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.APP_SECRET).toBeUndefined();
  });

  it("leaves NON-secret vars untouched (identity allowlist, base URLs, models, PATH)", () => {
    const env = {
      ...FAKE,
      HOUGE_TELEGRAM_USER_ID: "42",
      HOUGE_TELEGRAM_CHAT_ID: "555",
      HOUGE_KIMI_BASE_URL: "https://api.moonshot.ai",
      HOUGE_KIMI_MAX_TOKENS: "4096",
      HOUGE_LLM_MODEL_KIMI: "kimi-x",
      PATH: "/usr/bin"
    } as NodeJS.ProcessEnv;
    stripSecretsFromEnv(env);
    expect(env.HOUGE_TELEGRAM_USER_ID).toBe("42"); // identity, NOT a secret
    expect(env.HOUGE_TELEGRAM_CHAT_ID).toBe("555");
    expect(env.HOUGE_KIMI_BASE_URL).toBe("https://api.moonshot.ai");
    expect(env.HOUGE_KIMI_MAX_TOKENS).toBe("4096"); // ends _TOKENS, not _TOKEN
    expect(env.HOUGE_LLM_MODEL_KIMI).toBe("kimi-x");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("resolveSecretsFirewallEnabled — default OFF", () => {
  it("is OFF when unset or falsey", () => {
    expect(resolveSecretsFirewallEnabled({})).toBe(false);
    expect(resolveSecretsFirewallEnabled({ HOUGE_SECRETS_FIREWALL_ENABLED: "0" })).toBe(false);
    expect(resolveSecretsFirewallEnabled({ HOUGE_SECRETS_FIREWALL_ENABLED: "false" })).toBe(false);
  });

  it("is ON for the accepted truthy spellings", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      expect(resolveSecretsFirewallEnabled({ HOUGE_SECRETS_FIREWALL_ENABLED: v })).toBe(true);
    }
  });
});
