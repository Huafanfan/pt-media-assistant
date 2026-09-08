import type {
  DiscoveryMedia,
  DiscoveryReleaseResponse,
  ReleaseSummary,
} from "../../shared/contracts.js";
import type {
  AssistantAvailability,
  AssistantConstraintResult,
  AssistantPreferences,
  AssistantRankedRelease,
  AssistantRecommendationCard,
  AssistantReleaseEvidence,
} from "../../shared/assistant.js";

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
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max)
    : "";
}

const GENERIC_TITLE_WORDS = new Set(["the", "a", "an", "film", "movie", "season", "series"]);

function tokens(value: string): string[] {
  return cleanText(value, 240)
    .toLocaleLowerCase()
    .replace(/[“”"'‘’·•:：/\\()[\]{}.,!?！？_+-]/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 1 && !GENERIC_TITLE_WORDS.has(token));
}

function aliases(media: DiscoveryMedia): string[][] {
  return [media.title, media.originalTitle]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => tokens(value))
    .filter((value) => value.length > 0);
}

function tokenPresent(text: string, token: string): boolean {
  if (/\p{Script=Han}/u.test(token)) return text.includes(token);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "iu").test(text);
}

function releaseTitleMatch(media: DiscoveryMedia, release: ReleaseSummary): "confirmed" | "possible" | "unknown" {
  const releaseText = cleanText(release.title, 240).toLocaleLowerCase();
  const allAliases = aliases(media);
  const aliasMatches = allAliases.map((alias) => alias.every((token) => tokenPresent(releaseText, token)));
  const anyTokenMatches = allAliases.some((alias) => alias.some((token) => tokenPresent(releaseText, token)));
  if (!aliasMatches.some(Boolean)) return anyTokenMatches ? "possible" : "unknown";
  // A release without the canonical year is a possible match. The current
  // media contract has no season/episode identity, so TV releases remain
  // possible until a future metadata adapter provides that identity.
  if (media.mediaType === "tv" || /\bS\d{1,2}(?:E\d{1,3})?\b/iu.test(release.title) || release.categories.some(c => /(?:^TV|剧集|电视剧)/iu.test(c))) return "possible";
  if (!media.year || !tokenPresent(releaseText, media.year)) return "possible";
  return "confirmed";
}

function releaseSizeKnown(release: ReleaseWithEvidence): boolean {
  return release.evidence ? release.evidence.size === "upstream" : release.size > 0;
}

function releaseSeedersKnown(release: ReleaseWithEvidence): boolean {
  return release.evidence ? release.evidence.seeders === "upstream" : release.seeders > 0;
}

function freeleechState(release: ReleaseWithEvidence): "yes" | "no" | "unknown" {
  if (release.freeleechState) return release.freeleechState;
  return release.freeleech ? "yes" : "unknown";
}

function comparableSize(release: ReleaseWithEvidence): number {
  return releaseSizeKnown(release) ? release.size : Number.POSITIVE_INFINITY;
}

function comparableSeeders(release: ReleaseWithEvidence): number {
  return releaseSeedersKnown(release) ? release.seeders : -1;
}

function reasonCodes(
  release: ReleaseWithEvidence,
  prefs: AssistantPreferences,
  matchStatus: "confirmed" | "possible" | "unknown",
): AssistantRankedRelease["reasonCodes"] {
  const codes: AssistantRankedRelease["reasonCodes"] = [];
  if (prefs.maxSizeBytes !== null && releaseSizeKnown(release) && release.size <= prefs.maxSizeBytes) {
    codes.push("WITHIN_SIZE_LIMIT");
  }
  if (prefs.resolution && release.resolution === prefs.resolution) codes.push("PREFERRED_RESOLUTION");
  if (prefs.freeleechPreferred && freeleechState(release) === "yes") codes.push("PREFERRED_FREELEECH");
  if (releaseSeedersKnown(release) && release.seeders > 0) codes.push("MORE_SEEDERS");
  if (matchStatus === "confirmed") codes.push("MATCHED_TITLE");
  if (matchStatus === "possible") codes.push("POSSIBLE_MATCH");
  if (!releaseSeedersKnown(release)) codes.push("SEEDERS_UNKNOWN");
  return codes;
}

function hardMatch(
  release: ReleaseWithEvidence,
  prefs: AssistantPreferences,
  matchStatus: "confirmed" | "possible" | "unknown",
): boolean {
  if (release.protocol !== "torrent") return false;
  if (matchStatus !== "confirmed") return false;
  if (prefs.resolution && release.resolution !== prefs.resolution) return false;
  if (prefs.maxSizeBytes !== null && (!releaseSizeKnown(release) || release.size > prefs.maxSizeBytes)) return false;
  if (prefs.freeleechRequired && freeleechState(release) !== "yes") return false;
  return true;
}

