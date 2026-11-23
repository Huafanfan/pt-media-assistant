import type { ReleaseSummary } from "../../shared/contracts.js";
import {
  MAX_SELECTION_RELEASES,
  MAX_SELECTION_WARNINGS,
  type FieldEvidence,
  type RankedRelease,
  type RankingReasonCode,
  type RecommendationRole,
  type ReleaseCoverage,
  type ReleaseGroupKey,
  type ReleaseIdentityStatus,
  type ReleaseOverlap,
  type ReleaseWarning,
  type SelectionConstraintResult,
  type SelectionLanguage,
  type SelectionPreferences,
  type SelectionTarget,
} from "../../shared/release-selection.js";
import {
  buildCoverage,
  compareCoverage,
  evaluateTarget,
  groupForEvaluation,
  summarizeUnits,
  unitMatches,
  targetUnits,
  type TargetEvaluation,
} from "./coverage.js";
import { parseReleaseFacts, type ParsedReleaseFacts } from "./parser.js";

/**
 * The single deterministic ranking engine for release candidates.  AI never
 * participates here: identity, hard constraints, coverage grouping and
 * ordering are all pure functions of the snapshot, target and preferences.
 */

export type SelectionMediaIdentity = {
  mediaType: "movie" | "tv";
  itemId: string;
  title: string;
  originalTitle?: string;
  year?: string;
};

export type IdentityPolicy = "strict" | "assistant";

export type RankSelectionInput = {
  media: SelectionMediaIdentity | null;
  releases: ReleaseSummary[];
  target: SelectionTarget;
  preferences: SelectionPreferences;
  /**
   * "strict" is the selection surface: a TV title-token match is work-level
   * matched so its season coverage can be evaluated.  "assistant" preserves
   * the legacy AI-recommendation semantics, where a TV release stays
   * "possible" and is never ranked as a confirmed match.
   */
  identityPolicy?: IdentityPolicy;
  /** Snapshot check time; a free status is only valid for a bounded window. */
  snapshotCheckedAt?: string;
  nowMs?: number;
  /**
   * AI-suggested fields that passed raw-title verification.  They only soften
   * ordering/soft-preference signals; hard constraints never read them.
   */
  extraEvidence?: Record<string, FieldEvidence[]>;
};

export type RankedGroup = {
  key: ReleaseGroupKey;
  releases: RankedRelease[];
};

export type RankSelectionResult = {
  releases: RankedRelease[];
  groups: RankedGroup[];
  recommendations: RankedRelease[];
  availabilityPending: RankedRelease[];
  overlaps: ReleaseOverlap[];
  warnings: ReleaseWarning[];
  totalCandidates: number;
  eligibleCount: number;
};

type Evaluated = {
  release: ReleaseSummary;
  facts: ParsedReleaseFacts;
  /** facts plus verified AI suggestions; used for soft ordering only. */
  softFacts: ParsedReleaseFacts;
  aiEvidenceApplied: boolean;
  coverage: ReleaseCoverage;
  evaluation: TargetEvaluation;
  group: ReleaseGroupKey;
  identity: ReleaseIdentityStatus;
  constraints: SelectionConstraintResult[];
  eligible: boolean;
  available: boolean;
  sizeKnown: boolean;
  seedersKnown: boolean;
  reasons: RankingReasonCode[];
  warnings: ReleaseWarning[];
};

const GENERIC_TITLE_WORDS = new Set([
  "the",
  "a",
  "an",
  "film",
  "movie",
  "season",
  "series",
  "part",
  "vol",
  "complete",
]);

export function titleTokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[“”"'‘’·•:：/\\()[\]{}.,!?！？_+-]/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 1 && !GENERIC_TITLE_WORDS.has(token));
}

function tokenPresent(text: string, token: string): boolean {
  if (/\p{Script=Han}/u.test(token)) return text.includes(token);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu").test(
    text,
  );
}

export type IdentityResult = {
  status: ReleaseIdentityStatus;
  reason: string;
};

/** Work-level identity only; it never proves episode-level coverage. */
export function matchWorkIdentity(
  media: SelectionMediaIdentity,
  facts: ParsedReleaseFacts,
  policy: IdentityPolicy = "strict",
): IdentityResult {
  const releaseText = facts.title.toLocaleLowerCase();
  const aliasList = [media.title, media.originalTitle]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => titleTokens(value))
    .filter((value) => value.length > 0);
  if (aliasList.length === 0)
    return { status: "possible", reason: "作品名无法拆分出可核对词元" };
  const fullMatch = aliasList.some((alias) =>
    alias.every((token) => tokenPresent(releaseText, token)),
  );
  const partialMatch = aliasList.some((alias) =>
    alias.some((token) => tokenPresent(releaseText, token)),
  );
  if (!fullMatch) {
    return partialMatch
      ? { status: "possible", reason: "标题只匹配部分作品词元" }
      : { status: "conflict", reason: "标题与作品名不匹配" };
  }
  if (policy === "assistant" && media.mediaType === "tv") {
    return {
      status: "possible",
      reason: "剧集候选缺少季集身份，保持待确认",
    };
  }
  const mediaYear = media.year ? Number(media.year) : NaN;
  if (Number.isInteger(mediaYear) && facts.year !== undefined) {
    if (facts.year !== mediaYear) {
      return policy === "assistant"
        ? { status: "possible", reason: `候选年份 ${facts.year} 与作品年份 ${mediaYear} 不一致` }
        : {
            status: "conflict",
            reason: `候选年份 ${facts.year} 与作品年份 ${mediaYear} 不一致`,
          };
    }
    return { status: "matched", reason: "标题与年份均匹配" };
  }
  if (media.mediaType === "movie" && Number.isInteger(mediaYear)) {
    return { status: "possible", reason: "候选标题未标注年份，无法确认是同一部作品" };
  }
  return { status: "matched", reason: "标题词元匹配；季集范围由覆盖分析处理" };
}

