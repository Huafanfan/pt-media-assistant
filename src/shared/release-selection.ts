import { z } from "zod";

/**
 * RELEASE-001 shared contract: the browser and the server agree on a bounded,
 * evidence-based vocabulary for "what does this release contain" and "why is
 * it recommended".  Everything here is deliberately stricter than the legacy
 * ReleaseSummary: new fields stay optional and unknown stays representable.
 */

export const RELEASE_SELECTION_ALGORITHM_VERSION = "selection-1" as const;
export const RELEASE_SELECTION_PARSER_VERSION = "release-parse-1" as const;

export const MAX_SELECTION_SEASON = 50;
export const MAX_SELECTION_EPISODE = 2000;
export const MAX_SELECTION_ISSUE = 5000;
export const MAX_SELECTION_UNITS = 400;
export const MAX_SELECTION_DATES = 120;
export const MAX_SELECTION_RELEASES = 60;
export const MAX_SELECTION_EVIDENCE = 48;
export const MAX_SELECTION_CONFLICTS = 12;
export const MAX_SELECTION_WARNINGS = 24;
export const MAX_SELECTION_TEXT = 240;
export const MAX_SELECTION_CATEGORIES = 20;
export const MAX_SELECTION_SUBTITLE_LANGUAGES = 6;
export const MAX_SELECTION_AUDIO_LANGUAGES = 6;
export const MAX_SELECTION_PAGE_SIZE = 50;
export const MAX_SELECTION_TARGET_UNITS = 300;

const boundedInt = (min: number, max: number) =>
  z.number().int().min(min).max(max);

const seasonsSchema = z.array(boundedInt(1, MAX_SELECTION_SEASON)).max(MAX_SELECTION_SEASON);
const episodeNumbersSchema = z.array(boundedInt(1, MAX_SELECTION_EPISODE)).max(MAX_SELECTION_TARGET_UNITS);
const issueNumbersSchema = z.array(boundedInt(1, MAX_SELECTION_ISSUE)).max(MAX_SELECTION_TARGET_UNITS);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/** Content kinds the selection engine understands. */
export const selectionContentKindSchema = z.enum([
  "movie",
  "series",
  "variety",
  "unknown",
]);
export type SelectionContentKind = z.infer<typeof selectionContentKindSchema>;

/** 上/下段（综艺常见）。 */
export const selectionSegmentSchema = z.enum(["upper", "lower"]);
export type SelectionSegment = z.infer<typeof selectionSegmentSchema>;

/**
 * Program editions are separate numbering/identity spaces.  They are never
 * treated as equivalent candidates for the same target.
 */
export const selectionEditionSchema = z.enum([
  "main",
  "extra",
  "pure",
  "member",
  "preview",
  "bonus",
  "unknown",
]);
export type SelectionEdition = z.infer<typeof selectionEditionSchema>;

export const coverageCompletenessSchema = z.enum([
  "verified",
  "claimed",
  "unknown",
]);
export type CoverageCompleteness = z.infer<typeof coverageCompletenessSchema>;

export const selectionEvidenceSourceSchema = z.enum([
  "upstream",
  "title",
  "ai",
]);
export type SelectionEvidenceSource = z.infer<
  typeof selectionEvidenceSourceSchema
>;

export const selectionEvidenceFieldSchema = z.enum([
  "title",
  "year",
  "resolution",
  "source",
  "codec",
  "hdr",
  "audio",
  "subtitle",
  "season",
  "episode",
  "issue",
  "date",
  "segment",
  "edition",
  "completeness",
  "size",
  "seeders",
  "freeleech",
  "files",
]);
export type SelectionEvidenceField = z.infer<
  typeof selectionEvidenceFieldSchema
>;

/** Value + provenance for one extracted fact. */
export const fieldEvidenceSchema = z
  .object({
    field: selectionEvidenceFieldSchema,
    value: z.string().trim().min(1).max(120),
    source: selectionEvidenceSourceSchema,
    /** Minimal original fragment or upstream field name. */
    raw: z.string().trim().max(200).optional(),
    parserVersion: z.string().trim().min(1).max(40),
  })
  .strict();
