import { afterEach, describe, expect, it, vi } from "vitest";
import { createTavilyProvider } from "../../../src/web/providers/tavily.js";
import type { WebFetchImpl } from "../../../src/web/types.js";

function okResponse(json: unknown, status = 200): Awaited<ReturnType<WebFetchImpl>> {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

// Real Tavily shape (locked against the live API).
const tavilyBody = {
  query: "x",
  results: [
    { url: "https://a.com", title: "A", content: "alpha", score: 0.9, raw_content: null },
    { url: "https://b.com", title: "B", content: "beta", score: 0.8 }
  ]
};

const SAVED = process.env.TAVILY_API_KEY;
afterEach(() => {
  if (SAVED === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = SAVED;
});

describe("createTavilyProvider", () => {
  it("parses results and shapes the request (Bearer auth, max_results)", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse(tavilyBody));
    const provider = createTavilyProvider({ apiKey: "tvly-test", fetchImpl });

    const result = await provider.search({ query: "claude news", max_results: 2 });

    expect(result).toEqual({
      ok: true,
      provider: "tavily",
      results: [
        { title: "A", url: "https://a.com", content: "alpha" },
        { title: "B", url: "https://b.com", content: "beta" }
      ]
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.headers.Authorization).toBe("Bearer tvly-test");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ query: "claude news", max_results: 2 });
  });

  it("freshness_days switches to the news topic with days, and published_date maps through", async () => {
    const body = {
      query: "x",
      results: [
        { url: "https://a.com", title: "A", content: "alpha", published_date: "2026-07-28" },
        { url: "https://b.com", title: "B", content: "beta" }
      ]
    };
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse(body));
    const provider = createTavilyProvider({ apiKey: "tvly-test", fetchImpl });

    const result = await provider.search({ query: "claude news", max_results: 2, freshness_days: 1 });

    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({
      query: "claude news",
      max_results: 2,
      topic: "news",
      days: 1
    });
    expect(result).toEqual({
      ok: true,
      provider: "tavily",
      results: [
        { title: "A", url: "https://a.com", content: "alpha", published: "2026-07-28" },
        { title: "B", url: "https://b.com", content: "beta" }
      ]
    });
  });

  it("no freshness_days → request body unchanged (no topic/days keys)", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse(tavilyBody));
    const provider = createTavilyProvider({ apiKey: "tvly-test", fetchImpl });
    await provider.search({ query: "q", max_results: 3 });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({ query: "q", max_results: 3 });
  });

  it("classifies a missing API key as unavailable without calling fetch", async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse(tavilyBody));
    const provider = createTavilyProvider({ fetchImpl });

    const result = await provider.search({ query: "x" });

    expect(result).toEqual({
      ok: false,
      provider: "tavily",
      error: "TAVILY_API_KEY is not set",
      unavailable: true
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a non-2xx response to a plain error", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse({ error: "rate" }, 429));
    const provider = createTavilyProvider({ apiKey: "tvly-test", fetchImpl });

    expect(await provider.search({ query: "x" })).toEqual({
      ok: false,
      provider: "tavily",
      error: "Tavily request returned HTTP 429"
    });
  });

  it("fails when results are missing", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => okResponse({ query: "x" }));
    const provider = createTavilyProvider({ apiKey: "tvly-test", fetchImpl });

    expect(await provider.search({ query: "x" })).toEqual({
      ok: false,
      provider: "tavily",
      error: "Tavily response missing results"
    });
  });

  it("maps an aborted request to a timeout error", async () => {
    const fetchImpl = vi.fn<WebFetchImpl>(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const provider = createTavilyProvider({ apiKey: "tvly-test", timeoutMs: 5000, fetchImpl });

    expect(await provider.search({ query: "x" })).toEqual({
      ok: false,
      provider: "tavily",
      error: "Tavily request timed out after 5000ms"
    });
  });
});
