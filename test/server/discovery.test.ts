import { describe, expect, it, vi } from "vitest";

import type {
  DiscoveryCollectionResponse,
  DiscoveryItem,
  ReleaseSummary,
  SearchResponse,
} from "../../src/shared/contracts.js";
import {
  AVAILABLE_CACHE_TTL_MS,
  DiscoveryItemNotFoundError,
  DiscoveryService,
  PT_QUERY_MIN_INTERVAL_MS,
  UNAVAILABLE_CACHE_TTL_MS,
} from "../../src/server/discovery.js";
import { UnknownDiscoveryCollectionError } from "../../src/server/douban.js";

function item(id = "1", overrides: Partial<DiscoveryItem> = {}): DiscoveryItem {
  return {
    id,
    title: "中文标题",
    originalTitle: "Original Title",
    year: "2024",
    rank: 1,
    mediaType: "movie",
    genres: ["剧情"],
    summary: "简介",
    sourceUrl: `https://movie.douban.com/subject/${id}/`,
    ...overrides,
  };
}

function collection(items: DiscoveryItem[] = [item()]): DiscoveryCollectionResponse {
  return {
    collection: "movie-hot",
    updatedAt: new Date(0).toISOString(),
    stale: false,
    items,
  };
}

function release(id: string, seeders: number): ReleaseSummary {
  return {
    id,
    title: `Release ${id}`,
    indexer: "TJUPT",
    protocol: "torrent",
    size: 1,
    seeders,
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

describe("DiscoveryService", () => {
  it("lists collections through Douban and rejects unknown collection ids", async () => {
    const list = vi.fn(async () => collection());
    const service = new DiscoveryService({
      douban: { list },
      prowlarr: { search: vi.fn(async () => searchResponse([])) },
    });

    await service.list("movie-hot", 3);
    expect(list).toHaveBeenCalledWith("movie-hot", 3);
    await expect(service.list("bogus")).rejects.toBeInstanceOf(UnknownDiscoveryCollectionError);
  });

  it("prefers original title plus year, then falls back to Chinese title plus year", async () => {
    const search = vi.fn(async (intent: { searchTerm: string }) => {
      if (intent.searchTerm === "Original Title 2024") return searchResponse([]);
      return searchResponse([release("r1", 2), release("r1", 0), release("r2", 0)]);
    });
    const service = new DiscoveryService(
      { list: vi.fn(async () => collection()) },
      { search },
      { sleep: async () => undefined },
    );

    const result = await service.getReleases("movie-hot", "1", 10);
    expect(search.mock.calls.map(([intent]) => intent.searchTerm)).toEqual([
      "Original Title 2024",
      "中文标题 2024",
    ]);
    expect(result.status).toBe("available");
    expect(result.total).toBe(2);
    expect(result.releases.map((entry) => entry.id)).toEqual(["r1", "r2"]);
  });

  it("classifies possible and unavailable results, and merges concurrent same-item work", async () => {
    const search = vi.fn(async () => searchResponse([release("r1", 0)]));
    const service = new DiscoveryService({
      douban: { list: vi.fn(async () => collection([item("1", { originalTitle: undefined })])) },
      prowlarr: { search },
    });
    const [first, second] = await Promise.all([
      service.getReleases("movie-hot", "1"),
      service.getReleases("movie-hot", "1"),
    ]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("possible");
    expect(second.status).toBe("possible");

    const emptySearch = vi.fn(async () => searchResponse([]));
    const unavailable = new DiscoveryService({
      douban: { list: vi.fn(async () => collection([item("2", { originalTitle: undefined })])) },
      prowlarr: { search: emptySearch },
    });
    await expect(unavailable.getReleases("movie-hot", "missing")).rejects.toBeInstanceOf(DiscoveryItemNotFoundError);
    await expect(unavailable.getReleases("movie-hot", "2")).resolves.toMatchObject({ status: "unavailable", total: 0 });
  });

  it("serializes PT queries with the minimum spacing and applies status TTLs", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const search = vi.fn(async (intent: { searchTerm: string }) => {
      if (intent.searchTerm.startsWith("Original")) return searchResponse([]);
      return searchResponse([release(intent.searchTerm, intent.searchTerm.includes("B") ? 0 : 1)]);
    });
    const service = new DiscoveryService(
      { list: vi.fn(async (_collection, _limit) => collection([item("1", { originalTitle: undefined }), item("2", { title: "中文B", originalTitle: "Original B" })])) },
      { search },
      {
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      },
    );

    const available = await service.getReleases("movie-hot", "1");
    expect(available.status).toBe("available");
    const possible = await service.getReleases("movie-hot", "2");
    expect(possible.status).toBe("possible");
    expect(sleeps.length).toBe(2);
    expect(sleeps.every((milliseconds) => milliseconds === PT_QUERY_MIN_INTERVAL_MS)).toBe(true);

    const searchCount = search.mock.calls.length;
    now = AVAILABLE_CACHE_TTL_MS - 1;
    await service.getReleases("movie-hot", "1");
    expect(search).toHaveBeenCalledTimes(searchCount);
    now = AVAILABLE_CACHE_TTL_MS + 1;
    await service.getReleases("movie-hot", "1");
    expect(search.mock.calls.length).toBeGreaterThan(searchCount);

    const unavailableService = new DiscoveryService(
      { list: vi.fn(async () => collection([item("3", { originalTitle: undefined })])) },
      { search: vi.fn(async () => searchResponse([])) },
      { now: () => now, sleep: async () => undefined },
    );
    const before = unavailableService.getReleases("movie-hot", "3");
    await before;
    const noCallCount = (unavailableService as unknown as { prowlarr: { search: ReturnType<typeof vi.fn> } }).prowlarr.search.mock.calls.length;
    now += UNAVAILABLE_CACHE_TTL_MS - 1;
    await unavailableService.getReleases("movie-hot", "3");
    expect((unavailableService as unknown as { prowlarr: { search: ReturnType<typeof vi.fn> } }).prowlarr.search).toHaveBeenCalledTimes(noCallCount);
    now += 2;
    await unavailableService.getReleases("movie-hot", "3");
    expect((unavailableService as unknown as { prowlarr: { search: ReturnType<typeof vi.fn> } }).prowlarr.search).toHaveBeenCalledTimes(noCallCount + 1);
  });
});
