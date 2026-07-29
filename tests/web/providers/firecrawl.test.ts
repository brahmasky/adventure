import { afterEach, describe, expect, it, vi } from "vitest";
import { createFirecrawlProvider } from "../../../src/web/providers/firecrawl.js";
import type { WebFetchImpl } from "../../../src/web/types.js";

function okResponse(json: unknown, status = 200): Awaited<ReturnType<WebFetchImpl>> {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

// Real Firecrawl shape (locked against the live API): { success, data: [{ url, title, description }] }.
const firecrawlBody = {
  success: true,
  data: [
    { url: "https://a.com", title: "A", description: "alpha desc" },
    { url: "https://b.com", title: "B", description: "beta desc", markdown: "# Beta full" }
  ],
  id: "abc"
};

const SAVED = process.env.FIRECRAWL_API_KEY;
afterEach(() => {
  if (SAVED === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = SAVED;
});

describe("createFirecrawlProvider", () => {
  it("parses data[] (description, or markdown when present) and shapes the request", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse(firecrawlBody));
    const provider = createFirecrawlProvider({ apiKey: "fc-test", fetchImpl });

    const result = await provider.search({ query: "claude news", max_results: 2 });

    expect(result).toEqual({
      ok: true,
      provider: "firecrawl",
      results: [
        { title: "A", url: "https://a.com", content: "alpha desc" },
        { title: "B", url: "https://b.com", content: "# Beta full" } // markdown preferred
      ]
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.firecrawl.dev/v1/search");
    expect(init.headers.Authorization).toBe("Bearer fc-test");
    expect(JSON.parse(init.body)).toEqual({ query: "claude news", limit: 2 });
  });

  it("freshness_days maps to the coarsest covering tbs window", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse(firecrawlBody));
    const provider = createFirecrawlProvider({ apiKey: "fc-test", fetchImpl });

    await provider.search({ query: "q", max_results: 2, freshness_days: 1 });
    await provider.search({ query: "q", max_results: 2, freshness_days: 7 });
    await provider.search({ query: "q", max_results: 2, freshness_days: 30 });
    await provider.search({ query: "q", max_results: 2, freshness_days: 90 });

    const tbsOf = (i: number) => JSON.parse(fetchImpl.mock.calls[i]![1].body).tbs;
    expect(tbsOf(0)).toBe("qdr:d");
    expect(tbsOf(1)).toBe("qdr:w");
    expect(tbsOf(2)).toBe("qdr:m");
    expect(tbsOf(3)).toBe("qdr:y");
  });

  it("no freshness_days → request body unchanged (no tbs key)", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse(firecrawlBody));
    const provider = createFirecrawlProvider({ apiKey: "fc-test", fetchImpl });
    await provider.search({ query: "q", max_results: 2 });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({ query: "q", limit: 2 });
  });

  it("classifies a missing API key as unavailable without calling fetch", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse(firecrawlBody));
    const provider = createFirecrawlProvider({ fetchImpl });

    const result = await provider.search({ query: "x" });

    expect(result).toMatchObject({ ok: false, provider: "firecrawl", unavailable: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the data array is missing", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse({ success: true }));
    const provider = createFirecrawlProvider({ apiKey: "fc-test", fetchImpl });

    expect(await provider.search({ query: "x" })).toEqual({
      ok: false,
      provider: "firecrawl",
      error: "Firecrawl response missing data array"
    });
  });
});