const RESOLUTION_TIER: Record<string, number> = {
  "2160p": 3,
  "1080p": 2,
  "720p": 1,
};

const SOURCE_TIER: Record<string, number> = {
  remux: 5,
  bluray: 4,
  webdl: 3,
  webrip: 2,
  hdtv: 1,
  dvd: 0,
  other: 0,
};

export const FREELEECH_VALIDITY_MS = 60 * 60 * 1000;

type ResolvedField<T> = {
  value: T | undefined;
  conflict: boolean;
  title?: T;
  upstream?: T;
};

function resolveField<T>(
  titleValue: T | undefined,
  upstreamValue: T | undefined,
): ResolvedField<T> {
  if (titleValue !== undefined && upstreamValue !== undefined && titleValue !== upstreamValue) {
    return { value: undefined, conflict: true, title: titleValue, upstream: upstreamValue };
  }
  return {
    value: titleValue ?? upstreamValue,
    conflict: false,
    ...(titleValue !== undefined ? { title: titleValue } : {}),
    ...(upstreamValue !== undefined ? { upstream: upstreamValue } : {}),
  };
}

function resolutionField(
  release: ReleaseSummary,
  facts: ParsedReleaseFacts,
): ResolvedField<NonNullable<RankedRelease["resolution"]>> {
  return resolveField(
    facts.resolution,
    release.evidence?.resolution === "upstream"
      ? normalizeResolution(release.resolution)
      : undefined,
  );
}

function sourceField(
  release: ReleaseSummary,
  facts: ParsedReleaseFacts,
): ResolvedField<NonNullable<RankedRelease["source"]>> {
  return resolveField(facts.source, normalizeSource(release.source));
}

function codecField(
  release: ReleaseSummary,
  facts: ParsedReleaseFacts,
): ResolvedField<string> {
  return resolveField(
    normalizeCodec(facts.codec),
    release.evidence?.codec === "upstream"
      ? normalizeCodec(release.codec)
      : undefined,
  );
}

function hdrField(
  release: ReleaseSummary,
  facts: ParsedReleaseFacts,
): ResolvedField<NonNullable<RankedRelease["hdr"]>> {
  return resolveField(facts.hdr, normalizeHdr(release.hdr));
}

function specConflictFields(
  release: ReleaseSummary,
  facts: ParsedReleaseFacts,
): string[] {
  const conflicts: string[] = [];
  const record = (
    label: string,
    field: ResolvedField<string | undefined>,
  ): void => {
    if (!field.conflict) return;
    conflicts.push(
      `${label}（标题 ${field.title ?? "未知"} / 上游 ${field.upstream ?? "未知"}）`,
    );
  };
  record("分辨率", resolutionField(release, facts));
  record("片源类型", sourceField(release, facts));
  record("编码", codecField(release, facts));
  record("动态范围", hdrField(release, facts));
  return conflicts;
}

function effectiveFreeleech(
  input: RankSelectionInput,
  release: ReleaseSummary,
): { state: "yes" | "no" | "unknown"; fresh: boolean } {
  const state = freeleechStateOf(release);
  const fresh = freeleechFresh(input);
  // A stale snapshot can only prove "free at snapshot time", never a current
  // promotion; every consumer sees the same unknown.
  return { state: state === "yes" && !fresh ? "unknown" : state, fresh };
}

function freeleechFresh(input: RankSelectionInput): boolean {
  const checkedAt = input.snapshotCheckedAt
    ? Date.parse(input.snapshotCheckedAt)
    : Number.NaN;
  if (!Number.isFinite(checkedAt)) return false;
  const now = input.nowMs ?? Date.now();
  return now - checkedAt <= FREELEECH_VALIDITY_MS;
}

function normalizeResolution(
  value: string | undefined,
): RankedRelease["resolution"] {
  if (value === "2160p" || value === "1080p" || value === "720p") return value;
  return undefined;
}

function normalizeSource(
  value: string | undefined,
): RankedRelease["source"] {
  if (
    value === "remux" ||
    value === "bluray" ||
    value === "webdl" ||
    value === "webrip" ||
    value === "hdtv" ||
    value === "dvd" ||
    value === "other"
  )
    return value;
  return undefined;
}

const CODEC_TOKEN = /(x264|x265|h\.?264|h\.?265|hevc|avc|av1|xvid|divx|mpeg-?2|vc-?1)/iu;

/** Free-text upstream codecs are reduced to a known token or dropped. */
function normalizeCodec(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = CODEC_TOKEN.exec(value);
  return match?.[0]?.toUpperCase();
}

function normalizeHdr(value: string | undefined): RankedRelease["hdr"] {
  if (
    value === "hdr" ||
    value === "hdr10" ||
    value === "hdr10plus" ||
    value === "dolby_vision" ||
    value === "hlg" ||
    value === "sdr"
  )
    return value;
  return undefined;
}

