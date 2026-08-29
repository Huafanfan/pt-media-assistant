import type { GrabResponse, GrabPreviewResponse, ReleaseSummary, ServiceHealth, TorrentSummary } from "../shared/contracts";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: number;
};

export type SearchState = "idle" | "loading" | "success" | "error";

export type SelectionState = {
  release: ReleaseSummary;
  index: number;
  preview: GrabPreviewResponse | null;
};

export type GrabState = {
  result: GrabResponse;
  torrents: TorrentSummary[];
};

export type HealthView = {
  health: ServiceHealth | null;
  error: string | null;
};
