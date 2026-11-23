import type {
  DiscoveryMedia,
  DiscoveryReleaseResponse,
  ReleaseSummary,
} from "../../shared/contracts.js";
import {
  selectionPreferencesSchema,
  selectionTargetSchema,
} from "../../shared/release-selection.js";
import type {
  AssistantAvailability,
  AssistantConstraintResult,
  AssistantPreferences,
  AssistantRankedRelease,
  AssistantRecommendationCard,
  AssistantReleaseEvidence,
} from "../../shared/assistant.js";
import { parseReleaseFacts } from "../release-selection/parser.js";
import {
  FREELEECH_VALIDITY_MS,
  matchWorkIdentity,
  rankSelection,
  type SelectionMediaIdentity,
} from "../release-selection/ranking.js";

export type ReleaseWithEvidence = ReleaseSummary & {
  freeleechState?: "yes" | "no" | "unknown";
  evidence?: AssistantReleaseEvidence;
};

export type DiscoveryReleaseSnapshot = DiscoveryReleaseResponse & {
  snapshotId?: string;
  expiresAt?: string;
  actionableUntil?: string;
};

export type RecommendationCandidate = {
  media: DiscoveryMedia;
  snapshot?: DiscoveryReleaseSnapshot;
  releaseError?: string;
};

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, max)
    : "";
}

function mediaIdentity(media: DiscoveryMedia): SelectionMediaIdentity {
  return {
    mediaType: media.mediaType,
    itemId: media.id,
    title: media.title,
    ...(media.originalTitle ? { originalTitle: media.originalTitle } : {}),
    ...(media.year ? { year: media.year } : {}),
  };
}

/**
 * Assistant matching now uses the shared identity matcher with the explicit
 * "assistant" policy (TV stays possible, year mismatch is possible rather
 * than a hard conflict).  The selection surface uses the stricter policy.
 */
function releaseTitleMatch(
  media: DiscoveryMedia,
  release: ReleaseSummary,
): "confirmed" | "possible" | "unknown" {
  const identity = matchWorkIdentity(
    mediaIdentity(media),
    parseReleaseFacts(release.title),
    "assistant",
  );
  if (identity.status === "matched") return "confirmed";
  if (identity.status === "possible") return "possible";
  return "unknown";
}

function releaseSizeKnown(release: ReleaseWithEvidence): boolean {
  return release.evidence
    ? release.evidence.size === "upstream"
    : release.size > 0;
}

function releaseSeedersKnown(release: ReleaseWithEvidence): boolean {
  return release.evidence
    ? release.evidence.seeders === "upstream"
    : release.seeders > 0;
}

function freeleechState(
  release: ReleaseWithEvidence,
): "yes" | "no" | "unknown" {
  if (release.freeleechState) return release.freeleechState;
  return release.freeleech ? "yes" : "unknown";
}

function toAssistantRankedRelease(
  ranked: ReturnType<typeof rankSelection>["recommendations"][number],
  release: ReleaseSummary | undefined,
  prefs: AssistantPreferences,
  rank: number,
): AssistantRankedRelease {
  const matchStatus =
    ranked.identity === "matched"
      ? "confirmed"
      : ranked.identity === "possible"
        ? "possible"
        : "unknown";
  const codes: AssistantRankedRelease["reasonCodes"] = [];
  if (ranked.reasonCodes.includes("WITHIN_SIZE_LIMIT"))
    codes.push("WITHIN_SIZE_LIMIT");
  if (
    ranked.reasonCodes.includes("PREFERRED_RESOLUTION") ||
    ranked.reasonCodes.includes("REQUIRED_RESOLUTION_MET")
  )
    codes.push("PREFERRED_RESOLUTION");
  if (prefs.freeleechPreferred && ranked.freeleechState === "yes")
    codes.push("PREFERRED_FREELEECH");
  if (ranked.reasonCodes.includes("MORE_SEEDERS")) codes.push("MORE_SEEDERS");
  if (ranked.identity === "matched") codes.push("MATCHED_TITLE");
  if (ranked.identity === "possible") codes.push("POSSIBLE_MATCH");
  if (ranked.reasonCodes.includes("SEEDERS_UNKNOWN")) codes.push("SEEDERS_UNKNOWN");
  return {
    id: ranked.releaseId,
    title: cleanText(ranked.title, 240),
    indexer: cleanText(ranked.indexer, 100),
    protocol: ranked.protocol,
    size: Math.max(0, ranked.size),
    seeders: Math.max(0, Math.floor(ranked.seeders)),
    leechers: Math.max(0, Math.floor(ranked.leechers)),
    grabs: Math.max(0, Math.floor(ranked.grabs)),
    ageDays: Math.max(0, ranked.ageDays),
    categories: ranked.categories
      .map((category) => cleanText(category, 80))
      .filter(Boolean)
      .slice(0, 20),
    ...(ranked.resolution ? { resolution: ranked.resolution } : {}),
    ...(ranked.codec ? { codec: cleanText(ranked.codec, 40) } : {}),
    ...(release?.season ? { season: release.season } : {}),
    freeleech: Boolean(ranked.freeleech),
    ...(ranked.freeleechState
      ? { freeleechState: ranked.freeleechState }
      : {}),
    ...(release?.evidence ? { evidence: release.evidence } : {}),
    rank,
    reasonCodes: codes,
    matchStatus,
  };
}

