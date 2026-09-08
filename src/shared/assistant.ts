import { z } from "zod";

/** Public media types understood by the assistant. */
export const assistantMediaTypeSchema = z.enum(["movie", "tv"]);
export type AssistantMediaType = z.infer<typeof assistantMediaTypeSchema>;

export const assistantResolutionSchema = z.enum(["2160p", "1080p", "720p"]);
export type AssistantResolution = z.infer<typeof assistantResolutionSchema>;

export const assistantAvailabilitySchema = z.enum([
  "unchecked",
  "available",
  "possible",
  "unavailable",
  "error",
]);
export type AssistantAvailability = z.infer<typeof assistantAvailabilitySchema>;

/**
 * Preferences are normalized by the server and are deliberately smaller than
 * the model prompt.  Keeping this contract independent from the discovery
 * contracts lets the web client render the state without importing server
 * implementation details.
 */
const assistantPreferencesShape = {
  mediaType: assistantMediaTypeSchema.optional(),
  includeGenres: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  excludeGenres: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  yearFrom: z.number().int().min(1888).max(2200).nullable().default(null),
  yearTo: z.number().int().min(1888).max(2200).nullable().default(null),
  mood: z.string().trim().max(160).default(""),
  seenMediaIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]{1,64})?$/u)).max(100).default([]),
  resolution: assistantResolutionSchema.nullable().default(null),
  maxSizeBytes: z.number().int().positive().max(2 * 1024 ** 4).nullable().default(null),
  freeleechRequired: z.boolean().default(false),
  freeleechPreferred: z.boolean().default(false),
  onlyAvailable: z.boolean().default(false),
} as const;

export const assistantPreferencesSchema = z.object(assistantPreferencesShape).strict().superRefine((value, context) => {
  if (value.yearFrom !== null && value.yearTo !== null && value.yearFrom > value.yearTo) {
    context.addIssue({ code: "custom", path: ["yearFrom"], message: "yearFrom must not exceed yearTo" });
  }
  if (value.freeleechRequired && value.freeleechPreferred) {
    context.addIssue({ code: "custom", path: ["freeleechPreferred"], message: "required and preferred are mutually exclusive" });
  }
});
export type AssistantPreferences = z.infer<typeof assistantPreferencesSchema>;

/** Model updates are partial, but still reject unknown fields. */
export const assistantPreferencesPatchSchema = z.object({
  mediaType: assistantPreferencesShape.mediaType,
  includeGenres: assistantPreferencesShape.includeGenres.removeDefault(),
  excludeGenres: assistantPreferencesShape.excludeGenres.removeDefault(),
  yearFrom: assistantPreferencesShape.yearFrom.removeDefault(),
  yearTo: assistantPreferencesShape.yearTo.removeDefault(),
  mood: assistantPreferencesShape.mood.removeDefault(),
  seenMediaIds: assistantPreferencesShape.seenMediaIds.removeDefault(),
  resolution: assistantPreferencesShape.resolution.removeDefault(),
  maxSizeBytes: assistantPreferencesShape.maxSizeBytes.removeDefault(),
  freeleechRequired: assistantPreferencesShape.freeleechRequired.removeDefault(),
  freeleechPreferred: assistantPreferencesShape.freeleechPreferred.removeDefault(),
  onlyAvailable: assistantPreferencesShape.onlyAvailable.removeDefault(),
}).partial().strict();
export type AssistantPreferencesPatch = z.infer<typeof assistantPreferencesPatchSchema>;

export const assistantTurnRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  clientTurnId: z.string().uuid(),
  message: z.string().trim().min(1).max(2_000),
}).strict();
export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;

export const assistantConstraintResultSchema = z.object({
  key: z.string().trim().min(1).max(64),
  status: z.enum(["met", "not_met", "unknown"]),
  detail: z.string().trim().max(240),
}).strict();
export type AssistantConstraintResult = z.infer<typeof assistantConstraintResultSchema>;

export const assistantEvidenceSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: z.enum(["metadata", "release_snapshot", "release_field"]),
}).strict();
export type AssistantEvidence = z.infer<typeof assistantEvidenceSchema>;

export const assistantReleaseEvidenceSchema = z.object({
  resolution: z.enum(["upstream", "title_inferred", "unknown"]),
  codec: z.enum(["upstream", "title_inferred", "unknown"]),
  size: z.enum(["upstream", "unknown"]),
  seeders: z.enum(["upstream", "unknown"]),
}).strict();
export type AssistantReleaseEvidence = z.infer<typeof assistantReleaseEvidenceSchema>;

