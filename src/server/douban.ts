import type { DiscoveryCollectionId, DiscoveryCollectionResponse, DiscoveryItem } from "../shared/contracts.js";

/**
 * The collection ids accepted by the public discovery surface and their
 * corresponding ids in Douban's public subject-collection API.
 *
 * Keep this map closed.  In particular, never accept an upstream collection
 * id from a request: doing so would turn a small allowlisted client into a
 * general-purpose URL proxy.
 */
export const DOUBAN_COLLECTIONS: Readonly<Record<DiscoveryCollectionId, string>> = Object.freeze({
  "movie-hot": "movie_real_time_hotest",
  "movie-weekly": "movie_weekly_best",
  "tv-hot": "tv_real_time_hotest",
  "tv-weekly": "tv_global_best_weekly",
  top250: "movie_top250",
});

/** Backwards-compatible name for callers that prefer an explicit map name. */
export const COLLECTION_UPSTREAM_IDS = DOUBAN_COLLECTIONS;

export const DOUBAN_API_ORIGIN = "https://m.douban.com";
export const DOUBAN_API_PATH = "/rexxar/api/v2/subject_collection";
export const DOUBAN_SOURCE_URL_PREFIX = "https://movie.douban.com/subject/";
export const DEFAULT_DOUBAN_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_DISCOVERY_LIMIT = 10;
export const MIN_DISCOVERY_LIMIT = 1;
export const MAX_DISCOVERY_LIMIT = 20;

/** Public text bounds.  These are deliberately conservative for a compact API. */
export const DISCOVERY_TEXT_LIMITS = {
  title: 120,
  originalTitle: 160,
  summary: 320,
  genre: 80,
  genres: 6,
} as const;

export type DoubanFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class DoubanUpstreamError extends Error {
  public readonly cause?: unknown;

  public constructor(message = "Douban upstream service unavailable", cause?: unknown) {
    super(message);
    this.name = "DoubanUpstreamError";
    this.cause = cause;
  }
}

export class UnknownDiscoveryCollectionError extends Error {
  public readonly collection: string;

  public constructor(collection: string) {
    super(`Unknown discovery collection: ${collection}`);
    this.name = "UnknownDiscoveryCollectionError";
    this.collection = collection;
  }
}

/** Alias retained for route code that uses the shorter name. */
export class UnknownCollectionError extends UnknownDiscoveryCollectionError {}

export type DoubanClientOptions = {
  fetchImpl?: DoubanFetchLike;
  now?: () => number;
  ttlMs?: number;
  cacheTtlMs?: number;
};

type JsonObject = Record<string, unknown>;

type CachedCollection = {
  response: DiscoveryCollectionResponse;
  expiresAt: number;
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function valueFor(object: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_DISCOVERY_LIMIT;
  return Math.min(MAX_DISCOVERY_LIMIT, Math.max(MIN_DISCOVERY_LIMIT, Math.floor(parsed)));
}

/** Remove markup/control characters and collapse all whitespace. */
export function cleanDoubanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let text = String(value)
    // Script/style payloads are not descriptive text and should never be
    // allowed to survive a tag-only removal pass.
    .replace(/<\s*(?:script|style)[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  // Decode the small set of entities commonly emitted by the mobile API.
  // This is intentionally not a general HTML parser: the source is treated
  // as untrusted text and the output remains bounded plain text.
  text = text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/giu, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&nbsp;": return " ";
      case "&apos;":
      case "&#39;": return "'";
      default: return entity;
    }
  });
  text = text.replace(/&#x([\da-f]{1,6});/giu, (_match, hex: string) => {
    const codePoint = Number.parseInt(hex, 16);
    return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : "";
  });
  text = text.replace(/&#(\d{1,7});/gu, (_match, digits: string) => {
    const codePoint = Number.parseInt(digits, 10);
    return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : "";
  });

  // Entity decoding can reveal markup that was encoded in the upstream
  // payload.  Remove it as well, then normalize whitespace introduced by the
  // removal.
  text = text.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();

  return text.slice(0, Math.max(0, maxLength)).trim();
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = numberValue(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = nonNegativeNumber(value);
  if (number === undefined) return undefined;
  const integer = Math.floor(number);
  return integer > 0 ? integer : undefined;
}