/**
 * Assistant ranking adapter.  The ordering, hard constraints and dedupe all
 * come from the shared selection engine; only the returned shape and the
 * explicit "assistant" identity policy differ.
 */
export function rankReleases(
  media: DiscoveryMedia,
  snapshot: DiscoveryReleaseSnapshot,
  prefs: AssistantPreferences,
  limit = 3,
): AssistantRankedRelease[] {
  const boundedLimit = Math.min(3, Math.max(0, Math.floor(limit)));
  if (boundedLimit === 0) return [];
  const target = selectionTargetSchema.parse({
    kind: media.mediaType === "tv" ? "series" : "movie",
    mode: "browse",
  });
  const preferences = selectionPreferencesSchema.parse({
    preset: "balanced",
    freeleechOnly: prefs.freeleechRequired,
    freeleechPreferred: prefs.freeleechPreferred,
    resolution: prefs.resolution
      ? { value: prefs.resolution, strength: "required" }
      : null,
    maxSizeBytes: prefs.maxSizeBytes,
  });
  const ranked = rankSelection({
    media: mediaIdentity(media),
    releases: snapshot.releases,
    target,
    preferences,
    identityPolicy: "assistant",
    ...(snapshot.checkedAt ? { snapshotCheckedAt: snapshot.checkedAt } : {}),
  });
  const byId = new Map(snapshot.releases.map((release) => [release.id, release]));
  return ranked.recommendations
    .slice(0, boundedLimit)
    .map((entry, index) =>
      toAssistantRankedRelease(entry, byId.get(entry.releaseId), prefs, index + 1),
    );
}
/**
 * The assistant availability path must not claim a promotion is still current
 * from an old snapshot; it uses the same bounded window as the shared engine.
 */
function effectiveFreeleechForSnapshot(
  release: ReleaseWithEvidence,
  snapshot: DiscoveryReleaseSnapshot,
): "yes" | "no" | "unknown" {
  const state = freeleechState(release);
  if (state !== "yes") return state;
  const checkedAt = snapshot.checkedAt ? Date.parse(snapshot.checkedAt) : NaN;
  if (!Number.isFinite(checkedAt)) return "unknown";
  return Date.now() - checkedAt <= FREELEECH_VALIDITY_MS ? "yes" : "unknown";
}

function hardMatch(
  release: ReleaseWithEvidence,
  prefs: AssistantPreferences,
  matchStatus: "confirmed" | "possible" | "unknown",
  freeState: "yes" | "no" | "unknown",
): boolean {
  if (release.protocol !== "torrent") return false;
  if (matchStatus !== "confirmed") return false;
  if (prefs.resolution && release.resolution !== prefs.resolution) return false;
  if (
    prefs.maxSizeBytes !== null &&
    (!releaseSizeKnown(release) || release.size > prefs.maxSizeBytes)
  )
    return false;
  if (prefs.freeleechRequired && freeState !== "yes") return false;
  return true;
}

export function availabilityForSnapshot(
  snapshot: DiscoveryReleaseSnapshot,
): AssistantAvailability {
  // Without the media entity we cannot prove title/year matching. Keep this
  // helper conservative for callers that only have the raw snapshot.
  return snapshot.releases.length > 0 ? "possible" : "unavailable";
}

