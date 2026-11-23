import { describe, expect, it, vi } from "vitest";

import type {
  DiscoveryCollectionResponse,
  DiscoveryMedia,
  ReleaseSummary,
  SearchResponse,
} from "../../src/shared/contracts.js";
import { DiscoveryService, RELEASE_CACHE_TTL_MS } from "../../src/server/discovery.js";

function media(overrides: Partial<DiscoveryMedia> = {}): DiscoveryMedia {
  return {
    id: "1",
    title: "中文标题",
    originalTitle: "Original Title",
    year: "2024",
    mediaType: "movie",
    genres: ["剧情"],
    summary: "简介",
    sourceUrl: "https://movie.douban.com/subject/1/",
    ...overrides,
  };
}

function collection(): DiscoveryCollectionResponse {
  return {
    collection: "movie-hot",
    updatedAt: new Date(0).toISOString(),
    stale: false,
    page: 1,
    pageSize: 10,
    total: 1,
    hasNext: false,
    items: [{ ...media(), rank: 1 }],
  };
}

function release(id: string): ReleaseSummary {
  return {
    id,
    title: "Release",
    indexer: "TJUPT",
    protocol: "torrent",
    size: 1,
    seeders: 2,
    leechers: 0,
    grabs: 0,
    ageDays: 1,
    categories: [],
    freeleech: false,
  };
}

function searchResponse(releases: ReleaseSummary[]): SearchResponse {
  return {
    query: "",
    intent: { searchTerm: "" },
    total: releases.length,
    elapsedMs: 0,
    releases,
  };
}

function build(alive: Set<string>, now: () => number = Date.now) {
  const search = vi.fn(async () => searchResponse([release("r1")]));
  const service = new DiscoveryService(
    {
      douban: {
        list: vi.fn(async () => collection()),
        getMedia: vi.fn(async () => media()),
      },
      prowlarr: {
        search,
        hasRelease: (id: string) => alive.has(id),
      },
    },
    { minIntervalMs: 0, sleep: async () => undefined, now },
  );
  return { service, search };
}

describe("DiscoveryService.getReleaseSnapshot", () => {
  it("returns the live snapshot with its media identity", async () => {
    const alive = new Set(["r1"]);
    const { service } = build(alive);
    await service.getMediaReleases("movie", "1", 10);
    const view = service.getReleaseSnapshot("movie", "1");
    expect(view?.snapshotId).toBeTruthy();
    expect(view?.media.title).toBe("中文标题");
    expect(view?.response.releases.map((entry) => entry.id)).toEqual(["r1"]);
  });

  it("returns undefined once an opaque release reference is revoked", async () => {
    const alive = new Set(["r1"]);
    const { service } = build(alive);
    await service.getMediaReleases("movie", "1", 10);
    alive.clear();
    expect(service.getReleaseSnapshot("movie", "1")).toBeUndefined();
    // The revoked snapshot is evicted, so a second lookup also fails.
    expect(service.getReleaseSnapshot("movie", "1")).toBeUndefined();
  });

  it("returns undefined after the snapshot TTL passes", async () => {
    let now = 0;
    const alive = new Set(["r1"]);
    const { service } = build(alive, () => now);
    await service.getMediaReleases("movie", "1", 10);
    expect(service.getReleaseSnapshot("movie", "1")).toBeDefined();
    now = RELEASE_CACHE_TTL_MS + 1;
    expect(service.getReleaseSnapshot("movie", "1")).toBeUndefined();
  });

  it("returns undefined after an explicit cache clear", async () => {
    const alive = new Set(["r1"]);
    const { service } = build(alive);
    await service.getMediaReleases("movie", "1", 10);
    service.clearReleaseCache();
    expect(service.getReleaseSnapshot("movie", "1")).toBeUndefined();
  });

  it("does not trigger a new upstream search", async () => {
    const alive = new Set(["r1"]);
    const { service, search } = build(alive);
    await service.getMediaReleases("movie", "1", 10);
    search.mockClear();
    service.getReleaseSnapshot("movie", "1");
    expect(search).not.toHaveBeenCalled();
  });
});
