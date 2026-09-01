import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/client/api";

describe("discovery API client", () => {
  it("uses same-origin GET resources and strips unsupported discovery fields", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      collection: "movie-hot",
      updatedAt: "2026-08-29T00:00:00.000Z",
      stale: false,
      page: 2,
      pageSize: 10,
      total: 25,
      hasNext: true,
      items: [
        {
          id: "36808876",
          title: "奥德赛",
          posterUrl: "/api/discovery/collections/movie-hot/items/36808876/poster?page=2&limit=10",
          originalTitle: "The Odyssey",
          year: "2026",
          rating: 8.5,
          rank: 1,
          mediaType: "movie",
          genres: ["动作", "冒险"],
          summary: "漫长归途。",
          sourceUrl: "https://movie.douban.com/subject/36808876/",
          coverUrl: "https://untrusted.invalid/poster.jpg"
        },
        {
          id: "bad",
          title: "invalid",
          rank: 2,
          mediaType: "movie",
          genres: [],
          summary: "",
          sourceUrl: "https://untrusted.invalid/"
        }
      ]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchImpl as typeof fetch);

    const result = await client.getDiscoveryCollection("movie-hot", "csrf-test", 2, 10);

    expect(result.items).toHaveLength(1);
    expect(result.page).toBe(2);
    expect(result.hasNext).toBe(true);
    expect(result.items[0]?.posterUrl).toContain("/poster?page=2&limit=10");
    expect(result.items[0]).not.toHaveProperty("coverUrl");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/discovery/collections/movie-hot/items?page=2&limit=10",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test" })
      })
    );
  });

  it("loads normalized actor details through the same-origin API", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      itemId: "36808876",
      actors: [{ name: "演员甲" }, { name: "演员甲" }, { name: " 演员乙 " }, 12],
      directors: ["导演甲"],
      upstreamUrl: "https://untrusted.invalid/subject/36808876"
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchImpl as typeof fetch);

    const result = await client.getDiscoveryDetails("movie-hot", "36808876", "csrf-test", 2, 10);

    expect(result).toEqual({ itemId: "36808876", actors: [{ name: "演员甲" }, { name: "演员乙" }], directors: ["导演甲"] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/discovery/collections/movie-hot/items/36808876/details?page=2&limit=10",
      expect.objectContaining({ credentials: "same-origin" })
    );
  });

  it("normalizes availability and release summaries", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      itemId: "36808876",
      query: "The Odyssey 2026",
      status: "available",
      checkedAt: "2026-08-29T00:00:01.000Z",
      total: 1,
      releases: [{
        id: "release-opaque-123",
        title: "The Odyssey 2026 1080p",
        indexer: "TJUPT",
        protocol: "torrent",
        size: 1024,
        seeders: 8,
        leechers: 1,
        grabs: 2,
        ageDays: 1,
        categories: ["Movies"],
        freeleech: true,
        downloadUrl: "https://private.invalid/secret"
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchImpl as typeof fetch);

    const result = await client.getDiscoveryReleases("movie-hot", "36808876", "csrf-test");
    const refreshed = await client.refreshDiscoveryReleases("movie-hot", "36808876", "csrf-test");

    expect(result.status).toBe("available");
    expect(result.releases[0]).toMatchObject({ id: "release-opaque-123", seeders: 8, freeleech: true });
    expect(JSON.stringify(result)).not.toContain("private.invalid");
    expect(refreshed.status).toBe("available");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/discovery/collections/movie-hot/items/36808876/releases",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test" })
      })
    );
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls[0]?.[1]).not.toHaveProperty("method");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/discovery/collections/movie-hot/items/36808876/releases/refresh",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test" })
      })
    );
  });

  it("uses the canonical media routes for title matches, details, releases, and refresh", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/discovery/media?")) {
        return new Response(JSON.stringify({
          query: "星际穿越",
          total: 1,
          items: [{
            id: "1293000",
            title: "星际穿越",
            posterUrl: "/api/discovery/media/movie/1293000/poster",
            year: "2014",
            mediaType: "movie",
            genres: ["科幻"],
            summary: "一支探险队穿越虫洞。",
            sourceUrl: "https://movie.douban.com/subject/1293000/"
          }]
        }), { status: 200 });
      }
      if (url.endsWith("/details")) {
        return new Response(JSON.stringify({
          itemId: "1293000",
          actors: [{ name: "演员甲" }],
          directors: ["导演甲"]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        itemId: "1293000",
        query: "星际穿越 2014",
        status: "available",
        checkedAt: "2026-08-29T00:00:01.000Z",
        total: 1,
        releases: []
      }), { status: 200 });
    });
    const client = createApiClient(fetchImpl as typeof fetch);

    const media = await client.searchDiscoveryMedia("星际穿越", "csrf-test", 10);
    const details = await client.getDiscoveryMediaDetails("movie", "1293000", "csrf-test");
    const releases = await client.getDiscoveryMediaReleases("movie", "1293000", "csrf-test", 10);
    await client.refreshDiscoveryMediaReleases("movie", "1293000", "csrf-test", 10);

    expect(media.items[0]).toMatchObject({ id: "1293000", mediaType: "movie", title: "星际穿越" });
    expect(details).toEqual({ itemId: "1293000", actors: [{ name: "演员甲" }], directors: ["导演甲"] });
    expect(releases).toMatchObject({ itemId: "1293000", status: "available" });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/discovery/media?query=%E6%98%9F%E9%99%85%E7%A9%BF%E8%B6%8A&limit=10",
      expect.objectContaining({ credentials: "same-origin", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test" }) })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/discovery/media/movie/1293000/details",
      expect.objectContaining({ credentials: "same-origin" })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "/api/discovery/media/movie/1293000/releases?limit=10",
      expect.objectContaining({ credentials: "same-origin" })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      "/api/discovery/media/movie/1293000/releases/refresh?limit=10",
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    );
  });

  it("loads a bounded actor profile and only accepts same-origin artwork paths", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "1048026",
      name: "演员甲",
      latinName: "Actor A",
      avatarUrl: "/api/discovery/actors/1048026/avatar",
      intro: "演员 / 导演",
      page: 2,
      pageSize: 10,
      total: 21,
      hasNext: true,
      works: [
        {
          id: "1295644",
          title: "一部电影",
          posterUrl: "/api/discovery/actors/1048026/works/1295644/poster",
          year: "2024",
          rating: 8.8,
          mediaType: "movie",
          sourceUrl: "https://movie.douban.com/subject/1295644/"
        },
        {
          id: "1295645",
          title: "不可信图片",
          posterUrl: "https://img1.doubanio.com/poster.jpg",
          mediaType: "tv",
          sourceUrl: "https://movie.douban.com/subject/1295645/"
        }
      ]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient(fetchImpl as typeof fetch);

    const result = await client.getDiscoveryActor("演员甲", "csrf-test", 2, 10);

    expect(result).toMatchObject({ id: "1048026", name: "演员甲", page: 2, total: 21, hasNext: true });
    expect(result.works).toHaveLength(2);
    expect(result.works[0]?.posterUrl).toBe("/api/discovery/actors/1048026/works/1295644/poster");
    expect(result.works[1]).not.toHaveProperty("posterUrl");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/discovery/actors?name=%E6%BC%94%E5%91%98%E7%94%B2&page=2&limit=10",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test" })
      })
    );
  });
});