export function availabilityForMediaSnapshot(
  media: DiscoveryMedia,
  snapshot: DiscoveryReleaseSnapshot,
  prefs: AssistantPreferences,
): AssistantAvailability {
  if (!snapshot.releases.length) return "unavailable";
  let possible = false;
  for (const release of snapshot.releases) {
    const typed = release as ReleaseWithEvidence;
    const matchStatus = releaseTitleMatch(media, typed);
    if (matchStatus === "unknown") continue;
    if (
      matchStatus === "possible" ||
      !releaseSeedersKnown(typed) ||
      typed.seeders === 0
    )
      possible = true;
    if (
      hardMatch(
        typed,
        prefs,
        matchStatus,
        effectiveFreeleechForSnapshot(typed, snapshot),
      ) &&
      releaseSeedersKnown(typed) &&
      typed.seeders > 0
    ) {
      return "available";
    }
  }
  return possible ? "possible" : "unavailable";
}

export function constraintResults(
  media: DiscoveryMedia,
  prefs: AssistantPreferences,
  snapshot?: DiscoveryReleaseSnapshot,
): AssistantConstraintResult[] {
  const genres = new Set(
    media.genres.map((genre) => genre.toLocaleLowerCase()).filter(Boolean),
  );
  const results: AssistantConstraintResult[] = [];
  for (const genre of prefs.includeGenres) {
    const met = [...genres].some((candidate) =>
      candidate.includes(genre.toLocaleLowerCase()),
    );
    results.push({
      key: `includeGenre:${genre}`,
      status: genres.size === 0 ? "unknown" : met ? "met" : "unknown",
      detail:
        genres.size === 0
          ? `类型未知，无法确认${genre}`
          : met
            ? `类型包含${genre}`
            : `类型未从元数据确认包含${genre}`,
    });
  }
  for (const genre of prefs.excludeGenres) {
    const contains = [...genres].some((candidate) =>
      candidate.includes(genre.toLocaleLowerCase()),
    );
    results.push({
      key: `excludeGenre:${genre}`,
      status: genres.size === 0 ? "unknown" : contains ? "not_met" : "met",
      detail:
        genres.size === 0
          ? `类型未知，无法确认不包含${genre}`
          : contains
            ? `元数据包含排除类型${genre}`
            : `未发现排除类型${genre}`,
    });
  }
  if (prefs.yearFrom !== null || prefs.yearTo !== null) {
    const year = Number(media.year);
    const known = Number.isInteger(year);
    const met =
      known &&
      (prefs.yearFrom === null || year >= prefs.yearFrom) &&
      (prefs.yearTo === null || year <= prefs.yearTo);
    results.push({
      key: "yearRange",
      status: !known ? "unknown" : met ? "met" : "not_met",
      detail: !known
        ? "年份未知"
        : met
          ? `年份${media.year}符合范围`
          : `年份${media.year}不符合范围`,
    });
  }
  if (snapshot) {
    const snapshotAvailability = availabilityForMediaSnapshot(
      media,
      snapshot,
      prefs,
    );
    results.push({
      key: "ptAvailability",
      status:
        snapshotAvailability === "available"
          ? "met"
          : snapshotAvailability === "unavailable"
            ? "not_met"
            : "unknown",
      detail:
        snapshotAvailability === "available"
          ? "已从 PT 快照确认有匹配做种"
          : snapshotAvailability === "possible"
            ? "找到候选但匹配或做种仍需确认"
            : "快照未找到匹配资源",
    });
  } else if (prefs.onlyAvailable) {
    results.push({
      key: "ptAvailability",
      status: "unknown",
      detail: "尚未检查 PT 资源",
    });
  }
  const ranked = snapshot ? rankReleases(media, snapshot, prefs) : [];
  for (const [key, required, label] of [
    ["resolution", Boolean(prefs.resolution), "清晰度要求"],
    ["maxSizeBytes", prefs.maxSizeBytes !== null, "大小限制"],
    ["freeleechRequired", prefs.freeleechRequired, "免费要求"],
  ] as const) {
    if (required)
      results.push({
        key,
        status: !snapshot ? "unknown" : ranked.length ? "met" : "unknown",
        detail: ranked.length
          ? `${label}已满足`
          : `${label}尚未找到满足全部条件的版本`,
      });
  }
  return results.slice(0, 20);
}

export function defaultReason(
  media: DiscoveryMedia,
  availability: AssistantAvailability,
): string {
  const type = media.mediaType === "tv" ? "剧集" : "电影";
  const availabilityText =
    availability === "available"
      ? "已有快照确认至少有可用做种"
      : availability === "possible"
        ? "找到候选资源，但匹配或做种状态仍需确认"
        : availability === "unavailable"
          ? "当前快照没有找到资源"
          : "尚未检查 PT 资源";
  return `${media.title} 是一部${type}；${availabilityText}。`;
}