function freeleechStateOf(
  release: ReleaseSummary,
): "yes" | "no" | "unknown" {
  if (release.freeleechState) return release.freeleechState;
  return release.freeleech ? "yes" : "unknown";
}

function sizeKnownOf(release: ReleaseSummary): boolean {
  if (release.evidence) return release.evidence.size === "upstream";
  return release.size > 0;
}

function seedersKnownOf(release: ReleaseSummary): boolean {
  if (release.evidence) return release.evidence.seeders === "upstream";
  return release.seeders > 0;
}

function constraint(
  key: string,
  status: SelectionConstraintResult["status"],
  detail: string,
): SelectionConstraintResult {
  return { key, status, detail };
}

type ConstraintOutcome = {
  results: SelectionConstraintResult[];
  eligible: boolean;
};

function evaluateConstraints(
  input: RankSelectionInput,
  evaluated: Pick<
    Evaluated,
    "release" | "facts" | "coverage" | "evaluation" | "group" | "identity"
  >,
): ConstraintOutcome {
  const { release, facts, coverage, evaluation, group, identity } = evaluated;
  const { target, preferences } = input;
  const results: SelectionConstraintResult[] = [];
  const isBrowse = target.mode === "browse";

  let identityStatus: SelectionConstraintResult["status"] = "unknown";
  let identityDetail = "作品身份无法确认，仅能陈列候选";
  if (identity === "matched") {
    identityStatus = "met";
    identityDetail = "作品身份已核对";
  } else if (identity === "conflict") {
    identityStatus = "not_met";
    identityDetail = "与当前作品身份冲突";
  }
  results.push(constraint("identity", identityStatus, identityDetail));

  results.push(
    constraint(
      "protocol",
      release.protocol === "torrent" ? "met" : "not_met",
      release.protocol === "torrent"
        ? "可直接交给 qBittorrent"
        : "Usenet 候选不进入当前下载流程",
    ),
  );

  if (!isBrowse) {
    let scopeStatus: SelectionConstraintResult["status"] = "unknown";
    let scopeDetail = `候选范围只能部分满足或无法核对：${
      evaluation.missingSummary.join("、") || "范围待确认"
    }`;
    if (group === "covers_target") {
      scopeStatus = "met";
      scopeDetail = "标题范围覆盖目标范围";
    } else if (group === "other_scope") {
      scopeStatus = "not_met";
      scopeDetail = "候选范围与当前目标不重叠";
    }
    results.push(constraint("scope", scopeStatus, scopeDetail));
  }

  if (target.edition) {
    let editionStatus: SelectionConstraintResult["status"] = "not_met";
    let editionDetail = `候选是${editionLabel(coverage.edition)}，目标要求${editionLabel(target.edition)}`;
    if (coverage.edition === target.edition) {
      editionStatus = "met";
      editionDetail = "节目版本与目标一致";
    } else if (coverage.edition === "unknown") {
      editionStatus = "unknown";
      editionDetail = "标题没有节目版本信息，不能确认是目标版本";
    }
    results.push(constraint("edition", editionStatus, editionDetail));
  }

  if (target.year && target.kind !== "movie") {
    const dateImpliedYear =
      facts.dates.length > 0 &&
      facts.dates.every((date) => date.startsWith(target.year!))
        ? Number(target.year)
        : undefined;
    const year = facts.year ?? dateImpliedYear;
    let yearStatus: SelectionConstraintResult["status"] = "unknown";
    let yearDetail = "标题未标注年份，日期也无法确认年份";
    if (year !== undefined) {
      if (String(year) === target.year) {
        yearStatus = "met";
        yearDetail =
          facts.year !== undefined
            ? `年份 ${year} 符合目标`
            : `日期均落在 ${year} 年，符合目标`;
      } else {
        yearStatus = "not_met";
        yearDetail = `年份 ${year} 与目标 ${target.year} 不一致`;
      }
    }
    results.push(constraint("year", yearStatus, yearDetail));
  }

  if (target.kind === "variety" && target.season !== null) {
    let seasonStatus: SelectionConstraintResult["status"] = "unknown";
    let seasonDetail = "标题未标注季，无法确认";
    if (facts.seasons.length === 1) {
      if (facts.seasons[0] === target.season) {
        seasonStatus = "met";
        seasonDetail = `标题标注第 ${target.season} 季`;
      } else {
        seasonStatus = "not_met";
        seasonDetail = `标题标注的是第 ${facts.seasons[0]} 季`;
      }
    } else if (facts.seasons.length > 1) {
      // Mixed seasons: without per-unit binding the target season cannot be
      // proven from a global membership test.
      seasonDetail = `标题同时涉及第 ${facts.seasons.join("、")} 季，无法确认目标季对应哪条声明`;
    }
    results.push(constraint("season", seasonStatus, seasonDetail));
  }

  // Segment identity is matched per issue unit (上/下 belong to one 期), so no
  // global segment constraint exists here.

  if (preferences.freeleechOnly) {
    const recorded = freeleechStateOf(release);
    const { state, fresh } = effectiveFreeleech(input, release);
    let status: SelectionConstraintResult["status"] = "unknown";
    let detail = "免费状态未知，不能当作满足";
    if (state === "yes") {
      status = "met";
      detail = "快照显示当前为免费（快照时间内有效）";
    } else if (recorded === "yes" && !fresh) {
      detail = "只有快照时的免费记录，无法确认当前仍然免费";
    } else if (state === "no") {
      status = "not_met";
      detail = "快照显示不是免费";
    }
    results.push(constraint("freeleechOnly", status, detail));
  }

  if (preferences.resolution && preferences.resolution.strength === "required") {
    const required = preferences.resolution.value;
    const resolved = resolutionField(release, facts);
    let status: SelectionConstraintResult["status"] = "not_met";
    let detail = `清晰度为 ${resolved.value ?? "未知"}，不符合 ${required}`;
    if (resolved.conflict) {
      status = "unknown";
      detail = "标题与上游的清晰度互相冲突，需要人工确认";
    } else if (resolved.value === required) {
      status = "met";
      detail = `清晰度 ${resolved.value} 符合要求`;
    } else if (resolved.value === undefined) {
      status = "unknown";
      detail = "标题与上游都没有清晰度信息";
    }
    results.push(constraint("resolution", status, detail));
  }

  if (preferences.maxSizeBytes !== null) {
    const limit = preferences.maxSizeBytes;
    const known = sizeKnownOf(release);
    let status: SelectionConstraintResult["status"] = "met";
    let detail = "总体积在限制内";
    if (!known) {
      status = "unknown";
      detail = "体积未知，不能确认在限制内";
    } else if (release.size > limit) {
      status = "not_met";
      detail = "总体积超过限制";
    }
    results.push(constraint("maxSizeBytes", status, detail));
  }

  for (const entry of preferences.subtitles) {
    if (entry.strength !== "required") continue;
    const has = facts.subtitleLanguages.includes(entry.language);
    const unknown =
      !has && !facts.hasSubtitleClaim && facts.subtitleLanguages.length === 0;
    let status: SelectionConstraintResult["status"] = "not_met";
    let detail = `未发现${languageLabel(entry.language)}字幕标注`;
    if (has) {
      status = "met";
      detail = `已标注${languageLabel(entry.language)}字幕`;
    } else if (unknown) {
      status = "unknown";
      detail = "没有字幕信息";
    }
    results.push(constraint(`subtitle:${entry.language}`, status, detail));
  }

  for (const entry of preferences.audio) {
    if (entry.strength !== "required") continue;
    const has = facts.audioLanguages.includes(entry.language);
    const unknown = !has && facts.audioLanguages.length === 0;
    let status: SelectionConstraintResult["status"] = "not_met";
    let detail = `未发现${languageLabel(entry.language)}音轨标注`;
    if (has) {
      status = "met";
      detail = `已标注${languageLabel(entry.language)}音轨`;
    } else if (unknown) {
      status = "unknown";
      detail = "没有音轨信息";
    }
    results.push(constraint(`audio:${entry.language}`, status, detail));
  }

  if (preferences.verifiedCompletenessRequired && !isBrowse) {
    const completeness = coverage.completeness;
    let status: SelectionConstraintResult["status"] = "unknown";
    let detail = "完整性未知";
    if (completeness === "verified") {
      status = "met";
      detail = "完整性已核验";
    } else if (completeness === "claimed") {
      detail = "只有标题声明，未核验文件清单";
    }
    results.push(constraint("verifiedCompleteness", status, detail));
  }

  const eligible = results.every((result) => result.status === "met");
  return { results, eligible };
}

