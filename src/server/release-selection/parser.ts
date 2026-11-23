import {
  RELEASE_SELECTION_PARSER_VERSION,
  type CoverageConflict,
  type CoverageUnit,
  type FieldEvidence,
  type ReleaseWarning,
  type SelectionEdition,
  type SelectionLanguage,
  type SelectionSegment,
} from "../../shared/release-selection.js";

/**
 * Deterministic release-title parsing with per-field evidence.  This module
 * never guesses a season from unrelated numbers and never promotes a
 * publisher's "complete" wording into verified completeness.
 */

const MAX_PARSE_UNITS = 400;
const MAX_PARSE_TITLE = 400;
const PARSER_VERSION = RELEASE_SELECTION_PARSER_VERSION;

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function parseChineseInteger(value: string): number | undefined {
  if (/^\d+$/u.test(value)) return Number(value);
  if (value.length === 0 || value.length > 3) return undefined;
  if (!/^[一二两三四五六七八九十百]+$/u.test(value)) return undefined;
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (character === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else {
      current = CHINESE_DIGITS[character] ?? 0;
    }
  }
  return total + current;
}

type ParsedEpisode = {
  /** null: the title did not state a season. */
  season: number | null;
  episode: number;
};

export type ParsedReleaseFacts = {
  title: string;
  year?: number;
  resolution?: "2160p" | "1080p" | "720p";
  source?: "remux" | "bluray" | "webdl" | "webrip" | "hdtv" | "dvd" | "other";
  codec?: string;
  hdr?: "hdr" | "hdr10" | "hdr10plus" | "dolby_vision" | "hlg" | "sdr";
  subtitleLanguages: SelectionLanguage[];
  hasSubtitleClaim: boolean;
  audioLanguages: SelectionLanguage[];
  seasons: number[];
  episodes: ParsedEpisode[];
  issues: number[];
  /** Issue numbers keep their own 上/下 segment; never a global set. */
  issueSegments: Array<{ issue: number; segment: SelectionSegment | null }>;
  /** Calendar dates keep their own 上/下 segment when one is adjacent. */
  dateSegments: Array<{ date: string; segment: SelectionSegment | null }>;
  /** Dates with a conflicting marker whose ownership stayed unknown. */
  ambiguousDates: string[];
  dates: string[];
  wholeSeasons: number[];
  completeSeries: boolean;
  completeEpisodes: boolean;
  completeIssues: boolean;
  /** Raw title contains 更新至, regardless of whether its tail parsed. */
  hasUpdateMarker: boolean;
  updatedTo?: ParsedEpisode;
  segments: SelectionSegment[];
  edition: SelectionEdition;
  multiSeason: boolean;
  fileCount?: number;
  evidence: FieldEvidence[];
  conflicts: CoverageConflict[];
  warnings: ReleaseWarning[];
};

export type ParseUpstreamFacts = {
  fileCount?: number | null;
};

function cleanTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_PARSE_TITLE);
}

type Span = { start: number; end: number };

function overlapsAny(span: Span, spans: readonly Span[]): boolean {
  return spans.some((other) => span.start < other.end && other.start < span.end);
}

function collectMatches(
  title: string,
  pattern: RegExp,
  handler: (match: RegExpExecArray) => void,
): Span[] {
  const spans: Span[] = [];
  for (const match of title.matchAll(pattern)) {
    const index = match.index ?? 0;
    const span = { start: index, end: index + match[0].length };
    spans.push(span);
    handler(match);
  }
  return spans;
}

function evidence(
  field: FieldEvidence["field"],
  value: string,
  raw: string,
  source: FieldEvidence["source"] = "title",
): FieldEvidence {
  return {
    field,
    value: value.slice(0, 120),
    source,
    raw: raw.slice(0, 200),
    parserVersion: PARSER_VERSION,
  };
}

const RESOLUTION_PATTERNS: Array<{
  value: NonNullable<ParsedReleaseFacts["resolution"]>;
  pattern: RegExp;
}> = [
  { value: "2160p", pattern: /\b(?:4k|2160p?)\b/iu },
  { value: "1080p", pattern: /\b1080[pi]\b/iu },
  { value: "720p", pattern: /\b720p\b/iu },
];

const SOURCE_PATTERNS: Array<{
  value: NonNullable<ParsedReleaseFacts["source"]>;
  pattern: RegExp;
}> = [
  { value: "remux", pattern: /\bremux\b/iu },
  { value: "webrip", pattern: /\bweb[\s._-]?rip\b/iu },
  { value: "webdl", pattern: /\bweb[\s._-]?(?:dl|d l)\b|\bweb\b/iu },
  { value: "bluray", pattern: /\b(?:blu[\s._-]?ray|bdrip|brrip|bdmv|bd)\b/iu },
  { value: "hdtv", pattern: /\b(?:uhd[\s._-]?tv|hdtv|hdtvrip|tvrip)\b/iu },
  { value: "dvd", pattern: /\b(?:dvdrip|dvd)\b/iu },
];

const CODEC_PATTERN =
  /\b(?:x265|x264|h\.?265|h\.?264|hevc|avc|av1|xvid|divx|mpeg[\s._-]?2|vc[\s._-]?1)\b/iu;

const HDR_PATTERNS: Array<{
  value: NonNullable<ParsedReleaseFacts["hdr"]>;
  pattern: RegExp;
}> = [
  { value: "dolby_vision", pattern: /\b(?:dolby[\s._-]?vision|dovi)\b/iu },
  { value: "hdr10plus", pattern: /\bhdr10\s*\+|\bhdr10plus\b/iu },
  { value: "hdr10", pattern: /\bhdr10\b/iu },
  { value: "hlg", pattern: /\bhlg\b/iu },
  { value: "hdr", pattern: /\bhdr\b/iu },
  { value: "sdr", pattern: /\bsdr\b/iu },
];