export function buildRecommendationCard(
  conversationId: string,
  turnId: string,
  index: number,
  candidate: RecommendationCandidate,
  prefs: AssistantPreferences,
  modelReason = "",
  modelEvidenceIds: string[] = [],
  _modelConstraints: AssistantConstraintResult[] = [],
): AssistantRecommendationCard {
  const availability = candidate.releaseError
    ? "error"
    : candidate.snapshot
      ? availabilityForMediaSnapshot(candidate.media, candidate.snapshot, prefs)
      : "unchecked";
  const rankedReleases = candidate.snapshot
    ? rankReleases(candidate.media, candidate.snapshot, prefs, 3)
    : [];
  const evidenceIds = new Set<string>([
    `metadata:${candidate.media.mediaType}:${candidate.media.id}`,
    ...(candidate.snapshot?.snapshotId
      ? [`release_snapshot:${candidate.snapshot.snapshotId}`]
      : []),
  ]);
  modelEvidenceIds.forEach((id) => {
    if (evidenceIds.has(id)) evidenceIds.add(id);
  });
  const checkedAt = candidate.snapshot?.checkedAt;
  const reason =
    cleanText(modelReason, 800) || defaultReason(candidate.media, availability);
  const constraints = [
    ...constraintResults(candidate.media, prefs, candidate.snapshot),
  ]
    .filter(
      (value, position, values) =>
        values.findIndex((entry) => entry.key === value.key) === position,
    )
    .slice(0, 20);
  return {
    cardId: `card_${conversationId.slice(0, 12)}_${turnId.slice(0, 12)}_${index + 1}`,
    mediaId: cleanText(candidate.media.id, 64),
    mediaType: candidate.media.mediaType,
    title: cleanText(candidate.media.title, 240),
    ...(candidate.media.originalTitle
      ? { originalTitle: cleanText(candidate.media.originalTitle, 240) }
      : {}),
    ...(candidate.media.year
      ? { year: cleanText(candidate.media.year, 16) }
      : {}),
    genres: candidate.media.genres
      .map((genre) => cleanText(genre, 40))
      .filter(Boolean)
      .slice(0, 20),
    summary: cleanText(candidate.media.summary, 900),
    reason,
    evidenceIds: [...evidenceIds].slice(0, 20),
    constraintResults: constraints,
    availability,
    ...(checkedAt ? { checkedAt } : {}),
    ...(candidate.snapshot?.snapshotId
      ? { snapshotId: candidate.snapshot.snapshotId }
      : {}),
    ...(candidate.snapshot?.expiresAt
      ? { expiresAt: candidate.snapshot.expiresAt }
      : {}),
    ...(candidate.snapshot?.actionableUntil
      ? { actionableUntil: candidate.snapshot.actionableUntil }
      : {}),
    rankedReleases,
  };
}

export function filterCandidateForPreferences(
  media: DiscoveryMedia,
  prefs: AssistantPreferences,
  knownSeen?: ReadonlySet<string>,
): boolean {
  const mediaId = `${media.mediaType}:${media.id}`;
  if (
    prefs.seenMediaIds.includes(media.id) ||
    prefs.seenMediaIds.includes(mediaId)
  )
    return false;
  // The persisted seen collection can exceed the bounded preference array;
  // the durable set stays authoritative for exclusion.
  if (knownSeen?.has(media.id) || knownSeen?.has(mediaId)) return false;
  const genres = media.genres.map((genre) => genre.toLocaleLowerCase());
  if (
    prefs.includeGenres.length &&
    !prefs.includeGenres.every((genre) =>
      genres.some((candidate) => candidate.includes(genre.toLocaleLowerCase())),
    )
  )
    return false;
  if (prefs.excludeGenres.length && !genres.length) return false;
  if (
    prefs.excludeGenres.some((genre) =>
      genres.some((candidate) => candidate.includes(genre.toLocaleLowerCase())),
    )
  )
    return false;
  const year = media.year ? Number(media.year) : NaN;
  if (
    (prefs.yearFrom !== null || prefs.yearTo !== null) &&
    !Number.isInteger(year)
  )
    return false;
  if (
    prefs.yearFrom !== null &&
    Number.isInteger(year) &&
    year < prefs.yearFrom
  )
    return false;
  if (prefs.yearTo !== null && Number.isInteger(year) && year > prefs.yearTo)
    return false;
  if (prefs.mediaType && media.mediaType !== prefs.mediaType) return false;
  return true;
}
