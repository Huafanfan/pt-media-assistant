import { randomUUID } from "node:crypto";
import type {
  DiscoveryCollectionId,
  DiscoveryCollectionResponse,
  DiscoveryActorProfile,
  DiscoveryItem,
  DiscoveryItemDetails,
  DiscoveryMedia,
  DiscoveryMediaSearchResponse,
  DiscoveryReleaseResponse,
  ParsedIntent,
  ReleaseSummary,
  SearchResponse,
} from "../shared/contracts.js";
import {
  DEFAULT_DISCOVERY_LIMIT,
  DoubanClient,
  isDiscoveryCollectionId,
  normalizeDiscoveryLimit,
  normalizeDiscoveryPage,
  UnknownDiscoveryCollectionError,
  type DiscoveryPosterAsset,
  type DoubanSubjectDetails,
} from "./douban.js";

export const PT_QUERY_MIN_INTERVAL_MS = 1_200;
export const RELEASE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Keep one bounded PT snapshot so the inspector can paginate without a new upstream query. */
export const DISCOVERY_RELEASE_FETCH_LIMIT = 50;
// Kept as aliases for callers that used the previous status-specific names.
export const AVAILABLE_CACHE_TTL_MS = RELEASE_CACHE_TTL_MS;
export const UNAVAILABLE_CACHE_TTL_MS = RELEASE_CACHE_TTL_MS;

export class DiscoveryItemNotFoundError extends Error {
  public readonly collection: DiscoveryCollectionId | string;
  public readonly itemId: string;

  public constructor(collection: DiscoveryCollectionId | string, itemId: string) {
    super(`Discovery item not found: ${collection}/${itemId}`);
    this.name = "DiscoveryItemNotFoundError";
    this.collection = collection;
    this.itemId = itemId;
  }
}

/** A deliberately small interface makes the PT adapter straightforward to fake in tests. */
export type DiscoveryDoubanClient = {
  list: (
    collection: DiscoveryCollectionId | string,
    page?: number,
    limit?: number,
  ) => Promise<DiscoveryCollectionResponse>;
  getDetails?: (itemId: string, mediaType: "movie" | "tv") => Promise<DoubanSubjectDetails>;
  getMedia?: (itemId: string, mediaType: "movie" | "tv") => Promise<DiscoveryMedia>;
  getMediaPoster?: (itemId: string, mediaType: "movie" | "tv") => Promise<DiscoveryPosterAsset>;
  searchMedia?: (query: string, limit?: number) => Promise<DiscoveryMediaSearchResponse>;
  getActorProfile?: (name: string, page?: number, limit?: number) => Promise<DiscoveryActorProfile>;
  getActorAvatar?: (actorId: string) => Promise<DiscoveryPosterAsset>;
  getActorWorkPoster?: (actorId: string, workId: string) => Promise<DiscoveryPosterAsset>;
  getPoster?: (
    collection: DiscoveryCollectionId,
    itemId: string,
    page?: number,
    limit?: number,
  ) => Promise<DiscoveryPosterAsset>;
};

export type DiscoverySearchResult = SearchResponse | ReleaseSummary[];

export type DiscoveryProwlarrClient = {
  search: (intent: ParsedIntent, limit?: number, options?: { signal?: AbortSignal }) => Promise<DiscoverySearchResult>;
  retainReleases?: (ids: string[], expiresAt: number) => void;
  releaseReleases?: (ids: string[]) => void;
  hasRelease?: (id: string) => boolean;
};

export type DiscoveryServiceOptions = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  minIntervalMs?: number;
  /** Accepted for compatibility; the release snapshot size stays fixed. */
  collectionLimit?: number;
};

export type DiscoveryReleaseQueryOptions = {
  forceRefresh?: boolean;
  page?: number;
  signal?: AbortSignal;
  beforeSearch?: () => void;
};

type CachedReleases = {
  response: DiscoveryReleaseResponse;
  expiresAt: number;
  releaseIds: string[];
};

type PendingReleaseWaiter = {
  signal?: AbortSignal;
  beforeSearch?: () => void;
  active: boolean;
};

