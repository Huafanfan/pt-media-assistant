import type {
  DiscoveryCollectionId,
  DiscoveryCollectionResponse,
  DiscoveryItem,
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
  UnknownDiscoveryCollectionError,
} from "./douban.js";

export const PT_QUERY_MIN_INTERVAL_MS = 1_200;
export const AVAILABLE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const UNAVAILABLE_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

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
export type DiscoveryDoubanClient = Pick<DoubanClient, "list"> | {
  list: (collection: DiscoveryCollectionId | string, limit?: number) => Promise<DiscoveryCollectionResponse>;
};

export type DiscoverySearchResult = SearchResponse | ReleaseSummary[];

export type DiscoveryProwlarrClient = {
  search: (intent: ParsedIntent, limit?: number) => Promise<DiscoverySearchResult>;
};

export type DiscoveryServiceOptions = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  minIntervalMs?: number;
  collectionLimit?: number;
};

type CachedReleases = {
  response: DiscoveryReleaseResponse;
  expiresAt: number;
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
  return {
    ...release,
    categories: Array.isArray(release.categories) ? [...release.categories] : [],
  };
}

function cloneReleaseResponse(response: DiscoveryReleaseResponse, limit?: number): DiscoveryReleaseResponse {
  const boundedLimit = limit === undefined ? undefined : normalizeDiscoveryLimit(limit);
  const releases = boundedLimit === undefined
    ? response.releases
    : response.releases.slice(0, boundedLimit);
  return {
    itemId: response.itemId,
    query: response.query,
    status: response.status,
    checkedAt: response.checkedAt,
    total: response.total,
    releases: releases.map(copyRelease),
  };
}

function queryFor(item: DiscoveryItem, field: "title" | "originalTitle"): string {
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
  private readonly collectionLimit: number;
  private readonly releaseCache = new Map<string, CachedReleases>();
  private readonly pendingReleases = new Map<string, Promise<DiscoveryReleaseResponse>>();
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
    this.collectionLimit = normalizeDiscoveryLimit(options.collectionLimit ?? DEFAULT_DISCOVERY_LIMIT);
  }

  public async list(collection: DiscoveryCollectionId | string, limit = DEFAULT_DISCOVERY_LIMIT): Promise<DiscoveryCollectionResponse> {
    if (!isDiscoveryCollectionId(collection)) throw new UnknownDiscoveryCollectionError(String(collection));
    return this.douban.list(collection, normalizeDiscoveryLimit(limit));
  }

  public getCollection(collection: DiscoveryCollectionId | string, limit = DEFAULT_DISCOVERY_LIMIT): Promise<DiscoveryCollectionResponse> {
    return this.list(collection, limit);
  }

  public async getReleases(
    collection: DiscoveryCollectionId | string,
    itemId: string,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryReleaseResponse> {
    if (!isDiscoveryCollectionId(collection)) throw new UnknownDiscoveryCollectionError(String(collection));
    const boundedLimit = normalizeDiscoveryLimit(limit);
    const normalizedItemId = String(itemId);
    const key = `${collection}:${normalizedItemId}:${boundedLimit}`;
    const cached = this.releaseCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cloneReleaseResponse(cached.response, boundedLimit);

    const existing = this.pendingReleases.get(key);
    if (existing) return existing.then((response) => cloneReleaseResponse(response, boundedLimit));

    const operation = this.queryReleases(collection, normalizedItemId, boundedLimit, key, cached);
    this.pendingReleases.set(key, operation);
    try {
      const response = await operation;
      return cloneReleaseResponse(response, boundedLimit);
    } finally {
      if (this.pendingReleases.get(key) === operation) this.pendingReleases.delete(key);
    }
  }

  public clearReleaseCache(): void {
    this.releaseCache.clear();
  }

  private async queryReleases(
    collection: DiscoveryCollectionId,
    itemId: string,
    limit: number,
    key: string,
    oldCache?: CachedReleases,
  ): Promise<DiscoveryReleaseResponse> {
    // Fetch the collection only after a release-cache miss.  The item lookup
    // is intentionally done against the allowlisted Douban response rather
    // than accepting title/year data from the browser.
    const collectionResponse = await this.douban.list(collection, this.collectionLimit);
    const item = collectionResponse.items.find((candidate) => String(candidate.id) === itemId);
    if (!item) throw new DiscoveryItemNotFoundError(collection, itemId);

    const primaryQuery = item.originalTitle ? queryFor(item, "originalTitle") : queryFor(item, "title");
    const primary = await this.enqueuePtSearch(primaryQuery, limit);
    let releases = mergeReleases(asReleases(primary));
    let selectedQuery = primaryQuery;

    // A non-empty original-title query is sufficient; use the local title as
    // a fallback only when it returned no releases.  This is the sole reason
    // a request can make two PT upstream calls.
    if (item.originalTitle && releases.length === 0) {
      const fallbackQuery = queryFor(item, "title");
      const fallback = await this.enqueuePtSearch(fallbackQuery, limit);
      releases = mergeReleases(releases, asReleases(fallback));
      selectedQuery = fallbackQuery;
    }

    const status = statusFor(releases);
    const response: DiscoveryReleaseResponse = {
      itemId,
      query: selectedQuery,
      status,
      checkedAt: new Date(this.now()).toISOString(),
      total: releases.length,
      releases: releases.slice(0, limit),
    };
    const ttl = status === "unavailable" ? UNAVAILABLE_CACHE_TTL_MS : AVAILABLE_CACHE_TTL_MS;
    this.releaseCache.set(key, { response, expiresAt: this.now() + ttl });
    return response;
  }

  /** Serialize all Prowlarr calls and enforce the inter-call interval. */
  private enqueuePtSearch(query: string, limit: number): Promise<DiscoverySearchResult> {
    let result: Promise<DiscoverySearchResult>;
    const previous = this.ptQueue;
    result = previous.then(async () => {
      if (this.lastPtCallAt !== undefined) {
        const elapsed = this.now() - this.lastPtCallAt;
        const remaining = this.minIntervalMs - elapsed;
        if (remaining > 0) await this.sleep(remaining);
      }
      this.lastPtCallAt = this.now();
      return this.prowlarr.search({ searchTerm: query }, limit);
    });
    this.ptQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