function editionLabel(edition: string): string {
  switch (edition) {
    case "main":
      return "正片";
    case "extra":
      return "加更";
    case "pure":
      return "纯享";
    case "member":
      return "会员版";
    case "preview":
      return "预告";
    case "bonus":
      return "花絮";
    default:
      return "版本未知";
  }
}

function languageLabel(language: SelectionLanguage): string {
  switch (language) {
    case "zh":
      return "中文";
    case "zh-hant":
      return "繁体中文";
    case "en":
      return "英文";
    case "ja":
      return "日文";
    case "ko":
      return "韩文";
    default:
      return "其他语言";
  }
}

function evidenceScore(
  release: ReleaseSummary,
  facts: ParsedReleaseFacts,
): number {
  let score = 0;
  const resolution = resolutionField(release, facts);
  if (resolution.value) score += release.evidence?.resolution === "upstream" ? 2 : 1;
  if (sourceField(release, facts).value) score += 1;
  if (codecField(release, facts).value) score += 1;
  if (hdrField(release, facts).value) score += 1;
  return score;
}

function softPreferenceScore(
  input: RankSelectionInput,
  preferences: SelectionPreferences,
  facts: ParsedReleaseFacts,
  release: ReleaseSummary,
): number {
  let score = 0;
  if (
    preferences.freeleechPreferred &&
    effectiveFreeleech(input, release).state === "yes"
  )
    score += 1;
  if (
    preferences.resolution &&
    preferences.resolution.strength === "preferred" &&
    (facts.resolution ?? undefined) === preferences.resolution.value
  )
    score += 1;
  for (const entry of preferences.subtitles) {
    if (entry.strength === "preferred" && facts.subtitleLanguages.includes(entry.language))
      score += 1;
  }
  for (const entry of preferences.audio) {
    if (entry.strength === "preferred" && facts.audioLanguages.includes(entry.language))
      score += 1;
  }
  return score;
}

type SortKeys = {
  soft: number;
  extra: number;
  spec: number;
  resolutionTier: number;
  sourceTier: number;
  size: number;
  seeders: number;
  id: string;
};

