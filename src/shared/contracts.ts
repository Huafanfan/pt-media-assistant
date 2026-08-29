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

export type DiscoveryItem = {
  id: string;
  title: string;
  originalTitle?: string;
  year?: string;
  rating?: number;
  ratingCount?: number;
  rank: number;
  mediaType: "movie" | "tv";
  genres: string[];
  summary: string;
  sourceUrl: string;
};

export type DiscoveryCollectionResponse = {
  collection: DiscoveryCollectionId;
  updatedAt: string;
  stale: boolean;
  items: DiscoveryItem[];
};

export type DiscoveryReleaseStatus = "available" | "possible" | "unavailable";

export type DiscoveryReleaseResponse = {
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

export type ApiErrorBody = {
  error: string;
  code?: string;
  details?: unknown;
};
