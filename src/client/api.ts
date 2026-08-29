import type {
  DiscoveryCollectionId,
  DiscoveryCollectionResponse,
  DiscoveryItem,
  DiscoveryReleaseResponse,
  GrabPreviewResponse,
  GrabRequest,
  GrabResponse,
  NasStorageSummary,
  PairRequest,
  ReleaseSummary,
  SearchResponse,
  SearchRequest,
  ServiceHealth,
  SessionResponse,
  TorrentSummary
} from "../shared/contracts";

export const DESTINATION_PATH = "/Volumes/YourNAS/pt";

type JsonRecord = Record<string, unknown>;

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

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
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

function normalizeHealth(payload: unknown): ServiceHealth {
  const value = asRecord(payload);
  const services = asRecord(value?.services);
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
      : {})
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
    freeleech: asBoolean(value.freeleech)
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
  const value = asRecord(payload);
  if (!value) return null;
  const id = asString(value.id);
  const title = asString(value.title);
  const sourceUrl = asString(value.sourceUrl);
  if (!/^\d{1,16}$/u.test(id) || !title || !/^https:\/\/movie\.douban\.com\/subject\/\d+\/$/u.test(sourceUrl)) {
    return null;
  }
  const genres = Array.isArray(value.genres)
    ? value.genres.filter((item): item is string => typeof item === "string").slice(0, 6)
    : [];
  const rating = asFiniteNumber(value.rating, -1);
  return {
    id,
    title: title.slice(0, 120),
    ...(typeof value.originalTitle === "string" && value.originalTitle.trim()
      ? { originalTitle: value.originalTitle.trim().slice(0, 160) }
      : {}),
    ...(typeof value.year === "string" && value.year.trim() ? { year: value.year.trim().slice(0, 12) } : {}),
    ...(rating >= 0 && rating <= 10 ? { rating } : {}),
    ...(typeof value.ratingCount === "number" && Number.isFinite(value.ratingCount)
      ? { ratingCount: Math.max(0, Math.floor(value.ratingCount)) }
      : {}),
    rank: Math.max(1, Math.floor(asFiniteNumber(value.rank, 1))),
    mediaType: value.mediaType === "tv" ? "tv" : "movie",
    genres,
    summary: asString(value.summary).slice(0, 320),
    sourceUrl
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
  return {
    collection,
    updatedAt: asString(value?.updatedAt, new Date(0).toISOString()),
    stale: asBoolean(value?.stale),
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

export type ApiClient = {
  getSession(): Promise<SessionResponse>;
  getHealth(): Promise<ServiceHealth>;
  pair(request: PairRequest): Promise<SessionResponse>;
  search(request: SearchRequest, csrfToken: string): Promise<SearchResponse>;
  getDiscoveryCollection(collection: DiscoveryCollectionId, csrfToken: string): Promise<DiscoveryCollectionResponse>;
  getDiscoveryReleases(
    collection: DiscoveryCollectionId,
    itemId: string,
    csrfToken: string
  ): Promise<DiscoveryReleaseResponse>;
  grabPreview(releaseId: string, csrfToken: string): Promise<GrabPreviewResponse>;
  grab(request: GrabRequest, csrfToken: string): Promise<GrabResponse>;
  getTorrents(csrfToken: string): Promise<TorrentSummary[]>;
  getStorage(csrfToken: string): Promise<NasStorageSummary>;
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

    async getDiscoveryCollection(collection, csrfToken) {
      return normalizeDiscoveryCollection(
        await requestJson<unknown>(`/api/discovery/collections/${encodeURIComponent(collection)}/items`, {
          headers: withCsrf(csrfToken)
        }, fetchImpl),
        collection
      );
    },

    async getDiscoveryReleases(collection, itemId, csrfToken) {
      return normalizeDiscoveryReleases(
        await requestJson<unknown>(
          `/api/discovery/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(itemId)}/releases`,
          { headers: withCsrf(csrfToken) },
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

    async getStorage(csrfToken) {
      return normalizeStorage(
        await requestJson<unknown>("/api/storage", {
          headers: withCsrf(csrfToken)
        }, fetchImpl)
      );
    }
  };
}

export const apiClient = createApiClient();