export type FieldEvidence = z.infer<typeof fieldEvidenceSchema>;

export const coverageConflictSchema = z
  .object({
    field: z.string().trim().min(1).max(40),
    values: z.array(z.string().trim().min(1).max(80)).min(1).max(6),
  })
  .strict();
export type CoverageConflict = z.infer<typeof coverageConflictSchema>;

/** One unit of release scope.  季/集、期、日期、整季、整剧 are distinct spaces. */
export const coverageUnitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("movie") }).strict(),
  z
    .object({ kind: z.literal("season"), season: boundedInt(1, MAX_SELECTION_SEASON) })
    .strict(),
  z
    .object({
      kind: z.literal("episode"),
      /** null means the title did not state a season; never assumed. */
      season: boundedInt(1, MAX_SELECTION_SEASON).nullable(),
      episode: boundedInt(1, MAX_SELECTION_EPISODE),
      /** 上/下 half when the title binds one to this episode. */
      segment: selectionSegmentSchema.nullable().optional(),
      /** A segment marker exists but could not be bound to this unit. */
      ambiguous: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("issue"),
      issue: boundedInt(1, MAX_SELECTION_ISSUE),
      /** 上/下 half; absent means the title does not state a segment. */
      segment: selectionSegmentSchema.nullable().optional(),
      /** A segment marker exists but could not be bound to this issue. */
      ambiguous: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("date"),
      date: isoDateSchema,
      segment: selectionSegmentSchema.nullable().optional(),
      /** A segment marker exists but could not be bound to this date. */
      ambiguous: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("series") }).strict(),
]);
export type CoverageUnit = z.infer<typeof coverageUnitSchema>;

export const releaseWarningSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().min(1).max(300),
  })
  .strict();
export type ReleaseWarning = z.infer<typeof releaseWarningSchema>;

/** What the release title (and optional upstream fields) claim. */
export const releaseCoverageSchema = z
  .object({
    scope: z.enum([
      "movie",
      "season",
      "episodes",
      "issues",
      "dates",
      "series",
      "unknown",
    ]),
    seasons: seasonsSchema,
    units: z.array(coverageUnitSchema).max(MAX_SELECTION_UNITS),
    multiSeason: z.boolean(),
    segments: z.array(selectionSegmentSchema).max(2),
    edition: selectionEditionSchema,
    completeness: coverageCompletenessSchema,
    /** Content year when the title states one; used for space comparison. */
    year: boundedInt(1900, 2100).nullable().optional(),
    /** True when episodes/issues/dates were expressed as a continuous range. */
    continuous: z.boolean(),
    /** 更新至 / ongoing releases: never proof of completeness. */
    openEnded: z.boolean(),
    fileCount: boundedInt(0, 100000).nullable(),
    evidence: z.array(fieldEvidenceSchema).max(MAX_SELECTION_EVIDENCE),
    conflicts: z.array(coverageConflictSchema).max(MAX_SELECTION_CONFLICTS),
    warnings: z.array(releaseWarningSchema).max(MAX_SELECTION_WARNINGS),
  })
  .strict();
export type ReleaseCoverage = z.infer<typeof releaseCoverageSchema>;

export const selectionTargetModeSchema = z.enum(["browse", "whole", "explicit"]);
export type SelectionTargetMode = z.infer<typeof selectionTargetModeSchema>;