function sortKeysFor(
  input: RankSelectionInput,
  release: ReleaseSummary,
  facts: ParsedReleaseFacts,
  evaluation: TargetEvaluation,
  preferences: SelectionPreferences,
): SortKeys {
  const resolution = resolutionField(release, facts).value;
  const source = sourceField(release, facts).value;
  return {
    soft: softPreferenceScore(input, preferences, facts, release),
    extra: evaluation.extraUnitCount,
    spec: evidenceScore(release, facts),
    resolutionTier: resolution ? (RESOLUTION_TIER[resolution] ?? 0) : 0,
    sourceTier: source ? (SOURCE_TIER[source] ?? 0) : -1,
    size: sizeKnownOf(release) ? release.size : Number.POSITIVE_INFINITY,
    seeders: seedersKnownOf(release) ? release.seeders : -1,
    id: release.id,
  };
}

type SortPreset = SelectionPreferences["preset"];

function compareByPreset(preset: SortPreset, left: SortKeys, right: SortKeys): number {
  if (preset === "quality") {
    return (
      right.resolutionTier - left.resolutionTier ||
      right.sourceTier - left.sourceTier ||
      right.spec - left.spec ||
      right.seeders - left.seeders ||
      left.id.localeCompare(right.id)
    );
  }
  if (preset === "compact") {
    return (
      left.size - right.size ||
      right.seeders - left.seeders ||
      left.id.localeCompare(right.id)
    );
  }
  return (
    right.soft - left.soft ||
    left.extra - right.extra ||
    right.spec - left.spec ||
    right.resolutionTier - left.resolutionTier ||
    right.sourceTier - left.sourceTier ||
    left.size - right.size ||
    right.seeders - left.seeders ||
    left.id.localeCompare(right.id)
  );
}

function reasonCodesFor(
  evaluated: Pick<
    Evaluated,
    "release" | "facts" | "coverage" | "evaluation" | "group" | "identity"
  >,
  input: RankSelectionInput,
  target: SelectionTarget,
): RankingReasonCode[] {
  const { preferences } = input;
  const { release, facts, coverage, evaluation, group, identity } = evaluated;
  const codes: RankingReasonCode[] = [];
  if (group === "covers_target") codes.push("COVERS_TARGET");
  else if (group === "partial_coverage") codes.push("PARTIAL_COVERAGE");
  else if (group === "single_unit") codes.push("SINGLE_UNIT");
  else if (group === "unknown_scope") codes.push("UNKNOWN_SCOPE");

  if (coverage.completeness === "verified") codes.push("COMPLETENESS_VERIFIED");
  else if (coverage.completeness === "claimed") codes.push("COMPLETENESS_CLAIMED");
  else codes.push("COMPLETENESS_UNKNOWN");

  if (target.edition && coverage.edition === target.edition) codes.push("EDITION_MATCH");
  if (identity === "possible") codes.push("IDENTITY_POSSIBLE");
  else if (identity === "unverified") codes.push("IDENTITY_UNVERIFIED");

  const state = effectiveFreeleech(input, release).state;
  if (state === "yes") codes.push("FREELEECH_CONFIRMED");
  else if (state === "unknown") codes.push("FREELEECH_UNKNOWN");

  const resolution = resolutionField(release, facts).value;
  if (preferences.resolution && resolution === preferences.resolution.value) {
    codes.push(
      preferences.resolution.strength === "required"
        ? "REQUIRED_RESOLUTION_MET"
        : "PREFERRED_RESOLUTION",
    );
  }
  const source = sourceField(release, facts).value;
  if (source && (SOURCE_TIER[source] ?? 0) >= SOURCE_TIER.webdl!) codes.push("PREFERRED_SOURCE");
  if (hdrField(release, facts).value) codes.push("PREFERRED_HDR");

  if (preferences.maxSizeBytes !== null) {
    if (!sizeKnownOf(release)) codes.push("SIZE_UNKNOWN");
    else if (release.size <= preferences.maxSizeBytes) codes.push("WITHIN_SIZE_LIMIT");
  }
  if (evaluation.extraUnitCount > 0) codes.push("EXTRA_SCOPE");
  if (coverage.multiSeason) codes.push("MULTI_SEASON_EXTRA");

  for (const entry of preferences.subtitles) {
    if (entry.strength === "required" && facts.subtitleLanguages.includes(entry.language))
      codes.push("SUBTITLE_REQUIREMENT_MET");
    if (entry.strength === "preferred" && facts.subtitleLanguages.includes(entry.language))
      codes.push("SUBTITLE_PREFERRED");
  }
  for (const entry of preferences.audio) {
    if (entry.strength === "required" && facts.audioLanguages.includes(entry.language))
      codes.push("AUDIO_REQUIREMENT_MET");
    if (entry.strength === "preferred" && facts.audioLanguages.includes(entry.language))
      codes.push("AUDIO_PREFERRED");
  }
  if (preferences.subtitles.some((entry) => entry.strength === "preferred") && facts.subtitleLanguages.length === 0)
    codes.push("SUBTITLE_UNKNOWN");
  if (preferences.audio.some((entry) => entry.strength === "preferred") && facts.audioLanguages.length === 0)
    codes.push("AUDIO_UNKNOWN");

  if (!seedersKnownOf(release)) codes.push("SEEDERS_UNKNOWN");
  else if (release.seeders === 0) codes.push("ZERO_SEEDERS");
  else codes.push("MORE_SEEDERS");

  codes.push(evidenceScore(release, facts) >= 3 ? "SPEC_EVIDENCE_RELIABLE" : "SPEC_EVIDENCE_WEAK");
  if (coverage.openEnded) codes.push("ONGOING_RELEASE");
  return [...new Set(codes)].slice(0, 24);
}