function yearValue(raw: JsonObject): string | undefined {
  const direct = positiveInteger(valueFor(raw, "year", "releaseYear"));
  if (direct !== undefined && direct >= 1800 && direct <= 3000) return String(direct);

  const directText = cleanDoubanText(valueFor(raw, "year", "releaseYear"), 20);
  const directMatch = /(?:^|\D)((?:18|19|20|21|22|23|24|25|26|27|28|29)\d{2})(?:\D|$)/u.exec(directText);
  if (directMatch) return directMatch[1];

  const metadata = cleanDoubanText(valueFor(raw, "card_subtitle", "cardSubtitle", "subtitle"), 240);
  const match = /(?:^|\D)((?:18|19|20|21|22|23|24|25|26|27|28|29)\d{2})(?:\D|$)/u.exec(metadata);
  return match?.[1];
}

function textFrom(value: unknown, maxLength: number): string {
  return cleanDoubanText(value, maxLength);
}

function ratingValue(raw: JsonObject): number | undefined {
  const rating = valueFor(raw, "rating", "score");
  const candidate = isObject(rating) ? valueFor(rating, "value", "score") : rating;
  const number = nonNegativeNumber(candidate);
  if (number === undefined || number > 10) return undefined;
  return Math.round(number * 100) / 100;
}

function ratingCountValue(raw: JsonObject): number | undefined {
  const rating = valueFor(raw, "rating");
  const candidate = isObject(rating) ? valueFor(rating, "count", "ratingCount") : undefined;
  const fallback = candidate === undefined ? valueFor(raw, "rating_count", "ratingCount") : candidate;
  const number = nonNegativeNumber(fallback);
  return number === undefined ? undefined : Math.floor(number);
}

function splitGenreText(value: string): string[] {
  return value
    .split(/[\/,、|·]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

const KNOWN_GENRES = new Set([
  "剧情", "喜剧", "动作", "爱情", "科幻", "动画", "悬疑", "惊悚", "恐怖", "犯罪",
  "同性", "音乐", "歌舞", "传记", "历史", "战争", "西部", "奇幻", "冒险", "灾难",
  "武侠", "古装", "运动", "家庭", "儿童", "纪录片", "短片", "真人秀"
]);

function metadataGenres(raw: JsonObject): string[] {
  const metadata = textFrom(valueFor(raw, "card_subtitle", "cardSubtitle", "info"), 300);
  return metadata
    .split(/[\/、,|·\s]+/u)
    .map((part) => part.trim())
    .filter((part) => KNOWN_GENRES.has(part));
}

function genresValue(raw: JsonObject): string[] {
  const directSource = valueFor(raw, "genres", "genre");
  const source = directSource ?? valueFor(raw, "tags") ?? metadataGenres(raw);
  const values: unknown[] = Array.isArray(source)
    ? source
    : typeof source === "string"
      ? splitGenreText(source)
      : source === undefined
        ? []
        : [source];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const genre = textFrom(isObject(value) ? valueFor(value, "name", "title") : value, DISCOVERY_TEXT_LIMITS.genre);
    if (!genre || seen.has(genre) || (directSource === undefined && !KNOWN_GENRES.has(genre))) continue;
    seen.add(genre);
    result.push(genre);
    if (result.length >= DISCOVERY_TEXT_LIMITS.genres) break;
  }
  if (result.length === 0 && directSource === undefined) {
    for (const genre of metadataGenres(raw)) {
      if (seen.has(genre)) continue;
      seen.add(genre);
      result.push(genre);
      if (result.length >= DISCOVERY_TEXT_LIMITS.genres) break;
    }
  }
  return result;
}

function summaryValue(raw: JsonObject): string {
  const direct = textFrom(
    valueFor(raw, "summary", "short_description", "shortDescription", "intro", "description", "recommended_reason"),
    DISCOVERY_TEXT_LIMITS.summary,
  );
  if (direct) return direct;
  const comments = valueFor(raw, "comments");
  if (Array.isArray(comments)) {
    for (const comment of comments) {
      const text = textFrom(isObject(comment) ? valueFor(comment, "content", "text", "comment") : comment, DISCOVERY_TEXT_LIMITS.summary);
      if (text) return text;
    }
  }
  const metadata = textFrom(valueFor(raw, "info", "card_subtitle", "cardSubtitle"), DISCOVERY_TEXT_LIMITS.summary);
  const segments = metadata.split("/").map((part) => part.trim()).filter(Boolean);
  return segments.length > 2 ? segments.slice(-2).join(" · ") : metadata;
}

function numericId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = String(value).trim();
  return /^\d{1,16}$/u.test(id) ? id : undefined;
}