/** The user's requested viewing scope. */
export const selectionTargetSchema = z
  .object({
    kind: selectionContentKindSchema,
    mode: selectionTargetModeSchema,
    season: boundedInt(1, MAX_SELECTION_SEASON).nullable().default(null),
    year: z
      .string()
      .regex(/^\d{4}$/u)
      .nullable()
      .default(null),
    episodes: episodeNumbersSchema.default([]),
    issues: issueNumbersSchema.default([]),
    dates: z.array(isoDateSchema).max(MAX_SELECTION_DATES).default([]),
    segments: z.array(selectionSegmentSchema).max(2).default([]),
    edition: selectionEditionSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    const hasExplicitUnits =
      value.episodes.length > 0 ||
      value.issues.length > 0 ||
      value.dates.length > 0;
    if (value.mode === "explicit" && !hasExplicitUnits) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "explicit target requires at least one episode, issue, or date",
      });
    }
    if (value.kind === "movie" && value.mode !== "browse") {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "movie target has no season/episode scope",
      });
    }
    if (value.kind === "series" && value.mode === "whole" && value.season === null) {
      context.addIssue({
        code: "custom",
        path: ["season"],
        message: "whole-season target requires a season",
      });
    }
    if (value.kind === "series" && value.issues.length + value.dates.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "series target cannot use issue or date units",
      });
    }
    if (value.kind === "variety" && value.episodes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "variety target uses issues or dates, not episode numbers",
      });
    }
    // Requesting both segments doubles the units; the expanded size must stay
    // bounded so no requirement is silently truncated later.
    const uniqueUnits =
      new Set(value.episodes.map((episode) => `e:${episode}`)).size +
      new Set(value.issues.map((issue) => `i:${issue}`)).size +
      new Set(value.dates.map((date) => `d:${date}`)).size +
      (value.mode === "whole" ? 1 : 0);
    const segmentMultiplier = Math.max(1, value.segments.length);
    if (uniqueUnits * segmentMultiplier > MAX_SELECTION_TARGET_UNITS) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: `target expands to more than ${MAX_SELECTION_TARGET_UNITS} units`,
      });
    }
  });
export type SelectionTarget = z.infer<typeof selectionTargetSchema>;

export const selectionPreferenceStrengthSchema = z.enum(["required", "preferred"]);
export type SelectionPreferenceStrength = z.infer<
  typeof selectionPreferenceStrengthSchema
>;

export const selectionLanguageSchema = z.enum([
  "zh",
  "zh-hant",
  "en",
  "ja",
  "ko",
  "other",
]);
export type SelectionLanguage = z.infer<typeof selectionLanguageSchema>;

export const selectionLanguageConstraintSchema = z
  .object({
    language: selectionLanguageSchema,
    strength: selectionPreferenceStrengthSchema,
  })
  .strict();
export type SelectionLanguageConstraint = z.infer<
  typeof selectionLanguageConstraintSchema
>;

export const selectionPresetSchema = z.enum(["balanced", "quality", "compact"]);
export type SelectionPreset = z.infer<typeof selectionPresetSchema>;

export const selectionPreferencesSchema = z
  .object({
    preset: selectionPresetSchema.default("balanced"),
    /** Independent hard filter, combinable with any preset. */
    freeleechOnly: z.boolean().default(false),
    /** Soft preference; never overrides the hard filter. */
    freeleechPreferred: z.boolean().default(false),
    resolution: z
      .object({
        value: z.enum(["2160p", "1080p", "720p"]),
        strength: selectionPreferenceStrengthSchema,
      })
      .strict()
      .nullable()
      .default(null),
    maxSizeBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 ** 4)
      .nullable()
      .default(null),
    subtitles: z
      .array(selectionLanguageConstraintSchema)
      .max(MAX_SELECTION_SUBTITLE_LANGUAGES)
      .default([]),
    audio: z
      .array(selectionLanguageConstraintSchema)
      .max(MAX_SELECTION_AUDIO_LANGUAGES)
      .default([]),
    /** When true, claimed/unknown completeness cannot satisfy the target. */
    verifiedCompletenessRequired: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.freeleechOnly && value.freeleechPreferred) {
      context.addIssue({
        code: "custom",
        path: ["freeleechPreferred"],
        message: "freeleechOnly already requires every candidate to be free",
      });
    }
    for (const [field, list] of [
      ["subtitles", value.subtitles],
      ["audio", value.audio],
    ] as const) {
      const required = list.filter((entry) => entry.strength === "required");
      const preferred = list.filter((entry) => entry.strength === "preferred");
      if (required.some((entry) => preferred.some((other) => other.language === entry.language))) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "a language cannot be required and preferred at the same time",
        });
      }
      if (new Set(list.map((entry) => entry.language)).size !== list.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "duplicate language constraint",
        });
      }
    }
  });