function warningsFor(
  evaluated: Pick<
    Evaluated,
    "release" | "facts" | "coverage" | "evaluation" | "group" | "identity"
  >,
  target: SelectionTarget,
): ReleaseWarning[] {
  const warnings: ReleaseWarning[] = [...evaluated.coverage.warnings];
  const specConflicts = specConflictFields(evaluated.release, evaluated.facts);
  if (specConflicts.length > 0) {
    warnings.push({
      code: "SPEC_CONFLICT",
      message: `标题与上游的${specConflicts.join("、")}互相冲突，相关判断按未知处理`,
    });
  }
  if (evaluated.identity === "possible")
    warnings.push({ code: "IDENTITY_POSSIBLE", message: "作品身份只能部分核对，需人工确认" });
  if (evaluated.identity === "unverified")
    warnings.push({ code: "IDENTITY_UNVERIFIED", message: "未提供作品身份，无法核对是否同一作品" });
  if (evaluated.identity === "conflict")
    warnings.push({ code: "IDENTITY_CONFLICT", message: "与当前作品身份冲突，不进入推荐" });
  if (evaluated.group === "partial_coverage")
    warnings.push({
      code: "PARTIAL_TARGET",
      message: `按标题范围，目标中 ${evaluated.evaluation.missingSummary.join("、") || "部分单元"} 未覆盖`,
    });
  if (evaluated.group === "unknown_scope")
    warnings.push({ code: "SCOPE_UNKNOWN", message: "范围只能部分核对，无法确认是否覆盖目标" });
  if (evaluated.group === "other_scope")
    warnings.push({ code: "OTHER_SCOPE", message: "范围与当前目标不重叠" });
  if (evaluated.group === "single_unit" && target.mode !== "browse")
    warnings.push({ code: "SINGLE_UNIT_ONLY", message: "只包含目标中的单个单元" });
  if (evaluated.evaluation.extraUnitCount > 0)
    warnings.push({
      code: "EXTRA_SCOPE",
      message: `额外包含 ${summarizeUnits(
        evaluated.coverage.units.filter((unit) =>
          targetUnits(target).every((targetUnit) => unitMatches(targetUnit, unit) === "no"),
        ),
        3,
      ).join("、") || `${evaluated.evaluation.extraUnitCount} 个单元`}`,
    });
  return dedupeReleaseWarnings(warnings);
}

function dedupeReleaseWarnings(warnings: ReleaseWarning[]): ReleaseWarning[] {
  const seen = new Set<string>();
  const result: ReleaseWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result.slice(0, MAX_SELECTION_WARNINGS);
}

function subgroupOf(
  coverage: ReleaseCoverage,
  kind: SelectionTarget["kind"],
): string | undefined {
  if (kind === "movie") return undefined;
  const parts: string[] = [];
  if (coverage.year) parts.push(String(coverage.year));
  if (coverage.seasons.length > 0)
    parts.push(`第${coverage.seasons.join("、")}季`);
  if (coverage.edition !== "unknown")
    parts.push(editionLabel(coverage.edition));
  return parts.length > 0 ? parts.join(" · ").slice(0, 64) : undefined;
}

function toRankedRelease(
  input: RankSelectionInput,
  evaluated: Evaluated,
  rank: number,
  role: RecommendationRole | null,
): RankedRelease {
  const { release, facts, coverage, group, identity, constraints } = evaluated;
  const resolution = resolutionField(release, facts).value;
  const source = sourceField(release, facts).value;
  const hdr = hdrField(release, facts).value;
  const codec = codecField(release, facts).value;
  return {
    releaseId: release.id,
    title: release.title.slice(0, 240),
    indexer: release.indexer.slice(0, 100),
    protocol: release.protocol,
    size: Math.max(0, release.size),
    sizeKnown: evaluated.sizeKnown,
    seeders: Math.max(0, Math.floor(release.seeders)),
    seedersKnown: evaluated.seedersKnown,
    leechers: Math.max(0, Math.floor(release.leechers)),
    grabs: Math.max(0, Math.floor(release.grabs)),
    ageDays: Math.max(0, release.ageDays),
    categories: release.categories.slice(0, 20),
    ...(resolution ? { resolution } : {}),
    ...(codec ? { codec: codec.slice(0, 40) } : {}),
    ...(source ? { source } : {}),
    ...(hdr ? { hdr } : {}),
    subtitleLanguages: facts.subtitleLanguages.slice(0, 6),
    audioLanguages: facts.audioLanguages.slice(0, 6),
    freeleech: release.freeleech,
    freeleechState: effectiveFreeleech(input, release).state,
    identity,
    group,
    ...(subgroupOf(coverage, input.target.kind)
      ? { subgroup: subgroupOf(coverage, input.target.kind) }
      : {}),
    rank,
    recommendationRole: role,
    reasonCodes: evaluated.reasons,
    warnings: evaluated.warnings,
    constraintResults: constraints,
    coverage,
    evidence: coverage.evidence,
  };
}

