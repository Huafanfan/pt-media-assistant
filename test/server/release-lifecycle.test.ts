import { describe, expect, it, vi } from "vitest";
import { DiscoveryService, RELEASE_CACHE_TTL_MS } from "../../src/server/discovery.js";
import { ProwlarrClient, ReleaseCache, sanitizeRelease } from "../../src/server/prowlarr.js";
import type { ReleaseSummary } from "../../src/shared/contracts.js";

const media = { id: "1", title: "Test", year: "2024", mediaType: "movie" as const, genres: [], summary: "", sourceUrl: "" };
const douban = { list: vi.fn(), getMedia: async () => media };

describe("recommendation snapshot references", () => {
  it("keeps snapshot references for 24 hours but leaves ordinary searches at 15 minutes", async () => {
    let now = Date.now();
    const cache = new ReleaseCache({ now: () => now });
    const client = new ProwlarrClient({ baseUrl: "http://example.invalid", cache,
      fetchImpl: async () => Response.json([{ title: "Test 2024 1080p", seeders: 5, size: 100 }]) });
    const ordinary = await client.search({ searchTerm: "Other" });
    const service = new DiscoveryService({ douban, prowlarr: client }, { now: () => now, minIntervalMs: 0 });
    const snapshot = await service.getMediaReleases("movie", "1");
    now += 16 * 60 * 1000;
    expect(cache.get(ordinary.releases[0]!.id)).toBeUndefined();
    expect(cache.get(snapshot.releases[0]!.id)).toBeDefined();
    expect((await service.getMediaReleases("movie", "1")).snapshotId).toBe(snapshot.snapshotId);
    now += RELEASE_CACHE_TTL_MS;
    expect(cache.get(snapshot.releases[0]!.id)).toBeUndefined();
  });

  it("marks an evicted reference unactionable without secretly querying again", async () => {
    let now = Date.now();
    const cache = new ReleaseCache({ maxEntries: 1, now: () => now });
    const fetchImpl = vi.fn(async () => Response.json([{ title: "Test 2024", seeders: 5 }]));
    const client = new ProwlarrClient({ baseUrl: "http://example.invalid", cache, fetchImpl });
    const service = new DiscoveryService({ douban, prowlarr: client }, { now: () => now, minIntervalMs: 0 });
    await service.getMediaReleases("movie", "1");
    cache.put({ title: "Other" });
    now += 100;
    const cached = await service.getMediaReleases("movie", "1");
    expect(Date.parse(cached.actionableUntil!)).toBe(now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("evicts raw references with snapshot LRU and explicit cache clearing", async () => {
    let now = Date.now();
    let searchIndex = 0;
    const cache = new ReleaseCache({ now: () => now });
    const client = new ProwlarrClient({
      baseUrl: "http://example.invalid",
      cache,
      fetchImpl: async () => Response.json([{ title: `Test ${++searchIndex}`, seeders: 5, size: 100 }]),
    });
    const service = new DiscoveryService({
      douban: {
        list: vi.fn(),
        getMedia: async (itemId: string) => ({ ...media, id: itemId, title: `Test ${itemId}` }),
      },
      prowlarr: client,
    }, { now: () => now, minIntervalMs: 0 });

    const first = await service.getMediaReleases("movie", "1");
    for (let itemId = 2; itemId <= 201; itemId += 1) {
      await service.getMediaReleases("movie", String(itemId));
    }
    expect(cache.get(first.releases[0]!.id)).toBeUndefined();

    const latest = await service.getMediaReleases("movie", "201");
    service.clearReleaseCache();
    expect(cache.get(latest.releases[0]!.id)).toBeUndefined();
  });

  it("invalidates old references before an explicit refresh", async () => {
    let now = Date.now();
    const cache = new ReleaseCache({ now: () => now });
    const client = new ProwlarrClient({
      baseUrl: "http://example.invalid",
      cache,
      fetchImpl: async () => Response.json([{ title: "Test 2024 1080p", seeders: 5, size: 100 }]),
    });
    const service = new DiscoveryService({ douban, prowlarr: client }, { now: () => now, minIntervalMs: 0 });

    const first = await service.getMediaReleases("movie", "1");
    const refreshed = await service.getMediaReleases("movie", "1", 10, { forceRefresh: true });
    expect(refreshed.snapshotId).not.toBe(first.snapshotId);
    expect(cache.get(first.releases[0]!.id)).toBeUndefined();
    expect(cache.get(refreshed.releases[0]!.id)).toBeDefined();
  });

  it("keeps runtime release responses on the browser-safe DTO allowlist", async () => {
    const rawSummary = {
      id: "opaque-release",
      title: "Test 2024 1080p",
      indexer: "TJUPT",
      protocol: "torrent" as const,
      size: 100,
      seeders: 5,
      leechers: 0,
      grabs: 0,
      ageDays: 1,
      categories: [{ guid: "secret" }, "Movies"],
      freeleech: false,
      guid: "private-guid",
      downloadUrl: "https://private.invalid/download",
    } as unknown as ReleaseSummary & { guid: string; downloadUrl: string };
    const service = new DiscoveryService({
      douban,
      prowlarr: { search: async () => [rawSummary] },
    }, { minIntervalMs: 0 });

    const response = await service.getMediaReleases("movie", "1");
    expect(response.releases[0]).toEqual(expect.objectContaining({ categories: ["Movies"] }));
    expect(response.releases[0]).not.toHaveProperty("guid");
    expect(response.releases[0]).not.toHaveProperty("downloadUrl");
  });

  it("never revives an expired ID", () => {
    let now = 0;
    const cache = new ReleaseCache({ now: () => now, ttlMs: 10 });
    const id = cache.put({ title: "A" });
    now = 11;
    expect(cache.retain(id, 1000)).toBe(false);
    expect(cache.get(id)).toBeUndefined();
  });

  it("checks actual-search budgets including alternate titles, and does not cache failures", async () => {
    const search = vi.fn(async () => []);
    const beforeSearch = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("budget"); });
    const service = new DiscoveryService({ douban: { ...douban, getMedia: async () => ({ ...media, originalTitle: "Original" }) }, prowlarr: { search } }, { minIntervalMs: 0 });
    await expect(service.getMediaReleases("movie", "1", 10, { beforeSearch })).rejects.toThrow("budget");
    expect(search).toHaveBeenCalledTimes(1);
    await service.getMediaReleases("movie", "1");
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("does not search after cancellation while queued", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const search = vi.fn().mockImplementationOnce(async () => { await pending; return []; }).mockResolvedValue([]);
    const service = new DiscoveryService({ douban, prowlarr: { search } }, { minIntervalMs: 0 });
    const first = service.getMediaReleases("movie", "1");
    const controller = new AbortController();
    const second = service.getMediaReleases("movie", "2", 10, { signal: controller.signal });
    controller.abort();
    release();
    await first;
    await expect(second).rejects.toThrow();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("lets a valid waiter adopt the budget gate when the first waiter cancels", async () => {
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
    const candidate = {
      id: "shared-release",
      title: "Test 2024 1080p",
      indexer: "TJUPT",
      protocol: "torrent" as const,
      size: 100,
      seeders: 5,
      leechers: 0,
      grabs: 0,
      ageDays: 1,
      categories: [],
      freeleech: false,
    };
    const search = vi.fn(async (intent: { searchTerm: string }) => {
      if (intent.searchTerm === "Blocker 2024") {
        blockerStarted();
        await blocker;
        return [];
      }
      return { query: intent.searchTerm, intent, total: 1, elapsedMs: 0, releases: [candidate] };
    });
    const service = new DiscoveryService({
      douban: {
        list: vi.fn(),
        getMedia: async (itemId: string) => ({ ...media, id: itemId, title: itemId === "blocker" ? "Blocker" : "Test" }),
      },
      prowlarr: { search },
    }, { minIntervalMs: 0 });

    const blockerRequest = service.getMediaReleases("movie", "blocker");
    await started;
    const ownerController = new AbortController();
    const adopterController = new AbortController();
    const ownerBudget = vi.fn();
    const adopterBudget = vi.fn();
    const owner = service.getMediaReleases("movie", "1", 10, {
      signal: ownerController.signal,
      beforeSearch: ownerBudget,
    });
    const adopter = service.getMediaReleases("movie", "1", 10, {
      signal: adopterController.signal,
      beforeSearch: adopterBudget,
    });

    ownerController.abort();
    releaseBlocker();
    await expect(owner).rejects.toMatchObject({ name: "AbortError" });
    await expect(blockerRequest).resolves.toMatchObject({ status: "unavailable" });
    await expect(adopter).resolves.toMatchObject({ status: "available" });
    expect(ownerBudget).not.toHaveBeenCalled();
    expect(adopterBudget).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("aborts the shared upstream work when every waiter cancels", async () => {
    let searchStarted!: () => void;
    let sawAbort = false;
    const started = new Promise<void>((resolve) => { searchStarted = resolve; });
    const search = vi.fn(async (
      _intent: { searchTerm: string },
      _limit?: number,
      options?: { signal?: AbortSignal },
    ) => {
      searchStarted();
      if (!options?.signal) throw new Error("missing operation signal");
      return new Promise<never>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => {
          sawAbort = true;
          reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    });
    const service = new DiscoveryService({ douban, prowlarr: { search } }, { minIntervalMs: 0 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.getMediaReleases("movie", "1", 10, { signal: firstController.signal });
    const second = service.getMediaReleases("movie", "1", 10, { signal: secondController.signal });
    await started;

    firstController.abort();
    secondController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(sawAbort).toBe(true);
  });
});

describe("release field evidence", () => {
  it("distinguishes absent freeleech and numeric fields from confirmed values", () => {
    const unknown = sanitizeRelease({ title: "Movie 1080p HEVC", size: null, seeders: "" }, "release-id");
    expect(unknown.freeleechState).toBe("unknown");
    expect(unknown.evidence).toEqual({ resolution: "title_inferred", codec: "title_inferred", size: "unknown", seeders: "unknown", season: "unknown" });
    const known = sanitizeRelease({ title: "Movie", resolution: "1080p", codec: "HEVC", size: 10, seeders: 0, freeleech: false }, "release-id");
    expect(known.freeleechState).toBe("no");
    expect(known.evidence?.seeders).toBe("upstream");
    expect(sanitizeRelease({ indexerFlags: ["Freeleech"] }, "release-id").freeleechState).toBe("yes");
    expect(sanitizeRelease({ indexerFlags: ["非免费"] }, "release-id").freeleechState).toBe("unknown");
    expect(sanitizeRelease({ indexerFlags: ["非Freeleech"] }, "release-id").freeleechState).toBe("unknown");
  });

  it("infers a season only from explicit season tokens in the title", () => {
    expect(sanitizeRelease({ title: "Show S02 1080p" }, "id").season).toBe(2);
    expect(sanitizeRelease({ title: "Show.Season.3.1080p" }, "id").season).toBe(3);
    expect(sanitizeRelease({ title: "Show 第三季 1080p" }, "id").season).toBe(3);
    expect(sanitizeRelease({ title: "Show 第十二季 1080p" }, "id").season).toBe(12);
    expect(sanitizeRelease({ title: "Show S02 1080p" }, "id").evidence?.season).toBe("title_inferred");
    expect(sanitizeRelease({ title: "Show 1080p HEVC" }, "id").season).toBeUndefined();
    expect(sanitizeRelease({ title: "Show 1080p HEVC" }, "id").evidence?.season).toBe("unknown");
    // Bare numbers and words ending in "s" are never guessed as a season.
    expect(sanitizeRelease({ title: "Se7en 1995 1080p" }, "id").season).toBeUndefined();
    expect(sanitizeRelease({ title: "The Class 10 1080p" }, "id").season).toBeUndefined();
  });

  it("does not treat unknown size as satisfying a hard max-size constraint", async () => {
    const client = new ProwlarrClient({
      baseUrl: "http://example.invalid",
      fetchImpl: async () => Response.json([{ title: "Movie 1080p", seeders: 5 }]),
    });
    const result = await client.search({ searchTerm: "Movie", maxSizeBytes: 100 });
    expect(result.releases).toHaveLength(0);
  });

  it("preserves caller cancellation as an abort error", async () => {
    const controller = new AbortController();
    const client = new ProwlarrClient({
      baseUrl: "http://example.invalid",
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    });
    const request = client.search({ searchTerm: "Movie" }, 20, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
