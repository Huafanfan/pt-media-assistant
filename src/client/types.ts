import type { GrabResponse, GrabPreviewResponse, ReleaseSummary, ServiceHealth, TorrentSummary } from "../shared/contracts";
import type {
  AssistantAvailability,
  AssistantPreferences,
  AssistantRecommendationCard,
  AssistantTurnResponse,
  AssistantWarning
} from "../shared/assistant";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: number;
};

export type AssistantConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  recommendations?: AssistantRecommendationCard[];
  preferences?: AssistantPreferences;
  warnings?: AssistantWarning[];
  status?: "pending" | "cancelled";
};

export type AssistantRequestState = {
  loading: boolean;
  error: string | null;
  errorCode?: string;
  activeTurnId: string | null;
};

export type AssistantResponse = AssistantTurnResponse;

export type AssistantAvailabilityLabel = {
  label: string;
  tone: "success" | "warning" | "muted" | "danger";
};

export type AssistantCardReference = {
  card: AssistantRecommendationCard;
  availability: AssistantAvailability;
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