const AUDIO_LANGUAGE_PATTERNS: Array<{
  value: SelectionLanguage;
  pattern: RegExp;
}> = [
  { value: "zh", pattern: /(?:国语(?!字幕)|國語(?!字幕)|普通话(?!字幕)|普通話(?!字幕)|中文音轨|中文音軌|mandarin(?![\s._-]*(?:subs?|subtitles?))(?:\s+(?:audio|dub))?)/iu },
  { value: "en", pattern: /(?:英语(?!字幕)|英語(?!字幕)|英文音轨|英文音軌|english(?![\s._-]*(?:subs?|subtitles?))(?:(?!\s+(?:subs?|subtitles?))\s+(?:audio|dub))?)/iu },
  { value: "ja", pattern: /(?:日语(?!字幕)|日語(?!字幕)|日本語(?!字幕)|japanese(?![\s._-]*(?:subs?|subtitles?))(?:(?!\s+(?:subs?|subtitles?))\s+(?:audio|dub))?)/iu },
  { value: "ko", pattern: /(?:韩语(?!字幕)|韓語(?!字幕)|한국어(?!字幕)|korean(?![\s._-]*(?:subs?|subtitles?))(?:(?!\s+(?:subs?|subtitles?))\s+(?:audio|dub))?)/iu },
  { value: "other", pattern: /(?:粤语|粵語|cantonese|台语|台語)/iu },
];

const SUBTITLE_LANGUAGE_PATTERNS: Array<{
  value: SelectionLanguage;
  pattern: RegExp;
}> = [
  { value: "zh", pattern: /(?:简中|簡中|简体字幕|簡體字幕|中文字幕|国语字幕|國語字幕|中字|\bchs\b|\bcht\b|chinese\s+subs?(?:title)?s?)/iu },
  { value: "zh-hant", pattern: /(?:繁中|繁体字幕|繁體字幕|\bbig5\b)/iu },
  { value: "en", pattern: /(?:英文字幕|英字|english\s+subs?(?:title)?s?|\beng\b)/iu },
  { value: "ja", pattern: /(?:日文字幕|日语字幕|日本語字幕|japanese\s+subs?(?:title)?s?)/iu },
  { value: "ko", pattern: /(?:韩文字幕|韓文字幕|korean\s+subs?(?:title)?s?)/iu },
];

const SUBTITLE_MARKER_PATTERN =
  /(?:中字|字幕|简中|簡中|繁中|内封|內封|内嵌|內嵌|外挂|外掛|subbed|subs)/iu;

// A negation before a claim ("无中文字幕", "no subs") must not count as a
// positive language fact; the stripped text keeps positive claims intact.
const NEGATED_CLAIM_PATTERN =
  /(?:无|無|没有|沒有|不含|未含|no|without)\s*(?:(?:中文|简中|簡中|繁中|英文|英语|英語|日语|日語|韩语|韓語|国语|國語|粤语|粵語|english|chinese|japanese|korean|mandarin|cantonese)\s*)?(?:中字|中文字幕|简中|簡中|繁中|繁体字幕|繁體字幕|英字|英文字幕|字幕|国语|國語|粤语|粵語|英语|英語|日语|日語|韩语|韓語|原声|原聲|音轨|音軌|subs?|subtitles?|audio|dub)/giu;

function stripNegatedClaims(text: string): string {
  return text.replace(NEGATED_CLAIM_PATTERN, " ");
}

const EDITION_PATTERNS: Array<{
  value: SelectionEdition;
  pattern: RegExp;
}> = [
  { value: "preview", pattern: /(?:预告|預告|抢先看|搶先看|trailer)/iu },
  { value: "bonus", pattern: /(?:花絮|番外|彩蛋|幕后|幕後|特典|bonus|behind[\s._-]?the[\s._-]?scenes)/iu },
  { value: "pure", pattern: /(?:纯享|純享)/iu },
  { value: "extra", pattern: /(?:加更|加料|会员加更|會員加更)/iu },
  { value: "member", pattern: /(?:会员版|會員版|会员专享|會員專享|尊享版)/iu },
  { value: "main", pattern: /(?:正片|完整版)/iu },
];

function firstDefined<T>(
  title: string,
  patterns: Array<{ value: T; pattern: RegExp }>,
): { value: T; raw: string } | undefined {
  for (const { value, pattern } of patterns) {
    const match = pattern.exec(title);
    if (match) return { value, raw: match[0] };
  }
  return undefined;
}

type SeasonHit = { season: number; raw: string; span: Span };

