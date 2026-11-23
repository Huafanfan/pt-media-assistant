import {
  MAX_SELECTION_CONFLICTS,
  MAX_SELECTION_EVIDENCE,
  MAX_SELECTION_UNITS,
  MAX_SELECTION_WARNINGS,
  type CoverageCompleteness,
  type CoverageUnit,
  type ReleaseCoverage,
  type ReleaseGroupKey,
  type ReleaseWarning,
  type SelectionContentKind,
  type SelectionTarget,
} from "../../shared/release-selection.js";
import {
  type ParsedReleaseFacts,
  factsToUnits,
} from "./parser.js";

/**
 * Coverage answers "does this release include the requested units" with a
 * three-valued match: yes / unknown / no.  Unknown (for example an unscoped
 * episode number) never becomes a confirmation.
 */

export type UnitMatch = "yes" | "partial" | "unknown" | "no";

export type TargetRelation =
  | "covers"
  | "partial"
  | "single"
  | "unknown"
  | "other"
  | "browse";

export type TargetEvaluation = {
  relation: TargetRelation;
  targetUnitCount: number;
  matchedCount: number;
  unknownCount: number;
  missingSummary: string[];
  extraSummary: string[];
  extraUnitCount: number;
};

function isSeasonUnit(
  unit: CoverageUnit,
): unit is Extract<CoverageUnit, { kind: "season" }> {
  return unit.kind === "season";
}

function isEpisodeUnit(
  unit: CoverageUnit,
): unit is Extract<CoverageUnit, { kind: "episode" }> {
  return unit.kind === "episode";
}

function isIssueUnit(
  unit: CoverageUnit,
): unit is Extract<CoverageUnit, { kind: "issue" }> {
  return unit.kind === "issue";
}

function isDateUnit(
  unit: CoverageUnit,
): unit is Extract<CoverageUnit, { kind: "date" }> {
  return unit.kind === "date";
}

/** Whether one coverage unit satisfies one requested target unit. */
export function unitMatches(target: CoverageUnit, unit: CoverageUnit): UnitMatch {
  // A segment marker that exists but could not be bound leaves the unit
  // unknown for every target, including a whole-unit target.
  if (
    (unit.kind === "issue" ||
      unit.kind === "date" ||
      unit.kind === "episode") &&
    unit.ambiguous
  )
    return "unknown";
  if (target.kind === "movie") return unit.kind === "movie" ? "yes" : "no";
  // An unbounded "whole series" claim cannot prove a specific season/unit.
  if (unit.kind === "series") return "unknown";
  if (target.kind === "season") {
    if (isSeasonUnit(unit)) return unit.season === target.season ? "yes" : "no";
    if (isEpisodeUnit(unit)) {
      if (unit.season === null) return "unknown";
      // Same numbering space but a single episode cannot prove a whole season.
      return unit.season === target.season ? "partial" : "no";
    }
    return "no";
  }
  if (target.kind === "episode") {
    if (isEpisodeUnit(unit)) {
      if (
        target.season !== null &&
        unit.season !== null &&
        target.season !== unit.season
      )
        return "no";
      if (target.season === null || unit.season === null) {
        return target.episode === unit.episode ? "unknown" : "no";
      }
      return target.episode === unit.episode ? "yes" : "no";
    }
    if (isSeasonUnit(unit)) {
      if (target.season === null) return "unknown";
      return unit.season === target.season ? "yes" : "no";
    }
    return "no";
  }
  if (target.kind === "issue") {
    if (isIssueUnit(unit)) {
      if (unit.issue !== target.issue) return "no";
      const targetSegment = target.segment ?? null;
      const unitSegment = unit.segment ?? null;
      if (targetSegment === unitSegment) return "yes";
      // A whole issue includes either half; an unsegmented title cannot prove
      // that one specific half is included.
      if (targetSegment === null) return "partial";
      if (unitSegment === null) return "unknown";
      return "no";
    }
    // Dates and issue numbers are different numbering spaces.
    if (isDateUnit(unit)) return "unknown";
    return "no";
  }
  if (target.kind === "date") {
    if (isDateUnit(unit)) {
      if (unit.date !== target.date) return "no";
      const targetSegment = target.segment ?? null;
      const unitSegment = unit.segment ?? null;
      if (targetSegment === unitSegment) return "yes";
      if (targetSegment === null)
        return unitSegment === null ? "yes" : "partial";
      // The opposite known half does not include the requested one.
      if (unitSegment !== null) return "no";
      // An unsegmented date cannot confirm a specific half.
      return "unknown";
    }
    if (isIssueUnit(unit)) return "unknown";
    return "no";
  }
  return "no";
}