function applyVerifiedEvidence(
  facts: ParsedReleaseFacts,
  entries: FieldEvidence[],
): ParsedReleaseFacts {
  const subtitleLanguages = new Set(facts.subtitleLanguages);
  const audioLanguages = new Set(facts.audioLanguages);
  let hdr = facts.hdr;
  let source = facts.source;
  let codec = facts.codec;
  for (const entry of entries) {
    switch (entry.field) {
      case "subtitle":
        if (isLanguage(entry.value)) subtitleLanguages.add(entry.value);
        break;
      case "audio":
        if (isLanguage(entry.value)) audioLanguages.add(entry.value);
        break;
      case "hdr":
        if (isHdr(entry.value)) hdr = entry.value;
        break;
      case "source":
        if (isSource(entry.value)) source = entry.value;
        break;
      case "codec":
        codec = entry.value;
        break;
      default:
        break;
    }
  }
  return {
    ...facts,
    subtitleLanguages: [...subtitleLanguages],
    audioLanguages: [...audioLanguages],
    ...(hdr ? { hdr } : {}),
    ...(source ? { source } : {}),
    ...(codec ? { codec } : {}),
  };
}

function isLanguage(value: string): value is SelectionLanguage {
  return (
    value === "zh" ||
    value === "zh-hant" ||
    value === "en" ||
    value === "ja" ||
    value === "ko" ||
    value === "other"
  );
}

function isHdr(value: string): value is NonNullable<ParsedReleaseFacts["hdr"]> {
  return (
    value === "hdr" ||
    value === "hdr10" ||
    value === "hdr10plus" ||
    value === "dolby_vision" ||
    value === "hlg" ||
    value === "sdr"
  );
}

function isSource(
  value: string,
): value is NonNullable<ParsedReleaseFacts["source"]> {
  return (
    value === "remux" ||
    value === "bluray" ||
    value === "webdl" ||
    value === "webrip" ||
    value === "hdtv" ||
    value === "dvd" ||
    value === "other"
  );
}

function toEvaluated(
  input: RankSelectionInput,
  release: ReleaseSummary,
): Evaluated {
  const facts = parseReleaseFacts(release.title, {
    fileCount: release.fileCount ?? null,
    ...(release.source ? { source: release.source } : {}),
    ...(release.hdr ? { hdr: release.hdr } : {}),
  });
  const extra = input.extraEvidence?.[release.id] ?? [];
  const softFacts = extra.length > 0 ? applyVerifiedEvidence(facts, extra) : facts;
  const kind = input.target.kind;
  const coverage = buildCoverage(facts, kind);
  const evaluation = evaluateTarget(input.target, coverage);
  const group = groupForEvaluation(input.target, evaluation);
  const identity: ReleaseIdentityStatus = input.media
    ? matchWorkIdentity(input.media, facts, input.identityPolicy ?? "strict").status
    : "unverified";
  const sizeKnown = sizeKnownOf(release);
  const seedersKnown = seedersKnownOf(release);
  const partial: Pick<
    Evaluated,
    "release" | "facts" | "coverage" | "evaluation" | "group" | "identity"
  > = { release, facts, coverage, evaluation, group, identity };
  const { results, eligible } = evaluateConstraints(input, partial);
  const reasons = reasonCodesFor(
    { ...partial, facts: softFacts },
    input,
    input.target,
  );
  const warnings = warningsFor(partial, input.target);
  if (softFacts !== facts) {
    warnings.push({
      code: "AI_EVIDENCE_APPLIED",
      message: "AI 建议已核对原文，仅影响解释与软排序，不改变硬条件",
    });
  }
  return {
    release,
    facts,
    softFacts,
    aiEvidenceApplied: softFacts !== facts,
    coverage,
    evaluation,
    group,
    identity,
    constraints: results,
    eligible,
    available: seedersKnown && release.seeders > 0,
    sizeKnown,
    seedersKnown,
    reasons,
    warnings,
  };
}

const GROUP_ORDER: ReleaseGroupKey[] = [
  "covers_target",
  "partial_coverage",
  "single_unit",
  "unknown_scope",
  "browse_scope",
  "other_scope",
];

/**
 * Rank the full bounded snapshot.  The caller paginates the result; ranking
 * never depends on which page is being displayed.
 */