export const assistantRankedReleaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  title: z.string().trim().min(1).max(240),
  indexer: z.string().trim().max(100),
  protocol: z.enum(["torrent", "usenet"]),
  size: z.number().nonnegative(),
  seeders: z.number().int().nonnegative(),
  leechers: z.number().int().nonnegative(),
  grabs: z.number().int().nonnegative(),
  ageDays: z.number().nonnegative(),
  categories: z.array(z.string().trim().max(80)).max(20),
  resolution: assistantResolutionSchema.optional(),
  codec: z.string().trim().max(40).optional(),
  freeleech: z.boolean(),
  freeleechState: z.enum(["yes", "no", "unknown"]).optional(),
  evidence: assistantReleaseEvidenceSchema.optional(),
  rank: z.number().int().positive(),
  reasonCodes: z.array(z.enum([
    "WITHIN_SIZE_LIMIT",
    "PREFERRED_RESOLUTION",
    "PREFERRED_FREELEECH",
    "MORE_SEEDERS",
    "MATCHED_TITLE",
    "SEEDERS_UNKNOWN",
    "POSSIBLE_MATCH",
  ])).max(12),
  matchStatus: z.enum(["confirmed", "possible", "unknown"]),
}).strict();
export type AssistantRankedRelease = z.infer<typeof assistantRankedReleaseSchema>;

export const assistantRecommendationCardSchema = z.object({
  cardId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/u),
  mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  mediaType: assistantMediaTypeSchema,
  title: z.string().trim().min(1).max(240),
  originalTitle: z.string().trim().max(240).optional(),
  year: z.string().trim().max(16).optional(),
  genres: z.array(z.string().trim().max(40)).max(20),
  summary: z.string().trim().max(900),
  reason: z.string().trim().max(800),
  evidenceIds: z.array(z.string().trim().min(1).max(120)).max(20),
  constraintResults: z.array(assistantConstraintResultSchema).max(20),
  availability: assistantAvailabilitySchema,
  checkedAt: z.string().datetime().optional(),
  snapshotId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/u).optional(),
  expiresAt: z.string().datetime().optional(),
  actionableUntil: z.string().datetime().optional(),
  rankedReleases: z.array(assistantRankedReleaseSchema).max(3),
}).strict();
export type AssistantRecommendationCard = z.infer<typeof assistantRecommendationCardSchema>;

export const assistantWarningSchema = z.object({
  code: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(300),
  mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u).optional(),
}).strict();
export type AssistantWarning = z.infer<typeof assistantWarningSchema>;

export const assistantUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  modelRequests: z.number().int().nonnegative(),
  toolExecutions: z.number().int().nonnegative(),
}).strict();
export type AssistantUsage = z.infer<typeof assistantUsageSchema>;

export const assistantTurnResponseSchema = z.object({
  conversationId: z.string().uuid(),
  turnId: z.string().uuid(),
  clientTurnId: z.string().uuid(),
  text: z.string().max(4_000),
  preferences: assistantPreferencesSchema,
  recommendations: z.array(assistantRecommendationCardSchema).max(5),
  warnings: z.array(assistantWarningSchema).max(20),
  usage: assistantUsageSchema.optional(),
}).strict();
export type AssistantTurnResponse = z.infer<typeof assistantTurnResponseSchema>;

export const assistantErrorCodeSchema = z.enum([
  "AI_DISABLED",
  "AI_UNAVAILABLE",
  "AI_TIMEOUT",
  "AI_CANCELLED",
  "AI_BUDGET_EXCEEDED",
  "AI_INVALID_OUTPUT",
  "CONVERSATION_EXPIRED",
  "TURN_IN_PROGRESS",
  "TURN_NOT_FOUND",
]);
export type AssistantErrorCode = z.infer<typeof assistantErrorCodeSchema>;

export type AssistantErrorBody = {
  error: string;
  code: AssistantErrorCode;
};

/** The small final payload the model is allowed to author. */
export const assistantModelOutputSchema = z.object({
  text: z.string().trim().max(4_000).default(""),
  preferences: assistantPreferencesPatchSchema.optional(),
  recommendations: z.array(z.object({
    mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    reason: z.string().trim().max(800).default(""),
    evidenceIds: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    constraintResults: z.array(assistantConstraintResultSchema).max(20).default([]),
  }).strict()).max(5).default([]),
  warnings: z.array(assistantWarningSchema).max(20).default([]),
}).strict();
export type AssistantModelOutput = z.infer<typeof assistantModelOutputSchema>;

export function defaultAssistantPreferences(): AssistantPreferences {
  return assistantPreferencesSchema.parse({});
}

export function normalizeAssistantPreferences(value: unknown): AssistantPreferences {
  return assistantPreferencesSchema.parse(value);
}
