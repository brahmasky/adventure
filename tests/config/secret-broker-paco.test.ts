import { describe, expect, it } from "vitest";
import { createSecretBroker, REDACTED_PLACEHOLDER, stripSecretsFromEnv } from "../../src/config/secret-broker.js";

const PACO = "1//synthetic-paco-refresh-token-0001";

describe("Paco's Gmail refresh token in the broker", () => {
  it("is returned by its own getter, distinct from the Houge token", () => {
    const b = createSecretBroker({ HOUGE_GMAIL_REFRESH_TOKEN: "1//houge-token-xxxxxxxx", HOUGE_PACO_GMAIL_REFRESH_TOKEN: PACO } as NodeJS.ProcessEnv);
    expect(b.pacoGmailRefreshToken()).toBe(PACO);
    expect(b.gmailRefreshToken()).toBe("1//houge-token-xxxxxxxx");
  });
  it("is masked by redact()", () => {
    const b = createSecretBroker({ HOUGE_PACO_GMAIL_REFRESH_TOKEN: PACO } as NodeJS.ProcessEnv);
    expect(b.redact(`leak ${PACO} end`)).toBe(`leak ${REDACTED_PLACEHOLDER} end`);
  });
  it("is stripped from process.env", () => {
    const env = { HOUGE_PACO_GMAIL_REFRESH_TOKEN: PACO, HOUGE_MAIL_ENABLED: "1" } as NodeJS.ProcessEnv;
    stripSecretsFromEnv(env);
    expect(env.HOUGE_PACO_GMAIL_REFRESH_TOKEN).toBeUndefined();
    expect(env.HOUGE_MAIL_ENABLED).toBe("1");
  });
});
