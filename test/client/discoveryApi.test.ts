import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/client/api";

describe("discovery API client", () => {
  it("uses same-origin GET resources and strips unsupported discovery fields", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      collection: "movie-hot",
      updatedAt: "2026-08-29T00:00:00.000Z",
      stale: false,
      items: [
        {
          id: "36808876",
          title: "奥德赛",
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

    const result = await client.getDiscoveryCollection("movie-hot", "csrf-test");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty("coverUrl");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/discovery/collections/movie-hot/items",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test" })
      })
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

    expect(result.status).toBe("available");
    expect(result.releases[0]).toMatchObject({ id: "release-opaque-123", seeders: 8, freeleech: true });
    expect(JSON.stringify(result)).not.toContain("private.invalid");
  });
});