function toRankedRelease(
  release: ReleaseWithEvidence,
  prefs: AssistantPreferences,
  rank: number,
  matchStatus: "confirmed" | "possible" | "unknown",
): AssistantRankedRelease {
  return {
    id: release.id,
    title: cleanText(release.title, 240),
    indexer: cleanText(release.indexer, 100),
    protocol: release.protocol,
    size: Math.max(0, release.size),
    seeders: Math.max(0, Math.floor(release.seeders)),
    leechers: Math.max(0, Math.floor(release.leechers)),
    grabs: Math.max(0, Math.floor(release.grabs)),
    ageDays: Math.max(0, release.ageDays),
    categories: release.categories.map((category) => cleanText(category, 80)).filter(Boolean).slice(0, 20),
    ...(release.resolution ? { resolution: release.resolution as AssistantRankedRelease["resolution"] } : {}),
    ...(release.codec ? { codec: cleanText(release.codec, 40) } : {}),
    freeleech: Boolean(release.freeleech),
    ...(release.freeleechState ? { freeleechState: release.freeleechState } : {}),
    ...(release.evidence ? { evidence: release.evidence } : {}),
    rank,
    reasonCodes: reasonCodes(release, prefs, matchStatus),
    matchStatus,
  };
}

export function rankReleases(
  media: DiscoveryMedia,
  snapshot: DiscoveryReleaseSnapshot,
  prefs: AssistantPreferences,
  limit = 3,
): AssistantRankedRelease[] {
  const candidates = snapshot.releases.map((release) => {
    const typed = release as ReleaseWithEvidence;
    const matchStatus = releaseTitleMatch(media, typed);
    return { release: typed, matchStatus, eligible: hardMatch(typed, prefs, matchStatus) };
  });
  const eligible = candidates
    .filter((candidate) => candidate.eligible && releaseSeedersKnown(candidate.release) && candidate.release.seeders > 0)
    .sort((left, right) => {
      const leftResolution = prefs.resolution && left.release.resolution === prefs.resolution ? 1 : 0;
      const rightResolution = prefs.resolution && right.release.resolution === prefs.resolution ? 1 : 0;
      const leftFree = prefs.freeleechPreferred && freeleechState(left.release) === "yes" ? 1 : 0;
      const rightFree = prefs.freeleechPreferred && freeleechState(right.release) === "yes" ? 1 : 0;
      return rightResolution - leftResolution
        || rightFree - leftFree
        || comparableSeeders(right.release) - comparableSeeders(left.release)
        || comparableSize(left.release) - comparableSize(right.release)
        || left.release.id.localeCompare(right.release.id);
    })
    .slice(0, Math.min(3, Math.max(0, Math.floor(limit))));
  return eligible.map((candidate, index) => toRankedRelease(
    candidate.release,
    prefs,
    index + 1,
    candidate.matchStatus,
  ));
}