function rankValue(raw: JsonObject, index: number): number {
  const rank = positiveInteger(valueFor(raw, "rank", "position", "index"));
  return rank ?? index + 1;
}

function itemFromRaw(raw: unknown, index: number, mediaType: "movie" | "tv"): DiscoveryItem | undefined {
  if (!isObject(raw)) return undefined;
  const id = numericId(valueFor(raw, "id", "subject_id", "subjectId"));
  if (!id) return undefined;

  const title = textFrom(valueFor(raw, "title", "name"), DISCOVERY_TEXT_LIMITS.title);
  if (!title) return undefined;
  const originalTitle = textFrom(
    valueFor(raw, "original_title", "originalTitle", "original_name", "originalName"),
    DISCOVERY_TEXT_LIMITS.originalTitle,
  );
  const summary = summaryValue(raw);
  const year = yearValue(raw);
  const rating = ratingValue(raw);
  const ratingCount = ratingCountValue(raw);
  const item: DiscoveryItem = {
    id,
    title,
    rank: rankValue(raw, index),
    mediaType,
    genres: genresValue(raw),
    summary,
    sourceUrl: `${DOUBAN_SOURCE_URL_PREFIX}${id}/`,
  };
  if (originalTitle) item.originalTitle = originalTitle;
  if (year !== undefined) item.year = year;
  if (rating !== undefined) item.rating = rating;
  if (ratingCount !== undefined) item.ratingCount = ratingCount;
  return item;
}

/**
 * Convert the mobile API payload into the intentionally small shared
 * discovery contract.  In particular, cover/picture/url fields are never
 * copied into the returned item.
 */
export function parseDoubanCollection(
  payload: unknown,
  collection: DiscoveryCollectionId,
  now = Date.now,
): DiscoveryCollectionResponse {
  const itemsValue = isObject(payload)
    ? valueFor(payload, "subject_collection_items", "items")
    : payload;
  if (!Array.isArray(itemsValue)) throw new DoubanUpstreamError("Invalid Douban response");
  const mediaType: "movie" | "tv" = collection === "tv-hot" || collection === "tv-weekly" ? "tv" : "movie";
  const items = itemsValue
    .map((item, index) => itemFromRaw(item, index, mediaType))
    .filter((item): item is DiscoveryItem => item !== undefined);
  return {
    collection,
    updatedAt: new Date(now()).toISOString(),
    stale: false,
    items,
  };
}

function cloneResponse(response: DiscoveryCollectionResponse, stale: boolean): DiscoveryCollectionResponse {
  return {
    collection: response.collection,
    updatedAt: response.updatedAt,
    stale,
    items: response.items.map((item) => ({
      ...item,
      genres: [...item.genres],
    })),
  };
}

function collectionKey(collection: DiscoveryCollectionId, limit: number): string {
  return `${collection}:${limit}`;
}

export function isDiscoveryCollectionId(value: string): value is DiscoveryCollectionId {
  return Object.prototype.hasOwnProperty.call(DOUBAN_COLLECTIONS, value);
}

/**
 * Small, dependency-injected client for the five public Douban collections.
 * It owns both the two-hour cache and in-flight request coalescing so callers
 * never need to coordinate duplicate requests themselves.
 */
