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
  return String(response.headers["set-cookie"]).split(";", 1)[0];
}

describe("discovery routes", () => {
  it("protects and returns a bounded collection resource", async () => {
    const list = vi.fn(async () => ({
      collection: "movie-hot" as const,
      updatedAt: "2026-08-29T00:00:00.000Z",
      stale: false,
      items: [item]
    }));
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

    const cookie = await trustedSession(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/discovery/collections/movie-hot/items",
      headers: { host: "localhost:4178", cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().items).toEqual([item]);
    expect(list).toHaveBeenCalledWith("movie-hot", 10);
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
    const cookie = await trustedSession(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/discovery/collections/movie-hot/items/${item.id}/releases`,
      headers: { host: "localhost:4178", cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ itemId: item.id, status: "available" });
    expect(getReleases).toHaveBeenCalledWith("movie-hot", item.id, 10);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/discovery/collections/not-real/items/not-numeric/releases",
      headers: { host: "localhost:4178", cookie }
    });
    expect(invalid.statusCode).toBe(400);

    getReleases.mockRejectedValueOnce(new DiscoveryItemNotFoundError("movie-hot", "9999"));
    const missing = await app.inject({
      method: "GET",
      url: "/api/discovery/collections/movie-hot/items/9999/releases",
      headers: { host: "localhost:4178", cookie }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("DISCOVERY_ITEM_NOT_FOUND");
    await app.close();
  });
});
