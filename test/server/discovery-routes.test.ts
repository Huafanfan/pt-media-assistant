import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { DiscoveryItemNotFoundError } from "../../src/server/discovery.js";

const config = {
  host: "0.0.0.0",
  port: 4178,
  prowlarrUrl: "http://127.0.0.1:9696",
  prowlarrApiKey: "test-only-key",
  qbittorrentUrl: "http://127.0.0.1:8080",
  nasPath: "/Volumes/YourNAS/pt",
  nasCheckMode: "smbfs" as const,
  nasSentinelName: ".pt-media-assistant-mounted",
  pairingCode: "123456",
  sessionTtlMs: 3_600_000,
  releaseCacheTtlMs: 900_000,
  upstreamTimeoutMs: 60_000,
  allowGrab: false,
  trustLan: true
};

const item = {
  id: "36808876",
  title: "奥德赛",
  originalTitle: "The Odyssey",
  year: "2026",
  rating: 8.5,
  rank: 1,
  mediaType: "movie" as const,
  genres: ["动作", "冒险"],
  summary: "漫长归途。",
  sourceUrl: "https://movie.douban.com/subject/36808876/"
};

const collectionResponse = {
  collection: "movie-hot" as const,
  updatedAt: "2026-08-29T00:00:00.000Z",
  stale: false,
  page: 1,
  pageSize: 10,
  total: 1,
  hasNext: false,
  items: [item]
};

function baseServices() {
  return {
    prowlarr: {
      search: vi.fn(),
      getRelease: vi.fn(),
      grab: vi.fn(),
      check: vi.fn(async () => true)
    },
    qbittorrent: {
      listTorrents: vi.fn(async () => []),
      duplicateForRelease: vi.fn(async () => false),
      check: vi.fn(async () => true)
    },
    nas: {
      preflight: vi.fn(async () => ({ path: config.nasPath, mounted: true, directoryExists: true, ready: true })),
      storage: vi.fn(async () => ({
        path: config.nasPath,
        mounted: true,
        ready: true,
        totalBytes: 100,
        usedBytes: 40,
        freeBytes: 60
      }))
    }
  };
}

async function trustedSession(app: Awaited<ReturnType<typeof createApp>>) {
  const response = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { host: "localhost:4178" },
    remoteAddress: "10.0.0.42"
  });
  return {
    cookie: String(response.headers["set-cookie"]).split(";", 1)[0],
    csrfToken: String(response.json().csrfToken)
  };
}