export class DoubanClient {
  private readonly fetchImpl: DoubanFetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CachedCollection>();
  private readonly pending = new Map<string, Promise<DiscoveryCollectionResponse>>();

  public constructor(options?: DoubanClientOptions);
  public constructor(fetchImpl: DoubanFetchLike, now?: () => number);
  public constructor(
    optionsOrFetch: DoubanClientOptions | DoubanFetchLike = {},
    injectedNow?: () => number,
  ) {
    const options: DoubanClientOptions = typeof optionsOrFetch === "function"
      ? { fetchImpl: optionsOrFetch, ...(injectedNow ? { now: injectedNow } : {}) }
      : optionsOrFetch;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(0, options.ttlMs ?? options.cacheTtlMs ?? DEFAULT_DOUBAN_CACHE_TTL_MS);
  }

  public async getCollection(collection: DiscoveryCollectionId | string, limit = DEFAULT_DISCOVERY_LIMIT): Promise<DiscoveryCollectionResponse> {
    if (!isDiscoveryCollectionId(collection)) throw new UnknownDiscoveryCollectionError(String(collection));
    const boundedLimit = clampLimit(limit);
    const key = collectionKey(collection, boundedLimit);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cloneResponse(cached.response, false);

    const existing = this.pending.get(key);
    if (existing) return existing.then((response) => cloneResponse(response, response.stale));

    const operation = this.requestCollection(collection, boundedLimit, cached);
    this.pending.set(key, operation);
    try {
      const response = await operation;
      return cloneResponse(response, response.stale);
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }

  /** Primary list-shaped API used by the discovery routes. */
  public list(collection: DiscoveryCollectionId | string, limit = DEFAULT_DISCOVERY_LIMIT): Promise<DiscoveryCollectionResponse> {
    return this.getCollection(collection, limit);
  }

  /** Alias for callers that use fetch terminology. */
  public fetch(collection: DiscoveryCollectionId | string, limit = DEFAULT_DISCOVERY_LIMIT): Promise<DiscoveryCollectionResponse> {
    return this.getCollection(collection, limit);
  }

  /** Alias used by discovery-oriented callers. */
  public fetchCollection(collection: DiscoveryCollectionId | string, limit = DEFAULT_DISCOVERY_LIMIT): Promise<DiscoveryCollectionResponse> {
    return this.getCollection(collection, limit);
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public get cacheSize(): number {
    return this.cache.size;
  }

  private async requestCollection(
    collection: DiscoveryCollectionId,
    limit: number,
    oldCache?: CachedCollection,
  ): Promise<DiscoveryCollectionResponse> {
    const upstreamId = DOUBAN_COLLECTIONS[collection];
    // Construct only from the closed map and bounded integer.  No request
    // parameter can supply a host, path, or query parameter of its own.
    const url = `${DOUBAN_API_ORIGIN}${DOUBAN_API_PATH}/${upstreamId}/items?start=0&count=${limit}&items_only=1`;
    const referer = `${DOUBAN_API_ORIGIN}/subject_collection/${upstreamId}`;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json,text/plain,*/*",
          Referer: referer,
          // Douban serves this public collection endpoint to its regular web
          // client and rejects generic server-library user agents. No cookie,
          // account state, or client fingerprint is sent.
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        },
      });
      if (!response.ok) throw new DoubanUpstreamError();
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new DoubanUpstreamError("Invalid Douban response", error);
      }
      const parsed = parseDoubanCollection(payload, collection, this.now);
      this.cache.set(collectionKey(collection, limit), {
        response: parsed,
        expiresAt: this.now() + this.ttlMs,
      });
      return parsed;
    } catch (error) {
      if (oldCache) return cloneResponse(oldCache.response, true);
      if (error instanceof DoubanUpstreamError) throw error;
      throw new DoubanUpstreamError(undefined, error);
    }
  }
}

export function normalizeDiscoveryLimit(value: unknown): number {
  return clampLimit(value);
}