export type SelectionPreferences = z.infer<typeof selectionPreferencesSchema>;

/** Partial preference draft returned by AI; never applied automatically. */
export const selectionPreferencesPatchSchema = z
  .object({
    preset: selectionPresetSchema,
    freeleechOnly: z.boolean(),
    freeleechPreferred: z.boolean(),
    resolution: z
      .object({
        value: z.enum(["2160p", "1080p", "720p"]),
        strength: selectionPreferenceStrengthSchema,
      })
      .strict()
      .nullable(),
    maxSizeBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 ** 4)
      .nullable(),
    subtitles: z
      .array(selectionLanguageConstraintSchema)
      .max(MAX_SELECTION_SUBTITLE_LANGUAGES),
    audio: z
      .array(selectionLanguageConstraintSchema)
      .max(MAX_SELECTION_AUDIO_LANGUAGES),
    verifiedCompletenessRequired: z.boolean(),
  })
  .partial()
  .strict();

export const defaultSelectionPreferences = (): SelectionPreferences =>
  selectionPreferencesSchema.parse({});

/** Bounded reference to an existing server-side release snapshot. */
export const selectionSnapshotRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("discovery"),
      mediaType: z.enum(["movie", "tv"]),
      itemId: z.string().regex(/^\d{1,16}$/u),
      snapshotId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("search"),
      snapshotId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/u),
    })
    .strict(),
]);
export type SelectionSnapshotRef = z.infer<typeof selectionSnapshotRefSchema>;

export const releaseSelectionRequestSchema = z
  .object({
    snapshot: selectionSnapshotRefSchema,
    target: selectionTargetSchema,
    preferences: selectionPreferencesSchema.default(() =>
      selectionPreferencesSchema.parse({}),
    ),
  })
  .strict();
export type ReleaseSelectionRequest = z.infer<
  typeof releaseSelectionRequestSchema
>;

/** Grouping key inside one selection answer. */
export const releaseGroupKeySchema = z.enum([
  "covers_target",
  "partial_coverage",
  "single_unit",
  "unknown_scope",
  "browse_scope",
  "other_scope",
]);
export type ReleaseGroupKey = z.infer<typeof releaseGroupKeySchema>;

export const releaseIdentityStatusSchema = z.enum([
  "matched",
  "possible",
  "conflict",
  "unverified",
]);
export type ReleaseIdentityStatus = z.infer<
  typeof releaseIdentityStatusSchema
>;

export const rankingReasonCodeSchema = z.enum([
  "COVERS_TARGET",
  "PARTIAL_COVERAGE",
  "SINGLE_UNIT",
  "UNKNOWN_SCOPE",
  "EDITION_MATCH",
  "COMPLETENESS_CLAIMED",
  "COMPLETENESS_VERIFIED",
  "COMPLETENESS_UNKNOWN",
  "WITHIN_SIZE_LIMIT",
  "SIZE_UNKNOWN",
  "PREFERRED_RESOLUTION",
  "REQUIRED_RESOLUTION_MET",
  "PREFERRED_SOURCE",
  "PREFERRED_HDR",
  "SMALLER_SIZE",
  "MORE_SEEDERS",
  "FREELEECH_CONFIRMED",
  "FREELEECH_UNKNOWN",
  "SEEDERS_UNKNOWN",
  "ZERO_SEEDERS",
  "EXTRA_SCOPE",
  "MULTI_SEASON_EXTRA",
  "SUBTITLE_REQUIREMENT_MET",
  "SUBTITLE_PREFERRED",
  "SUBTITLE_UNKNOWN",
  "AUDIO_REQUIREMENT_MET",
  "AUDIO_PREFERRED",
  "AUDIO_UNKNOWN",
  "SPEC_EVIDENCE_RELIABLE",
  "SPEC_EVIDENCE_WEAK",
  "ONGOING_RELEASE",
  "IDENTITY_POSSIBLE",
  "IDENTITY_UNVERIFIED",
]);
export type RankingReasonCode = z.infer<typeof rankingReasonCodeSchema>;