type PendingReleaseWork = {
  controller: AbortController;
  promise?: Promise<DiscoveryReleaseResponse>;
  waiters: Set<PendingReleaseWaiter>;
  finished: boolean;
};

export type DiscoveryDependencies = {
  douban: DiscoveryDoubanClient;
  prowlarr: DiscoveryProwlarrClient;
};

export type DiscoveryServiceDependencies = DiscoveryDependencies & DiscoveryServiceOptions;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asReleases(result: DiscoverySearchResult): ReleaseSummary[] {
  if (Array.isArray(result)) return result;
  return Array.isArray(result.releases) ? result.releases : [];
}

function releaseId(value: ReleaseSummary): string {
  return typeof value.id === "string" ? value.id : String(value.id);
}

function seeders(value: ReleaseSummary): number {
  const number = typeof value.seeders === "number" ? value.seeders : Number(value.seeders);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function copyRelease(release: ReleaseSummary): ReleaseSummary {
  const evidence = release.evidence;
  return {
    id: releaseId(release),
    title: release.title,
    indexer: release.indexer,
    protocol: release.protocol === "usenet" ? "usenet" : "torrent",
    size: release.size,
    seeders: release.seeders,
    leechers: release.leechers,
    grabs: release.grabs,
    ageDays: release.ageDays,
    categories: Array.isArray(release.categories)
      ? release.categories.filter((category): category is string => typeof category === "string").slice(0, 20)
      : [],
    ...(release.resolution !== undefined ? { resolution: release.resolution } : {}),
    ...(release.codec !== undefined ? { codec: release.codec } : {}),
    ...(release.season !== undefined ? { season: release.season } : {}),
    freeleech: release.freeleech === true,
    ...(release.freeleechState === "yes" || release.freeleechState === "no" || release.freeleechState === "unknown"
      ? { freeleechState: release.freeleechState }
      : {}),
    ...(evidence ? {
      evidence: {
        resolution: evidence.resolution === "upstream" || evidence.resolution === "title_inferred"
          ? evidence.resolution
          : "unknown",
        codec: evidence.codec === "upstream" || evidence.codec === "title_inferred"
          ? evidence.codec
          : "unknown",
        size: evidence.size === "upstream" ? "upstream" : "unknown",
        seeders: evidence.seeders === "upstream" ? "upstream" : "unknown",
        season: evidence.season === "title_inferred" ? "title_inferred" : "unknown",
      },
    } : {}),
  };
}

type AbortReason = Error;

function abortReason(signal?: AbortSignal): AbortReason {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

function cloneReleaseResponse(response: DiscoveryReleaseResponse): DiscoveryReleaseResponse {
  return {
    ...(response.snapshotId ? { snapshotId: response.snapshotId } : {}),
    ...(response.expiresAt ? { expiresAt: response.expiresAt } : {}),
    ...(response.actionableUntil ? { actionableUntil: response.actionableUntil } : {}),
    itemId: response.itemId,
    query: response.query,
    status: response.status,
    checkedAt: response.checkedAt,
    total: response.total,
    releases: response.releases.map(copyRelease),
  };
}

function queryFor(item: DiscoveryMedia, field: "title" | "originalTitle"): string {
  const title = field === "originalTitle" ? item.originalTitle : item.title;
  const base = title?.trim() || item.title.trim();
  return item.year ? `${base} ${item.year}` : base;
}

function mergeReleases(primary: ReleaseSummary[], secondary: ReleaseSummary[] = []): ReleaseSummary[] {
  const seen = new Set<string>();
  const merged: ReleaseSummary[] = [];
  for (const release of [...primary, ...secondary]) {
    if (!isObject(release)) continue;
    const id = releaseId(release);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(copyRelease(release));
  }
  return merged;
}

function statusFor(releases: ReleaseSummary[]): DiscoveryReleaseResponse["status"] {
  if (releases.some((release) => seeders(release) > 0)) return "available";
  if (releases.length > 0) return "possible";
  return "unavailable";
}

function mediaKey(mediaType: "movie" | "tv", itemId: string): string {
  return `${mediaType}:${itemId}`;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function dependenciesFrom(
  first: DiscoveryDependencies | DiscoveryDoubanClient,
  second?: DiscoveryProwlarrClient,
): DiscoveryDependencies {
  if (second) return { douban: first as DiscoveryDoubanClient, prowlarr: second };
  if (isObject(first) && "douban" in first && "prowlarr" in first) {
    const douban = first.douban;
    const prowlarr = first.prowlarr;
    if (isObject(douban) && typeof douban.list === "function" && isObject(prowlarr) && typeof prowlarr.search === "function") {
      return { douban: douban as DiscoveryDoubanClient, prowlarr: prowlarr as DiscoveryProwlarrClient };
    }
  }
  throw new TypeError("DiscoveryService requires Douban and Prowlarr clients");
}

/**
 * Domain service for the discovery surface.  It only previews/searches PT
 * releases; no grab or download operation is reachable from this class.
 */
export class DiscoveryService {
  private readonly douban: DiscoveryDoubanClient;
  private readonly prowlarr: DiscoveryProwlarrClient;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly releaseCache = new Map<string, CachedReleases>();
  private readonly pendingReleases = new Map<string, PendingReleaseWork>();
  private ptQueue: Promise<unknown> = Promise.resolve();
  private lastPtCallAt: number | undefined;

  public constructor(
    dependencies: DiscoveryDependencies,
    options?: DiscoveryServiceOptions,
  );
  public constructor(dependencies: DiscoveryServiceDependencies);
  public constructor(
    douban: DiscoveryDoubanClient,
    prowlarr: DiscoveryProwlarrClient,
    options?: DiscoveryServiceOptions,
  );
  public constructor(
    first: DiscoveryDependencies | DiscoveryServiceDependencies | DiscoveryDoubanClient,
    second?: DiscoveryProwlarrClient | DiscoveryServiceOptions,
    third: DiscoveryServiceOptions = {},
  ) {
    const isOptions = !second || !("search" in second);
    const dependencies = isOptions
      ? dependenciesFrom(first)
      : dependenciesFrom(first, second as DiscoveryProwlarrClient);
    const firstRecord = isObject(first) ? (first as Record<string, unknown>) : undefined;
    const embeddedOptions = firstRecord
      ? {
        ...(typeof firstRecord.now === "function" ? { now: firstRecord.now as () => number } : {}),
        ...(typeof firstRecord.sleep === "function" ? { sleep: firstRecord.sleep as (milliseconds: number) => Promise<void> } : {}),
        ...(typeof firstRecord.minIntervalMs === "number" ? { minIntervalMs: firstRecord.minIntervalMs } : {}),
        ...(typeof firstRecord.collectionLimit === "number" ? { collectionLimit: firstRecord.collectionLimit } : {}),
      }
      : {};
    const options = isOptions
      ? { ...embeddedOptions, ...((second as DiscoveryServiceOptions | undefined) ?? {}) }
      : third;
    this.douban = dependencies.douban;
    this.prowlarr = dependencies.prowlarr;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? PT_QUERY_MIN_INTERVAL_MS);
  }

  public async list(
    collection: DiscoveryCollectionId | string,
    page = 1,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryCollectionResponse> {
    if (!isDiscoveryCollectionId(collection)) throw new UnknownDiscoveryCollectionError(String(collection));
    return this.douban.list(collection, normalizeDiscoveryPage(page), normalizeDiscoveryLimit(limit));
  }

  public getCollection(
    collection: DiscoveryCollectionId | string,
    page = 1,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryCollectionResponse> {
    return this.list(collection, page, limit);
  }

  public async getReleases(
    collection: DiscoveryCollectionId | string,
    itemId: string,
    limit = DEFAULT_DISCOVERY_LIMIT,
    options: DiscoveryReleaseQueryOptions = {},
  ): Promise<DiscoveryReleaseResponse> {
    if (!isDiscoveryCollectionId(collection)) throw new UnknownDiscoveryCollectionError(String(collection));
    // `limit` remains part of the public route for compatibility with the
    // collection page size. Release candidates are deliberately fetched as a
    // bounded snapshot and paginated locally by the inspector.
    const boundedLimit = normalizeDiscoveryLimit(limit);
    const page = normalizeDiscoveryPage(options.page);
    const normalizedItemId = String(itemId);
    const item = await this.findItem(collection, normalizedItemId, page, boundedLimit);
    return this.getMediaReleases(item.mediaType, item.id, boundedLimit, options, item);
  }

  public async getMediaReleases(
    mediaType: "movie" | "tv",
    itemId: string,
    limit = DEFAULT_DISCOVERY_LIMIT,
    options: DiscoveryReleaseQueryOptions = {},
    knownMedia?: DiscoveryMedia,
  ): Promise<DiscoveryReleaseResponse> {
    const boundedLimit = normalizeDiscoveryLimit(limit);
    const normalizedItemId = String(itemId);
    const key = mediaKey(mediaType, normalizedItemId);
    options.signal?.throwIfAborted();
    this.evictExpiredSnapshots();
    if (options.forceRefresh) this.removeSnapshot(key);
    const cached = this.releaseCache.get(key);
    if (!options.forceRefresh && cached && cached.expiresAt > this.now()) {
      this.releaseCache.delete(key);
      this.releaseCache.set(key, cached);
      if (this.prowlarr.hasRelease && cached.response.releases.some((release) => !this.prowlarr.hasRelease!(release.id))) {
        cached.response.actionableUntil = new Date(this.now()).toISOString();
      }
      return cloneReleaseResponse(cached.response);
    }

    const existing = this.pendingReleases.get(key);
    if (existing && !existing.finished && !existing.controller.signal.aborted) {
      return this.waitForPending(existing, options);
    }
    if (existing && this.pendingReleases.get(key) === existing) {
      this.pendingReleases.delete(key);
    }

    const work: PendingReleaseWork = {
      controller: new AbortController(),
      waiters: new Set(),
      finished: false,
    };
    this.pendingReleases.set(key, work);
    const operation = this.queryReleases(mediaType, normalizedItemId, boundedLimit, key, knownMedia, {
      ...(options.signal ? { signal: work.controller.signal } : {}),
      beforeSearch: () => this.runBeforeSearch(work),
    });
    work.promise = operation;
    void operation.then(
      () => this.finishPending(key, work),
      () => this.finishPending(key, work),
    );
    return this.waitForPending(work, options);
  }

  public clearReleaseCache(): void {
    for (const key of [...this.releaseCache.keys()]) this.removeSnapshot(key);
  }

  private removeSnapshot(key: string): void {
    const cached = this.releaseCache.get(key);
    if (!cached) return;
    this.releaseCache.delete(key);
    this.prowlarr.releaseReleases?.(cached.releaseIds);
  }

  private evictExpiredSnapshots(): void {
    const now = this.now();
    for (const [key, value] of this.releaseCache) {
      if (value.expiresAt <= now) this.removeSnapshot(key);
    }
  }

  private finishPending(key: string, work: PendingReleaseWork): void {
    work.finished = true;
    if (this.pendingReleases.get(key) === work) this.pendingReleases.delete(key);
  }

  private runBeforeSearch(work: PendingReleaseWork): void {
    const waiter = [...work.waiters].find((candidate) => (
      candidate.active && !candidate.signal?.aborted && candidate.beforeSearch
    ));
    waiter?.beforeSearch?.();
  }

  private waitForPending(
    work: PendingReleaseWork,
    options: DiscoveryReleaseQueryOptions,
  ): Promise<DiscoveryReleaseResponse> {
    options.signal?.throwIfAborted();
    const operation = work.promise;
    if (!operation) return Promise.reject(new Error("Discovery release operation unavailable"));

    const waiter: PendingReleaseWaiter = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.beforeSearch ? { beforeSearch: options.beforeSearch } : {}),
      active: true,
    };
    work.waiters.add(waiter);

    return new Promise<DiscoveryReleaseResponse>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        waiter.active = false;
        work.waiters.delete(waiter);
        if (!work.finished && work.waiters.size === 0) work.controller.abort();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortReason(options.signal));
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      void operation.then(
        (response) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(cloneReleaseResponse(response));
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  private async findItem(
    collection: DiscoveryCollectionId | string,
    itemId: string,
    page: number,
    limit: number,
  ): Promise<DiscoveryItem> {
    if (!isDiscoveryCollectionId(collection)) throw new UnknownDiscoveryCollectionError(String(collection));
    const response = await this.douban.list(
      collection,
      normalizeDiscoveryPage(page),
      normalizeDiscoveryLimit(limit),
    );
    const item = response.items.find((candidate) => String(candidate.id) === String(itemId));
    if (!item) throw new DiscoveryItemNotFoundError(collection, String(itemId));
    return item;
  }

  public async getDetails(
    collection: DiscoveryCollectionId | string,
    itemId: string,
    page = 1,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryItemDetails> {
    const item = await this.findItem(collection, itemId, page, limit);
    if (!this.douban.getDetails) throw new Error("Discovery details unavailable");
    const details = await this.douban.getDetails(item.id, item.mediaType);
    return {
      itemId: item.id,
      actors: [...details.actors],
      directors: [...details.directors],
    };
  }

  public async getMediaDetails(
    mediaType: "movie" | "tv",
    itemId: string,
  ): Promise<DiscoveryItemDetails> {
    if (!this.douban.getDetails) throw new Error("Discovery details unavailable");
    const details = await this.douban.getDetails(itemId, mediaType);
    return {
      itemId: details.itemId,
      actors: details.actors.map((actor) => ({ ...actor })),
      directors: [...details.directors],
    };
  }

  public async getMedia(mediaType: "movie" | "tv", itemId: string): Promise<DiscoveryMedia> {
    if (!this.douban.getMedia) throw new Error("Discovery media unavailable");
    const media = await this.douban.getMedia(itemId, mediaType);
    return {
      id: media.id, title: media.title, mediaType: media.mediaType,
      genres: [...media.genres], summary: media.summary, sourceUrl: media.sourceUrl,
      ...(media.originalTitle ? { originalTitle: media.originalTitle } : {}),
      ...(media.year ? { year: media.year } : {}),
      ...(media.rating !== undefined ? { rating: media.rating } : {}),
      ...(media.ratingCount !== undefined ? { ratingCount: media.ratingCount } : {}),
      ...(media.posterUrl ? { posterUrl: media.posterUrl } : {}),
    };
  }

  public async getMediaPoster(
    mediaType: "movie" | "tv",
    itemId: string,
  ): Promise<DiscoveryPosterAsset> {
    if (!this.douban.getMediaPoster) throw new Error("Discovery media poster unavailable");
    return this.douban.getMediaPoster(itemId, mediaType);
  }

  public async searchMedia(
    query: string,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryMediaSearchResponse> {
    if (!this.douban.searchMedia) throw new Error("Discovery media search unavailable");
    return this.douban.searchMedia(query, normalizeDiscoveryLimit(limit));
  }

  public async getActorProfile(
    name: string,
    page = 1,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryActorProfile> {
    if (!this.douban.getActorProfile) throw new Error("Discovery actor profile unavailable");
    const profile = await this.douban.getActorProfile(
      name,
      normalizeDiscoveryPage(page),
      normalizeDiscoveryLimit(limit),
    );
    return {
      id: profile.id,
      name: profile.name,
      ...(profile.latinName ? { latinName: profile.latinName } : {}),
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      intro: profile.intro,
      works: profile.works.map((work) => ({ ...work })),
      page: profile.page,
      pageSize: profile.pageSize,
      total: profile.total,
      hasNext: profile.hasNext,
    };
  }

  public async getActorAvatar(actorId: string): Promise<DiscoveryPosterAsset> {
    if (!this.douban.getActorAvatar) throw new Error("Discovery actor avatar unavailable");
    return this.douban.getActorAvatar(actorId);
  }

  public async getActorWorkPoster(actorId: string, workId: string): Promise<DiscoveryPosterAsset> {
    if (!this.douban.getActorWorkPoster) throw new Error("Discovery actor work poster unavailable");
    return this.douban.getActorWorkPoster(actorId, workId);
  }

  public async getPoster(
    collection: DiscoveryCollectionId | string,
    itemId: string,
    page = 1,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryPosterAsset> {
    const item = await this.findItem(collection, itemId, page, limit);
    if (!this.douban.getPoster) throw new Error("Discovery poster unavailable");
    return this.douban.getPoster(collection as DiscoveryCollectionId, item.id, page, limit);
  }

  private async queryReleases(
    mediaType: "movie" | "tv",
    itemId: string,
    // The requested page limit never shrinks the bounded release snapshot;
    // it is kept in the signature for the public getMediaReleases route.
    _limit: number,
    key: string,
    knownMedia?: DiscoveryMedia,
    options: DiscoveryReleaseQueryOptions = {},
  ): Promise<DiscoveryReleaseResponse> {
    // The media summary is always sourced from an allowlisted Douban response
    // or from a server-known collection item; title/year data never comes
    // from the browser.
    const item = knownMedia ?? await this.douban.getMedia?.(itemId, mediaType);
    if (!item) throw new Error("Discovery media unavailable");

    const primaryQuery = item.originalTitle ? queryFor(item, "originalTitle") : queryFor(item, "title");
    const primary = await this.enqueuePtSearch(primaryQuery, DISCOVERY_RELEASE_FETCH_LIMIT, options);
    let releases = mergeReleases(asReleases(primary));
    let selectedQuery = primaryQuery;

    // A non-empty original-title query is sufficient; use the local title as
    // a fallback only when it returned no releases.  This is the sole reason
    // a request can make two PT upstream calls.
    if (item.originalTitle && releases.length === 0) {
      const fallbackQuery = queryFor(item, "title");
      const fallback = await this.enqueuePtSearch(fallbackQuery, DISCOVERY_RELEASE_FETCH_LIMIT, options);
      releases = mergeReleases(releases, asReleases(fallback));
      selectedQuery = fallbackQuery;
    }

    options.signal?.throwIfAborted();
    const status = statusFor(releases);
    const expiresAt = this.now() + RELEASE_CACHE_TTL_MS;
    const snapshotReleases = releases.slice(0, DISCOVERY_RELEASE_FETCH_LIMIT);
    const releaseIds = [...new Set(snapshotReleases.map(releaseId))];
    this.prowlarr.retainReleases?.(releaseIds, expiresAt);
    const response: DiscoveryReleaseResponse = {
      snapshotId: randomUUID(),
      expiresAt: new Date(expiresAt).toISOString(),
      actionableUntil: new Date(expiresAt).toISOString(),
      itemId,
      query: selectedQuery,
      status,
      checkedAt: new Date(this.now()).toISOString(),
      total: releases.length,
      releases: snapshotReleases,
    };
    this.removeSnapshot(key);
    this.releaseCache.set(key, { response, expiresAt, releaseIds });
    while (this.releaseCache.size > 200) {
      const oldest = this.releaseCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.removeSnapshot(oldest);
    }
    return response;
  }

  /** Serialize all Prowlarr calls and enforce the inter-call interval. */
  private enqueuePtSearch(query: string, limit: number, options: DiscoveryReleaseQueryOptions = {}): Promise<DiscoverySearchResult> {
    let result: Promise<DiscoverySearchResult>;
    const previous = this.ptQueue;
    result = previous.then(async () => {
      options.signal?.throwIfAborted();
      if (this.lastPtCallAt !== undefined) {
        const elapsed = this.now() - this.lastPtCallAt;
        const remaining = this.minIntervalMs - elapsed;
        if (remaining > 0) await this.sleep(remaining);
      }
      options.signal?.throwIfAborted();
      options.beforeSearch?.();
      this.lastPtCallAt = this.now();
      return options.signal
        ? this.prowlarr.search({ searchTerm: query }, limit, { signal: options.signal })
        : this.prowlarr.search({ searchTerm: query }, limit);
    });
    this.ptQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
