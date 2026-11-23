import type { ReleaseSummary } from "../../shared/contracts";
import type {
  RankedRelease,
  ReleaseCoverage,
  RankingReasonCode,
  ReleaseGroupKey,
  SelectionEdition,
  SelectionLanguage,
} from "../../shared/release-selection";

export const REASON_LABELS: Record<RankingReasonCode, string> = {
  COVERS_TARGET: "覆盖目标范围",
  PARTIAL_COVERAGE: "只覆盖部分目标",
  SINGLE_UNIT: "只包含单个单元",
  UNKNOWN_SCOPE: "范围待确认",
  EDITION_MATCH: "节目版本一致",
  COMPLETENESS_CLAIMED: "标题声明完整，未核验",
  COMPLETENESS_VERIFIED: "完整性已核验",
  COMPLETENESS_UNKNOWN: "完整性未知",
  WITHIN_SIZE_LIMIT: "在体积限制内",
  SIZE_UNKNOWN: "体积未知",
  PREFERRED_RESOLUTION: "符合偏好清晰度",
  REQUIRED_RESOLUTION_MET: "满足清晰度要求",
  PREFERRED_SOURCE: "来源规格较好",
  PREFERRED_HDR: "有动态范围信息",
  SMALLER_SIZE: "体积更小",
  MORE_SEEDERS: "做种较多",
  FREELEECH_CONFIRMED: "当前免费",
  FREELEECH_UNKNOWN: "免费状态未知",
  SEEDERS_UNKNOWN: "做种数未知",
  ZERO_SEEDERS: "零做种",
  EXTRA_SCOPE: "包含额外范围",
  MULTI_SEASON_EXTRA: "包含多季",
  SUBTITLE_REQUIREMENT_MET: "满足字幕要求",
  SUBTITLE_PREFERRED: "符合字幕偏好",
  SUBTITLE_UNKNOWN: "字幕未知",
  AUDIO_REQUIREMENT_MET: "满足音轨要求",
  AUDIO_PREFERRED: "符合音轨偏好",
  AUDIO_UNKNOWN: "音轨未知",
  SPEC_EVIDENCE_RELIABLE: "规格信息较完整",
  SPEC_EVIDENCE_WEAK: "规格信息较少",
  ONGOING_RELEASE: "仍在更新",
  IDENTITY_POSSIBLE: "作品身份待确认",
  IDENTITY_UNVERIFIED: "作品身份未确认",
};

export const GROUP_LABELS: Record<ReleaseGroupKey, string> = {
  covers_target: "覆盖目标范围",
  partial_coverage: "部分覆盖",
  single_unit: "单集 / 单期",
  unknown_scope: "范围待确认",
  browse_scope: "全部候选",
  other_scope: "其他范围",
};

export const ROLE_LABELS = {
  balanced_pick: "均衡首选",
  quality_pick: "更重画质规格",
  compact_pick: "节省空间",
  availability_pending: "可用性待确认",
} as const;

export const EDITION_LABELS: Record<SelectionEdition, string> = {
  main: "正片",
  extra: "加更",
  pure: "纯享",
  member: "会员版",
  preview: "预告",
  bonus: "花絮",
  unknown: "版本未知",
};

export const LANGUAGE_LABELS: Record<SelectionLanguage, string> = {
  zh: "中文",
  "zh-hant": "繁体中文",
  en: "英文",
  ja: "日文",
  ko: "韩文",
  other: "其他",
};

export const COMPLETENESS_LABELS = {
  verified: "已核验",
  claimed: "标题声明",
  unknown: "未知",
} as const;

/** Bounded free-text parser: "1-12,15" -> [1..12,15]. */
export function parseNumberList(
  value: string,
  max = 300,
): { values: number[]; overflow: boolean } {
  const numbers = new Set<number>();
  let overflow = false;
  for (const part of value.split(/[,，、\s]+/u)) {
    if (!part) continue;
    const range = /^(\d{1,4})\s*[-~–—至到]\s*(\d{1,4})$/u.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
      if (from < 1 || to < from) continue;
      for (let current = from; current <= to; current += 1) {
        if (numbers.size >= max) {
          if (!numbers.has(current)) overflow = true;
          break;
        }
        numbers.add(current);
      }
      continue;
    }
    if (/^\d{1,4}$/u.test(part)) {
      const number = Number(part);
      if (!Number.isInteger(number) || number < 1) continue;
      if (numbers.size >= max && !numbers.has(number)) {
        overflow = true;
        continue;
      }
      numbers.add(number);
    }
  }
  const values = [...numbers].sort((left, right) => left - right).slice(0, max);
  return { values, overflow };
}

