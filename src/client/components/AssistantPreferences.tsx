import type { AssistantPreferences as AssistantPreferenceValues } from "../../shared/assistant";
import { formatBytes } from "./ReleaseList";

function mediaTypeLabel(value: AssistantPreferenceValues["mediaType"]): string {
  return value === "tv" ? "剧集" : value === "movie" ? "电影" : "电影或剧集";
}

function yearLabel(preferences: AssistantPreferenceValues): string | null {
  if (preferences.yearFrom !== null && preferences.yearTo !== null) return `${preferences.yearFrom}–${preferences.yearTo}`;
  if (preferences.yearFrom !== null) return `${preferences.yearFrom} 年后`;
  if (preferences.yearTo !== null) return `${preferences.yearTo} 年前`;
  return null;
}

export function AssistantPreferences({ preferences }: { preferences: AssistantPreferenceValues | null }) {
  if (!preferences) return null;
  const chips = [
    `类型：${mediaTypeLabel(preferences.mediaType)}`,
    preferences.includeGenres.length > 0 ? `偏好：${preferences.includeGenres.join("、")}` : null,
    preferences.excludeGenres.length > 0 ? `排除：${preferences.excludeGenres.join("、")}` : null,
    preferences.mood ? `氛围：${preferences.mood}` : null,
    yearLabel(preferences) ? `年代：${yearLabel(preferences)}` : null,
    preferences.resolution ? `清晰度：${preferences.resolution}` : null,
    preferences.maxSizeBytes ? `大小 ≤ ${formatBytes(preferences.maxSizeBytes)}` : null,
    preferences.freeleechRequired ? "只要免费" : preferences.freeleechPreferred ? "偏好免费" : null,
    preferences.onlyAvailable ? "只看有资源" : null,
    preferences.seenMediaIds.length > 0 ? `已排除看过 ${preferences.seenMediaIds.length} 部` : null
  ].filter((chip): chip is string => Boolean(chip));

  if (chips.length === 0) return null;
  return (
    <section className="assistant-preferences" aria-label="当前推荐偏好">
      <div className="assistant-preferences-heading">
        <span className="eyebrow">CURRENT FILTERS</span>
        <span>{chips.length} 项</span>
      </div>
      <div className="assistant-preference-chips">
        {chips.map((chip) => <span className="assistant-preference-chip" key={chip}>{chip}</span>)}
      </div>
    </section>
  );
}

export default AssistantPreferences;
