import { describe, expect, it } from "vitest";
import {
  buildWebChain,
  DEFAULT_WEB_MAX_RESULTS,
  resolveWebMaxResults,
  searchWithChain
} from "../../src/web/registry.js";
import type { WebProvider } from "../../src/web/types.js";

function provider(name: string, result: Awaited<ReturnType<WebProvider["search"]>>): WebProvider {
  return { name, search: async () => result };
}

describe("buildWebChain", () => {
  it("defaults to tavily,firecrawl", () => {
    const chain = buildWebChain({} as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["tavily", "firecrawl"]);
  });

  it("honors HOUGE_WEB_PROVIDERS order", () => {
    const chain = buildWebChain({ HOUGE_WEB_PROVIDERS: "firecrawl,tavily" } as unknown as NodeJS.ProcessEnv);
    expect(chain.map((p) => p.name)).toEqual(["firecrawl", "tavily"]);
  });

  it("throws on an unknown provider name", () => {
    expect(() => buildWebChain({ HOUGE_WEB_PROVIDERS: "bing" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /Unknown web provider: bing/
    );
  });
});

describe("resolveWebMaxResults", () => {
  it("defaults when unset or invalid", () => {
    expect(resolveWebMaxResults({} as NodeJS.ProcessEnv)).toBe(DEFAULT_WEB_MAX_RESULTS);
    expect(resolveWebMaxResults({ HOUGE_WEB_MAX_RESULTS: "nope" } as unknown as NodeJS.ProcessEnv)).toBe(
      DEFAULT_WEB_MAX_RESULTS
    );
  });
  it("reads a positive override", () => {
    expect(resolveWebMaxResults({ HOUGE_WEB_MAX_RESULTS: "3" } as unknown as NodeJS.ProcessEnv)).toBe(3);
  });
});

describe("searchWithChain", () => {
  const hit = { ok: true as const, provider: "tavily", results: [{ title: "A", url: "https://a", content: "x" }] };

  it("returns the first ok result", async () => {
    const chain = [
      provider("tavily", hit),
      provider("firecrawl", { ok: false, provider: "firecrawl", error: "never reached" })
    ];
    expect(await searchWithChain(chain, { query: "x" })).toEqual(hit);
  });

  it("falls through an unavailable provider to the next", async () => {
    const chain = [
      provider("tavily", { ok: false, provider: "tavily", error: "no key", unavailable: true }),
      provider("firecrawl", { ...hit, provider: "firecrawl" })
    ];
    const result = await searchWithChain(chain, { query: "x" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("firecrawl");
  });

  it("aggregates errors when every provider fails", async () => {
    const chain = [
      provider("tavily", { ok: false, provider: "tavily", error: "no key", unavailable: true }),
      provider("firecrawl", { ok: false, provider: "firecrawl", error: "HTTP 500" })
    ];
    const result = await searchWithChain(chain, { query: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.provider).toBe("chain");
      expect(result.error).toContain("tavily");
      expect(result.error).toContain("firecrawl");
    }
  });
});