/** Requested units derived from a validated target. */
export function targetUnits(target: SelectionTarget): CoverageUnit[] {
  if (target.kind === "movie") return [{ kind: "movie" }];
  const units: CoverageUnit[] = [];
  if (target.mode === "whole" && target.season !== null) {
    units.push({ kind: "season", season: target.season });
  }
  for (const episode of new Set(target.episodes)) {
    units.push({ kind: "episode", season: target.season, episode });
  }
  for (const issue of new Set(target.issues)) {
    // Both halves requested means both must be proven; never fold that into
    // one unsegmented unit.
    if (target.segments.length === 0) {
      units.push({ kind: "issue", issue });
      continue;
    }
    for (const segment of target.segments) {
      units.push({ kind: "issue", issue, segment });
    }
  }
  for (const date of new Set(target.dates)) {
    if (target.segments.length === 0) {
      units.push({ kind: "date", date });
      continue;
    }
    for (const segment of target.segments) {
      units.push({ kind: "date", date, segment });
    }
  }
  // The schema bounds the expanded count; truncating here would silently drop
  // part of the user's request.
  if (units.length > MAX_SELECTION_UNITS) {
    throw new Error("Selection target expands beyond the unit limit");
  }
  return units;
}

function seasonLabel(season: number | null): string {
  return season === null ? "未标季" : `第${season}季`;
}

function episodeKey(unit: Extract<CoverageUnit, { kind: "episode" }>): string {
  return `${unit.season ?? "?"}:${unit.episode}`;
}

