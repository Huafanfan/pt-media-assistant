import type {
  DiscoveryCollectionId,
  DiscoveryCollectionResponse,
  DiscoveryActor,
  DiscoveryActorProfile,
  DiscoveryActorWork,
  DiscoveryMedia,
  DiscoveryMediaSearchResponse,
  DiscoveryItem,
  DiscoveryItemDetails,
} from "../shared/contracts.js";

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
export const DOUBAN_SUGGEST_ORIGIN = "https://movie.douban.com";
export const DOUBAN_API_PATH = "/rexxar/api/v2/subject_collection";
export const DOUBAN_SUBJECT_API_PATH = "/rexxar/api/v2";
export const DOUBAN_SOURCE_URL_PREFIX = "https://movie.douban.com/subject/";
export const DEFAULT_DOUBAN_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_DISCOVERY_LIMIT = 10;
export const MIN_DISCOVERY_LIMIT = 1;
export const MAX_DISCOVERY_LIMIT = 20;
export const MIN_DISCOVERY_PAGE = 1;
export const MAX_DISCOVERY_PAGE = 100;
export const DISCOVERY_CAST_LIMIT = 12;
export const DISCOVERY_NAME_LIMIT = 80;
export const DISCOVERY_ACTOR_INTRO_LIMIT = 600;
export const DISCOVERY_ROLE_LIMIT = 80;
export const MAX_DISCOVERY_POSTER_BYTES = 4 * 1024 * 1024;
const DISCOVERY_POSTER_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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

export type DiscoveryPosterAsset = {
  body: Uint8Array;
  contentType: string;
};

export type DoubanSubjectDetails = DiscoveryItemDetails & {
  posterSource?: string;
  media?: DoubanMediaDetails;
};

export type DoubanMediaDetails = DiscoveryMedia & {
  posterSource?: string;
};

export type DoubanActorProfile = DiscoveryActorProfile & {
  avatarSource?: string;
};

type CachedDetails = {
  response: DoubanSubjectDetails;
  expiresAt: number;
};

type CachedPoster = {
  asset: DiscoveryPosterAsset;
  expiresAt: number;
};

type CachedActorProfile = {
  response: DoubanActorProfile;
  expiresAt: number;
};

type CachedMediaSearch = {
  response: DiscoveryMediaSearchResponse;
  expiresAt: number;
};