export function parseDateList(
  value: string,
  max = 120,
): { values: string[]; overflow: boolean } {
  const dates = new Set<string>();
  let overflow = false;
  const add = (date: string): void => {
    if (dates.has(date)) return;
    if (dates.size >= max) {
      overflow = true;
      return;
    }
    dates.add(date);
  };
  for (const part of value.split(/[,，、\s]+/u)) {
    if (!part) continue;
    const separated = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(part);
    if (separated) {
      const [, year, month, day] = separated;
      add(
        `${year}-${String(Number(month)).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`,
      );
      continue;
    }
    const compact = /^(\d{4})(\d{2})(\d{2})$/u.exec(part);
    if (compact) {
      const [, year, month, day] = compact;
      add(`${year}-${month}-${day}`);
    }
  }
  return { values: [...dates].slice(0, max), overflow };
}

export function rankedToReleaseSummary(ranked: RankedRelease): ReleaseSummary {
  return {
    id: ranked.releaseId,
    title: ranked.title,
    indexer: ranked.indexer,
    protocol: ranked.protocol,
    size: ranked.size,
    seeders: ranked.seeders,
    leechers: ranked.leechers,
    grabs: ranked.grabs,
    ageDays: ranked.ageDays,
    categories: ranked.categories,
    ...(ranked.resolution ? { resolution: ranked.resolution } : {}),
    ...(ranked.codec ? { codec: ranked.codec } : {}),
    freeleech: ranked.freeleech,
    freeleechState: ranked.freeleechState,
  };
}

function seasonLabel(season: number | null): string {
  return season === null ? "未标季" : `第${season}季`;
}

function rangesOf(numbers: number[], prefix: string): string {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0] ?? 0;
  let previous = start;
  const flush = (): void => {
    const pad = (value: number) => String(value).padStart(2, "0");
    parts.push(
      start === previous
        ? `${prefix}${pad(start)}`
        : `${prefix}${pad(start)}–${prefix}${pad(previous)}`,
    );
  };
  for (const value of sorted.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    flush();
    start = value;
    previous = value;
  }
  flush();
  return parts.join("、");
}