export function availabilityForSnapshot(snapshot: DiscoveryReleaseSnapshot): AssistantAvailability {
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
    if (matchStatus === "possible" || !releaseSeedersKnown(typed) || typed.seeders === 0) possible = true;
    if (hardMatch(typed, prefs, matchStatus) && releaseSeedersKnown(typed) && typed.seeders > 0) {
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
  const genres = new Set(media.genres.map((genre) => genre.toLocaleLowerCase()).filter(Boolean));
  const results: AssistantConstraintResult[] = [];
  for (const genre of prefs.includeGenres) {
    const met = [...genres].some((candidate) => candidate.includes(genre.toLocaleLowerCase()));
    results.push({ key: `includeGenre:${genre}`, status: genres.size === 0 ? "unknown" : met ? "met" : "unknown", detail: genres.size === 0 ? `类型未知，无法确认${genre}` : met ? `类型包含${genre}` : `类型未从元数据确认包含${genre}` });
  }
  for (const genre of prefs.excludeGenres) {
    const contains = [...genres].some((candidate) => candidate.includes(genre.toLocaleLowerCase()));
    results.push({ key: `excludeGenre:${genre}`, status: genres.size === 0 ? "unknown" : contains ? "not_met" : "met", detail: genres.size === 0 ? `类型未知，无法确认不包含${genre}` : contains ? `元数据包含排除类型${genre}` : `未发现排除类型${genre}` });
  }
  if (prefs.yearFrom !== null || prefs.yearTo !== null) {
    const year = Number(media.year);
    const known = Number.isInteger(year);
    const met = known
      && (prefs.yearFrom === null || year >= prefs.yearFrom)
      && (prefs.yearTo === null || year <= prefs.yearTo);
    results.push({ key: "yearRange", status: !known ? "unknown" : met ? "met" : "not_met", detail: !known ? "年份未知" : met ? `年份${media.year}符合范围` : `年份${media.year}不符合范围` });
  }
  if (snapshot) {
    const snapshotAvailability = availabilityForMediaSnapshot(media, snapshot, prefs);
    results.push({
      key: "ptAvailability",
      status: snapshotAvailability === "available" ? "met" : snapshotAvailability === "unavailable" ? "not_met" : "unknown",
      detail: snapshotAvailability === "available" ? "已从 PT 快照确认有匹配做种" : snapshotAvailability === "possible" ? "找到候选但匹配或做种仍需确认" : "快照未找到匹配资源",
    });
  } else if (prefs.onlyAvailable) {
    results.push({ key: "ptAvailability", status: "unknown", detail: "尚未检查 PT 资源" });
  }
  const ranked = snapshot ? rankReleases(media, snapshot, prefs) : [];
  for (const [key, required, label] of [
    ["resolution", Boolean(prefs.resolution), "清晰度要求"],
    ["maxSizeBytes", prefs.maxSizeBytes !== null, "大小限制"],
    ["freeleechRequired", prefs.freeleechRequired, "免费要求"],
  ] as const) {
    if (required) results.push({ key, status: !snapshot ? "unknown" : ranked.length ? "met" : "unknown", detail: ranked.length ? `${label}已满足` : `${label}尚未找到满足全部条件的版本` });
  }
  return results.slice(0, 20);
}

export function defaultReason(media: DiscoveryMedia, availability: AssistantAvailability): string {
  const type = media.mediaType === "tv" ? "剧集" : "电影";
  const availabilityText = availability === "available"
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
  modelConstraints: AssistantConstraintResult[] = [],
): AssistantRecommendationCard {
  const availability = candidate.releaseError
    ? "error"
    : candidate.snapshot
      ? availabilityForMediaSnapshot(candidate.media, candidate.snapshot, prefs)
      : "unchecked";
  const rankedReleases = candidate.snapshot ? rankReleases(candidate.media, candidate.snapshot, prefs, 3) : [];
  const evidenceIds = new Set<string>([
    `metadata:${candidate.media.mediaType}:${candidate.media.id}`,
    ...(candidate.snapshot?.snapshotId ? [`release_snapshot:${candidate.snapshot.snapshotId}`] : []),
  ]);
  modelEvidenceIds.forEach((id) => {
    if (evidenceIds.has(id)) evidenceIds.add(id);
  });
  const checkedAt = candidate.snapshot?.checkedAt;
  const reason = cleanText(modelReason, 800) || defaultReason(candidate.media, availability);
  const constraints = [...constraintResults(candidate.media, prefs, candidate.snapshot), ...[]]
    .filter((value, position, values) => values.findIndex((entry) => entry.key === value.key) === position)
    .slice(0, 20);
  return {
    cardId: `card_${conversationId.slice(0, 12)}_${turnId.slice(0, 12)}_${index + 1}`,
    mediaId: cleanText(candidate.media.id, 64),
    mediaType: candidate.media.mediaType,
    title: cleanText(candidate.media.title, 240),
    ...(candidate.media.originalTitle ? { originalTitle: cleanText(candidate.media.originalTitle, 240) } : {}),
    ...(candidate.media.year ? { year: cleanText(candidate.media.year, 16) } : {}),
    genres: candidate.media.genres.map((genre) => cleanText(genre, 40)).filter(Boolean).slice(0, 20),
    summary: cleanText(candidate.media.summary, 900),
    reason,
    evidenceIds: [...evidenceIds].slice(0, 20),
    constraintResults: constraints,
    availability,
    ...(checkedAt ? { checkedAt } : {}),
    ...(candidate.snapshot?.snapshotId ? { snapshotId: candidate.snapshot.snapshotId } : {}),
    ...(candidate.snapshot?.expiresAt ? { expiresAt: candidate.snapshot.expiresAt } : {}),
    ...(candidate.snapshot?.actionableUntil ? { actionableUntil: candidate.snapshot.actionableUntil } : {}),
    rankedReleases,
  };
}

export function filterCandidateForPreferences(media: DiscoveryMedia, prefs: AssistantPreferences): boolean {
  const mediaId = `${media.mediaType}:${media.id}`;
  if (prefs.seenMediaIds.includes(media.id) || prefs.seenMediaIds.includes(mediaId)) return false;
  const genres = media.genres.map((genre) => genre.toLocaleLowerCase());
  if (prefs.includeGenres.length && !prefs.includeGenres.every((genre) => genres.some((candidate) => candidate.includes(genre.toLocaleLowerCase())))) return false;
  if (prefs.excludeGenres.length && !genres.length) return false;
  if (prefs.excludeGenres.some((genre) => genres.some((candidate) => candidate.includes(genre.toLocaleLowerCase())))) return false;
  const year = media.year ? Number(media.year) : NaN;
  if ((prefs.yearFrom !== null || prefs.yearTo !== null) && !Number.isInteger(year)) return false;
  if (prefs.yearFrom !== null && Number.isInteger(year) && year < prefs.yearFrom) return false;
  if (prefs.yearTo !== null && Number.isInteger(year) && year > prefs.yearTo) return false;
  if (prefs.mediaType && media.mediaType !== prefs.mediaType) return false;
  return true;
}