/** Compact human summary, preserving "unknown season" as 未标季. */
export function summarizeUnits(units: CoverageUnit[], maxRanges = 6): string[] {
  const episodes: Extract<CoverageUnit, { kind: "episode" }>[] = [];
  const issues: number[] = [];
  const dates: string[] = [];
  const seasons: number[] = [];
  let movie = false;
  let series = false;
  for (const unit of units) {
    if (unit.kind === "episode") episodes.push(unit);
    else if (unit.kind === "issue") issues.push(unit.issue);
    else if (unit.kind === "date") dates.push(unit.date);
    else if (unit.kind === "season") seasons.push(unit.season);
    else if (unit.kind === "movie") movie = true;
    else series = true;
  }
  const summary: string[] = [];
  if (movie) summary.push("影片");
  if (series) summary.push("全剧");
  const seasonKeys = [...new Set(seasons)].sort((left, right) => left - right);
  if (seasonKeys.length > 0) summary.push(seasonKeys.map((season) => `第${season}季`).join("、"));

  const bySeason = new Map<string, number[]>();
  for (const unit of episodes) {
    const key = seasonLabel(unit.season);
    const list = bySeason.get(key) ?? [];
    list.push(unit.episode);
    bySeason.set(key, list);
  }
  for (const [key, list] of [...bySeason.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    summary.push(`${key} ${compactNumbers(list, "E")}`);
    if (summary.length >= maxRanges) return summary.slice(0, maxRanges);
  }
  if (issues.length > 0) summary.push(`期 ${compactNumbers(issues, "第", "期")}`);
  if (dates.length > 0) {
    summary.push(
      dates.length <= 3 ? dates.join("、") : `${dates.slice(0, 3).join("、")} 等${dates.length}个日期`,
    );
  }
  return summary.slice(0, maxRanges);
}

function compactNumbers(numbers: number[], prefix: string, suffix = ""): string {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  if (sorted.length === 0) return "";
  const ranges: string[] = [];
  let start = sorted[0] ?? 0;
  let previous = start;
  const flush = (): void => {
    const pad = (value: number) => String(value).padStart(2, "0");
    ranges.push(
      start === previous
        ? `${prefix}${pad(start)}${suffix}`
        : `${prefix}${pad(start)}–${prefix}${pad(previous)}${suffix}`,
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
  return ranges.join("、");
}

export function evaluateTarget(
  target: SelectionTarget,
  coverage: ReleaseCoverage,
): TargetEvaluation {
  const units = targetUnits(target);
  if (target.mode === "browse" || units.length === 0) {
    return {
      relation: "browse",
      targetUnitCount: 0,
      matchedCount: 0,
      unknownCount: 0,
      missingSummary: [],
      extraSummary: [],
      extraUnitCount: 0,
    };
  }

  const missing: CoverageUnit[] = [];
  let matchedCount = 0;
  let partialCount = 0;
  let unknownCount = 0;
  const matchRank: Record<UnitMatch, number> = {
    no: 0,
    unknown: 1,
    partial: 2,
    yes: 3,
  };
  const hasBothHalves = (unit: CoverageUnit): boolean => {
    const segments = new Set(
      coverage.units.flatMap((candidate) => {
        if (unit.kind === "issue" && candidate.kind === "issue") {
          return candidate.issue === unit.issue
            ? [candidate.segment ?? null]
            : [];
        }
        if (unit.kind === "date" && candidate.kind === "date") {
          return candidate.date === unit.date
            ? [candidate.segment ?? null]
            : [];
        }
        return [];
      }),
    );
    return (
      segments.has("upper") && segments.has("lower") && !segments.has(null)
    );
  };
  for (const unit of units) {
    let best: UnitMatch = "no";
    for (const candidate of coverage.units) {
      const match = unitMatches(unit, candidate);
      if (matchRank[match] > matchRank[best]) best = match;
      if (best === "yes") break;
    }
    // 上 + 下 together are the whole issue.
    if (best !== "yes" && hasBothHalves(unit)) best = "yes";
    if (best === "yes") matchedCount += 1;
    else if (best === "partial") partialCount += 1;
    else if (best === "unknown") unknownCount += 1;
    else missing.push(unit);
  }

  const extraUnits = coverage.units.filter((unit) =>
    units.every((targetUnit) => unitMatches(targetUnit, unit) === "no"),
  );
  const relation = relationFor(
    matchedCount,
    partialCount,
    unknownCount,
    units.length,
  );
  const incompleteSeasons = units
    .filter(
      (unit): unit is Extract<CoverageUnit, { kind: "season" }> =>
        unit.kind === "season" && (partialCount > 0 || unknownCount > 0),
    )
    .map((unit) => `第${unit.season}季未完整`);

  return {
    relation,
    targetUnitCount: units.length,
    matchedCount,
    unknownCount,
    missingSummary: [...incompleteSeasons, ...summarizeUnits(missing)].slice(0, 6),
    extraSummary: extraUnits.length > 0 ? summarizeUnits(extraUnits) : [],
    extraUnitCount: extraUnits.length,
  };
}

function relationFor(
  matchedCount: number,
  partialCount: number,
  unknownCount: number,
  targetUnitCount: number,
): TargetRelation {
  if (matchedCount === targetUnitCount) return "covers";
  if (matchedCount === 0) {
    if (partialCount > 0) return "partial";
    if (unknownCount > 0) return "unknown";
    return "other";
  }
  if (
    matchedCount === 1 &&
    targetUnitCount > 1 &&
    partialCount === 0 &&
    unknownCount === 0
  )
    return "single";
  return "partial";
}

export function groupForEvaluation(
  target: SelectionTarget,
  evaluation: TargetEvaluation,
): ReleaseGroupKey {
  if (target.mode === "browse" || evaluation.relation === "browse") return "browse_scope";
  switch (evaluation.relation) {
    case "covers":
      return "covers_target";
    case "partial":
      return "partial_coverage";
    case "single":
      return "single_unit";
    case "unknown":
      return "unknown_scope";
    case "other":
      return "other_scope";
    default:
      return "unknown_scope";
  }
}

function scopeFor(
  kind: SelectionContentKind,
  units: CoverageUnit[],
): ReleaseCoverage["scope"] {
  if (kind === "movie") return "movie";
  if (units.some((unit) => unit.kind === "series")) return "series";
  if (units.some((unit) => unit.kind === "season")) return "season";
  if (units.some((unit) => unit.kind === "episode")) return "episodes";
  if (units.some((unit) => unit.kind === "issue")) return "issues";
  if (units.some((unit) => unit.kind === "date")) return "dates";
  return "unknown";
}

/**
 * Build the release's own scope claim from parsed facts.  Title evidence can
 * reach "claimed" at most; "verified" requires a manifest we do not have.
 */
export function buildCoverage(
  facts: ParsedReleaseFacts,
  kind: SelectionContentKind,
): ReleaseCoverage {
  const units = kind === "movie" ? [{ kind: "movie" } as CoverageUnit] : factsToUnits(facts);
  const hasCompletenessConflict = facts.conflicts.some(
    (conflict) => conflict.field === "completeness",
  );
  const claimed =
    !hasCompletenessConflict &&
    (facts.completeSeries ||
      facts.completeEpisodes ||
      facts.completeIssues ||
      facts.wholeSeasons.length > 0);
  const completeness: CoverageCompleteness = claimed ? "claimed" : "unknown";
  const warnings: ReleaseWarning[] = [...facts.warnings];
  if (completeness === "claimed" && kind !== "movie") {
    warnings.push({
      code: "COMPLETENESS_CLAIMED",
      message: "完整性来自标题声明，尚未核验文件清单",
    });
  }
  const unitSeasons = units.flatMap((unit) =>
    unit.kind === "episode" && unit.season !== null
      ? [unit.season]
      : unit.kind === "season"
        ? [unit.season]
        : [],
  );
  return {
    scope: scopeFor(kind, units),
    year: facts.year ?? null,
    // Title-named seasons stay visible as identity for comparison/grouping even
    // when they never became a satisfiable whole-season unit.
    seasons: [...new Set([...facts.seasons, ...unitSeasons])].sort(
      (left, right) => left - right,
    ),
    units: units.slice(0, MAX_SELECTION_UNITS),
    multiSeason: facts.multiSeason,
    segments: [...facts.segments],
    edition: facts.edition,
    completeness,
    continuous:
      facts.completeSeries || facts.completeEpisodes || facts.wholeSeasons.length > 0,
    openEnded: Boolean(facts.updatedTo) || warnings.some((warning) => warning.code === "OPEN_ENDED"),
    fileCount: facts.fileCount ?? null,
    evidence: facts.evidence.slice(0, MAX_SELECTION_EVIDENCE),
    conflicts: facts.conflicts.slice(0, MAX_SELECTION_CONFLICTS),
    warnings: dedupeWarnings(warnings).slice(0, MAX_SELECTION_WARNINGS),
  };
}

export function dedupeWarnings(warnings: ReleaseWarning[]): ReleaseWarning[] {
  const seen = new Set<string>();
  const result: ReleaseWarning[] = [];
  for (const warning of warnings) {
    if (seen.has(warning.code)) continue;
    seen.add(warning.code);
    result.push(warning);
  }
  return result;
}

/** Pairwise overlap/complement clues within the current snapshot. */
function coverageSpaceSignature(coverage: ReleaseCoverage): string {
  const kinds = [...new Set(coverage.units.map((unit) => unit.kind))].sort();
  const seasons = [...new Set(coverage.seasons)].sort((a, b) => a - b);
  return `${kinds.join(",")}|s:${seasons.join(",")}|y:${coverage.year ?? "?"}`;
}

/**
 * Compare two coverages only inside the same numbering space.  Different
 * seasons, editions, or unit kinds return null instead of a false
 * overlap/complement clue.
 */
export function compareCoverage(
  left: ReleaseCoverage,
  right: ReleaseCoverage,
): { shared: number; leftOnly: number; rightOnly: number } | null {
  if (left.edition !== right.edition) return null;
  if (left.units.length === 0 || right.units.length === 0) return null;
  if (coverageSpaceSignature(left) !== coverageSpaceSignature(right)) return null;
  const kinds = coverageSpaceSignature(left).split("|")[0] ?? "";
  if (
    /issue|date/u.test(kinds) &&
    (left.edition === "unknown" || right.edition === "unknown")
  )
    return null;
  // 上 and 下 of the same 期/日期 are a legitimate complement; a shared group
  // with an unstated segment on either side stays incomparable, and unrelated
  // groups (different issues/dates/seasons) are never compared at all.
  if (!sharesGroupingUnit(left, right)) return null;
  if (hasUnstatedSharedSegment(left, right)) return null;
  const leftKeys = comparisonKeys(left);
  const rightKeys = comparisonKeys(right);
  let shared = 0;
  let leftOnly = 0;
  let rightOnly = 0;
  for (const key of leftKeys) {
    if (rightKeys.has(key)) shared += 1;
    else leftOnly += 1;
  }
  for (const key of rightKeys) {
    if (!leftKeys.has(key)) rightOnly += 1;
  }
  return { shared, leftOnly, rightOnly };
}

/**
 * Coverage-level keys for set comparison.  An unsegmented unit stays its own
 * key: it is "segment unknown", not a confirmed whole.
 */
function comparisonKeys(coverage: ReleaseCoverage): Set<string> {
  return new Set(coverage.units.map(unitKey));
}

function sharesGroupingUnit(
  left: ReleaseCoverage,
  right: ReleaseCoverage,
): boolean {
  // Episode/season spaces are already separated by the coverage signature;
  // only issue/date spaces need the shared-group check.
  const usesIssueOrDate = (coverage: ReleaseCoverage): boolean =>
    coverage.units.some(
      (unit) => unit.kind === "issue" || unit.kind === "date",
    );
  if (!usesIssueOrDate(left) && !usesIssueOrDate(right)) return true;
  const leftIssues = left.units.flatMap((unit) =>
    unit.kind === "issue" ? [unit.issue] : [],
  );
  const rightIssues = new Set(
    right.units.flatMap((unit) => (unit.kind === "issue" ? [unit.issue] : [])),
  );
  if (leftIssues.some((issue) => rightIssues.has(issue))) return true;
  const leftDates = left.units.flatMap((unit) =>
    unit.kind === "date" ? [unit.date] : [],
  );
  const rightDates = new Set(
    right.units.flatMap((unit) => (unit.kind === "date" ? [unit.date] : [])),
  );
  return leftDates.some((date) => rightDates.has(date));
}

/** True when either side leaves a *shared* issue/date segment unstated. */
function hasUnstatedSharedSegment(
  left: ReleaseCoverage,
  right: ReleaseCoverage,
): boolean {
  const groups = (coverage: ReleaseCoverage): Map<string, boolean> => {
    const result = new Map<string, boolean>();
    for (const unit of coverage.units) {
      if (unit.kind !== "issue" && unit.kind !== "date") continue;
      const group =
        unit.kind === "issue" ? `issue:${unit.issue}` : `date:${unit.date}`;
      const unstated = (unit.segment ?? null) === null;
      result.set(group, (result.get(group) ?? false) || unstated);
    }
    return result;
  };
  const leftGroups = groups(left);
  const rightGroups = groups(right);
  for (const [group, leftUnstated] of leftGroups) {
    const rightUnstated = rightGroups.get(group);
    if (rightUnstated === undefined) continue;
    if (leftUnstated || rightUnstated) return true;
  }
  return false;
}

function unitKey(unit: CoverageUnit): string {
  switch (unit.kind) {
    case "movie":
      return "movie";
    case "season":
      return `season:${unit.season}`;
    case "episode":
      return `episode:${episodeKey(unit)}`;
    case "issue":
      return `issue:${unit.issue}:${unit.segment ?? "whole"}`;
    case "date":
      return `date:${unit.date}:${unit.segment ?? "whole"}`;
    case "series":
      return "series";
  }
}