type DoubanActorIdentity = {
  id: string;
  celebrityId: string;
  name: string;
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

function clampPage(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return MIN_DISCOVERY_PAGE;
  return Math.min(MAX_DISCOVERY_PAGE, Math.max(MIN_DISCOVERY_PAGE, Math.floor(parsed)));
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

function safeImageSource(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !/^img\d+\.doubanio\.com$/iu.test(url.hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function posterSourceValue(raw: JsonObject): string | undefined {
  const pic = valueFor(raw, "pic");
  if (isObject(pic)) {
    const source = safeImageSource(valueFor(pic, "normal", "large"));
    if (source) return source;
  }
  const cover = valueFor(raw, "cover");
  if (isObject(cover)) {
    const source = safeImageSource(valueFor(cover, "url", "image"));
    if (source) return source;
  }
  return safeImageSource(valueFor(raw, "cover_url", "coverUrl"));
}

function collectionItems(payload: unknown): JsonObject[] {
  const value = isObject(payload) ? valueFor(payload, "subject_collection_items", "items") : payload;
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function posterPath(collection: DiscoveryCollectionId, itemId: string, page: number, pageSize: number): string {
  return `/api/discovery/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(itemId)}/poster?page=${page}&limit=${pageSize}`;
}

function mediaPosterPath(mediaType: "movie" | "tv", itemId: string): string {
  return `/api/discovery/media/${encodeURIComponent(mediaType)}/${encodeURIComponent(itemId)}/poster`;
}

function actorAvatarPath(actorId: string): string {
  return `/api/discovery/actors/${encodeURIComponent(actorId)}/avatar`;
}

function mediaKey(mediaType: "movie" | "tv", itemId: string): string {
  return `${mediaType}:${itemId}`;
}

function rankValue(raw: JsonObject, index: number, offset: number): number {
  const rank = positiveInteger(valueFor(raw, "rank", "position", "index"));
  return rank ?? offset + index + 1;
}

function itemFromRaw(
  raw: unknown,
  index: number,
  mediaType: "movie" | "tv",
  collection: DiscoveryCollectionId,
  page: number,
  pageSize: number,
): DiscoveryItem | undefined {
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
  const posterSource = posterSourceValue(raw);
  const item: DiscoveryItem = {
    id,
    title,
    ...(posterSource ? { posterUrl: posterPath(collection, id, page, pageSize) } : {}),
    rank: rankValue(raw, index, (page - 1) * pageSize),
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
 * Convert the mobile API payload into the bounded shared discovery contract.
 * Image bytes remain server-side; the returned poster path points to the
 * authenticated same-origin proxy rather than exposing the upstream URL.
 */
export function parseDoubanCollection(
  payload: unknown,
  collection: DiscoveryCollectionId,
  now = Date.now,
  page = MIN_DISCOVERY_PAGE,
  pageSize = DEFAULT_DISCOVERY_LIMIT,
): DiscoveryCollectionResponse {
  const boundedPage = clampPage(page);
  const boundedPageSize = clampLimit(pageSize);
  const itemsValue = isObject(payload)
    ? valueFor(payload, "subject_collection_items", "items")
    : payload;
  if (!Array.isArray(itemsValue)) throw new DoubanUpstreamError("Invalid Douban response");
  const mediaType: "movie" | "tv" = collection === "tv-hot" || collection === "tv-weekly" ? "tv" : "movie";
  const items = itemsValue
    .map((item, index) => itemFromRaw(item, index, mediaType, collection, boundedPage, boundedPageSize))
    .filter((item): item is DiscoveryItem => item !== undefined);
  const start = (boundedPage - 1) * boundedPageSize;
  const total = isObject(payload) ? nonNegativeNumber(valueFor(payload, "total")) : undefined;
  const boundedTotal = Math.max(start + items.length, Math.floor(total ?? start + items.length));
  return {
    collection,
    updatedAt: new Date(now()).toISOString(),
    stale: false,
    page: boundedPage,
    pageSize: boundedPageSize,
    total: boundedTotal,
    hasNext: boundedPage < MAX_DISCOVERY_PAGE && boundedPage * boundedPageSize < boundedTotal,
    items,
  };
}

function mediaFromRaw(raw: JsonObject, itemId: string, mediaType: "movie" | "tv"): DoubanMediaDetails | undefined {
  const normalizedId = numericId(valueFor(raw, "id", "subject_id", "subjectId")) ?? numericId(itemId);
  const title = textFrom(valueFor(raw, "title", "name"), DISCOVERY_TEXT_LIMITS.title);
  if (!normalizedId || !title) return undefined;
  const posterSource = posterSourceValue(raw);
  const media: DoubanMediaDetails = {
    id: normalizedId,
    title,
    ...(posterSource ? { posterUrl: mediaPosterPath(mediaType, normalizedId) } : {}),
    mediaType,
    genres: genresValue(raw),
    summary: summaryValue(raw),
    sourceUrl: `${DOUBAN_SOURCE_URL_PREFIX}${normalizedId}/`,
  };
  const originalTitle = textFrom(
    valueFor(raw, "original_title", "originalTitle", "original_name", "originalName"),
    DISCOVERY_TEXT_LIMITS.originalTitle,
  );
  const year = yearValue(raw);
  const rating = ratingValue(raw);
  const ratingCount = ratingCountValue(raw);
  if (originalTitle) media.originalTitle = originalTitle;
  if (year !== undefined) media.year = year;
  if (rating !== undefined) media.rating = rating;
  if (ratingCount !== undefined) media.ratingCount = ratingCount;
  if (posterSource) media.posterSource = posterSource;
  return media;
}

function yearFromSuggestion(raw: JsonObject): string | undefined {
  const source = textFrom(valueFor(raw, "year", "sub_title", "subTitle", "subtitle"), 80);
  const match = /(?:^|\D)((?:18|19|20|21|22|23|24|25|26|27|28|29)\d{2})(?:\D|$)/u.exec(source);
  return match?.[1];
}

export function parseDoubanMediaSearch(
  payload: unknown,
  query: string,
  limit = DEFAULT_DISCOVERY_LIMIT,
): DiscoveryMediaSearchResponse {
  const boundedLimit = clampLimit(limit);
  const values = Array.isArray(payload) ? payload.filter(isObject) : [];
  const items: DiscoveryMedia[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const mediaType = valueFor(value, "type", "media_type", "mediaType") === "tv" ? "tv" :
      valueFor(value, "type", "media_type", "mediaType") === "movie" ? "movie" : undefined;
    const id = numericId(valueFor(value, "id", "subject_id", "subjectId"));
    const title = textFrom(valueFor(value, "title", "name"), DISCOVERY_TEXT_LIMITS.title);
    if (!mediaType || !id || !title || seen.has(`${mediaType}:${id}`)) continue;
    const posterSource = safeImageSource(valueFor(value, "img", "cover_url", "coverUrl"));
    const item: DiscoveryMedia = {
      id,
      title,
      ...(posterSource ? { posterUrl: mediaPosterPath(mediaType, id) } : {}),
      ...(yearFromSuggestion(value) ? { year: yearFromSuggestion(value) } : {}),
      mediaType,
      genres: [],
      summary: textFrom(valueFor(value, "sub_title", "subTitle", "subtitle"), DISCOVERY_TEXT_LIMITS.summary),
      sourceUrl: `${DOUBAN_SOURCE_URL_PREFIX}${id}/`,
    };
    items.push(item);
    seen.add(`${mediaType}:${id}`);
    if (items.length >= boundedLimit) break;
  }
  return { query: textFrom(query, DISCOVERY_NAME_LIMIT), total: items.length, items };
}

function namesValue(raw: JsonObject, key: "actors" | "directors"): string[] {
  const source = valueFor(raw, key);
  const values = Array.isArray(source) ? source : source === undefined ? [] : [source];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = textFrom(isObject(value) ? valueFor(value, "name", "title") : value, DISCOVERY_NAME_LIMIT);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= DISCOVERY_CAST_LIMIT) break;
  }
  return names;
}

function actorsValue(raw: JsonObject): DiscoveryActor[] {
  const source = valueFor(raw, "actors");
  const values = Array.isArray(source) ? source : source === undefined ? [] : [source];
  const actors: DiscoveryActor[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const object = isObject(value) ? value : undefined;
    const name = textFrom(object ? valueFor(object, "name", "title") : value, DISCOVERY_NAME_LIMIT);
    if (!name || seen.has(name)) continue;
    const id = numericId(object ? valueFor(object, "id", "celebrity_id", "celebrityId", "personage_id", "personageId") : undefined);
    actors.push({ name, ...(id ? { id } : {}) });
    seen.add(name);
    if (actors.length >= DISCOVERY_CAST_LIMIT) break;
  }
  return actors;
}

export function parseDoubanSubjectDetails(
  payload: unknown,
  itemId: string,
  mediaType?: "movie" | "tv",
): DoubanSubjectDetails {
  if (!isObject(payload)) throw new DoubanUpstreamError("Invalid Douban response");
  const normalizedId = numericId(valueFor(payload, "id")) ?? itemId;
  const media = mediaType ? mediaFromRaw(payload, normalizedId, mediaType) : undefined;
  return {
    itemId: normalizedId,
    actors: actorsValue(payload),
    directors: namesValue(payload, "directors"),
    ...(posterSourceValue(payload) ? { posterSource: posterSourceValue(payload) } : {}),
    ...(media ? { media } : {}),
  };
}

function actorAvatarSourceValue(raw: JsonObject): string | undefined {
  const direct = safeImageSource(valueFor(raw, "avatar", "avatar_url", "avatarUrl"));
  if (direct) return direct;
  const coverImage = valueFor(raw, "cover_img", "coverImg");
  if (isObject(coverImage)) {
    const source = safeImageSource(valueFor(coverImage, "url", "image"));
    if (source) return source;
  }
  const cover = valueFor(raw, "cover");
  if (isObject(cover)) {
    const source = safeImageSource(valueFor(cover, "url", "image"));
    if (source) return source;
    for (const key of ["normal", "large"]) {
      const nested = valueFor(cover, key);
      if (!isObject(nested)) continue;
      const nestedSource = safeImageSource(valueFor(nested, "url", "image"));
      if (nestedSource) return nestedSource;
    }
  }
  return undefined;
}

function actorIntroValue(raw: JsonObject): string {
  const extra = valueFor(raw, "extra");
  if (!isObject(extra)) return "暂无公开简介";
  const shortInfo = textFrom(valueFor(extra, "short_info", "shortInfo"), DISCOVERY_ACTOR_INTRO_LIMIT);
  const info = valueFor(extra, "info");
  const metadata = Array.isArray(info)
    ? info
      .map((entry) => {
        if (!Array.isArray(entry)) return textFrom(entry, DISCOVERY_NAME_LIMIT);
        const label = textFrom(entry[0], DISCOVERY_NAME_LIMIT);
        const value = textFrom(entry[1], DISCOVERY_NAME_LIMIT);
        return label && value ? `${label}：${value}` : value || label;
      })
      .filter(Boolean)
      .join(" · ")
    : "";
  return [shortInfo, metadata].filter(Boolean).join("\n") || "暂无公开简介";
}

function actorWorkEntries(payload: unknown): JsonObject[] {
  const value = isObject(payload) ? valueFor(payload, "works", "items") : payload;
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function roleValue(raw: JsonObject): string | undefined {
  const source = valueFor(raw, "roles", "role");
  const values = Array.isArray(source) ? source : source === undefined ? [] : [source];
  for (const value of values) {
    const role = textFrom(isObject(value) ? valueFor(value, "name", "title", "role") : value, DISCOVERY_ROLE_LIMIT);
    if (role) return role;
  }
  return undefined;
}

function actorWorkFromRaw(raw: JsonObject): DiscoveryActorWork | undefined {
  const work = isObject(valueFor(raw, "work")) ? valueFor(raw, "work") as JsonObject : raw;
  const id = numericId(valueFor(work, "id", "subject_id", "subjectId"));
  const title = textFrom(valueFor(work, "title", "name"), DISCOVERY_TEXT_LIMITS.title);
  if (!id || !title) return undefined;
  const type = textFrom(valueFor(work, "type", "subtype", "media_type", "mediaType"), 20).toLowerCase();
  if (type !== "movie" && type !== "tv") return undefined;
  const posterSource = posterSourceValue(work);
  const actorWork: DiscoveryActorWork = {
    id,
    title,
    ...(posterSource ? { posterUrl: mediaPosterPath(type, id) } : {}),
    mediaType: type,
    genres: genresValue(work),
    summary: summaryValue(work),
    sourceUrl: `${DOUBAN_SOURCE_URL_PREFIX}${id}/`,
  };
  const originalTitle = textFrom(
    valueFor(work, "original_title", "originalTitle", "original_name", "originalName"),
    DISCOVERY_TEXT_LIMITS.originalTitle,
  );
  const year = yearValue(work);
  const rating = ratingValue(work);
  const ratingCount = ratingCountValue(work);
  const role = roleValue(raw);
  if (year !== undefined) actorWork.year = year;
  if (originalTitle) actorWork.originalTitle = originalTitle;
  if (rating !== undefined) actorWork.rating = rating;
  if (ratingCount !== undefined) actorWork.ratingCount = ratingCount;
  if (role) actorWork.role = role;
  return actorWork;
}

export function parseDoubanActorProfile(
  profilePayload: unknown,
  worksPayload: unknown,
  actorId: string,
  page = MIN_DISCOVERY_PAGE,
  pageSize = DEFAULT_DISCOVERY_LIMIT,
): DoubanActorProfile {
  if (!isObject(profilePayload)) throw new DoubanUpstreamError("Invalid Douban actor response");
  const normalizedActorId = numericId(actorId) ?? numericId(valueFor(profilePayload, "id"));
  const name = textFrom(valueFor(profilePayload, "title", "name"), DISCOVERY_TEXT_LIMITS.title);
  if (!normalizedActorId || !name) throw new DoubanUpstreamError("Invalid Douban actor response");
  const boundedPage = clampPage(page);
  const boundedPageSize = clampLimit(pageSize);
  const works = actorWorkEntries(worksPayload)
    .map((entry) => actorWorkFromRaw(entry))
    .filter((work): work is DiscoveryActorWork => work !== undefined)
    .filter((work, index, values) => values.findIndex((candidate) => candidate.id === work.id) === index);
  const start = (boundedPage - 1) * boundedPageSize;
  const total = isObject(worksPayload) ? nonNegativeNumber(valueFor(worksPayload, "total")) : undefined;
  const boundedTotal = Math.max(start + works.length, Math.floor(total ?? start + works.length));
  const latinName = textFrom(valueFor(profilePayload, "latin_title", "latinTitle"), DISCOVERY_TEXT_LIMITS.originalTitle);
  const avatarSource = actorAvatarSourceValue(profilePayload);
  return {
    id: normalizedActorId,
    name,
    ...(latinName ? { latinName } : {}),
    ...(avatarSource ? { avatarUrl: actorAvatarPath(normalizedActorId) } : {}),
    intro: actorIntroValue(profilePayload),
    works,
    page: boundedPage,
    pageSize: boundedPageSize,
    total: boundedTotal,
    hasNext: boundedPage < MAX_DISCOVERY_PAGE && boundedPage * boundedPageSize < boundedTotal,
    ...(avatarSource ? { avatarSource } : {}),
  };
}

function normalizedActorName(value: string): string {
  return value.replace(/\s+/gu, "").toLocaleLowerCase();
}

function actorIdentityFromSuggest(payload: unknown, requestedName: string): { id: string; name: string } | undefined {
  const candidates = (Array.isArray(payload) ? payload : [])
    .filter(isObject)
    .map((entry) => {
      const type = textFrom(valueFor(entry, "type"), 30).toLowerCase();
      const id = numericId(valueFor(entry, "id"));
      const name = textFrom(valueFor(entry, "title", "name"), DISCOVERY_NAME_LIMIT);
      return type === "celebrity" && id && name ? { id, name } : undefined;
    })
    .filter((candidate): candidate is { id: string; name: string } => candidate !== undefined);
  return candidates.find((candidate) => normalizedActorName(candidate.name) === normalizedActorName(requestedName))
    ?? candidates[0];
}

function actorProfileKey(actorId: string, page: number, limit: number): string {
  return `${actorId}:${page}:${limit}`;
}

function actorWorkKey(actorId: string, workId: string): string {
  return `${actorId}:${workId}`;
}

function cloneResponse(response: DiscoveryCollectionResponse, stale: boolean): DiscoveryCollectionResponse {
  return {
    collection: response.collection,
    updatedAt: response.updatedAt,
    stale,
    page: response.page,
    pageSize: response.pageSize,
    total: response.total,
    hasNext: response.hasNext,
    items: response.items.map((item) => ({
      ...item,
      genres: [...item.genres],
    })),
  };
}

function collectionKey(collection: DiscoveryCollectionId, page: number, limit: number): string {
  return `${collection}:${page}:${limit}`;
}

function itemKey(collection: DiscoveryCollectionId, itemId: string): string {
  return `${collection}:${itemId}`;
}

function detailsKey(itemId: string, mediaType: "movie" | "tv"): string {
  return `${mediaType}:${itemId}`;
}

function cloneDetails(details: DoubanSubjectDetails): DoubanSubjectDetails {
  return {
    itemId: details.itemId,
    actors: details.actors.map((actor) => ({ ...actor })),
    directors: [...details.directors],
    ...(details.posterSource ? { posterSource: details.posterSource } : {}),
    ...(details.media
      ? {
          media: {
            ...details.media,
            genres: [...details.media.genres],
          },
        }
      : {}),
  };
}

function cloneActorProfile(profile: DoubanActorProfile): DoubanActorProfile {
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
    ...(profile.avatarSource ? { avatarSource: profile.avatarSource } : {}),
  };
}

function cloneMediaSearch(response: DiscoveryMediaSearchResponse): DiscoveryMediaSearchResponse {
  return {
    query: response.query,
    total: response.total,
    items: response.items.map((item) => ({
      ...item,
      genres: [...item.genres],
    })),
  };
}

function publicActorProfile(profile: DoubanActorProfile): DiscoveryActorProfile {
  const cloned = cloneActorProfile(profile);
  const { avatarSource: _avatarSource, ...publicProfile } = cloned;
  return publicProfile;
}

function clonePoster(asset: DiscoveryPosterAsset): DiscoveryPosterAsset {
  return { contentType: asset.contentType, body: asset.body.slice() };
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
  private readonly posterSources = new Map<string, string>();
  private readonly detailsCache = new Map<string, CachedDetails>();
  private readonly pendingDetails = new Map<string, Promise<DoubanSubjectDetails>>();
  private readonly actorLookupCache = new Map<string, DoubanActorIdentity>();
  private readonly pendingActorLookups = new Map<string, Promise<DoubanActorIdentity>>();
  private readonly actorProfileCache = new Map<string, CachedActorProfile>();
  private readonly pendingActorProfiles = new Map<string, Promise<DoubanActorProfile>>();
  private readonly actorAvatarSources = new Map<string, string>();
  private readonly actorWorkPosterSources = new Map<string, string>();
  private readonly mediaPosterSources = new Map<string, string>();
  private readonly mediaSearchCache = new Map<string, CachedMediaSearch>();
  private readonly pendingMediaSearch = new Map<string, Promise<DiscoveryMediaSearchResponse>>();
  private readonly posterCache = new Map<string, CachedPoster>();
  private readonly pendingPosters = new Map<string, Promise<DiscoveryPosterAsset>>();

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

  public async getCollection(
    collection: DiscoveryCollectionId | string,
    page = MIN_DISCOVERY_PAGE,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryCollectionResponse> {
    if (!isDiscoveryCollectionId(collection)) throw new UnknownDiscoveryCollectionError(String(collection));
    const boundedPage = clampPage(page);
    const boundedLimit = clampLimit(limit);
    const key = collectionKey(collection, boundedPage, boundedLimit);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cloneResponse(cached.response, false);

    const existing = this.pending.get(key);
    if (existing) return existing.then((response) => cloneResponse(response, response.stale));

    const operation = this.requestCollection(collection, boundedPage, boundedLimit, cached);
    this.pending.set(key, operation);
    try {
      const response = await operation;
      return cloneResponse(response, response.stale);
    } finally {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }

  /** Primary list-shaped API used by the discovery routes. */
  public list(
    collection: DiscoveryCollectionId | string,
    page = MIN_DISCOVERY_PAGE,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryCollectionResponse> {
    return this.getCollection(collection, page, limit);
  }

  /** Alias for callers that use fetch terminology. */
  public fetch(
    collection: DiscoveryCollectionId | string,
    page = MIN_DISCOVERY_PAGE,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryCollectionResponse> {
    return this.getCollection(collection, page, limit);
  }

  /** Alias used by discovery-oriented callers. */
  public fetchCollection(
    collection: DiscoveryCollectionId | string,
    page = MIN_DISCOVERY_PAGE,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryCollectionResponse> {
    return this.getCollection(collection, page, limit);
  }

  public clearCache(): void {
    this.cache.clear();
    this.posterSources.clear();
    this.detailsCache.clear();
    this.actorLookupCache.clear();
    this.actorProfileCache.clear();
    this.actorAvatarSources.clear();
    this.actorWorkPosterSources.clear();
    this.mediaPosterSources.clear();
    this.mediaSearchCache.clear();
    this.posterCache.clear();
  }

  public get cacheSize(): number {
    return this.cache.size;
  }

  public async getDetails(itemId: string, mediaType: "movie" | "tv"): Promise<DoubanSubjectDetails> {
    const normalizedId = numericId(itemId);
    if (!normalizedId) throw new DoubanUpstreamError("Invalid Douban subject id");
    const key = detailsKey(normalizedId, mediaType);
    const cached = this.detailsCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cloneDetails(cached.response);
    const existing = this.pendingDetails.get(key);
    if (existing) return existing.then(cloneDetails);

    const operation = this.requestDetails(normalizedId, mediaType, cached);
    this.pendingDetails.set(key, operation);
    try {
      const response = await operation;
      return cloneDetails(response);
    } finally {
      if (this.pendingDetails.get(key) === operation) this.pendingDetails.delete(key);
    }
  }

  public async getMedia(itemId: string, mediaType: "movie" | "tv"): Promise<DoubanMediaDetails> {
    const details = await this.getDetails(itemId, mediaType);
    if (!details.media) throw new DoubanUpstreamError("Media details unavailable");
    return {
      ...details.media,
      genres: [...details.media.genres],
    };
  }

  public async getMediaPoster(itemId: string, mediaType: "movie" | "tv"): Promise<DiscoveryPosterAsset> {
    const normalizedId = numericId(itemId);
    if (!normalizedId) throw new DoubanUpstreamError("Invalid Douban subject id");
    const source = this.mediaPosterSources.get(mediaKey(mediaType, normalizedId));
    if (source) return this.getCachedPoster(source);
    const media = await this.getMedia(itemId, mediaType);
    if (!media.posterSource) throw new DoubanUpstreamError("Media poster unavailable");
    this.mediaPosterSources.set(mediaKey(mediaType, media.id), media.posterSource);
    return this.getCachedPoster(media.posterSource);
  }

  public async searchMedia(
    query: string,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryMediaSearchResponse> {
    const normalizedQuery = textFrom(query, DISCOVERY_NAME_LIMIT);
    if (!normalizedQuery) return { query: "", total: 0, items: [] };
    const boundedLimit = clampLimit(limit);
    const key = `${normalizedActorName(normalizedQuery)}:${boundedLimit}`;
    const cached = this.mediaSearchCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cloneMediaSearch(cached.response);
    const existing = this.pendingMediaSearch.get(key);
    if (existing) return existing.then(cloneMediaSearch);

    const operation = this.requestMediaSearch(normalizedQuery, boundedLimit, key, cached);
    this.pendingMediaSearch.set(key, operation);
    try {
      const response = await operation;
      return cloneMediaSearch(response);
    } finally {
      if (this.pendingMediaSearch.get(key) === operation) this.pendingMediaSearch.delete(key);
    }
  }

  public async getActorProfile(
    name: string,
    page = MIN_DISCOVERY_PAGE,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryActorProfile> {
    const normalizedName = textFrom(name, DISCOVERY_NAME_LIMIT);
    if (!normalizedName) throw new DoubanUpstreamError("Invalid Douban actor name");
    const boundedPage = clampPage(page);
    const boundedLimit = clampLimit(limit);
    const identity = await this.resolveActor(normalizedName);
    const key = actorProfileKey(identity.id, boundedPage, boundedLimit);
    const cached = this.actorProfileCache.get(key);
    if (cached && cached.expiresAt > this.now()) return publicActorProfile(cached.response);
    const existing = this.pendingActorProfiles.get(key);
    if (existing) return existing.then(publicActorProfile);

    const operation = this.requestActorProfile(identity, boundedPage, boundedLimit, key, cached);
    this.pendingActorProfiles.set(key, operation);
    try {
      const response = await operation;
      return publicActorProfile(response);
    } finally {
      if (this.pendingActorProfiles.get(key) === operation) this.pendingActorProfiles.delete(key);
    }
  }

  public async getActorAvatar(actorId: string): Promise<DiscoveryPosterAsset> {
    const normalizedActorId = numericId(actorId);
    if (!normalizedActorId) throw new DoubanUpstreamError("Invalid Douban actor id");
    const source = this.actorAvatarSources.get(normalizedActorId);
    if (!source) throw new DoubanUpstreamError("Actor avatar unavailable");
    return this.getCachedPoster(source);
  }

  public async getActorWorkPoster(actorId: string, workId: string): Promise<DiscoveryPosterAsset> {
    const normalizedActorId = numericId(actorId);
    const normalizedWorkId = numericId(workId);
    if (!normalizedActorId || !normalizedWorkId) throw new DoubanUpstreamError("Invalid Douban work id");
    const source = this.actorWorkPosterSources.get(actorWorkKey(normalizedActorId, normalizedWorkId));
    if (!source) throw new DoubanUpstreamError("Actor work poster unavailable");
    return this.getCachedPoster(source);
  }

  public async getPoster(
    collection: DiscoveryCollectionId,
    itemId: string,
    page = MIN_DISCOVERY_PAGE,
    limit = DEFAULT_DISCOVERY_LIMIT,
  ): Promise<DiscoveryPosterAsset> {
    const normalizedId = numericId(itemId);
    if (!normalizedId) throw new DoubanUpstreamError("Invalid Douban subject id");
    const sourceKey = itemKey(collection, normalizedId);
    let source = this.posterSources.get(sourceKey);
    if (!source) {
      await this.getCollection(collection, page, limit);
      source = this.posterSources.get(sourceKey);
    }
    if (!source) throw new DoubanUpstreamError("Poster unavailable");

    const cached = this.posterCache.get(source);
    if (cached && cached.expiresAt > this.now()) return clonePoster(cached.asset);
    const existing = this.pendingPosters.get(source);
    if (existing) return existing.then(clonePoster);

    const operation = this.requestPoster(source, cached);
    this.pendingPosters.set(source, operation);
    try {
      const asset = await operation;
      return clonePoster(asset);
    } finally {
      if (this.pendingPosters.get(source) === operation) this.pendingPosters.delete(source);
    }
  }

  private async resolveActor(name: string): Promise<DoubanActorIdentity> {
    const key = normalizedActorName(name);
    const cached = this.actorLookupCache.get(key);
    if (cached) return cached;
    const existing = this.pendingActorLookups.get(key);
    if (existing) return existing;

    const operation = this.requestActorIdentity(name);
    this.pendingActorLookups.set(key, operation);
    try {
      const identity = await operation;
      this.actorLookupCache.set(key, identity);
      return identity;
    } finally {
      if (this.pendingActorLookups.get(key) === operation) this.pendingActorLookups.delete(key);
    }
  }

  private async requestMediaSearch(
    query: string,
    limit: number,
    key: string,
    oldCache?: CachedMediaSearch,
  ): Promise<DiscoveryMediaSearchResponse> {
    const suggestUrl = `${DOUBAN_SUGGEST_ORIGIN}/j/subject_suggest?q=${encodeURIComponent(query)}`;
    try {
      const payload = await this.requestJson(suggestUrl, `${DOUBAN_SUGGEST_ORIGIN}/`);
      const response = parseDoubanMediaSearch(payload, query, limit);
      for (const raw of Array.isArray(payload) ? payload.filter(isObject) : []) {
        const mediaType = valueFor(raw, "type", "media_type", "mediaType");
        const id = numericId(valueFor(raw, "id", "subject_id", "subjectId"));
        const source = safeImageSource(valueFor(raw, "img", "cover_url", "coverUrl"));
        if ((mediaType === "movie" || mediaType === "tv") && id && source) {
          this.mediaPosterSources.set(mediaKey(mediaType, id), source);
        }
      }
      this.mediaSearchCache.set(key, { response, expiresAt: this.now() + this.ttlMs });
      return response;
    } catch (error) {
      if (oldCache) return cloneMediaSearch(oldCache.response);
      if (error instanceof DoubanUpstreamError) throw error;
      throw new DoubanUpstreamError(undefined, error);
    }
  }

  private async requestActorIdentity(name: string): Promise<DoubanActorIdentity> {
    const suggestUrl = `${DOUBAN_SUGGEST_ORIGIN}/j/subject_suggest?q=${encodeURIComponent(name)}`;
    const suggestPayload = await this.requestJson(suggestUrl, `${DOUBAN_SUGGEST_ORIGIN}/`);
    const candidate = actorIdentityFromSuggest(suggestPayload, name);
    if (!candidate) throw new DoubanUpstreamError("Actor not found");
    // The suggestion endpoint returns the celebrity id directly. The mobile
    // profile response has a different person-subject id, but the celebrity
    // id is stable for both profile and filmography routes and keeps proxy
    // asset keys consistent.
    return { id: candidate.id, celebrityId: candidate.id, name: candidate.name };
  }

  private async requestActorProfile(
    identity: DoubanActorIdentity,
    page: number,
    limit: number,
    key: string,
    oldCache?: CachedActorProfile,
  ): Promise<DoubanActorProfile> {
    const start = (page - 1) * limit;
    const profileUrl = `${DOUBAN_API_ORIGIN}${DOUBAN_SUBJECT_API_PATH}/celebrity/${identity.celebrityId}`;
    const worksUrl = `${DOUBAN_API_ORIGIN}${DOUBAN_SUBJECT_API_PATH}/celebrity/${identity.celebrityId}/works?start=${start}&count=${limit}`;
    try {
      const [profilePayload, worksPayload] = await Promise.all([
        this.requestJson(profileUrl, `${DOUBAN_API_ORIGIN}/`),
        this.requestJson(worksUrl, profileUrl),
      ]);
      const parsed = parseDoubanActorProfile(profilePayload, worksPayload, identity.id, page, limit);
      const avatarSource = actorAvatarSourceValue(isObject(profilePayload) ? profilePayload : {});
      if (avatarSource) this.actorAvatarSources.set(identity.id, avatarSource);
      for (const entry of actorWorkEntries(worksPayload)) {
        const work = isObject(valueFor(entry, "work")) ? valueFor(entry, "work") as JsonObject : entry;
        const workId = numericId(valueFor(work, "id", "subject_id", "subjectId"));
        const source = posterSourceValue(work);
        if (workId && source) {
          this.actorWorkPosterSources.set(actorWorkKey(identity.id, workId), source);
          const type = valueFor(work, "type", "subtype", "media_type", "mediaType");
          if (type === "movie" || type === "tv") this.mediaPosterSources.set(mediaKey(type, workId), source);
        }
      }
      this.actorProfileCache.set(key, { response: parsed, expiresAt: this.now() + this.ttlMs });
      return parsed;
    } catch (error) {
      if (oldCache) return cloneActorProfile(oldCache.response);
      if (error instanceof DoubanUpstreamError) throw error;
      throw new DoubanUpstreamError(undefined, error);
    }
  }

  private async requestJson(url: string, referer: string): Promise<unknown> {
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.upstreamHeaders(referer),
      });
      if (!response.ok) throw new DoubanUpstreamError();
      try {
        return await response.json();
      } catch (error) {
        throw new DoubanUpstreamError("Invalid Douban response", error);
      }
    } catch (error) {
      if (error instanceof DoubanUpstreamError) throw error;
      throw new DoubanUpstreamError(undefined, error);
    }
  }

  private async getCachedPoster(source: string): Promise<DiscoveryPosterAsset> {
    const cached = this.posterCache.get(source);
    if (cached && cached.expiresAt > this.now()) return clonePoster(cached.asset);
    const existing = this.pendingPosters.get(source);
    if (existing) return existing.then(clonePoster);
    const operation = this.requestPoster(source, cached);
    this.pendingPosters.set(source, operation);
    try {
      const asset = await operation;
      return clonePoster(asset);
    } finally {
      if (this.pendingPosters.get(source) === operation) this.pendingPosters.delete(source);
    }
  }

  private async requestCollection(
    collection: DiscoveryCollectionId,
    page: number,
    limit: number,
    oldCache?: CachedCollection,
  ): Promise<DiscoveryCollectionResponse> {
    const upstreamId = DOUBAN_COLLECTIONS[collection];
    // Construct only from the closed map and bounded integer.  No request
    // parameter can supply a host, path, or query parameter of its own.
    const start = (page - 1) * limit;
    const url = `${DOUBAN_API_ORIGIN}${DOUBAN_API_PATH}/${upstreamId}/items?start=${start}&count=${limit}&items_only=1`;
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
      const parsed = parseDoubanCollection(payload, collection, this.now, page, limit);
      const mediaType: "movie" | "tv" = collection === "tv-hot" || collection === "tv-weekly" ? "tv" : "movie";
      for (const rawItem of collectionItems(payload)) {
        const id = numericId(valueFor(rawItem, "id", "subject_id", "subjectId"));
        const source = posterSourceValue(rawItem);
        if (id && source) {
          this.posterSources.set(itemKey(collection, id), source);
          this.mediaPosterSources.set(mediaKey(mediaType, id), source);
        }
      }
      this.cache.set(collectionKey(collection, page, limit), {
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

  private async requestDetails(
    itemId: string,
    mediaType: "movie" | "tv",
    oldCache?: CachedDetails,
  ): Promise<DoubanSubjectDetails> {
    const url = `${DOUBAN_API_ORIGIN}${DOUBAN_SUBJECT_API_PATH}/${mediaType}/${itemId}`;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.upstreamHeaders(DOUBAN_API_ORIGIN),
      });
      if (!response.ok) throw new DoubanUpstreamError();
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new DoubanUpstreamError("Invalid Douban response", error);
      }
      const parsed = parseDoubanSubjectDetails(payload, itemId, mediaType);
      if (parsed.media?.posterSource) this.mediaPosterSources.set(mediaKey(mediaType, parsed.media.id), parsed.media.posterSource);
      this.detailsCache.set(detailsKey(itemId, mediaType), {
        response: parsed,
        expiresAt: this.now() + this.ttlMs,
      });
      return parsed;
    } catch (error) {
      if (oldCache) return cloneDetails({ ...oldCache.response });
      if (error instanceof DoubanUpstreamError) throw error;
      throw new DoubanUpstreamError(undefined, error);
    }
  }

  private async requestPoster(source: string, oldCache?: CachedPoster): Promise<DiscoveryPosterAsset> {
    try {
      const response = await this.fetchImpl(source, {
        method: "GET",
        headers: this.upstreamHeaders(DOUBAN_API_ORIGIN),
      });
      if (!response.ok) throw new DoubanUpstreamError();
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (!contentType || !DISCOVERY_POSTER_CONTENT_TYPES.has(contentType)) {
        throw new DoubanUpstreamError("Invalid Douban image");
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_POSTER_BYTES) {
        throw new DoubanUpstreamError("Invalid Douban image");
      }
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.length === 0 || body.length > MAX_DISCOVERY_POSTER_BYTES) {
        throw new DoubanUpstreamError("Invalid Douban image");
      }
      const asset = { body, contentType };
      this.posterCache.set(source, { asset, expiresAt: this.now() + this.ttlMs });
      return asset;
    } catch (error) {
      if (oldCache) return clonePoster(oldCache.asset);
      if (error instanceof DoubanUpstreamError) throw error;
      throw new DoubanUpstreamError(undefined, error);
    }
  }

  private upstreamHeaders(referer: string): HeadersInit {
    return {
      Accept: "application/json,text/plain,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: referer,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    };
  }
}

export function normalizeDiscoveryLimit(value: unknown): number {
  return clampLimit(value);
}

export function normalizeDiscoveryPage(value: unknown): number {
  return clampPage(value);
}
