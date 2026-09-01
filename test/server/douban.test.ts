import { describe, expect, it, vi } from "vitest";

import {
  DOUBAN_COLLECTIONS,
  DISCOVERY_TEXT_LIMITS,
  DoubanClient,
  DoubanUpstreamError,
  parseDoubanActorProfile,
  parseDoubanMediaSearch,
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
        pic: {
          normal: "https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg",
          large: "https://img1.doubanio.com/view/photo/l/public/p123.jpg",
        },
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
      await client.list(collection, 1, 7);
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

    const result = await client.list("movie-hot", 1, 99);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("count=20");
    expect(result.items).toEqual([
      {
        id: "1295644",
        title: "中文片名",
        posterUrl: "/api/discovery/collections/movie-hot/items/1295644/poster?page=1&limit=20",
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
    expect(JSON.stringify(result)).not.toContain("img.example.invalid");
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

    const first = client.list("movie-weekly", 1, 5);
    const second = client.list("movie-weekly", 1, 5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch!(new Response(JSON.stringify(payload()), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    now += 2 * 60 * 60 * 1000 + 1;
    shouldFail = true;
    const stale = await client.list("movie-weekly", 1, 5);
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

  it("loads bounded actor and director details and proxies cached posters", async () => {
    const image = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://img1.doubanio.com/")) {
        return new Response(image, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      }
      if (url.endsWith("/movie/1295644")) {
        return new Response(JSON.stringify({
          id: "1295644",
          actors: [{ name: "演员甲" }, { name: "演员甲" }, { name: "演员乙" }],
          directors: [{ name: "导演甲" }],
          pic: { normal: "https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg" }
        }), { status: 200 });
      }
      return new Response(JSON.stringify(payload()), { status: 200 });
    });
    const client = new DoubanClient({ fetchImpl });

    const details = await client.getDetails("1295644", "movie");
    expect(details).toMatchObject({ itemId: "1295644", actors: [{ name: "演员甲" }, { name: "演员乙" }], directors: ["导演甲"] });

    await client.list("movie-hot", 2, 1);
    const poster = await client.getPoster("movie-hot", "1295644", 2, 1);
    expect(poster.contentType).toBe("image/jpeg");
    expect([...poster.body]).toEqual([1, 2, 3, 4]);
    await client.getPoster("movie-hot", "1295644", 2, 1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("normalizes and caches generic media search matches without exposing poster origins", async () => {
    const image = new Uint8Array([5, 6, 7]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/j/subject_suggest?q=%E6%98%9F%E9%99%85%E7%A9%BF%E8%B6%8A")) {
        return new Response(JSON.stringify([
          {
            id: "1293000",
            title: "星际穿越",
            type: "movie",
            year: "2014",
            img: "https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123.jpg",
            sub_title: "2014 / 美国 / 科幻"
          },
          { id: "1048026", title: "演员甲", type: "celebrity", img: "https://img1.doubanio.com/avatar.jpg" },
          { id: "1293000", title: "星际穿越", type: "movie", img: "https://evil.invalid/duplicate.jpg" }
        ]), { status: 200 });
      }
      if (url.startsWith("https://img1.doubanio.com/")) {
        return new Response(image, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new DoubanClient({ fetchImpl });

    const result = await client.searchMedia(" 星际穿越 ", 10);
    const cached = await client.searchMedia("星际穿越", 10);

    expect(result).toEqual({
      query: "星际穿越",
      total: 1,
      items: [expect.objectContaining({
        id: "1293000",
        title: "星际穿越",
        posterUrl: "/api/discovery/media/movie/1293000/poster",
        year: "2014",
        mediaType: "movie",
        genres: [],
        summary: "2014 / 美国 / 科幻",
        sourceUrl: "https://movie.douban.com/subject/1293000/"
      })]
    });
    expect(cached).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("doubanio.com");
    expect(parseDoubanMediaSearch([
      { id: "1293001", title: "不可信图片", type: "movie", img: "https://evil.invalid/poster.jpg" }
    ], "不可信图片").items[0]).not.toHaveProperty("posterUrl");

    const poster = await client.getMediaPoster("1293000", "movie");
    expect([...poster.body]).toEqual([...image]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("resolves an actor and parses paged filmography with safe poster proxies", async () => {
    const image = new Uint8Array([8, 9, 10]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://img2.doubanio.com/")) {
        return new Response(image, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      }
      if (url.includes("/j/subject_suggest?q=%E6%BC%94%E5%91%98%E7%94%B2")) {
        return new Response(JSON.stringify([
          { id: "1048026", title: "演员甲", type: "celebrity" },
          { id: "1295644", title: "一部电影", type: "movie" }
        ]), { status: 200 });
      }
      if (url.endsWith("/celebrity/1048026")) {
        return new Response(JSON.stringify({
          id: "27253787",
          title: "演员甲",
          latin_title: "Actor A",
          cover_img: { url: "https://img2.doubanio.com/avatar.jpg" },
          extra: { short_info: "演员 / 导演", info: [["出生地", "中国"]] }
        }), { status: 200 });
      }
      if (url.includes("/celebrity/1048026/works?start=10&count=10")) {
        return new Response(JSON.stringify({
          start: 10,
          count: 10,
          total: 21,
          works: [{
            roles: ["演员"],
            work: {
              id: "1295644",
              title: "一部电影",
              type: "movie",
              year: "2024",
              rating: { value: 8.8, count: 100 },
              cover_url: "https://img2.doubanio.com/view/photo/m_ratio_poster/public/p123.jpg",
              url: "https://evil.invalid/should-not-leak"
            }
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ subject_collection_items: [] }), { status: 200 });
    });
    const client = new DoubanClient({ fetchImpl });

    const profile = await client.getActorProfile("演员甲", 2, 10);
    expect(profile).toMatchObject({
      id: "1048026",
      name: "演员甲",
      latinName: "Actor A",
      avatarUrl: "/api/discovery/actors/1048026/avatar",
      intro: "演员 / 导演\n出生地：中国",
      page: 2,
      pageSize: 10,
      total: 21,
      hasNext: true
    });
    expect(profile.works).toEqual([expect.objectContaining({
      id: "1295644",
      posterUrl: "/api/discovery/media/movie/1295644/poster",
      mediaType: "movie",
      role: "演员",
      sourceUrl: "https://movie.douban.com/subject/1295644/"
    })]);
    expect(JSON.stringify(profile)).not.toContain("img2.doubanio.com");

    const avatar = await client.getActorAvatar("1048026");
    const poster = await client.getActorWorkPoster("1048026", "1295644");
    expect([...avatar.body]).toEqual([...image]);
    expect([...poster.body]).toEqual([...image]);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("keeps actor profile parsing bounded when an upstream payload is malformed", () => {
    expect(() => parseDoubanActorProfile({}, { total: 0, works: [] }, "27253787")).toThrow(DoubanUpstreamError);
  });
});