function extractSeasons(title: string): SeasonHit[] {
  const hits: SeasonHit[] = [];
  const chinese = /第\s*([一二两三四五六七八九十百\d]{1,3})\s*(?:[-~–—至到]\s*([一二两三四五六七八九十百\d]{1,3})\s*)?季/gu;
  for (const match of title.matchAll(chinese)) {
    const index = match.index ?? 0;
    const from = parseChineseInteger(match[1] ?? "");
    if (from === undefined || from < 1 || from > 50) continue;
    const to = match[2] ? parseChineseInteger(match[2]) : from;
    if (to === undefined || to < from || to > 50) continue;
    for (let season = from; season <= to && season <= 50; season += 1) {
      hits.push({
        season,
        raw: match[0],
        span: { start: index, end: index + match[0].length },
      });
    }
  }
  const fullSeasons = /(?:全|共)\s*([\d一二两三四五六七八九十百]{1,2})\s*季/gu;
  for (const match of title.matchAll(fullSeasons)) {
    const count = parseChineseInteger(match[1] ?? "");
    if (count === undefined || count < 1 || count > 50) continue;
    const index = match.index ?? 0;
    const span = { start: index, end: index + match[0].length };
    for (let season = 1; season <= count; season += 1) {
      if (hits.some((hit) => hit.season === season)) continue;
      hits.push({ season, raw: match[0], span });
    }
  }
  const chineseShort = /(?<![\dA-Za-z第])(\d{1,2})\s*季/gu;
  for (const match of title.matchAll(chineseShort)) {
    const index = match.index ?? 0;
    const span = { start: index, end: index + match[0].length };
    if (overlapsAny(span, hits.map((hit) => hit.span))) continue;
    const season = Number(match[1]);
    if (!Number.isInteger(season) || season < 1 || season > 50) continue;
    hits.push({ season, raw: match[0], span });
  }
  // S01 / S01-S03 / S01-03; a bare Sxx followed by Exx is an episode marker.
  const english = /\bS(\d{1,2})(?:\s*[-~–—]\s*S?(\d{1,2}))?\b(?!\s*[.\-_ ]?E(?:P)?\d)/giu;
  for (const match of title.matchAll(english)) {
    const index = match.index ?? 0;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (!Number.isInteger(from) || from < 1 || from > 50) continue;
    if (!Number.isInteger(to) || to < from || to > 50) continue;
    for (let season = from; season <= to; season += 1) {
      hits.push({
        season,
        raw: match[0],
        span: { start: index, end: index + match[0].length },
      });
    }
  }
  return hits;
}

type EpisodeHit = { season: number | null; episodes: number[]; raw: string; complete: boolean; span: Span };

function expandRange(from: number, to: number, max: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to && values.length < max; value += 1) {
    values.push(value);
  }
  return values;
}

