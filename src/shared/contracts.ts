export type ServiceHealth = {
  status: "ok" | "degraded";
  version: string;
  pairingRequired: boolean;
  services?: {
    prowlarr: boolean;
    qbittorrent: boolean;
    nasMounted: boolean;
  };
};

export type NasStorageSummary = {
  mounted: boolean;
  ready: boolean;
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
};

export type PairRequest = { code: string };

export type SessionResponse = {
  paired: boolean;
  csrfToken?: string;
};

export type ParsedIntent = {
  searchTerm: string;
  resolution?: "2160p" | "1080p" | "720p";
  maxSizeBytes?: number;
  freeleechOnly?: boolean;
};

export type SearchRequest = {
  query: string;
  limit?: number;
};

export type ReleaseSummary = {
  id: string;
  title: string;
  indexer: string;
  protocol: "torrent" | "usenet";
  size: number;
  seeders: number;
  leechers: number;
  grabs: number;
  ageDays: number;
  categories: string[];
  resolution?: string;
  codec?: string;
  freeleech: boolean;
  freeleechState?: "yes" | "no" | "unknown";
  evidence?: {
    resolution: "upstream" | "title_inferred" | "unknown";
    codec: "upstream" | "title_inferred" | "unknown";
    size: "upstream" | "unknown";
    seeders: "upstream" | "unknown";
  };
};

export type SearchResponse = {
  query: string;
  intent: ParsedIntent;
  total: number;
  elapsedMs: number;
  releases: ReleaseSummary[];
};

export type DiscoveryCollectionId =
  | "movie-hot"
  | "movie-weekly"
  | "tv-hot"
  | "tv-weekly"
  | "top250";

/** Canonical media summary shared by every discovery entry point. */
export type DiscoveryMedia = {
  id: string;
  title: string;
  posterUrl?: string;
  originalTitle?: string;
  year?: string;
  rating?: number;
  ratingCount?: number;
  mediaType: "movie" | "tv";
  genres: string[];
  summary: string;
  role?: string;
  sourceUrl: string;
};

export type DiscoveryItem = DiscoveryMedia & {
  rank: number;
};

export type DiscoveryItemDetails = {
  itemId: string;
  actors: DiscoveryActor[];
  directors: string[];
};

/** The browser only needs the display name to open the actor dimension. */
export type DiscoveryActor = {
  name: string;
  id?: string;
};

export type DiscoveryActorWork = DiscoveryMedia;

export type DiscoveryActorProfile = {
  id: string;
  name: string;
  latinName?: string;
  avatarUrl?: string;
  intro: string;
  works: DiscoveryActorWork[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
};

export type DiscoveryMediaSearchResponse = {
  query: string;
  total: number;
  items: DiscoveryMedia[];
};

export type DiscoveryCollectionResponse = {
  collection: DiscoveryCollectionId;
  updatedAt: string;
  stale: boolean;
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  items: DiscoveryItem[];
};

export type DiscoveryReleaseStatus = "available" | "possible" | "unavailable";

export type DiscoveryReleaseResponse = {
  snapshotId?: string;
  expiresAt?: string;
  actionableUntil?: string;
  itemId: string;
  query: string;
  status: DiscoveryReleaseStatus;
  checkedAt: string;
  total: number;
  releases: ReleaseSummary[];
};

export type GrabPreviewRequest = { releaseId: string };

export type GrabPreviewResponse = {
  release: ReleaseSummary;
  destination: string;
  nasMounted: boolean;
  duplicate: boolean;
  initialState: "started" | "stopped";
};

export type GrabRequest = {
  releaseId: string;
  confirm: true;
};

export type GrabResponse = {
  accepted: boolean;
  message: string;
  initialState: "started" | "stopped";
};

export type TorrentSummary = {
  hash: string;
  name: string;
  progress: number;
  state: string;
  size: number;
  downloadSpeed: number;
  uploadSpeed: number;
  eta: number;
  savePath: string;
};

/** The browser can only pause, resume, or remove a task record. */
export type TorrentAction = "pause" | "resume" | "remove";

export type TorrentActionRequest = {
  action: TorrentAction;
  hashes: string[];
};

export type TorrentActionResponse = { ok: boolean };

export type ApiErrorBody = {
  error: string;
  code?: string;
  details?: unknown;
};
