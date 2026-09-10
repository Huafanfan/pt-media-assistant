import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { TavilySearchProvider } from "../../src/server/ai/web-search.js";

function tavilyResponse(results: unknown, status = 200): Response {
  return new Response(JSON.stringify({ results }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

const validResult = {
  title: "A public result",
  url: "https://example.com/story",
  content: "A short source summary.",
};

describe("TavilySearchProvider", () => {
  it("uses the fixed Tavily request shape and returns bounded, stable sources", async () => {
    const fetchImpl = vi.fn(async () => tavilyResponse([
      {
        title: `  ${"Title ".repeat(60)}\n`,
        url: "https://example.com/story?utm_source=search#section",
        content: `  ${"summary ".repeat(100)}\n`,
      },
      {
        title: "Duplicate canonical URL",
        url: "https://example.com/story?another=tracking",
        content: "This duplicate is removed after query stripping.",
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://source${index}.example.com/article`,
        content: `Content ${index}`,
      })),
    ]));
    const provider = new TavilySearchProvider({ apiKey: "  tvly-test-key  ", fetchImpl });

    const result = await provider.search("  星际\n 旅行  ");

    expect(requestBody(fetchImpl)).toEqual({
      query: "星际 旅行",
      search_depth: "fast",
      max_results: 6,
      include_answer: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tvly-test-key");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(result.status).toBe("ok");
    expect(result.cached).toBe(false);
    expect(result.results).toHaveLength(6);
    expect(result.results[0]).toMatchObject({
      title: expect.any(String),
      url: "https://example.com/story",
      content: expect.any(String),
      id: createHash("sha256").update("https://example.com/story", "utf8").digest("hex"),
    });
    expect(result.results[0]?.title.length).toBeLessThanOrEqual(240);
    expect(result.results[0]?.content.length).toBeLessThanOrEqual(600);
    expect(new Set(result.results.map((item) => item.id)).size).toBe(result.results.length);
  });

  it("normalizes public include domains, maps them to Tavily, and isolates their cache keys", async () => {
    const fetchImpl = vi.fn(async () => tavilyResponse([validResult]));
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl });

    const first = await provider.search("domain query", {
      includeDomains: [
        " B.EXAMPLE.COM ",
        "a.example.com",
        "https://should-not-be-a-domain.example.com",
        "127.0.0.1",
        "a.example.com",
      ],
    });
    const sameFilters = await provider.search("domain query", {
      includeDomains: ["a.example.com", "b.example.com"],
    });
    const differentFilters = await provider.search("domain query", {
      includeDomains: ["c.example.com"],
    });
    await provider.search("domain limit", {
      includeDomains: Array.from({ length: 20 }, (_, index) => `domain-${index}.example.com`),
    });

    expect(first.cached).toBe(false);
    expect(sameFilters.cached).toBe(true);
    expect(differentFilters.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      include_domains: ["a.example.com", "b.example.com"],
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      include_domains: ["c.example.com"],
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body)).include_domains).toHaveLength(12);
  });

  it("normalizes empty input and bounds overlong input before any network call", async () => {
    const fetchImpl = vi.fn(async () => tavilyResponse([validResult]));
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl });

    await expect(provider.search(" \n\t ")).resolves.toEqual({
      results: [],
      status: "ok",
      cached: false,
    });
    await expect(provider.search("x".repeat(401))).resolves.toEqual({
      results: [],
      status: "unavailable",
      cached: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caches successful public results for the TTL and protects the cached clone", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => tavilyResponse([validResult]));
    const provider = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      fetchImpl,
      now: () => now,
      cacheTtlMs: 600,
    });

    const first = await provider.search("  same   query ");
    first.results[0]!.title = "caller mutation";
    const cached = await provider.search("same query");

    expect(cached).toEqual({
      results: [{
        id: createHash("sha256").update(validResult.url, "utf8").digest("hex"),
        title: validResult.title,
        url: validResult.url,
        content: validResult.content,
      }],
      status: "ok",
      cached: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = 1_600;
    await expect(provider.search("same query")).resolves.toMatchObject({ status: "ok", cached: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures or expose upstream body text", async () => {
    const secret = "upstream-private-secret";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(secret, { status: 503 }))
      .mockResolvedValueOnce(tavilyResponse([validResult]));
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl });

    const failure = await provider.search("failure");
    expect(failure).toEqual({ results: [], status: "unavailable", cached: false });
    expect(JSON.stringify(failure)).not.toContain(secret);

    const retry = await provider.search("failure");
    expect(retry.status).toBe("ok");
    expect(retry.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable for malformed successful payloads without leaking their content", async () => {
    const secret = "malformed-private-content";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answer: secret }), { status: 200 }));
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl });

    const result = await provider.search("malformed");

    expect(result).toEqual({ results: [], status: "unavailable", cached: false });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("filters unsafe URLs, removes tracking query and hash, and never follows result URLs", async () => {
    const fetchImpl = vi.fn(async () => tavilyResponse([
      { title: "loopback", url: "http://127.0.0.1/private", content: "private" },
      { title: "localhost", url: "https://localhost/private", content: "private" },
      { title: "ipv6", url: "http://[::1]/private", content: "private" },
      { title: "public IP", url: "https://8.8.8.8/public", content: "public ip" },
      { title: "port", url: "https://example.com:8443/story", content: "port" },
      { title: "credential", url: "https://user:password@example.com/story", content: "credential" },
      { title: "non-http", url: "file:///tmp/private", content: "file" },
      { title: "single label", url: "https://intranet/story", content: "local" },
      { title: "redirect", url: "https://www.baidu.com/link?url=opaque", content: "not a source" },
      { title: "google redirect", url: "https://www.google.com/url?q=https://example.com", content: "not a source" },
      { title: "safe", url: "https://news.example.com/story?utm_source=x#section", content: "safe" },
    ]));
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl });

    const result = await provider.search("safe URLs");

    expect(result.status).toBe("ok");
    expect(result.results).toEqual([{
      id: createHash("sha256").update("https://news.example.com/story", "utf8").digest("hex"),
      title: "safe",
      url: "https://news.example.com/story",
      content: "safe",
    }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports structurally malformed entries as unavailable and all-unsafe shaped results as an empty success", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tavilyResponse([{ title: "missing fields" }]))
      .mockResolvedValueOnce(tavilyResponse([{ title: "local", url: "http://127.0.0.1", content: "filtered" }]));
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl });

    await expect(provider.search("missing fields")).resolves.toEqual({
      results: [],
      status: "unavailable",
      cached: false,
    });
    await expect(provider.search("unsafe only")).resolves.toEqual({
      results: [],
      status: "ok",
      cached: false,
    });
  });

  it("throws AbortError for caller cancellation and does not cache the cancelled request", async () => {
    let calls = 0;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(tavilyResponse([validResult]));
    });
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl, timeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = provider.search("cancel me", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(provider.search("cancel me")).resolves.toMatchObject({ status: "ok", cached: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable on timeout and retries because timeout failures are not cached", async () => {
    let calls = 0;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(tavilyResponse([validResult]));
    });
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl, timeoutMs: 5 });

    await expect(provider.search("timeout")).resolves.toEqual({ results: [], status: "unavailable", cached: false });
    await expect(provider.search("timeout")).resolves.toMatchObject({ status: "ok", cached: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds the successful query cache to 200 entries", async () => {
    const fetchImpl = vi.fn(async () => tavilyResponse([validResult]));
    const provider = new TavilySearchProvider({ apiKey: "tvly-test-key", fetchImpl, cacheTtlMs: 60_000 });

    for (let index = 0; index < 201; index += 1) await provider.search(`query-${index}`);
    await provider.search("query-0");

    expect(fetchImpl).toHaveBeenCalledTimes(202);
  });
});
