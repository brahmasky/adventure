import { describe, expect, it, vi } from "vitest";
import { buildWebChain } from "../../src/web/registry.js";
import type { WebFetchImpl } from "../../src/web/types.js";
import { createSecretBroker } from "../../src/config/secret-broker.js";

// A broker holding known fake keys — the firewall-ON case.
function broker() {
  return createSecretBroker({
    KIMI_API_KEY: "kimi-broker-key-123456",
    GEMINI_API_KEY: "gemini-broker-key-123456",
    TAVILY_API_KEY: "tavily-broker-key-123456",
    FIRECRAWL_API_KEY: "firecrawl-broker-key-123456"
  } as NodeJS.ProcessEnv);
}

function webOk() {
  return { ok: true, status: 200, json: async () => ({ results: [{ url: "https://x", title: "X", content: "c" }] }) };
}

describe("firewall ON — chain builders deliver the BROKER key to providers (no starvation)", () => {
  it("buildWebChain(tavily/firecrawl) puts the broker keys into the Authorization header", async () => {
    const tavilyFetch = vi.fn<WebFetchImpl>(async () => webOk());
    const firecrawlFetch = vi.fn<WebFetchImpl>(async () => webOk());
    const chain = buildWebChain(
      { HOUGE_WEB_PROVIDERS: "tavily,firecrawl" } as NodeJS.ProcessEnv,
      { tavilyConfig: { fetchImpl: tavilyFetch }, firecrawlConfig: { fetchImpl: firecrawlFetch } },
      broker()
    );
    await chain[0]!.search({ query: "q" });
    await chain[1]!.search({ query: "q" });
    expect(tavilyFetch.mock.calls[0]![1].headers.Authorization).toBe("Bearer tavily-broker-key-123456");
    expect(firecrawlFetch.mock.calls[0]![1].headers.Authorization).toBe("Bearer firecrawl-broker-key-123456");
  });
});

describe("firewall OFF — chain builders read the ENV key (byte-identical to before)", () => {
  it("buildWebChain(tavily) with no broker uses env.TAVILY_API_KEY", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => webOk());
    const [tavily] = buildWebChain(
      { HOUGE_WEB_PROVIDERS: "tavily", TAVILY_API_KEY: "tavily-env-key-999" } as NodeJS.ProcessEnv,
      { tavilyConfig: { fetchImpl } }
    );
    await tavily!.search({ query: "q" });
    expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBe("Bearer tavily-env-key-999");
  });
});

describe("fallback removed — a provider is UNAVAILABLE when no key is resolved", () => {
  it("tavily is unavailable when no key is resolved", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => webOk());
    const [tavily] = buildWebChain({ HOUGE_WEB_PROVIDERS: "tavily" } as NodeJS.ProcessEnv, {
      tavilyConfig: { fetchImpl }
    });
    const result = await tavily!.search({ query: "q" });
    expect(result).toMatchObject({ ok: false, unavailable: true, error: "TAVILY_API_KEY is not set" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