describe("discovery routes", () => {
  it("protects and returns a bounded collection resource", async () => {
    const list = vi.fn(async () => collectionResponse);
    const app = await createApp({
      config,
      ...baseServices(),
      discovery: { list, getReleases: vi.fn() },
      staticRoot: "/definitely-not-a-static-root"
    });

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/discovery/collections/movie-hot/items",
      headers: { host: "localhost:4178" }
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();

    const session = await trustedSession(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/discovery/collections/movie-hot/items",
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().items).toEqual([item]);
    expect(list).toHaveBeenCalledWith("movie-hot", 1, 10);
    await app.close();
  });

  it("paginates collections and protects details and poster proxy routes", async () => {
    const list = vi.fn(async (_collection: string, page = 1, limit = 10) => ({
      ...collectionResponse,
      page,
      pageSize: limit,
      total: 25,
      hasNext: page < 3
    }));
    const getDetails = vi.fn(async (_collection: string, itemId: string, page: number, limit: number) => ({
      itemId,
      actors: [{ name: "演员甲" }, { name: "演员乙" }],
      directors: ["导演甲"],
      page,
      limit
    }));
    const getPoster = vi.fn(async (_collection: string, _itemId: string, _page: number, _limit: number) => ({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg"
    }));
    const app = await createApp({
      config,
      ...baseServices(),
      discovery: { list, getReleases: vi.fn(), getDetails, getPoster },
      staticRoot: "/definitely-not-a-static-root"
    });
    const session = await trustedSession(app);

    const page = await app.inject({
      method: "GET",
      url: "/api/discovery/collections/movie-hot/items?page=2&limit=10",
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ page: 2, pageSize: 10, total: 25, hasNext: true });
    expect(list).toHaveBeenCalledWith("movie-hot", 2, 10);

    const details = await app.inject({
      method: "GET",
      url: `/api/discovery/collections/movie-hot/items/${item.id}/details?page=2&limit=10`,
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(details.statusCode).toBe(200);
    expect(details.json()).toMatchObject({ itemId: item.id, actors: [{ name: "演员甲" }, { name: "演员乙" }] });
    expect(getDetails).toHaveBeenCalledWith("movie-hot", item.id, 2, 10);

    const poster = await app.inject({
      method: "GET",
      url: `/api/discovery/collections/movie-hot/items/${item.id}/poster?page=2&limit=10`,
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toMatch(/^image\/jpeg/iu);
    expect(poster.headers["cache-control"]).toBe("private, max-age=86400");
    expect(getPoster).toHaveBeenCalledWith("movie-hot", item.id, 2, 10);

    const unauthorizedPoster = await app.inject({
      method: "GET",
      url: `/api/discovery/collections/movie-hot/items/${item.id}/poster`,
      headers: { host: "localhost:4178" }
    });
    expect(unauthorizedPoster.statusCode).toBe(401);
    expect(getPoster).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns release candidates and maps validation/not-found failures", async () => {
    const getReleases = vi.fn(async () => ({
      itemId: item.id,
      query: "The Odyssey 2026",
      status: "available" as const,
      checkedAt: "2026-08-29T00:00:01.000Z",
      total: 0,
      releases: []
    }));
    const app = await createApp({
      config,
      ...baseServices(),
      discovery: { list: vi.fn(), getReleases },
      staticRoot: "/definitely-not-a-static-root"
    });
    const session = await trustedSession(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/discovery/collections/movie-hot/items/${item.id}/releases`,
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ itemId: item.id, status: "available" });
    expect(getReleases).toHaveBeenCalledWith("movie-hot", item.id, 10);

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/discovery/collections/movie-hot/items/${item.id}/releases/refresh`,
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken
      }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(getReleases).toHaveBeenNthCalledWith(2, "movie-hot", item.id, 10, { forceRefresh: true });

    const csrfFailure = await app.inject({
      method: "POST",
      url: `/api/discovery/collections/movie-hot/items/${item.id}/releases/refresh`,
      headers: { host: "localhost:4178", cookie: session.cookie, origin: "http://localhost:4178" }
    });
    expect(csrfFailure.statusCode).toBe(403);
    expect(getReleases).toHaveBeenCalledTimes(2);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/discovery/collections/not-real/items/not-numeric/releases",
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(invalid.statusCode).toBe(400);

    getReleases.mockRejectedValueOnce(new DiscoveryItemNotFoundError("movie-hot", "9999"));
    const missing = await app.inject({
      method: "GET",
      url: "/api/discovery/collections/movie-hot/items/9999/releases",
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("DISCOVERY_ITEM_NOT_FOUND");
    await app.close();
  });

  it("returns protected actor profiles and proxied actor artwork", async () => {
    const getActorProfile = vi.fn(async (name: string, page: number, limit: number) => ({
      id: "1048026",
      name,
      latinName: "Actor A",
      avatarUrl: "/api/discovery/actors/1048026/avatar",
      intro: "演员 / 导演",
      works: [{
        id: "1295644",
        title: "一部电影",
        posterUrl: "/api/discovery/actors/1048026/works/1295644/poster",
        mediaType: "movie" as const,
        sourceUrl: "https://movie.douban.com/subject/1295644/"
      }],
      page,
      pageSize: limit,
      total: 21,
      hasNext: page < 3
    }));
    const getActorAvatar = vi.fn(async () => ({ body: new Uint8Array([4, 5]), contentType: "image/jpeg" }));
    const getActorWorkPoster = vi.fn(async () => ({ body: new Uint8Array([6, 7]), contentType: "image/png" }));
    const app = await createApp({
      config,
      ...baseServices(),
      discovery: { list: vi.fn(), getReleases: vi.fn(), getActorProfile, getActorAvatar, getActorWorkPoster },
      staticRoot: "/definitely-not-a-static-root"
    });
    const session = await trustedSession(app);

    const profile = await app.inject({
      method: "GET",
      url: "/api/discovery/actors?name=%E6%BC%94%E5%91%98%E7%94%B2&page=2&limit=10",
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ id: "1048026", name: "演员甲", page: 2, total: 21, hasNext: true });
    expect(getActorProfile).toHaveBeenCalledWith("演员甲", 2, 10);

    const avatar = await app.inject({
      method: "GET",
      url: "/api/discovery/actors/1048026/avatar",
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers["cache-control"]).toBe("private, max-age=86400");
    expect(getActorAvatar).toHaveBeenCalledWith("1048026");

    const poster = await app.inject({
      method: "GET",
      url: "/api/discovery/actors/1048026/works/1295644/poster",
      headers: { host: "localhost:4178", cookie: session.cookie }
    });
    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toMatch(/^image\/png/iu);
    expect(getActorWorkPoster).toHaveBeenCalledWith("1048026", "1295644");

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/discovery/actors?name=%E6%BC%94%E5%91%98%E7%94%B2",
      headers: { host: "localhost:4178" }
    });
    expect(unauthorized.statusCode).toBe(401);
    await app.close();
  });

  it("exposes one canonical media route family for details, artwork, and releases", async () => {
    const { rank: _rank, ...media } = item;
    const searchMedia = vi.fn(async (query: string) => ({
      query,
      total: 1,
      items: [{ ...media, mediaType: "movie" as const, posterUrl: "/api/discovery/media/movie/36808876/poster" }]
    }));
    const getMediaDetails = vi.fn(async (mediaType: "movie" | "tv", itemId: string) => ({
      itemId,
      actors: [{ name: "演员甲" }],
      directors: ["导演甲"],
      mediaType
    }));
    const getMediaPoster = vi.fn(async () => ({ body: new Uint8Array([8, 9]), contentType: "image/webp" }));
    const getMediaReleases = vi.fn(async () => ({
      itemId: item.id,
      query: item.title,
      status: "available" as const,
      checkedAt: "2026-08-29T00:00:01.000Z",
      total: 1,
      releases: []
    }));
    const app = await createApp({
      config,
      ...baseServices(),
      discovery: { list: vi.fn(), getReleases: vi.fn(), searchMedia, getMediaDetails, getMediaPoster, getMediaReleases },
      staticRoot: "/definitely-not-a-static-root"
    });
    const session = await trustedSession(app);
    const headers = { host: "localhost:4178", cookie: session.cookie };

    const suggestions = await app.inject({
      method: "GET",
      url: "/api/discovery/media?query=%E5%A5%A5%E5%BE%B7%E8%B5%9B&limit=10",
      headers
    });
    expect(suggestions.statusCode).toBe(200);
    expect(suggestions.json().items[0].posterUrl).toBe("/api/discovery/media/movie/36808876/poster");
    expect(searchMedia).toHaveBeenCalledWith("奥德赛", 10);

    const details = await app.inject({
      method: "GET",
      url: "/api/discovery/media/movie/36808876/details",
      headers
    });
    expect(details.statusCode).toBe(200);
    expect(getMediaDetails).toHaveBeenCalledWith("movie", "36808876");

    const poster = await app.inject({
      method: "GET",
      url: "/api/discovery/media/movie/36808876/poster",
      headers
    });
    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toMatch(/^image\/webp/iu);
    expect(getMediaPoster).toHaveBeenCalledWith("movie", "36808876");

    const releases = await app.inject({
      method: "GET",
      url: "/api/discovery/media/movie/36808876/releases?limit=10",
      headers
    });
    expect(releases.statusCode).toBe(200);
    expect(getMediaReleases).toHaveBeenCalledWith("movie", "36808876", 10);

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/discovery/media/movie/36808876/releases/refresh?limit=10",
      headers: {
        ...headers,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken
      }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(getMediaReleases).toHaveBeenCalledWith("movie", "36808876", 10, { forceRefresh: true });
    await app.close();
  });
});
