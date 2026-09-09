import type { AssistantPreferences as AssistantPreferenceValues } from "../../shared/assistant";
import { formatBytes } from "./ReleaseList";

function mediaTypeLabel(value: AssistantPreferenceValues["mediaType"]): string {
  return value === "tv" ? "剧集" : value === "movie" ? "电影" : "";
}

function yearLabel(preferences: AssistantPreferenceValues): string | null {
  if (preferences.yearFrom !== null && preferences.yearTo !== null) return `${preferences.yearFrom}–${preferences.yearTo}`;
  if (preferences.yearFrom !== null) return `${preferences.yearFrom} 年后`;
  if (preferences.yearTo !== null) return `${preferences.yearTo} 年前`;
  return null;
}

export function AssistantPreferences({ preferences }: { preferences: AssistantPreferenceValues | null }) {
  if (!preferences) return null;
  const values = [
    mediaTypeLabel(preferences.mediaType),
    preferences.includeGenres.length > 0 ? `类型 ${preferences.includeGenres.join("、")}` : null,
    preferences.excludeGenres.length > 0 ? `排除 ${preferences.excludeGenres.join("、")}` : null,
    preferences.mood ? `氛围 ${preferences.mood}` : null,
    yearLabel(preferences),
    preferences.resolution ? `清晰度 ${preferences.resolution}` : null,
    preferences.maxSizeBytes ? `≤ ${formatBytes(preferences.maxSizeBytes)}` : null,
    preferences.freeleechRequired ? "免费" : preferences.freeleechPreferred ? "偏好免费" : null,
    preferences.onlyAvailable ? "有资源" : null,
    preferences.seenMediaIds.length > 0 ? `已排除看过 ${preferences.seenMediaIds.length} 部` : null
  ].filter((value): value is string => Boolean(value));

  if (values.length === 0) return null;
  return (
    <section className="assistant-preferences" aria-label="当前推荐偏好">
      <details>
        <summary>
          <span>已应用偏好</span>
          <span className="assistant-preferences-count">{values.length} 项</span>
        </summary>
        <p className="assistant-preferences-values">{values.join(" · ")}</p>
      </details>
    </section>
  );
}

export default AssistantPreferences;