/** Client-side display summary of the release's own claim; presentation only. */
export function summarizeCoverage(coverage: ReleaseCoverage): string {
  const parts: string[] = [];
  if (coverage.scope === "movie") parts.push("影片");
  if (coverage.units.some((unit) => unit.kind === "series")) parts.push("全剧");
  const seasonUnits = coverage.units
    .filter((unit): unit is Extract<typeof unit, { kind: "season" }> => unit.kind === "season")
    .map((unit) => unit.season);
  if (seasonUnits.length > 0)
    parts.push([...new Set(seasonUnits)].sort((a, b) => a - b).map((season) => `第${season}季`).join("、"));
  const episodes = coverage.units.filter(
    (unit): unit is Extract<typeof unit, { kind: "episode" }> => unit.kind === "episode",
  );
  const bySeason = new Map<string, number[]>();
  for (const episode of episodes) {
    const key = seasonLabel(episode.season);
    bySeason.set(key, [...(bySeason.get(key) ?? []), episode.episode]);
  }
  for (const [key, list] of bySeason) {
    parts.push(`${key} ${rangesOf(list, "E")}`);
  }
  const issueUnits = coverage.units.filter(
    (unit): unit is Extract<typeof unit, { kind: "issue" }> =>
      unit.kind === "issue",
  );
  if (issueUnits.length > 0) {
    // Group issues by their own segment so 第8期上 and 第9期下 never collapse
    // into a global "上、下" list.
    const byIssue = new Map<number, Set<"upper" | "lower">>();
    for (const unit of issueUnits) {
      const segments = byIssue.get(unit.issue) ?? new Set();
      if (unit.segment) segments.add(unit.segment);
      byIssue.set(unit.issue, segments);
    }
    const groups = new Map<string, number[]>();
    for (const [issue, segments] of byIssue) {
      const key =
        segments.size === 2
          ? "上下"
          : segments.has("upper")
            ? "上"
            : segments.has("lower")
              ? "下"
              : "";
      groups.set(key, [...(groups.get(key) ?? []), issue]);
    }
    for (const [key, list] of [...groups.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      parts.push(`第${rangesOf(list, "").replace(/^、/u, "")}期${key}`);
    }
  }
  const dateUnits = coverage.units.filter(
    (unit): unit is Extract<typeof unit, { kind: "date" }> =>
      unit.kind === "date",
  );
  if (dateUnits.length > 0) {
    const byDate = new Map<string, Set<"upper" | "lower">>();
    for (const unit of dateUnits) {
      const segments = byDate.get(unit.date) ?? new Set();
      if (unit.segment) segments.add(unit.segment);
      byDate.set(unit.date, segments);
    }
    const rendered = [...byDate.entries()].map(([date, segments]) => {
      const suffix =
        segments.size === 2
          ? "上下"
          : segments.has("upper")
            ? "上"
            : segments.has("lower")
              ? "下"
              : "";
      return suffix ? `${date} ${suffix}` : date;
    });
    parts.push(
      rendered.length <= 3
        ? rendered.join("、")
        : `${rendered.slice(0, 3).join("、")} 等${rendered.length}个日期`,
    );
  }
  if (
    issueUnits.length === 0 &&
    dateUnits.length === 0 &&
    coverage.segments.length > 0
  ) {
    parts.push(
      coverage.segments
        .map((segment) => (segment === "upper" ? "上" : "下"))
        .join("、"),
    );
  }
  if (coverage.edition !== "unknown") parts.push(EDITION_LABELS[coverage.edition]);
  if (parts.length === 0) parts.push("范围未知");
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ *
 * Local "owned" units derived from qBittorrent task names.  This is a
 * presentation-layer ordering aid: it never filters candidates and never
 * changes the server ranking, it only moves already-downloaded episodes
 * later so the next missing episode is easy to find.
 * ------------------------------------------------------------------ */

export type OwnedUnits = {
  /** season (null = task name did not state a season) -> episode numbers */
  episodes: Map<number | null, Set<number>>;
  issues: Set<number>;
  dates: Set<string>;
  total: number;
};

function addOwned(
  map: Map<number | null, Set<number>>,
  season: number | null,
  episode: number,
): void {
  const set = map.get(season) ?? new Set<number>();
  set.add(episode);
  map.set(season, set);
}

function matchAllDates(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(
    /(20\d{2})\s*[.\-/年]\s*(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?/gu,
  )) {
    result.push(
      `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`,
    );
  }
  for (const match of text.matchAll(
    /(?<!\d)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/gu,
  )) {
    result.push(`${match[1]}-${match[2]}-${match[3]}`);
  }
  return result;
}

function escapeRegExpPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Keep only qBittorrent task names that plausibly belong to the current work.
 * Without this, another show's S02E01-E08 would mark episodes as downloaded.
 */
export function filterTorrentNames(
  names: string[],
  candidates: string[],
): string[] {
  const tokens = candidates
    .flatMap((candidate) => candidate.trim().toLowerCase().split(/\s+/u))
    .map((token) => token.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return [];
  return names.filter((name) => {
    const text = name.toLowerCase();
    return tokens.some((token) =>
      /\p{Script=Han}/u.test(token)
        ? text.includes(token)
        : new RegExp(
            `(?:^|[^a-z0-9])${escapeRegExpPattern(token)}(?:$|[^a-z0-9])`,
            "u",
          ).test(text),
    );
  });
}

export function parseOwnedUnits(titles: string[]): OwnedUnits {
  const episodes = new Map<number | null, Set<number>>();
  const issues = new Set<number>();
  const dates = new Set<string>();
  for (const rawTitle of titles) {
    const text = rawTitle
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .slice(0, 240);
    for (const match of text.matchAll(
      /\bS(\d{1,2})\s*[.\-_ ]?\s*E(?:P)?(\d{1,4})(?:\s*[-~–—]\s*E?(?:P)?(\d{1,4}))?/giu,
    )) {
      const season = Number(match[1]);
      const from = Number(match[2]);
      const to = match[3] ? Number(match[3]) : from;
      if (!Number.isInteger(season) || season < 1 || season > 50) continue;
      if (!Number.isInteger(from) || from < 1) continue;
      for (let value = from; value <= to && value <= 2000; value += 1) {
        addOwned(episodes, season, value);
      }
    }
    for (const match of text.matchAll(
      /\bE(?:P)?(\d{1,4})(?:\s*[-~–—]\s*E?(?:P)?(\d{1,4}))?\b/giu,
    )) {
      const from = Number(match[1]);
      const to = match[2] ? Number(match[2]) : from;
      if (!Number.isInteger(from) || from < 1) continue;
      for (let value = from; value <= to && value <= 2000; value += 1) {
        addOwned(episodes, null, value);
      }
    }
    for (const match of text.matchAll(
      /第\s*(\d{1,4})\s*[-~至到]?\s*(\d{1,4})?\s*[集话話]/gu,
    )) {
      const from = Number(match[1]);
      const to = match[2] ? Number(match[2]) : from;
      if (!Number.isInteger(from) || from < 1) continue;
      for (let value = from; value <= to && value <= 2000; value += 1) {
        addOwned(episodes, null, value);
      }
    }
    for (const match of text.matchAll(/(?:全|共)\s*(\d{1,4})\s*[集话話]/gu)) {
      const count = Number(match[1]);
      if (!Number.isInteger(count) || count < 1) continue;
      for (let value = 1; value <= count && value <= 2000; value += 1) {
        addOwned(episodes, null, value);
      }
    }
    for (const match of text.matchAll(
      /第\s*(\d{1,4})\s*[-~至到]?\s*(\d{1,4})?\s*期/gu,
    )) {
      const from = Number(match[1]);
      const to = match[2] ? Number(match[2]) : from;
      if (!Number.isInteger(from) || from < 1) continue;
      for (let value = from; value <= to && value <= 5000; value += 1) {
        issues.add(value);
      }
    }
    for (const date of matchAllDates(text)) dates.add(date);
  }
  const total =
    [...episodes.values()].reduce((sum, set) => sum + set.size, 0) +
    issues.size +
    dates.size;
  return { episodes, issues, dates, total };
}

export type OwnedProgress = {
  space: "episode" | "issue" | "date";
  /** Lowest missing unit number; null when nothing is missing. */
  sortFirst: number | null;
  missingCount: number;
  coveredCount: number;
  missingLabel: string | null;
};

function unitLabel(kind: "episode" | "issue", value: number): string {
  return kind === "episode"
    ? `E${String(value).padStart(2, "0")}`
    : `第${value}期`;
}

function progressOf(
  kind: "episode" | "issue",
  coveredCount: number,
  missing: number[],
): OwnedProgress {
  const sortFirst = missing.length > 0 ? Math.min(...missing) : null;
  return {
    space: kind,
    sortFirst,
    missingCount: missing.length,
    coveredCount,
    missingLabel: sortFirst !== null ? unitLabel(kind, sortFirst) : null,
  };
}

/**
 * Compare one ranked release against the locally known downloaded units.
 * Returns null when the release has no comparable unit (unknown scope, movie,
 * a season pack without episode detail).
 */
export function ownedProgress(
  ranked: RankedRelease,
  owned: OwnedUnits,
): OwnedProgress | null {
  if (owned.total === 0) return null;
  const units = ranked.coverage.units;
  if (units.some((unit) => unit.kind === "issue")) {
    const issueUnits = units.filter(
      (unit): unit is Extract<typeof unit, { kind: "issue" }> =>
        unit.kind === "issue",
    );
    if (issueUnits.length === 0) return null;
    const missing = issueUnits
      .map((unit) => unit.issue)
      .filter((issue) => !owned.issues.has(issue));
    return progressOf("issue", issueUnits.length, missing);
  }
  if (units.some((unit) => unit.kind === "date")) {
    const dates = units.flatMap((unit) =>
      unit.kind === "date" ? [unit.date] : [],
    );
    if (dates.length === 0) return null;
    const missing = dates.filter((date) => !owned.dates.has(date));
    return {
      space: "date",
      sortFirst: missing.length > 0 ? 0 : null,
      missingCount: missing.length,
      coveredCount: dates.length,
      missingLabel: missing[0] ?? null,
    };
  }
  const episodeUnits = units.filter(
    (unit): unit is Extract<typeof unit, { kind: "episode" }> =>
      unit.kind === "episode",
  );
  if (episodeUnits.length === 0) return null;
  const season =
    episodeUnits.find((unit) => unit.season !== null)?.season ?? null;
  const missing = episodeUnits
    .map((unit) => unit.episode)
    .filter(
      (episode) =>
        !(
          owned.episodes.get(season)?.has(episode) ||
          owned.episodes.get(null)?.has(episode)
        ),
    );
  return progressOf("episode", episodeUnits.length, missing);
}

/**
 * Sort key: not-downloaded units first (ascending), then fully downloaded
 * rows, then unknown scope.  Stable on the server rank.
 */
export function ownedSortKey(
  progress: OwnedProgress | null,
): [number, number, number] {
  if (!progress) return [3, Number.MAX_SAFE_INTEGER, 0];
  if (progress.sortFirst !== null)
    return [0, progress.sortFirst, progress.missingCount];
  return [2, Number.MAX_SAFE_INTEGER, 0];
}

/**
 * Smallest episode/issue number (or date timestamp) a release covers, used to
 * read series/variety candidates from small to large.
 */
export function firstUnitSortKey(ranked: RankedRelease): number | null {
  let key: number | null = null;
  for (const unit of ranked.coverage.units) {
    const value =
      unit.kind === "episode"
        ? unit.episode
        : unit.kind === "issue"
          ? unit.issue
          : unit.kind === "date"
            ? Date.parse(unit.date)
            : null;
    if (value === null || Number.isNaN(value)) continue;
    if (key === null || value < key) key = value;
  }
  return key;
}

export function ownedHintText(progress: OwnedProgress | null): string | null {
  if (!progress) return null;
  const unit =
    progress.space === "episode"
      ? "集"
      : progress.space === "issue"
        ? "期"
        : "个日期";
  if (progress.missingCount === 0)
    return `已下载全部 ${progress.coveredCount} ${unit}`;
  const from = progress.missingLabel ? ` · 从 ${progress.missingLabel} 开始` : "";
  return `未下载 ${progress.missingCount} ${unit}${from}`;
}