export const recommendationRoleSchema = z.enum([
  "balanced_pick",
  "quality_pick",
  "compact_pick",
  "availability_pending",
]);
export type RecommendationRole = z.infer<typeof recommendationRoleSchema>;

export const selectionConstraintResultSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    status: z.enum(["met", "not_met", "unknown"]),
    detail: z.string().trim().max(240),
  })
  .strict();
export type SelectionConstraintResult = z.infer<
  typeof selectionConstraintResultSchema
>;

export const rankedReleaseSchema = z
  .object({
    releaseId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
    title: z.string().trim().min(1).max(MAX_SELECTION_TEXT),
    indexer: z.string().trim().max(100),
    protocol: z.enum(["torrent", "usenet"]),
    size: z.number().nonnegative(),
    sizeKnown: z.boolean(),
    seeders: z.number().int().nonnegative(),
    seedersKnown: z.boolean(),
    leechers: z.number().int().nonnegative(),
    grabs: z.number().int().nonnegative(),
    ageDays: z.number().nonnegative(),
    categories: z.array(z.string().trim().max(80)).max(MAX_SELECTION_CATEGORIES),
    resolution: z.enum(["2160p", "1080p", "720p"]).optional(),
    codec: z.string().trim().max(40).optional(),
    source: z
      .enum(["remux", "bluray", "webdl", "webrip", "hdtv", "dvd", "other"])
      .optional(),
    hdr: z
      .enum(["hdr", "hdr10", "hdr10plus", "dolby_vision", "hlg", "sdr"])
      .optional(),
    subtitleLanguages: z.array(selectionLanguageSchema).max(MAX_SELECTION_SUBTITLE_LANGUAGES),
    audioLanguages: z.array(selectionLanguageSchema).max(MAX_SELECTION_AUDIO_LANGUAGES),
    freeleech: z.boolean(),
    freeleechState: z.enum(["yes", "no", "unknown"]),
    identity: releaseIdentityStatusSchema,
    group: releaseGroupKeySchema,
    /** Season/edition/year bucket for same-space grouping inside a group. */
    subgroup: z.string().trim().min(1).max(64).optional(),
    rank: z.number().int().positive(),
    recommendationRole: recommendationRoleSchema.nullable(),
    reasonCodes: z.array(rankingReasonCodeSchema).max(24),
    warnings: z.array(releaseWarningSchema).max(MAX_SELECTION_WARNINGS),
    constraintResults: z.array(selectionConstraintResultSchema).max(24),
    coverage: releaseCoverageSchema,
    evidence: z.array(fieldEvidenceSchema).max(MAX_SELECTION_EVIDENCE),
  })
  .strict();
export type RankedRelease = z.infer<typeof rankedReleaseSchema>;

export const releaseOverlapSchema = z
  .object({
    leftReleaseId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
    rightReleaseId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
    kind: z.enum(["overlap", "complement"]),
    sharedUnitCount: z.number().int().nonnegative(),
    complementUnitCount: z.number().int().nonnegative(),
    note: z.string().trim().min(1).max(240),
  })
  .strict();
export type ReleaseOverlap = z.infer<typeof releaseOverlapSchema>;

export const selectionSnapshotSummarySchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/u),
    kind: z.enum(["discovery", "search"]),
    query: z.string().trim().max(240),
    checkedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    actionableUntil: z.string().datetime().nullable(),
    stale: z.boolean(),
    releaseCount: z.number().int().nonnegative(),
    media: z
      .object({
        mediaType: z.enum(["movie", "tv"]),
        itemId: z.string().regex(/^\d{1,16}$/u),
        title: z.string().trim().min(1).max(240),
        originalTitle: z.string().trim().max(240).optional(),
        year: z.string().trim().max(16).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SelectionSnapshotSummary = z.infer<
  typeof selectionSnapshotSummarySchema
>;

export const selectionRevisionSchema = z
  .object({
    snapshotId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/u),
    targetRevision: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
    preferencesRevision: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
    algorithmVersion: z.string().trim().min(1).max(40),
    checkedAt: z.string().datetime(),
  })
  .strict();
export type SelectionRevision = z.infer<typeof selectionRevisionSchema>;

export const releaseSelectionResponseSchema = z
  .object({
    snapshot: selectionSnapshotSummarySchema,
    target: selectionTargetSchema,
    preferences: selectionPreferencesSchema,
    revision: selectionRevisionSchema,
    groups: z
      .array(
        z
          .object({
            key: releaseGroupKeySchema,
            releases: z.array(rankedReleaseSchema).max(MAX_SELECTION_RELEASES),
          })
          .strict(),
      )
      .max(6),
    recommendations: z.array(rankedReleaseSchema).max(3),
    availabilityPending: z.array(rankedReleaseSchema).max(MAX_SELECTION_RELEASES),
    overlaps: z.array(releaseOverlapSchema).max(20),
    warnings: z.array(releaseWarningSchema).max(MAX_SELECTION_WARNINGS),
    totalCandidates: z.number().int().nonnegative(),
    eligibleCount: z.number().int().nonnegative(),
    recommendedCount: z.number().int().nonnegative(),
  })
  .strict();
export type ReleaseSelectionResponse = z.infer<
  typeof releaseSelectionResponseSchema
>;

export const selectionAssistModeSchema = z.enum(["compare", "preferences"]);
export type SelectionAssistMode = z.infer<typeof selectionAssistModeSchema>;

export const selectionAssistRequestSchema = z
  .object({
    snapshot: selectionSnapshotRefSchema,
    target: selectionTargetSchema,
    preferences: selectionPreferencesSchema.default(() =>
      selectionPreferencesSchema.parse({}),
    ),
    mode: selectionAssistModeSchema,
    /** Natural-language preference text (bounded). */
    message: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "preferences" && !value.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "preference assist requires a message",
      });
    }
  });
export type SelectionAssistRequest = z.infer<
  typeof selectionAssistRequestSchema
>;

export const selectionAssistAnalysisSchema = z.enum([
  "complete",
  "partial",
  "rule_fallback",
  "cached",
]);
export type SelectionAssistAnalysis = z.infer<
  typeof selectionAssistAnalysisSchema
>;

export const selectionAssistResponseSchema = z
  .object({
    analysis: selectionAssistAnalysisSchema,
    analyzedCandidateCount: z.number().int().nonnegative(),
    totalCandidateCount: z.number().int().nonnegative(),
    text: z.string().max(2000),
    /** Preference draft is never applied automatically. */
    preferenceDraft: selectionPreferencesSchema.nullable(),
    /** Only verified parse suggestions reach this list. */
    parseSuggestions: z
      .array(
        z
          .object({
            releaseId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
            field: selectionEvidenceFieldSchema,
            value: z.string().trim().min(1).max(120),
            raw: z.string().trim().max(200),
            reasonCode: rankingReasonCodeSchema.nullable(),
          })
          .strict(),
      )
      .max(12),
    /** The rules result always remains authoritative for the UI. */
    selection: releaseSelectionResponseSchema,
    warnings: z.array(releaseWarningSchema).max(MAX_SELECTION_WARNINGS),
  })
  .strict();
export type SelectionAssistResponse = z.infer<
  typeof selectionAssistResponseSchema
>;

export const selectionErrorCodeSchema = z.enum([
  "SNAPSHOT_NOT_FOUND",
  "SNAPSHOT_EXPIRED",
  "TARGET_INVALID",
  "PREFERENCES_CONFLICT",
  "AI_DISABLED",
  "AI_UNAVAILABLE",
  "AI_TIMEOUT",
  "AI_RATE_LIMITED",
  "AI_CONCURRENCY_LIMITED",
  "AI_INVALID_OUTPUT",
  "AI_CANCELLED",
]);
export type SelectionErrorCode = z.infer<typeof selectionErrorCodeSchema>;