export function rankSelection(input: RankSelectionInput): RankSelectionResult {
  const evaluated = input.releases.map((release) => toEvaluated(input, release));
  const sortKeys = new Map<string, SortKeys>();
  for (const entry of evaluated) {
    sortKeys.set(
      entry.release.id,
      sortKeysFor(
        input,
        entry.release,
        entry.softFacts,
        entry.evaluation,
        input.preferences,
      ),
    );
  }
  const compare = (left: Evaluated, right: Evaluated): number => {
    // Eligible + available first inside a group; then the preset ordering.
    const tier = (entry: Evaluated): number => {
      if (entry.eligible && entry.available) return 0;
      if (entry.eligible) return 1;
      return 2;
    };
    return (
      tier(left) - tier(right) ||
      compareByPreset(
        input.preferences.preset,
        sortKeys.get(left.release.id)!,
        sortKeys.get(right.release.id)!,
      )
    );
  };

  const groups: RankedGroup[] = [];
  for (const key of GROUP_ORDER) {
    const members = evaluated
      .filter((entry) => entry.group === key)
      .sort(compare)
      .slice(0, MAX_SELECTION_RELEASES);
    if (members.length === 0) continue;
    const releases = members.map((entry, index) =>
      toRankedRelease(input, entry, index + 1, null),
    );
    groups.push({ key, releases });
  }

  const eligibleAvailable = evaluated
    .filter((entry) => entry.eligible && entry.available)
    .sort((left, right) => {
      const balanced = compareByPreset(
        "balanced",
        sortKeys.get(left.release.id)!,
        sortKeys.get(right.release.id)!,
      );
      return balanced;
    });
  const eligiblePending = evaluated
    .filter((entry) => entry.eligible && !entry.available)
    .sort(compare);

  const recommendations: RankedRelease[] = [];
  // Browsing a series/variety has no single target, so no cross-season pick is
  // offered.  A movie "browse" target is the normal path and is recommended.
  const recommendable =
    input.target.mode !== "browse" || input.target.kind === "movie";
  if (recommendable) {
    const pick = (
      preset: SortPreset,
      role: RecommendationRole,
    ): void => {
      const chosen = [...eligibleAvailable].sort((left, right) =>
        compareByPreset(
          preset,
          sortKeys.get(left.release.id)!,
          sortKeys.get(right.release.id)!,
        ),
      )[0];
      if (!chosen) return;
      if (recommendations.some((entry) => entry.releaseId === chosen.release.id)) return;
      recommendations.push(
        toRankedRelease(input, chosen, recommendations.length + 1, role),
      );
    };
    pick("balanced", "balanced_pick");
    pick("quality", "quality_pick");
    pick("compact", "compact_pick");
  }

  const availabilityPending = eligiblePending
    .slice(0, MAX_SELECTION_RELEASES)
    .map((entry, index) =>
      toRankedRelease(input, entry, index + 1, "availability_pending"),
    );

  const overlaps = computeOverlaps(evaluated);
  const warnings = snapshotWarnings(evaluated, input);

  return {
    releases: groups.flatMap((group) => group.releases),
    groups,
    recommendations,
    availabilityPending,
    overlaps,
    warnings,
    totalCandidates: evaluated.length,
    eligibleCount: evaluated.filter((entry) => entry.eligible).length,
  };
}

function computeOverlaps(evaluated: Evaluated[]): ReleaseOverlap[] {
  const candidates = evaluated.filter(
    (entry) =>
      entry.coverage.units.length > 0 &&
      entry.group !== "other_scope" &&
      entry.identity !== "conflict",
  );
  const results: Array<{ overlap: ReleaseOverlap; weight: number }> = [];
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const leftEntry = candidates[left]!;
      const rightEntry = candidates[right]!;
      const compared = compareCoverage(leftEntry.coverage, rightEntry.coverage);
      if (!compared) continue;
      if (compared.shared === 0 && (compared.leftOnly === 0 || compared.rightOnly === 0))
        continue;
      const kind = compared.shared > 0 ? "overlap" : "complement";
      const overlapName = (title: string): string =>
        title.length > 40 ? `${title.slice(0, 40)}…${title.slice(-12)}` : title;
      let leftName = overlapName(leftEntry.release.title);
      let rightName = overlapName(rightEntry.release.title);
      if (leftName === rightName) {
        leftName = `${leftName} #${leftEntry.release.id.slice(0, 6)}`;
        rightName = `${rightName} #${rightEntry.release.id.slice(0, 6)}`;
      }
      results.push({
        overlap: {
          leftReleaseId: leftEntry.release.id,
          rightReleaseId: rightEntry.release.id,
          kind,
          sharedUnitCount: compared.shared,
          complementUnitCount: compared.leftOnly + compared.rightOnly,
          note:
            kind === "overlap"
              ? `「${leftName}」与「${rightName}」按标题有 ${compared.shared} 个单元重叠，仍未核验`
              : `「${leftName}」与「${rightName}」按标题互补，仍未核验，也不会自动合并下载`,
        },
        weight: kind === "complement" ? 1 : 0,
      });
    }
  }
  return results
    .sort(
      (left, right) =>
        left.weight - right.weight ||
        left.overlap.leftReleaseId.localeCompare(right.overlap.leftReleaseId) ||
        left.overlap.rightReleaseId.localeCompare(right.overlap.rightReleaseId),
    )
    .slice(0, 20)
    .map((entry) => entry.overlap);
}

function snapshotWarnings(
  evaluated: Evaluated[],
  input: RankSelectionInput,
): ReleaseWarning[] {
  const warnings: ReleaseWarning[] = [];
  if (!input.media) {
    warnings.push({
      code: "IDENTITY_UNVERIFIED",
      message: "尚未确认作品身份，只整理候选字段，不给出确定首选",
    });
  }
  if (input.target.mode === "browse") {
    warnings.push({
      code: "BROWSE_ALL",
      message: "浏览全部时按范围分组展示，不跨季给出综合首选",
    });
  }
  const conflicts = evaluated.filter((entry) => entry.identity === "conflict").length;
  if (conflicts > 0) {
    warnings.push({
      code: "IDENTITY_CONFLICTS",
      message: `${conflicts} 个候选与当前作品身份冲突，已排除推荐`,
    });
  }
  const eligible = evaluated.filter((entry) => entry.eligible);
  if (eligible.length > 0 && eligible.every((entry) => !entry.available)) {
    warnings.push({
      code: "NO_CONFIRMED_SEEDERS",
      message: "没有确认有做种者的候选，可用性待确认，不保证下载速度",
    });
  }
  if (input.preferences.freeleechOnly) {
    warnings.push({
      code: "FREELEECH_SNAPSHOT_ONLY",
      message: "免费状态来自当前快照，下载期间优惠可能变化",
    });
  }
  return dedupeReleaseWarnings(warnings);
}
