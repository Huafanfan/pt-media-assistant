import { z } from "zod";
import type { ParsedIntent, SearchRequest } from "../shared/contracts.js";

/** The parser intentionally has a small, deterministic vocabulary. */
export const MAX_QUERY_LENGTH = 240;
export const MAX_RESULT_LIMIT = 50;
const BYTES_PER_GIB = 1024 ** 3;

export const parsedIntentSchema = z.object({
  searchTerm: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  resolution: z.enum(["2160p", "1080p", "720p"]).optional(),
  maxSizeBytes: z.number().int().positive().max(10 * 1024 ** 4).optional(),
  freeleechOnly: z.boolean().optional(),
});

export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  limit: z.coerce.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
});

export type ValidatedSearchRequest = z.output<typeof searchRequestSchema>;

const RESOLUTION_PATTERNS: Array<{ value: ParsedIntent["resolution"]; pattern: RegExp }> = [
  { value: "2160p", pattern: /(?:\b4k\b|\b2160p?\b)/i },
  { value: "1080p", pattern: /\b1080p?\b/i },
  { value: "720p", pattern: /\b720p?\b/i },
];

const FREELEECH_PATTERN = /(?:\bfree[\s_-]?leech\b|免费(?:下载|做种)?)/giu;

// Keep the unit vocabulary deliberately narrow so "4K" is interpreted as a
// resolution and not as a four-kilobyte size limit.
const SIZE_PATTERN = /(?:(小于|少于|不超过|低于|最多|至多|<=|≤|<)\s*)?(\d+(?:\.\d+)?)\s*(TB?|GB?|MB?)\s*(以内|以下|内)?/giu;

const LEADING_SEARCH_WORDS = /^(?:请(?:搜索|查找|找(?:一下)?|看)?|帮我(?:搜索|查找|找|看)?|帮忙(?:搜索|查找|找|看)?|我想(?:看|找)|想(?:看|找)|搜索|搜一下|查找|寻找|找一下|找)\s*/u;

function cleanInput(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function parseSize(value: string, unit: string): number | undefined {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const normalized = unit.toUpperCase();
  const multiplier = normalized.startsWith("T")
    ? 1024 ** 4
    : normalized.startsWith("G")
      ? BYTES_PER_GIB
      : normalized.startsWith("M")
        ? 1024 ** 2
        : 1024;
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes > 10 * 1024 ** 4) return undefined;
  return bytes;
}

function removeMatches(input: string, patterns: RegExp[]): string {
  return patterns.reduce((current, pattern) => current.replace(pattern, " "), input);
}

function cleanSearchTerm(value: string): string {
  return value
    .replace(LEADING_SEARCH_WORDS, "")
    .replace(/\s+/gu, " ")
    .replace(/^[\s,，。.!！?？:：;；、-]+|[\s,，。.!！?？:：;；、-]+$/gu, "")
    .trim();
}

/**
 * Parse the bounded query language used by the UI. The original query is
 * never sent to an upstream service: only this normalized intent is used.
 */
export function parseQuery(query: string): ParsedIntent {
  const input = cleanInput(query);
  if (input.length === 0) {
    throw new Error("Search query must not be empty");
  }
  if (input.length > MAX_QUERY_LENGTH) {
    throw new Error("Search query is too long");
  }

  const titleMatch = /《([^《》]{1,160})》/u.exec(input);
  const title = titleMatch?.[1] ? cleanSearchTerm(titleMatch[1]) : undefined;
  let controls = titleMatch ? input.replace(titleMatch[0], " ") : input;

  let resolution: ParsedIntent["resolution"];
  for (const candidate of RESOLUTION_PATTERNS) {
    if (candidate.pattern.test(input)) {
      resolution = candidate.value;
      break;
    }
  }

  let maxSizeBytes: number | undefined;
  const sizeMatches: string[] = [];
  for (const match of controls.matchAll(SIZE_PATTERN)) {
    const operator = match[1];
    const amount = match[2];
    const unit = match[3];
    const suffix = match[4];
    // A bare "30GB" is not a constraint; this avoids treating a title's
    // catalog number as a size requirement.
    if (!operator && !suffix) continue;
    const parsed = parseSize(amount, unit);
    if (operator || suffix) {
      if (parsed === undefined) throw new Error("Size limit is outside the supported range");
      maxSizeBytes = parsed;
      sizeMatches.push(match[0]);
    }
  }

  const freeleechOnly = FREELEECH_PATTERN.test(input) ? true : undefined;

  // Strip only recognized control tokens. A title without 《…》 retains any
  // ordinary year, language, or other search terms supplied by the user.
  controls = removeMatches(controls, [
    /(?:\b4k\b|\b2160p?\b|\b1080p?\b|\b720p?\b)/giu,
    FREELEECH_PATTERN,
    ...sizeMatches.map((match) => new RegExp(match.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu")),
  ]);

  const searchTerm = title || cleanSearchTerm(controls);
  if (!searchTerm) {
    throw new Error("Search query must include a title or search term");
  }

  return parsedIntentSchema.parse({
    searchTerm,
    ...(resolution ? { resolution } : {}),
    ...(maxSizeBytes ? { maxSizeBytes } : {}),
    ...(freeleechOnly ? { freeleechOnly } : {}),
  });
}

export function parseSearchRequest(value: unknown): ValidatedSearchRequest & { intent: ParsedIntent } {
  const request = searchRequestSchema.parse(value) as SearchRequest & { limit: number };
  return { ...request, intent: parseQuery(request.query) };
}

// Friendly aliases for unit tests and callers that prefer the domain term.
export const parseIntent = parseQuery;
export const parseNaturalLanguageQuery = parseQuery;
