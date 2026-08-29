import { describe, expect, it, vi } from "vitest";

import {
  DOUBAN_COLLECTIONS,
  DISCOVERY_TEXT_LIMITS,
  DoubanClient,
  DoubanUpstreamError,
  UnknownDiscoveryCollectionError,
} from "../../src/server/douban.js";

function payload(id = "1295644") {
  return {
    subject_collection_items: [
      {
        id,
        title: " <strong>中文片名</strong> ",
        original_title: " Original Title ",
        year: "2024",
        rating: { value: 8.7, count: 12345 },
        rank: 3,
        genres: ["剧情", "剧情", "<em>悬疑</em>"],
        summary: "<p>一段\n很长的简介</p>",
        cover_url: "https://img.example.invalid/private-cover.jpg",
        url: "https://evil.example.invalid/subject/1295644",
      },
    ],
  };
}

describe("DoubanClient", () => {
  it("maps every public collection to a fixed URL and Referer", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ subject_collection_items: [] }), { status: 200 });
    });
    const client = new DoubanClient({ fetchImpl });

    for (const collection of Object.keys(DOUBAN_COLLECTIONS)) {
      await client.list(collection, 7);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    for (const call of calls) {
      const collectionEntry = Object.entries(DOUBAN_COLLECTIONS)
        .find(([, upstreamId]) => call.url.includes(`/subject_collection/${upstreamId}/items`));
      expect(collectionEntry).toBeDefined();
      const upstreamId = collectionEntry![1];
      expect(call.url).toBe(
        `https://m.douban.com/rexxar/api/v2/subject_collection/${upstreamId}/items?start=0&count=7&items_only=1`,
      );
      expect(call.init?.method).toBe("GET");
      expect(call.init?.headers).toEqual({
        Accept: "application/json,text/plain,*/*",
        Referer: `https://m.douban.com/subject_collection/${upstreamId}`,
        "User-Agent": expect.stringContaining("Mozilla/5.0"),
      });
      expect(JSON.stringify(call.init?.headers)).not.toMatch(/cookie/iu);
    }
  });

  it("clamps the upstream count and emits only bounded, plain discovery fields", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload()), { status: 200 }));
    const client = new DoubanClient({ fetchImpl });

    const result = await client.list("movie-hot", 99);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("count=20");
    expect(result.items).toEqual([
      {
        id: "1295644",
        title: "中文片名",
        originalTitle: "Original Title",
        year: "2024",
        rating: 8.7,
        ratingCount: 12345,
        rank: 3,
        mediaType: "movie",
        genres: ["剧情", "悬疑"],
        summary: "一段 很长的简介",
        sourceUrl: "https://movie.douban.com/subject/1295644/",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("cover_url");
    expect(JSON.stringify(result)).not.toContain("evil.example");
    expect(result.items[0].title.length).toBeLessThanOrEqual(DISCOVERY_TEXT_LIMITS.title);
    expect(result.items[0].summary.length).toBeLessThanOrEqual(DISCOVERY_TEXT_LIMITS.summary);
  });

  it("coalesces same-key requests and serves an expired cache as stale on failure", async () => {
    let now = 1_000;
    let resolveFetch: ((response: Response) => void) | undefined;
    let shouldFail = false;
    const fetchImpl = vi.fn(() => {
      if (shouldFail) return Promise.reject(new Error("offline"));
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const client = new DoubanClient({ fetchImpl, now: () => now });

    const first = client.list("movie-weekly", 5);
    const second = client.list("movie-weekly", 5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch!(new Response(JSON.stringify(payload()), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    now += 2 * 60 * 60 * 1000 + 1;
    shouldFail = true;
    const stale = await client.list("movie-weekly", 5);
    expect(stale.stale).toBe(true);
    expect(stale.items[0].id).toBe("1295644");
  });

  it("normalizes upstream failures and rejects unknown collections", async () => {
    const client = new DoubanClient({
      fetchImpl: vi.fn(async () => new Response("no", { status: 503 })),
    });
    await expect(client.list("movie-hot")).rejects.toBeInstanceOf(DoubanUpstreamError);
    await expect(client.list("not-a-collection")).rejects.toBeInstanceOf(UnknownDiscoveryCollectionError);
  });
});
