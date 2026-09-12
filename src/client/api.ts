import type {
  DiscoveryActor,
  DiscoveryActorProfile,
  DiscoveryCollectionId,
  DiscoveryCollectionResponse,
  DiscoveryItem,
  DiscoveryItemDetails,
  DiscoveryMedia,
  DiscoveryMediaSearchResponse,
  DiscoveryReleaseResponse,
  GrabPreviewResponse,
  GrabRequest,
  GrabResponse,
  HistoryResponse,
  MarkSeenRequest,
  NasStorageSummary,
  PairRequest,
  ReleaseSummary,
  SearchResponse,
  SearchRequest,
  SeenMediaEntry,
  ServiceCapabilities,
  ServiceHealth,
  SessionResponse,
  TorrentActionRequest,
  TorrentActionResponse,
  TorrentSummary
} from "../shared/contracts";
import {
  assistantPreferencesSchema,
  assistantStreamEventSchema,
  assistantTurnResponseSchema,
  defaultAssistantPreferences,
  type AssistantTurnRequest,
  type AssistantTurnResponse
} from "../shared/assistant";

export const DESTINATION_PATH = "/Volumes/YourNAS/pt";

type JsonRecord = Record<string, unknown>;

/** Recursive JSON boundary value; callers narrow it with the type guards below. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanMessage(value: unknown): string {
  if (typeof value !== "string") {
    return "请求失败，请稍后再试。";
  }

  // Error text is displayed as plain text. Removing tags also prevents a
  // malformed upstream value from being mistaken for interface markup.
  const withoutTags = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return withoutTags.slice(0, 240) || "请求失败，请稍后再试。";
}

function assistantResponseError(): ApiError {
  return new ApiError("推荐响应格式无效，请按片名搜索。", 502, "AI_INVALID_OUTPUT");
}

function normalizeAssistantTurn(payload: unknown): AssistantTurnResponse {
  const parsed = assistantTurnResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw assistantResponseError();
  }
  return parsed.data;
}

function assistantStreamResponseError(): ApiError {
  return new ApiError("推荐流响应格式无效，请按片名搜索。", 502, "AI_INVALID_OUTPUT");
}

function responseError(response: Response, payload: unknown): ApiError {
  const record = asRecord(payload);
  const code = record && typeof record.code === "string" ? record.code : undefined;
  const message = record?.error ?? record?.message;
  return new ApiError(cleanMessage(message ?? `请求失败（${response.status}）。`), response.status, code);
}

async function requestAssistantTurnStream(
  request: AssistantTurnRequest,
  csrfToken: string,
  onSnapshot: (snapshot: AssistantTurnResponse) => void,
  signal: AbortSignal | undefined,
  fetchImpl?: typeof fetch
): Promise<AssistantTurnResponse> {
  const requestFetch = fetchImpl ?? globalThis.fetch;
  if (!requestFetch) {
    throw new ApiError("当前环境不支持网络请求。", 0);
  }

  const response = await requestFetch("/api/assistant/turns/stream", {
    method: "POST",
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
    headers: {
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const payload = parseJson(await response.text());
    throw responseError(response, payload);
  }
  if (!response.body) {
    throw assistantStreamResponseError();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalSnapshot: AssistantTurnResponse | null = null;

  const throwIfAborted = (): void => {
    if (!signal?.aborted) return;
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  };

  const consumeLine = (line: string): void => {
    throwIfAborted();
    const trimmed = line.trim();
    if (!trimmed) return;

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch {
      throw assistantStreamResponseError();
    }

    const parsed = assistantStreamEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw assistantStreamResponseError();
    }
    if (parsed.data.type === "error") {
      throw new ApiError(cleanMessage(parsed.data.error), 502, parsed.data.code);
    }
    if (parsed.data.data.clientTurnId !== request.clientTurnId
      || (request.conversationId && parsed.data.data.conversationId !== request.conversationId)
      || (finalSnapshot && (parsed.data.data.turnId !== finalSnapshot.turnId || parsed.data.data.conversationId !== finalSnapshot.conversationId))) {
      throw assistantStreamResponseError();
    }

    finalSnapshot = parsed.data.data;
    onSnapshot(parsed.data.data);
    throwIfAborted();
  };

  try {
    while (true) {
      throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      if (buffer.length > 512_000) throw assistantStreamResponseError();
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
        buffer = buffer.slice(newlineIndex + 1);
        consumeLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    consumeLine(buffer.replace(/\r$/u, ""));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const completedSnapshot = finalSnapshot as AssistantTurnResponse | null;
  if (!completedSnapshot || completedSnapshot.phase !== "complete") {
    throw assistantStreamResponseError();
  }
  return completedSnapshot;
}

function parseJson(text: string): JsonValue | undefined {
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

async function requestJson<T>(
  path: string,
  init: RequestInit | undefined,
  fetchImpl?: typeof fetch
): Promise<T> {
  const requestFetch = fetchImpl ?? globalThis.fetch;
  if (!requestFetch) {
    throw new ApiError("当前环境不支持网络请求。", 0);
  }

  const response = await requestFetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    const record = asRecord(payload);
    const code = record && typeof record.code === "string" ? record.code : undefined;
    const message = record?.error ?? record?.message;
    throw new ApiError(cleanMessage(message ?? `请求失败（${response.status}）。`), response.status, code);
  }

  return payload as T;
}

function normalizeSession(payload: unknown): SessionResponse {
  const value = asRecord(payload);
  return {
    paired: asBoolean(value?.paired),
    ...(typeof value?.csrfToken === "string" ? { csrfToken: value.csrfToken } : {})
  };
}

function normalizeCapabilities(value: unknown): ServiceCapabilities | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const ai = asRecord(record.ai);
  const webSearch = asRecord(record.webSearch);
  const grab = asRecord(record.grab);
  const persistence = asRecord(record.persistence);
  if (!ai && !webSearch && !grab && !persistence) return undefined;
  return {
    ai: {
      enabled: asBoolean(ai?.enabled),
      configured: asBoolean(ai?.configured),
      ...(typeof ai?.model === "string" ? { model: ai.model } : {})
    },
    webSearch: {
      enabled: asBoolean(webSearch?.enabled),
      configured: asBoolean(webSearch?.configured)
    },
    grab: { enabled: asBoolean(grab?.enabled) },
    persistence: {
      enabled: asBoolean(persistence?.enabled),
      ...(typeof persistence?.error === "string" ? { error: persistence.error } : {})
    }
  };
}

function normalizeHealth(payload: unknown): ServiceHealth {
  const value = asRecord(payload);
  const services = asRecord(value?.services);
  const capabilities = normalizeCapabilities(value?.capabilities);
  return {
    status: value?.status === "ok" ? "ok" : "degraded",
    version: asString(value?.version, "unknown"),
    pairingRequired: asBoolean(value?.pairingRequired),
    ...(services
      ? {
          services: {
            prowlarr: asBoolean(services.prowlarr),
            qbittorrent: asBoolean(services.qbittorrent),
            nasMounted: asBoolean(services.nasMounted)
          }
        }
      : {}),
    ...(capabilities ? { capabilities } : {})
  };
}

function normalizeRelease(payload: unknown): ReleaseSummary | null {
  const value = asRecord(payload);
  if (!value) {
    return null;
  }

  const id = asString(value.id);
  const title = asString(value.title);
  if (!id || !title) {
    return null;
  }

  const evidence = asRecord(value.evidence);
  const protocol = value.protocol === "usenet" ? "usenet" : "torrent";
  const categories = Array.isArray(value.categories)
    ? value.categories.filter((item): item is string => typeof item === "string").slice(0, 8)
    : [];

  return {
    id,
    title,
    indexer: asString(value.indexer, "TJUPT"),
    protocol,
    size: asFiniteNumber(value.size),
    seeders: asFiniteNumber(value.seeders),
    leechers: asFiniteNumber(value.leechers),
    grabs: asFiniteNumber(value.grabs),
    ageDays: asFiniteNumber(value.ageDays),
    categories,
    ...(typeof value.resolution === "string" ? { resolution: value.resolution } : {}),
    ...(typeof value.codec === "string" ? { codec: value.codec } : {}),
    ...(typeof value.season === "number" && Number.isInteger(value.season) && value.season >= 1 && value.season <= 50
      ? { season: value.season }
      : {}),
    freeleech: asBoolean(value.freeleech),
    ...(value.freeleechState === "yes" || value.freeleechState === "no" || value.freeleechState === "unknown"
      ? { freeleechState: value.freeleechState }
      : {}),
    ...(evidence
      ? {
          evidence: {
            resolution: evidence.resolution === "upstream" || evidence.resolution === "title_inferred"
              ? evidence.resolution
              : "unknown",
            codec: evidence.codec === "upstream" || evidence.codec === "title_inferred"
              ? evidence.codec
              : "unknown",
            size: evidence.size === "upstream" ? "upstream" : "unknown",
            seeders: evidence.seeders === "upstream" ? "upstream" : "unknown",
            season: evidence.season === "title_inferred" ? "title_inferred" : "unknown"
          }
        }
      : {})
  };
}

function normalizeSearch(payload: unknown): SearchResponse {
  const value = asRecord(payload);
  const releases = Array.isArray(value?.releases)
    ? value.releases.map(normalizeRelease).filter((item): item is ReleaseSummary => item !== null)
    : [];
  const intent = asRecord(value?.intent);

  return {
    query: asString(value?.query),
    intent: {
      searchTerm: asString(intent?.searchTerm, asString(value?.query)),
      ...(intent?.resolution === "2160p" || intent?.resolution === "1080p" || intent?.resolution === "720p"
        ? { resolution: intent.resolution }
        : {}),
      ...(typeof intent?.maxSizeBytes === "number" ? { maxSizeBytes: intent.maxSizeBytes } : {}),
      ...(typeof intent?.freeleechOnly === "boolean" ? { freeleechOnly: intent.freeleechOnly } : {})
    },
    total: asFiniteNumber(value?.total, releases.length),
    elapsedMs: asFiniteNumber(value?.elapsedMs),
    releases
  };
}

const discoveryCollections = new Set<DiscoveryCollectionId>([
  "movie-hot",
  "movie-weekly",
  "tv-hot",
  "tv-weekly",
  "top250"
]);

function normalizeDiscoveryItem(payload: unknown): DiscoveryItem | null {
  const media = normalizeDiscoveryMedia(payload);
  const value = asRecord(payload);
  if (!media || typeof value?.rank !== "number" || !Number.isFinite(value.rank)) return null;
  return {
    ...media,
    rank: Math.max(1, Math.floor(value.rank))
  };
}

function isSafeDiscoveryPosterUrl(value: unknown, id: string, mediaType: "movie" | "tv"): value is string {
  if (typeof value !== "string") return false;
  if (value === `/api/discovery/media/${mediaType}/${id}/poster`) return true;
  if (/^\/api\/discovery\/collections\/(?:movie-hot|movie-weekly|tv-hot|tv-weekly|top250)\/items\/\d{1,16}\/poster\?page=\d+&limit=\d+$/u.test(value)) return true;
  return /^\/api\/discovery\/actors\/\d{1,16}\/works\/\d{1,16}\/poster$/u.test(value);
}

function normalizeDiscoveryMedia(payload: unknown): DiscoveryMedia | null {
  const value = asRecord(payload);
  if (!value) return null;
  const id = asString(value.id);
  const title = asString(value.title);
  const sourceUrl = asString(value.sourceUrl);
  const mediaType = value.mediaType === "tv" ? "tv" : value.mediaType === "movie" ? "movie" : null;
  if (!/^\d{1,16}$/u.test(id) || !title || !mediaType || !/^https:\/\/movie\.douban\.com\/subject\/\d+\/$/u.test(sourceUrl)) return null;
  const genres = Array.isArray(value.genres)
    ? value.genres.filter((item): item is string => typeof item === "string").slice(0, 6)
    : [];
  const rating = asFiniteNumber(value.rating, -1);
  const posterUrl = isSafeDiscoveryPosterUrl(value.posterUrl, id, mediaType) ? value.posterUrl : undefined;
  return {
    id,
    title: title.slice(0, 120),
    ...(posterUrl ? { posterUrl } : {}),
    ...(typeof value.originalTitle === "string" && value.originalTitle.trim()
      ? { originalTitle: value.originalTitle.trim().slice(0, 160) }
      : {}),
    ...(typeof value.year === "string" && value.year.trim() ? { year: value.year.trim().slice(0, 12) } : {}),
    ...(rating >= 0 && rating <= 10 ? { rating } : {}),
    ...(typeof value.ratingCount === "number" && Number.isFinite(value.ratingCount)
      ? { ratingCount: Math.max(0, Math.floor(value.ratingCount)) }
      : {}),
    mediaType,
    genres,
    summary: asString(value.summary).slice(0, 320),
    ...(typeof value.role === "string" && value.role.trim() ? { role: value.role.trim().slice(0, 80) } : {}),
    sourceUrl
  };
}

function normalizeDiscoveryNames(payload: unknown): string[] {
  return Array.isArray(payload)
    ? payload.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 80))
      .filter((item, index, values) => values.indexOf(item) === index)
      .slice(0, 12)
    : [];
}

function normalizeDiscoveryActors(payload: unknown): DiscoveryActor[] {
  if (!Array.isArray(payload)) return [];
  const actors: DiscoveryActor[] = [];
  const seen = new Set<string>();
  for (const entry of payload) {
    const value = asRecord(entry);
    const name = (typeof entry === "string" ? entry : asString(value?.name)).trim().slice(0, 80);
    if (!name || seen.has(name)) continue;
    const id = asString(value?.id);
    actors.push({ name, ...( /^\d{1,16}$/u.test(id) ? { id } : {}) });
    seen.add(name);
    if (actors.length >= 12) break;
  }
  return actors;
}

function normalizeDiscoveryDetails(payload: unknown): DiscoveryItemDetails {
  const value = asRecord(payload);
  return {
    itemId: asString(value?.itemId),
    actors: normalizeDiscoveryActors(value?.actors),
    directors: normalizeDiscoveryNames(value?.directors)
  };
}

function normalizeDiscoveryActorProfile(payload: unknown): DiscoveryActorProfile {
  const value = asRecord(payload);
  const id = asString(value?.id);
  const name = asString(value?.name).trim();
  const normalizedId = /^\d{1,16}$/u.test(id) ? id : "";
  const works = normalizedId && Array.isArray(value?.works)
    ? value.works.map(normalizeDiscoveryMedia).filter((work): work is DiscoveryMedia => work !== null)
    : [];
  const avatarUrl = typeof value?.avatarUrl === "string"
    && normalizedId !== ""
    && value.avatarUrl === `/api/discovery/actors/${normalizedId}/avatar`
    ? value.avatarUrl
    : undefined;
  const page = Math.min(100, Math.max(1, Math.floor(asFiniteNumber(value?.page, 1))));
  const pageSize = Math.min(20, Math.max(1, Math.floor(asFiniteNumber(value?.pageSize, 10))));
  const total = Math.max(0, Math.floor(asFiniteNumber(value?.total, works.length)));
  return {
    id: normalizedId,
    name: name.slice(0, 120),
    ...(typeof value?.latinName === "string" && value.latinName.trim() ? { latinName: value.latinName.trim().slice(0, 160) } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    intro: asString(value?.intro, "暂无公开简介").slice(0, 600),
    works,
    page,
    pageSize,
    total,
    hasNext: asBoolean(value?.hasNext, page < 100 && page * pageSize < total)
  };
}

function normalizeDiscoveryMediaSearch(payload: unknown): DiscoveryMediaSearchResponse {
  const value = asRecord(payload);
  const items = Array.isArray(value?.items)
    ? value.items.map(normalizeDiscoveryMedia).filter((item): item is DiscoveryMedia => item !== null)
    : [];
  return {
    query: asString(value?.query),
    total: Math.max(0, Math.floor(asFiniteNumber(value?.total, items.length))),
    items
  };
}

function normalizeDiscoveryCollection(
  payload: unknown,
  expectedCollection: DiscoveryCollectionId
): DiscoveryCollectionResponse {
  const value = asRecord(payload);
  const rawCollection = asString(value?.collection) as DiscoveryCollectionId;
  const collection = discoveryCollections.has(rawCollection) ? rawCollection : expectedCollection;
  const items = Array.isArray(value?.items)
    ? value.items.map(normalizeDiscoveryItem).filter((item): item is DiscoveryItem => item !== null)
    : [];
  const page = Math.min(100, Math.max(1, Math.floor(asFiniteNumber(value?.page, 1))));
  const pageSize = Math.min(20, Math.max(1, Math.floor(asFiniteNumber(value?.pageSize, 10))));
  const total = Math.max(0, Math.floor(asFiniteNumber(value?.total, items.length)));
  return {
    collection,
    updatedAt: asString(value?.updatedAt, new Date(0).toISOString()),
    stale: asBoolean(value?.stale),
    page,
    pageSize,
    total,
    hasNext: asBoolean(value?.hasNext, page < 100 && page * pageSize < total),
    items
  };
}

function normalizeDiscoveryReleases(payload: unknown): DiscoveryReleaseResponse {
  const value = asRecord(payload);
  const releases = Array.isArray(value?.releases)
    ? value.releases.map(normalizeRelease).filter((item): item is ReleaseSummary => item !== null)
    : [];
  const status = value?.status === "available" || value?.status === "possible"
    ? value.status
    : "unavailable";
  return {
    itemId: asString(value?.itemId),
    query: asString(value?.query),
    status,
    checkedAt: asString(value?.checkedAt, new Date(0).toISOString()),
    total: Math.max(0, Math.floor(asFiniteNumber(value?.total, releases.length))),
    releases
  };
}

function normalizePreview(payload: unknown): GrabPreviewResponse {
  const value = asRecord(payload);
  const release = normalizeRelease(value?.release);
  if (!release) {
    throw new ApiError("预览信息已失效，请重新选择片源。", 422);
  }

  return {
    release,
    // The destination is fixed by the local service contract. Keeping the
    // server value available in the type while displaying the fixed target
    // protects the visible copy from malformed responses.
    destination: DESTINATION_PATH,
    nasMounted: asBoolean(value?.nasMounted),
    duplicate: asBoolean(value?.duplicate),
    initialState: value?.initialState === "started" ? "started" : "stopped"
  };
}

function normalizeGrab(payload: unknown): GrabResponse {
  const value = asRecord(payload);
  return {
    accepted: asBoolean(value?.accepted),
    message: cleanMessage(value?.message),
    initialState: value?.initialState === "started" ? "started" : "stopped"
  };
}

function normalizeTorrent(payload: unknown): TorrentSummary | null {
  const value = asRecord(payload);
  if (!value) {
    return null;
  }

  const hash = asString(value.hash);
  const name = asString(value.name);
  if (!hash || !name) {
    return null;
  }

  return {
    hash,
    name,
    progress: asFiniteNumber(value.progress),
    state: asString(value.state, "unknown"),
    size: asFiniteNumber(value.size),
    downloadSpeed: asFiniteNumber(value.downloadSpeed),
    uploadSpeed: asFiniteNumber(value.uploadSpeed),
    eta: asFiniteNumber(value.eta),
    savePath: asString(value.savePath, DESTINATION_PATH)
  };
}

function normalizeTorrents(payload: unknown): TorrentSummary[] {
  const value = asRecord(payload);
  const list = Array.isArray(payload) ? payload : value && Array.isArray(value.torrents) ? value.torrents : [];
  return list.map(normalizeTorrent).filter((item): item is TorrentSummary => item !== null);
}

function asMediaType(value: unknown): "movie" | "tv" | null {
  if (value === "movie" || value === "tv") return value;
  return null;
}

function normalizeHistory(payload: unknown): HistoryResponse {
  const value = asRecord(payload);
  const seenSource = Array.isArray(value?.seen) ? value.seen : [];
  const seen = seenSource.flatMap((entry): SeenMediaEntry[] => {
    const record = asRecord(entry);
    if (!record) return [];
    const mediaId = asString(record.mediaId);
    const title = asString(record.title);
    const mediaType = asMediaType(record.mediaType);
    if (!mediaId || !title || !mediaType) return [];
    return [{ mediaId, mediaType, title, markedAt: asString(record.markedAt) }];
  });
  const preferences = assistantPreferencesSchema.safeParse(value?.preferences);
  return { seen, preferences: preferences.success ? preferences.data : defaultAssistantPreferences() };
}

export type ApiClient = {
  getSession(): Promise<SessionResponse>;
  getHealth(): Promise<ServiceHealth>;
  pair(request: PairRequest): Promise<SessionResponse>;
  search(request: SearchRequest, csrfToken: string): Promise<SearchResponse>;
  getDiscoveryCollection(
    collection: DiscoveryCollectionId,
    csrfToken: string,
    page?: number,
    limit?: number
  ): Promise<DiscoveryCollectionResponse>;
  getDiscoveryDetails(
    collection: DiscoveryCollectionId,
    itemId: string,
    csrfToken: string,
    page?: number,
    limit?: number
  ): Promise<DiscoveryItemDetails>;
  searchDiscoveryMedia(query: string, csrfToken: string, limit?: number): Promise<DiscoveryMediaSearchResponse>;
  getDiscoveryMediaDetails(
    mediaType: "movie" | "tv",
    itemId: string,
    csrfToken: string
  ): Promise<DiscoveryItemDetails>;
  getDiscoveryMediaReleases(
    mediaType: "movie" | "tv",
    itemId: string,
    csrfToken: string,
    limit?: number
  ): Promise<DiscoveryReleaseResponse>;
  refreshDiscoveryMediaReleases(
    mediaType: "movie" | "tv",
    itemId: string,
    csrfToken: string,
    limit?: number
  ): Promise<DiscoveryReleaseResponse>;
  getDiscoveryActor(
    name: string,
    csrfToken: string,
    page?: number,
    limit?: number
  ): Promise<DiscoveryActorProfile>;
  getDiscoveryReleases(
    collection: DiscoveryCollectionId,
    itemId: string,
    csrfToken: string,
    page?: number,
    limit?: number
  ): Promise<DiscoveryReleaseResponse>;
  refreshDiscoveryReleases(
    collection: DiscoveryCollectionId,
    itemId: string,
    csrfToken: string,
    page?: number,
    limit?: number
  ): Promise<DiscoveryReleaseResponse>;
  grabPreview(releaseId: string, csrfToken: string): Promise<GrabPreviewResponse>;
  grab(request: GrabRequest, csrfToken: string): Promise<GrabResponse>;
  getTorrents(csrfToken: string): Promise<TorrentSummary[]>;
  torrentAction?(request: TorrentActionRequest, csrfToken: string): Promise<TorrentActionResponse>;
  getHistory?(csrfToken: string): Promise<HistoryResponse>;
  markSeen?(request: MarkSeenRequest, csrfToken: string): Promise<void>;
  unmarkSeen?(mediaType: "movie" | "tv", mediaId: string, csrfToken: string): Promise<void>;
  getStorage(csrfToken: string): Promise<NasStorageSummary>;
  createAssistantTurnStream?(
    request: AssistantTurnRequest,
    csrfToken: string,
    onSnapshot: (snapshot: AssistantTurnResponse) => void,
    signal?: AbortSignal
  ): Promise<AssistantTurnResponse>;
  createAssistantTurn?(request: AssistantTurnRequest, csrfToken: string, signal?: AbortSignal): Promise<AssistantTurnResponse>;
  cancelAssistantTurn?(turnId: string, csrfToken: string): Promise<void>;
  clearAssistantConversation?(conversationId: string, csrfToken: string): Promise<void>;
};

function normalizeStorage(payload: unknown): NasStorageSummary {
  const value = asRecord(payload);
  const totalBytes = Math.max(0, asFiniteNumber(value?.totalBytes));
  const freeBytes = Math.min(totalBytes, Math.max(0, asFiniteNumber(value?.freeBytes)));
  const usedBytes = Math.min(totalBytes, Math.max(0, asFiniteNumber(value?.usedBytes, totalBytes - freeBytes)));
  return {
    path: asString(value?.path, DESTINATION_PATH),
    mounted: asBoolean(value?.mounted),
    ready: asBoolean(value?.ready),
    totalBytes,
    usedBytes,
    freeBytes
  };
}

function discoveryQuery(page?: number, limit?: number): string {
  const values: string[] = [];
  if (page !== undefined) values.push(`page=${Math.min(100, Math.max(1, Math.floor(page)))}`);
  if (limit !== undefined) values.push(`limit=${Math.min(20, Math.max(1, Math.floor(limit)))}`);
  return values.length > 0 ? `?${values.join("&")}` : "";
}

function discoveryActorQuery(name: string, page?: number, limit?: number): string {
  const values = [`name=${encodeURIComponent(name.trim().slice(0, 80))}`];
  if (page !== undefined) values.push(`page=${Math.min(100, Math.max(1, Math.floor(page)))}`);
  if (limit !== undefined) values.push(`limit=${Math.min(20, Math.max(1, Math.floor(limit)))}`);
  return `?${values.join("&")}`;
}

function discoveryMediaSearchQuery(query: string, limit?: number): string {
  const values = [`query=${encodeURIComponent(query.trim().slice(0, 80))}`];
  if (limit !== undefined) values.push(`limit=${Math.min(20, Math.max(1, Math.floor(limit)))}`);
  return `?${values.join("&")}`;
}

function discoveryMediaPath(mediaType: "movie" | "tv", itemId: string, resource: string): string {
  return `/api/discovery/media/${encodeURIComponent(mediaType)}/${encodeURIComponent(itemId)}/${resource}`;
}

export function createApiClient(fetchImpl?: typeof fetch): ApiClient {
  const withCsrf = (csrfToken: string): HeadersInit => ({ "X-CSRF-Token": csrfToken });

  return {
    async getSession() {
      return normalizeSession(await requestJson<unknown>("/api/session", undefined, fetchImpl));
    },

    async getHealth() {
      return normalizeHealth(await requestJson<unknown>("/api/health", undefined, fetchImpl));
    },

    async pair(request) {
      const payload = await requestJson<unknown>("/api/auth/pair", {
        method: "POST",
        body: JSON.stringify(request)
      }, fetchImpl);
      const session = normalizeSession(payload);
      // A successful pairing endpoint may intentionally return an empty body.
      return session.paired ? session : { ...session, paired: true };
    },

    async search(request, csrfToken) {
      return normalizeSearch(
        await requestJson<unknown>("/api/search", {
          method: "POST",
          headers: withCsrf(csrfToken),
          body: JSON.stringify(request)
        }, fetchImpl)
      );
    },

    async getDiscoveryCollection(collection, csrfToken, page, limit) {
      return normalizeDiscoveryCollection(
        await requestJson<unknown>(`/api/discovery/collections/${encodeURIComponent(collection)}/items${discoveryQuery(page, limit)}`, {
          headers: withCsrf(csrfToken)
        }, fetchImpl),
        collection
      );
    },

    async getDiscoveryDetails(collection, itemId, csrfToken, page, limit) {
      return normalizeDiscoveryDetails(
        await requestJson<unknown>(
          `/api/discovery/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(itemId)}/details${discoveryQuery(page, limit)}`,
          { headers: withCsrf(csrfToken) },
          fetchImpl
        )
      );
    },

    async searchDiscoveryMedia(query, csrfToken, limit) {
      return normalizeDiscoveryMediaSearch(
        await requestJson<unknown>(
          `/api/discovery/media${discoveryMediaSearchQuery(query, limit)}`,
          { headers: withCsrf(csrfToken) },
          fetchImpl
        )
      );
    },

    async getDiscoveryMediaDetails(mediaType, itemId, csrfToken) {
      return normalizeDiscoveryDetails(
        await requestJson<unknown>(
          discoveryMediaPath(mediaType, itemId, "details"),
          { headers: withCsrf(csrfToken) },
          fetchImpl
        )
      );
    },

    async getDiscoveryMediaReleases(mediaType, itemId, csrfToken, limit) {
      return normalizeDiscoveryReleases(
        await requestJson<unknown>(
          `${discoveryMediaPath(mediaType, itemId, "releases")}${limit === undefined ? "" : `?limit=${Math.min(20, Math.max(1, Math.floor(limit)))}`}`,
          { headers: withCsrf(csrfToken) },
          fetchImpl
        )
      );
    },

    async refreshDiscoveryMediaReleases(mediaType, itemId, csrfToken, limit) {
      return normalizeDiscoveryReleases(
        await requestJson<unknown>(
          `${discoveryMediaPath(mediaType, itemId, "releases/refresh")}${limit === undefined ? "" : `?limit=${Math.min(20, Math.max(1, Math.floor(limit)))}`}`,
          { method: "POST", headers: withCsrf(csrfToken) },
          fetchImpl
        )
      );
    },

    async getDiscoveryActor(name, csrfToken, page, limit) {
      return normalizeDiscoveryActorProfile(
        await requestJson<unknown>(
          `/api/discovery/actors${discoveryActorQuery(name, page, limit)}`,
          { headers: withCsrf(csrfToken) },
          fetchImpl
        )
      );
    },

    async getDiscoveryReleases(collection, itemId, csrfToken, page, limit) {
      return normalizeDiscoveryReleases(
        await requestJson<unknown>(
          `/api/discovery/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(itemId)}/releases${discoveryQuery(page, limit)}`,
          { headers: withCsrf(csrfToken) },
          fetchImpl
        )
      );
    },

    async refreshDiscoveryReleases(collection, itemId, csrfToken, page, limit) {
      return normalizeDiscoveryReleases(
        await requestJson<unknown>(
          `/api/discovery/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(itemId)}/releases/refresh${discoveryQuery(page, limit)}`,
          { method: "POST", headers: withCsrf(csrfToken) },
          fetchImpl
        )
      );
    },

    async grabPreview(releaseId, csrfToken) {
      return normalizePreview(
        await requestJson<unknown>("/api/grab/preview", {
          method: "POST",
          headers: withCsrf(csrfToken),
          body: JSON.stringify({ releaseId })
        }, fetchImpl)
      );
    },

    async grab(request, csrfToken) {
      return normalizeGrab(
        await requestJson<unknown>("/api/grab", {
          method: "POST",
          headers: withCsrf(csrfToken),
          body: JSON.stringify(request)
        }, fetchImpl)
      );
    },

    async getTorrents(csrfToken) {
      return normalizeTorrents(
        await requestJson<unknown>("/api/torrents", {
          headers: withCsrf(csrfToken)
        }, fetchImpl)
      );
    },

    async torrentAction(request, csrfToken) {
      // The response body is a boolean acknowledgement; requestJson already
      // throws on any non-2xx status, so reaching this point means accepted.
      await requestJson<unknown>("/api/torrents/actions", {
        method: "POST",
        headers: withCsrf(csrfToken),
        body: JSON.stringify(request)
      }, fetchImpl);
      return { ok: true };
    },

    async getStorage(csrfToken) {
      return normalizeStorage(
        await requestJson<unknown>("/api/storage", {
          headers: withCsrf(csrfToken)
        }, fetchImpl)
      );
    },

    async getHistory(csrfToken) {
      return normalizeHistory(
        await requestJson<unknown>("/api/history", {
          headers: withCsrf(csrfToken)
        }, fetchImpl)
      );
    },

    async markSeen(request, csrfToken) {
      await requestJson<unknown>("/api/history/seen", {
        method: "POST",
        headers: withCsrf(csrfToken),
        body: JSON.stringify(request)
      }, fetchImpl);
    },

    async unmarkSeen(mediaType, mediaId, csrfToken) {
      await requestJson<unknown>(
        `/api/history/seen/${encodeURIComponent(mediaType)}/${encodeURIComponent(mediaId)}`,
        { method: "DELETE", headers: withCsrf(csrfToken) },
        fetchImpl
      );
    },

    async createAssistantTurnStream(request, csrfToken, onSnapshot, signal) {
      return requestAssistantTurnStream(request, csrfToken, onSnapshot, signal, fetchImpl);
    },

    async createAssistantTurn(request, csrfToken, signal) {
      return normalizeAssistantTurn(
        await requestJson<unknown>("/api/assistant/turns", {
          method: "POST",
          headers: withCsrf(csrfToken),
          ...(signal ? { signal } : {}),
          body: JSON.stringify(request)
        }, fetchImpl)
      );
    },

    async cancelAssistantTurn(turnId, csrfToken) {
      await requestJson<unknown>(`/api/assistant/turns/${encodeURIComponent(turnId)}/cancel`, {
        method: "POST",
        headers: withCsrf(csrfToken)
      }, fetchImpl);
    },

    async clearAssistantConversation(conversationId, csrfToken) {
      await requestJson<unknown>(`/api/assistant/conversations/${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
        headers: withCsrf(csrfToken)
      }, fetchImpl);
    }
  };
}

export const apiClient = createApiClient();