function extractEpisodeHits(title: string): EpisodeHit[] {
  const hits: EpisodeHit[] = [];
  const seen = new Set<string>();
  const spanFor = (match: RegExpExecArray): Span => {
    const start = match.index ?? 0;
    return { start, end: start + match[0].length };
  };
  const push = (
    season: number | null,
    episodes: number[],
    raw: string,
    complete: boolean,
    span: Span,
  ): void => {
    if (episodes.length === 0) return;
    // A higher-priority pattern already claimed this span: S02E01-E08 must
    // not also produce an unscoped E01-E08 duplicate.
    if (overlapsAny(span, hits.map((hit) => hit.span))) return;
    const key = `${season ?? "?"}:${episodes[0]}-${episodes.at(-1)}:${complete}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ season, episodes, raw, complete, span });
  };

  const updatePattern = /更新至\s*(?:第\s*)?(?:E(?:P)?\s*)?(\d{1,4})\s*(?:[集话話期])?/giu;
  collectMatches(title, updatePattern, (match) => {
    const episode = Number(match[1]);
    if (Number.isInteger(episode) && episode >= 1) {
      push(null, [episode], match[0], false, spanFor(match));
    }
  });
  // "更新至S03E08" is still an ongoing marker even though the update number is
  // expressed as a season/episode pair.
  const updateSeasonEpisode = /更新至\s*S(\d{1,2})\s*[.\-_ ]?\s*E(?:P)?(\d{1,4})/giu;
  collectMatches(title, updateSeasonEpisode, (match) => {
    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (
      Number.isInteger(season) &&
      season >= 1 &&
      season <= 50 &&
      Number.isInteger(episode) &&
      episode >= 1 &&
      episode <= 2000
    ) {
      push(season, [episode], match[0], false, spanFor(match));
    }
  });

  const completePattern = /(?:全|共)\s*([\d一二两三四五六七八九十百]{1,4})\s*[集话話]/gu;
  collectMatches(title, completePattern, (match) => {
    const value = parseChineseInteger(match[1] ?? "");
    if (value === undefined || value < 1 || value > 2000) return;
    push(null, expandRange(1, value, MAX_PARSE_UNITS), match[0], true, spanFor(match));
  });

  const suffixCompletePattern = /([\d]{1,4})\s*[集话話]\s*全/gu;
  collectMatches(title, suffixCompletePattern, (match) => {
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value < 1 || value > 2000) return;
    push(null, expandRange(1, value, MAX_PARSE_UNITS), match[0], true, spanFor(match));
  });

  const seasonEpisodePattern =
    /\bS(\d{1,2})\s*[.\-_ ]?\s*E(?:P)?(\d{1,4})(?:\s*[-~–—]\s*E?(?:P)?(\d{1,4}))?/giu;
  collectMatches(title, seasonEpisodePattern, (match) => {
    const season = Number(match[1]);
    const from = Number(match[2]);
    const to = match[3] ? Number(match[3]) : from;
    if (!Number.isInteger(season) || season < 1 || season > 50) return;
    if (!Number.isInteger(from) || from < 1 || from > 2000) return;
    if (!Number.isInteger(to) || to < from || to > 2000) return;
    push(season, expandRange(from, to, MAX_PARSE_UNITS), match[0], false, spanFor(match));
  });

  const episodeRangePattern =
    /\bE(?:P)?(\d{1,4})(?:\s*[-~–—]\s*E?(?:P)?(\d{1,4}))?\b/giu;
  collectMatches(title, episodeRangePattern, (match) => {
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (!Number.isInteger(from) || from < 1 || from > 2000) return;
    if (!Number.isInteger(to) || to < from || to > 2000) return;
    push(null, expandRange(from, to, MAX_PARSE_UNITS), match[0], false, spanFor(match));
  });

  const chineseEpisodeRange =
    /第\s*(\d{1,4})\s*[-~–—至到]\s*(\d{1,4})\s*[集话話]/gu;
  collectMatches(title, chineseEpisodeRange, (match) => {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isInteger(from) || from < 1 || from > 2000) return;
    if (!Number.isInteger(to) || to < from || to > 2000) return;
    push(null, expandRange(from, to, MAX_PARSE_UNITS), match[0], false, spanFor(match));
  });

  const chineseEpisodeSingle = /第\s*(\d{1,4})\s*[集话話]/gu;
  collectMatches(title, chineseEpisodeSingle, (match) => {
    const episode = Number(match[1]);
    if (!Number.isInteger(episode) || episode < 1 || episode > 2000) return;
    push(null, [episode], match[0], false, spanFor(match));
  });

  const bareRange = /(?<![\d])(\d{1,4})\s*[-~–—至到]\s*(\d{1,4})\s*[集话話]/gu;
  collectMatches(title, bareRange, (match) => {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isInteger(from) || from < 1 || from > 2000) return;
    if (!Number.isInteger(to) || to < from || to > 2000) return;
    push(null, expandRange(from, to, MAX_PARSE_UNITS), match[0], false, spanFor(match));
  });

  return hits;
}

type IssueHit = {
  issue: number;
  segment: SelectionSegment | null;
  raw: string;
  complete: boolean;
};

function extractIssueHits(title: string): IssueHit[] {
  const hits: IssueHit[] = [];
  const push = (
    issue: number,
    segment: SelectionSegment | null,
    raw: string,
    complete: boolean,
  ): void => {
    if (!Number.isInteger(issue) || issue < 1 || issue > 5000) return;
    // The same issue may legitimately appear as 上 and 下; keep both, but
    // never duplicate the identical (issue, segment) pair or raw span.
    if (
      hits.some(
        (hit) =>
          hit.issue === issue &&
          hit.segment === segment &&
          hit.raw === raw,
      )
    )
      return;
    hits.push({ issue, segment, raw, complete });
  };
  const pushRange = (
    from: number,
    to: number,
    segment: SelectionSegment | null,
    raw: string,
    complete: boolean,
  ): void => {
    if (!Number.isInteger(from) || from < 1 || from > 5000) return;
    if (!Number.isInteger(to) || to < from || to > 5000) return;
    for (const issue of expandRange(from, to, MAX_PARSE_UNITS)) {
      push(issue, segment, raw, complete);
    }
  };

  // Numbered segments come first so "第8期上" keeps its own segment.
  const update = /更新至\s*(?:第\s*)?(\d{1,4})\s*期/gu;
  collectMatches(title, update, (match) => {
    push(Number(match[1]), null, match[0], false);
  });

  // Issues with an explicit 上/下 must not also produce an unsegmented unit,
  // otherwise a half would satisfy a whole-issue target.
  const segmentedIssues = new Set<number>();
  const pushUnsegmented = (
    issue: number,
    raw: string,
    complete: boolean,
  ): void => {
    if (segmentedIssues.has(issue)) return;
    push(issue, null, raw, complete);
  };
  const numbered =
    /(?:第\s*)?(\d{1,4})\s*期\s*[（(]?[\s._-]*\s*(上\s*[、/／]?\s*下|上下|上|下)/gu;
  collectMatches(title, numbered, (match) => {
    const issue = Number(match[1]);
    segmentedIssues.add(issue);
    const token = (match[2] ?? "").replace(/[\s、/／]/gu, "");
    if (token === "上下") {
      push(issue, "upper", match[0], false);
      push(issue, "lower", match[0], false);
      return;
    }
    push(issue, token === "上" ? "upper" : "lower", match[0], false);
  });

  const complete = /(?:全|共)\s*([\d一二两三四五六七八九十百]{1,4})\s*期/gu;
  collectMatches(title, complete, (match) => {
    const value = parseChineseInteger(match[1] ?? "");
    if (value === undefined || value < 1 || value > 5000) return;
    pushRange(1, value, null, match[0], true);
  });

  const suffixComplete = /(\d{1,4})\s*期\s*全/gu;
  collectMatches(title, suffixComplete, (match) => {
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value < 1 || value > 5000) return;
    pushRange(1, value, null, match[0], true);
  });

  const range = /第\s*(\d{1,4})\s*[-~–—至到]\s*(\d{1,4})\s*期/gu;
  collectMatches(title, range, (match) => {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isInteger(from) || from < 1 || from > 5000) return;
    if (!Number.isInteger(to) || to < from || to > 5000) return;
    for (const issue of expandRange(from, to, MAX_PARSE_UNITS)) {
      pushUnsegmented(issue, match[0], false);
    }
  });

  const single = /第\s*(\d{1,4})\s*期/gu;
  collectMatches(title, single, (match) => {
    pushUnsegmented(Number(match[1]), match[0], false);
  });

  const bareRange = /(?<!第\s)(?<![\d])(\d{1,4})\s*[-~–—至到]\s*(\d{1,4})\s*期/gu;
  collectMatches(title, bareRange, (match) => {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isInteger(from) || from < 1 || from > 5000) return;
    if (!Number.isInteger(to) || to < from || to > 5000) return;
    for (const issue of expandRange(from, to, MAX_PARSE_UNITS)) {
      pushUnsegmented(issue, match[0], false);
    }
  });

  // Order-independent cleanup: an issue with any explicit 上/下 declaration
  // never keeps an unsegmented twin (an update marker may be collected first).
  const declaredSegmented = new Set(
    hits.flatMap((hit) => (hit.segment !== null ? [hit.issue] : [])),
  );
  return hits.filter(
    (hit) =>
      hit.complete || hit.segment !== null || !declaredSegmented.has(hit.issue),
  );
}

function isoDate(year: number, month: number, day: number): string | undefined {
  if (year < 1990 || year > 2100) return undefined;
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type DateHit = { date: string; raw: string; span: Span };

function extractDates(title: string): DateHit[] {
  const dates: DateHit[] = [];
  // Every occurrence is kept: "20260912.上.20260912.下" must yield both
  // halves instead of being collapsed by date.
  const push = (
    date: string | undefined,
    raw: string,
    index: number,
  ): void => {
    if (!date) return;
    dates.push({ date, raw, span: { start: index, end: index + raw.length } });
  };
  const separated = /(20\d{2})\s*[.\-/年]\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?/gu;
  for (const match of title.matchAll(separated)) {
    push(
      isoDate(Number(match[1]), Number(match[2]), Number(match[3])),
      match[0],
      match.index ?? 0,
    );
  }
  const compact = /(?<!\d)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/gu;
  for (const match of title.matchAll(compact)) {
    push(
      isoDate(Number(match[1]), Number(match[2]), Number(match[3])),
      match[0],
      match.index ?? 0,
    );
  }
  // Mixed formats must still pair with markers in the original order.
  return dates.sort((left, right) => left.span.start - right.span.start);
}

/**
 * Binds a 上/下 marker to the date it sits next to, instead of inferring from
 * global sets.  Returns the segment per date; null means "not stated".
 */
function associateDateSegments(
  title: string,
  dateHits: DateHit[],
): {
  entries: Array<{ date: string; segment: SelectionSegment | null }>;
  ambiguousDates: string[];
} {
  if (dateHits.length === 0) return { entries: [], ambiguousDates: [] };
  const markerPattern = /(上下|上\s*[、/／]?\s*下|上|下)/gu;
  const segmentsOf = (token: string | undefined): SelectionSegment[] => {
    if (!token) return [];
    const normalized = token.replace(/[\s、/／]/gu, "");
    if (normalized === "上下") return ["upper", "lower"];
    return [normalized === "上" ? "upper" : "lower"];
  };
  const markers: Array<{
    segments: SelectionSegment[];
    start: number;
    end: number;
  }> = [];
  for (const match of title.matchAll(markerPattern)) {
    const index = match.index ?? 0;
    // A marker directly after 期 belongs to an issue, not to a date.
    if (/期\s*[（(]?\s*$/u.test(title.slice(Math.max(0, index - 4), index)))
      continue;
    markers.push({
      segments: segmentsOf(match[1]),
      start: index,
      end: index + (match[0]?.length ?? 0),
    });
  }
  const entries: Array<{ date: string; segment: SelectionSegment | null }> = [];
  const ambiguousDates = new Set<string>();
  const assigned = dateHits.map(() => ({
    before: null as SelectionSegment | null,
    after: null as SelectionSegment | null,
  }));
  const assign = (
    dateIndex: number,
    marker: { segments: SelectionSegment[]; start: number; end: number },
  ): void => {
    const hit = dateHits[dateIndex]!;
    const slot = assigned[dateIndex]!;
    const side: "before" | "after" =
      hit.span.end <= marker.start ? "after" : "before";
    for (const segment of marker.segments) {
      if (slot[side]) {
        const other = side === "after" ? "before" : "after";
        if (!slot[other]) slot[other] = segment;
        continue;
      }
      slot[side] = segment;
    }
  };
  if (markers.length === dateHits.length) {
    // Equal counts pair in order: "日1.上.日2.下" and "上.日1.下.日2" both
    // read as 日1上、日2下.
    markers.forEach((marker, index) => {
      const hit = dateHits[index]!;
      const distance =
        hit.span.end <= marker.start
          ? marker.start - hit.span.end
          : marker.end <= hit.span.start
            ? hit.span.start - marker.end
            : 0;
      if (distance <= 8) assign(index, marker);
    });
  } else {
    for (const marker of markers) {
      let best = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      let tied = false;
      dateHits.forEach((hit, index) => {
        const slot = assigned[index]!;
        const distance =
          hit.span.end <= marker.start
            ? slot.after === null
              ? marker.start - hit.span.end
              : Number.POSITIVE_INFINITY
            : marker.end <= hit.span.start
              ? slot.before === null
                ? hit.span.start - marker.end
                : Number.POSITIVE_INFINITY
              : Number.POSITIVE_INFINITY;
        if (distance > 8) return;
        if (distance < bestScore) {
          best = index;
          bestScore = distance;
          tied = false;
        } else if (distance === bestScore && index !== best) {
          tied = true;
        }
      });
      // An equidistant marker cannot be bound reliably: stay unknown.
      if (best !== -1 && !tied) assign(best, marker);
      if (best !== -1 && tied && dateHits[best])
        ambiguousDates.add(dateHits[best]!.date);
    }
  }
  for (const [index, hit] of dateHits.entries()) {
    const slot = assigned[index]!;
    if (slot.before) entries.push({ date: hit.date, segment: slot.before });
    if (slot.after && slot.after !== slot.before)
      entries.push({ date: hit.date, segment: slot.after });
    if (!slot.before && !slot.after)
      entries.push({ date: hit.date, segment: null });
  }
  const seen = new Set<string>();
  return {
    entries: entries.filter((entry) => {
      const key = `${entry.date}:${entry.segment ?? "whole"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    ambiguousDates: [...ambiguousDates],
  };
}

function extractSegments(title: string): SelectionSegment[] {
  const segments = new Set<SelectionSegment>();
  const part = /\bpart\s*[.\-_ ]?([12])\b/giu;
  for (const match of title.matchAll(part)) {
    segments.add(match[1] === "1" ? "upper" : "lower");
  }
  const chinese = /(?:^|[\s._\-(\[])(上|下)(?:集|期|半|部)?(?:$|[\s._\-)\]]|\d)/gu;
  for (const match of title.matchAll(chinese)) {
    segments.add(match[1] === "上" ? "upper" : "lower");
  }
  const combined = /(?:^|[\s._\-(\[])(?:上下|上\/下|上、下)(?:$|[\s._\-)\]]|\d)/gu;
  for (const _match of title.matchAll(combined)) {
    segments.add("upper");
    segments.add("lower");
  }
  const trailing = /第\s*\d{1,4}\s*期\s*[（(]?\s*(上|下)/gu;
  for (const match of title.matchAll(trailing)) {
    segments.add(match[1] === "上" ? "upper" : "lower");
  }
  const numbered = /(?:\d{1,4}\s*(?:期|集|话)|E(?:P)?\d{1,4})\s*[（(]?\s*(上|下)/giu;
  for (const match of title.matchAll(numbered)) {
    segments.add(match[1] === "上" ? "upper" : "lower");
  }
  return [...segments];
}

function extractYear(title: string, blocked: Span[]): { year: number; raw: string } | undefined {
  const pattern = /(?<!\d)((?:19|20)\d{2})(?!\d)/gu;
  for (const match of title.matchAll(pattern)) {
    const index = match.index ?? 0;
    const span = { start: index, end: index + match[0].length };
    if (overlapsAny(span, blocked)) continue;
    const year = Number(match[1]);
    if (year >= 1900 && year <= 2100) return { year, raw: match[0] };
  }
  return undefined;
}

export function parseReleaseFacts(
  rawTitle: string,
  upstream: ParseUpstreamFacts = {},
): ParsedReleaseFacts {
  const title = cleanTitle(rawTitle);
  const evidenceList: FieldEvidence[] = [evidence("title", title, title, "upstream")];
  const conflicts: CoverageConflict[] = [];
  const warnings: ReleaseWarning[] = [];

  const resolutionHit = firstDefined(title, RESOLUTION_PATTERNS);
  if (resolutionHit)
    evidenceList.push(evidence("resolution", resolutionHit.value, resolutionHit.raw));

  const sourceHit = firstDefined(title, SOURCE_PATTERNS);
  if (sourceHit) evidenceList.push(evidence("source", sourceHit.value, sourceHit.raw));

  const codecHit = CODEC_PATTERN.exec(title);
  if (codecHit)
    evidenceList.push(
      evidence("codec", codecHit[0].toUpperCase(), codecHit[0]),
    );

  const hdrHit = firstDefined(title, HDR_PATTERNS);
  if (hdrHit) evidenceList.push(evidence("hdr", hdrHit.value, hdrHit.raw));

  const claimText = stripNegatedClaims(title);
  const subtitleLanguages = new Set<SelectionLanguage>();
  for (const { value, pattern } of SUBTITLE_LANGUAGE_PATTERNS) {
    for (const match of claimText.matchAll(new RegExp(pattern.source, "giu"))) {
      const index = match.index ?? 0;
      const after = claimText.slice(
        index + match[0].length,
        index + match[0].length + 12,
      );
      // "Chinese audio" is an audio track, not a subtitle claim.
      if (/^[\s._\-]*(?:音轨|音軌|音频|音訊|audio|dub)/iu.test(after)) continue;
      subtitleLanguages.add(value);
      evidenceList.push(evidence("subtitle", value, match[0]));
      break;
    }
  }
  // "中字" with no explicit simplified/traditional marker is zh.
  if (
    !subtitleLanguages.has("zh") &&
    !subtitleLanguages.has("zh-hant") &&
    /中字/u.test(claimText)
  ) {
    subtitleLanguages.add("zh");
    evidenceList.push(evidence("subtitle", "zh", "中字"));
  }
  const hasSubtitleClaim = SUBTITLE_MARKER_PATTERN.test(claimText);

  const audioLanguages = new Set<SelectionLanguage>();
  for (const { value, pattern } of AUDIO_LANGUAGE_PATTERNS) {
    for (const match of claimText.matchAll(new RegExp(pattern.source, "giu"))) {
      const index = match.index ?? 0;
      const after = claimText.slice(index + match[0].length, index + match[0].length + 24);
      // "English字幕", "国语 字幕", "粤语字幕" are subtitle claims, never
      // audio tracks.
      if (/^[\s._\-(]*字幕/u.test(after)) continue;
      if (/^[\s._\-]*(?:subs?|subtitles?)\b/iu.test(after)) continue;
      audioLanguages.add(value);
      evidenceList.push(evidence("audio", value, match[0]));
      break;
    }
  }

  const seasonHits = extractSeasons(title);
  const episodeHits = extractEpisodeHits(title);
  const seasons = [
    ...new Set([
      ...seasonHits.map((hit) => hit.season),
      ...episodeHits.flatMap((hit) => (hit.season === null ? [] : [hit.season])),
    ]),
  ].sort((left, right) => left - right);
  if (seasons.length > 0) {
    const raws = [
      ...seasonHits.map((hit) => hit.raw),
      ...episodeHits
        .filter((hit) => hit.season !== null)
        .map((hit) => hit.raw),
    ];
    evidenceList.push(evidence("season", seasons.join(","), raws.join(" ")));
  }

  const titleUpdateClaim = /更新至/u.test(title);
  const titleCompleteClaim =
    /(?:全|共)\s*[\d一二两三四五六七八九十百]{1,4}\s*(?:集|话話|期)|\d{1,4}\s*(?:集|话話|期)\s*全/u.test(
      title,
    );
  const hadCompleteClaim =
    episodeHits.some((hit) => hit.complete) || titleCompleteClaim;
  const hadUpdateClaim = titleUpdateClaim;
  const completenessConflict = hadCompleteClaim && hadUpdateClaim;
  // "更新至E08 + 全12集" is a publisher contradiction: keep the open-ended
  // marker only and never expand the claimed complete range.
  const effectiveHits = completenessConflict
    ? episodeHits.filter((hit) => !hit.complete)
    : episodeHits;
  const boundedHits = effectiveHits.slice(0, MAX_PARSE_UNITS);
  const episodes: ParsedEpisode[] = [];
  let completeEpisodes = false;
  let updatedTo: ParsedEpisode | undefined;
  for (const hit of boundedHits) {
    const season = hit.season ?? (seasons.length === 1 ? seasons[0]! : null);
    for (const episode of hit.episodes) {
      episodes.push({ season, episode });
    }
    if (hit.complete) completeEpisodes = true;
    if (hit.raw.includes("更新至")) {
      const last = hit.episodes.at(-1);
      if (last !== undefined) updatedTo = { season, episode: last };
    }
  }
  if (episodes.length > 0) {
    const last = episodes.at(-1)!;
    const first = episodes[0]!;
    evidenceList.push(
      evidence(
        "episode",
        episodes.length === 1
          ? `${first.season === null ? "?" : first.season}x${first.episode}`
          : `${first.season === null ? "?" : first.season}x${first.episode}-${last.season === null ? "?" : last.season}x${last.episode}`,
        episodeHits.map((hit) => hit.raw).join(" ").slice(0, 200),
      ),
    );
  }
  if (completeEpisodes) {
    evidenceList.push(
      evidence("completeness", "claimed", "全X集/共X集", "title"),
    );
  }

  const issueHits = extractIssueHits(title);
  const issueCompleteHits = issueHits.filter((hit) => hit.complete);
  // Raw title claims survive the segment dedupe above.
  const issueCompletenessConflict =
    titleUpdateClaim &&
    (issueCompleteHits.length > 0 || titleCompleteClaim);
  // A conflicting complete claim never expands into satisfiable units.
  const effectiveIssueHits = issueCompletenessConflict
    ? issueHits.filter((hit) => !hit.complete)
    : issueHits;
  const issueSegments = effectiveIssueHits.map((hit) => ({
    issue: hit.issue,
    segment: hit.segment,
  }));
  const issues = [...new Set(issueSegments.map((entry) => entry.issue))].sort(
    (left, right) => left - right,
  );
  const issuesComplete = !issueCompletenessConflict && issueCompleteHits.length > 0;
  if (issues.length > 0) {
    evidenceList.push(
      evidence(
        "issue",
        issues.length === 1 ? `#${issues[0]}` : `#${issues[0]}-#${issues.at(-1)}`,
        effectiveIssueHits.map((hit) => hit.raw).join(" ").slice(0, 200),
      ),
    );
  }

  const dateHits = extractDates(title);
  const dates = dateHits.map((hit) => hit.date);
  const dateAssociation = associateDateSegments(title, dateHits);
  const dateSegments = dateAssociation.entries;
  const ambiguousDates = dateAssociation.ambiguousDates;
  if (dates.length > 0) {
    evidenceList.push(
      evidence("date", dates.join(","), dateHits.map((hit) => hit.raw).join(" ")),
    );
  }

  const segments = extractSegments(title);
  if (segments.length > 0) {
    evidenceList.push(evidence("segment", segments.join(","), segments.join(",")));
  }

  const editionHit = firstDefined(title, EDITION_PATTERNS);
  const distinctEditions = new Set(
    EDITION_PATTERNS.filter(
      (entry) =>
        entry.value !== "unknown" &&
        new RegExp(entry.pattern.source, "iu").test(title),
    ).map((entry) => entry.value),
  );
  const editionAmbiguous = distinctEditions.size > 1;
  const edition: SelectionEdition = editionAmbiguous
    ? "unknown"
    : (editionHit?.value ?? "unknown");
  if (editionHit) {
    evidenceList.push(evidence("edition", editionHit.value, editionHit.raw));
  }

  const hasUpdateMarker = /更新至/u.test(title);
  const completeSeasonsClaim =
    /(?:全集|完整版|complete(?:\s+series)?|全\s*\d{1,2}\s*季)/iu.test(title);
  const seasonCompletenessConflict = completeSeasonsClaim && hasUpdateMarker;
  const completeSeries =
    completeSeasonsClaim && seasons.length > 0 && !hasUpdateMarker;
  const wholeSeasons = completeSeries
    ? [...seasons]
    : hasUpdateMarker
      ? []
      : seasons.filter((season) =>
          new RegExp(
            `(?:S0?${season}\\b[^E]{0,24}(?:complete|全|repack)|第\\s*${season}\\s*季[^E]{0,16}全|全\\s*${season}\\s*季)`,
            "iu",
          ).test(title),
        );

  const blockedSpans = [
    ...seasonHits.map((hit) => hit.span),
    ...dateHits.map((hit) => {
      const index = title.indexOf(hit.raw);
      return { start: Math.max(0, index), end: Math.max(0, index) + hit.raw.length };
    }),
  ];
  const yearHit = extractYear(title, blockedSpans);
  if (yearHit) evidenceList.push(evidence("year", String(yearHit.year), yearHit.raw));

  if (
    completenessConflict ||
    issueCompletenessConflict ||
    seasonCompletenessConflict
  ) {
    conflicts.push({
      field: "completeness",
      values: ["更新至", "完整声明"],
    });
    warnings.push({
      code: "ONGOING_CONFLICT",
      message: "标题同时出现“更新至”和完整范围声明，只能视为发布者声明且互相冲突",
    });
  }
  if (episodes.length >= MAX_PARSE_UNITS || issues.length >= MAX_PARSE_UNITS) {
    warnings.push({
      code: "SCOPE_TRUNCATED",
      message: `标题声明的范围超过 ${MAX_PARSE_UNITS} 个单元，已截断分析`,
    });
  }
  if (editionAmbiguous) {
    warnings.push({
      code: "EDITION_AMBIGUOUS",
      message: "标题同时出现多个节目版本，无法确认目标版本对应哪一条声明",
    });
  }
  if (seasons.length > 1 && !completeSeries) {
    warnings.push({
      code: "MULTI_SEASON",
      message: `标题涉及 ${seasons.length} 个季，不能当作单季等价版本`,
    });
  }
  if (updatedTo) {
    warnings.push({
      code: "OPEN_ENDED",
      message: "“更新至”表示仍在更新，不能视为全集",
    });
  }

  const fileCount =
    upstream.fileCount === undefined || upstream.fileCount === null
      ? undefined
      : Math.max(0, Math.floor(upstream.fileCount));
  if (fileCount !== undefined) {
    evidenceList.push(
      evidence("files", String(fileCount), "upstream.files", "upstream"),
    );
  }

  return {
    title,
    ...(yearHit ? { year: yearHit.year } : {}),
    ...(resolutionHit ? { resolution: resolutionHit.value } : {}),
    ...(sourceHit ? { source: sourceHit.value } : {}),
    ...(codecHit ? { codec: codecHit[0].toUpperCase() } : {}),
    ...(hdrHit ? { hdr: hdrHit.value } : {}),
    subtitleLanguages: [...subtitleLanguages],
    hasSubtitleClaim,
    audioLanguages: [...audioLanguages],
    seasons,
    episodes,
    issues,
    issueSegments,
    dateSegments,
    ambiguousDates,
    dates,
    wholeSeasons,
    completeSeries,
    completeEpisodes,
    completeIssues: issuesComplete,
    hasUpdateMarker: /更新至/u.test(title),
    ...(updatedTo ? { updatedTo } : {}),
    segments,
    edition,
    multiSeason: seasons.length > 1,
    ...(fileCount !== undefined ? { fileCount } : {}),
    evidence: evidenceList.slice(0, 48),
    conflicts: conflicts.slice(0, 12),
    warnings: warnings.slice(0, 24),
  };
}

export function factsToUnits(facts: ParsedReleaseFacts): CoverageUnit[] {
  const units: CoverageUnit[] = [];
  const push = (unit: CoverageUnit): void => {
    if (units.length >= MAX_PARSE_UNITS) return;
    units.push(unit);
  };
  for (const season of facts.wholeSeasons) push({ kind: "season", season });
  const boundSegments = facts.segments.length > 0;
  for (const episode of facts.episodes) {
    push({
      kind: "episode",
      season: episode.season,
      episode: episode.episode,
      // Episode-level segment binding is not implemented yet; an explicit
      // marker that cannot be bound must stay unknown, never whole.
      ...(boundSegments ? { ambiguous: true } : {}),
    });
  }
  // A "S01-S03" pack claims those seasons even without episode detail, but a
  // season that already has concrete episode units must not be promoted to a
  // whole-season claim.
  const episodeSeasons = new Set<number>();
  for (const episode of facts.episodes) {
    if (episode.season !== null) episodeSeasons.add(episode.season);
  }
  const completenessConflicted = facts.conflicts.some(
    (conflict) => conflict.field === "completeness",
  );
  // "S01-S03.更新至E08" names seasons but is still airing; bare season
  // numbers must not become a whole-season coverage claim.
  const seasonBoundByUpdate =
    facts.hasUpdateMarker && facts.wholeSeasons.length === 0;
  // Episodes whose season could not be bound (e.g. 第1季第1集.第2季第2集) make
  // the bare season list unreliable as a whole-season claim.
  const hasUnboundEpisodes = facts.episodes.some(
    (episode) => episode.season === null,
  );
  const seasonBoundByUnboundEpisodes =
    hasUnboundEpisodes && facts.wholeSeasons.length === 0;
  for (const season of facts.seasons) {
    // A conflicted Complete claim only states which seasons are involved;
    // it must never regenerate a satisfiable whole-season unit.
    if (
      completenessConflicted ||
      seasonBoundByUpdate ||
      seasonBoundByUnboundEpisodes
    )
      break;
    if (facts.wholeSeasons.includes(season)) continue;
    if (episodeSeasons.has(season)) continue;
    push({ kind: "season", season });
  }
  for (const entry of facts.issueSegments) {
    push({
      kind: "issue",
      issue: entry.issue,
      ...(entry.segment ? { segment: entry.segment } : {}),
      // A global marker with no bound issue unit leaves the rest unknowable.
      ...(!entry.segment && boundSegments ? { ambiguous: true } : {}),
    });
  }
  const dateEntries =
    facts.dateSegments.length > 0
      ? facts.dateSegments
      : facts.dates.map((date) => ({ date, segment: null }));
  const ambiguousDateSet = new Set(facts.ambiguousDates);
  for (const entry of dateEntries) {
    push({
      kind: "date",
      date: entry.date,
      ...(entry.segment ? { segment: entry.segment } : {}),
      // null here may mean "not stated" or "declared but ambiguous"; the
      // latter must never be treated as a whole date.
      ...(entry.segment === null &&
      (ambiguousDateSet.has(entry.date) || boundSegments)
        ? { ambiguous: true }
        : {}),
    });
  }
  return units;
}
