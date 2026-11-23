import { describe, expect, it } from "vitest";

import {
  parseReleaseFacts,
} from "../../src/server/release-selection/parser.js";
import {
  buildCoverage,
  evaluateTarget,
  targetUnits,
} from "../../src/server/release-selection/coverage.js";
import {
  selectionTargetSchema,
  type SelectionTarget,
} from "../../src/shared/release-selection.js";

function target(value: Record<string, unknown>): SelectionTarget {
  return selectionTargetSchema.parse(value);
}

describe("parseReleaseFacts", () => {
  it("extracts evidence-backed movie specs", () => {
    const facts = parseReleaseFacts(
      "Some.Movie.2024.2160p.UHD.BluRay.REMUX.HDR10.DTS-HD.MA.5.1.x265-CHD[中字]",
    );
    expect(facts.year).toBe(2024);
    expect(facts.resolution).toBe("2160p");
    expect(facts.source).toBe("remux");
    expect(facts.codec).toBe("X265");
    expect(facts.hdr).toBe("hdr10");
    expect(facts.subtitleLanguages).toContain("zh");
    expect(facts.hasSubtitleClaim).toBe(true);
    const resolutionEvidence = facts.evidence.find(
      (entry) => entry.field === "resolution",
    );
    expect(resolutionEvidence?.raw).toMatch(/2160p/iu);
    expect(resolutionEvidence?.parserVersion).toBe("release-parse-1");
  });

  it("parses SxxExx ranges without promoting completeness", () => {
    const facts = parseReleaseFacts("Show.Name.S02E01-E08.1080p.WEB-DL");
    expect(facts.seasons).toEqual([2]);
    expect(facts.episodes).toHaveLength(8);
    expect(facts.episodes[0]).toEqual({ season: 2, episode: 1 });
    expect(facts.episodes.at(-1)).toEqual({ season: 2, episode: 8 });
    expect(facts.completeEpisodes).toBe(false);
    expect(facts.updatedTo).toBeUndefined();
  });

  it("keeps unscoped episode numbers as unknown season", () => {
    const facts = parseReleaseFacts("Some.Show.E01-E12.1080p");
    expect(facts.episodes[0]?.season).toBeNull();
    expect(facts.seasons).toEqual([]);
  });

  it("parses Chinese episode ranges with a single stated season", () => {
    const facts = parseReleaseFacts("某剧 第二季 第01-12集 4K 内封中字");
    expect(facts.seasons).toEqual([2]);
    expect(facts.episodes).toHaveLength(12);
    expect(facts.episodes.every((episode) => episode.season === 2)).toBe(true);
  });

  it("records 全X集 as a claimed complete scope", () => {
    const facts = parseReleaseFacts("某剧.全12集.1080p.WEB-DL");
    expect(facts.completeEpisodes).toBe(true);
    expect(facts.episodes).toHaveLength(12);
  });

  it("never treats 更新至 as complete", () => {
    const facts = parseReleaseFacts("某剧.更新至E08.1080p");
    expect(facts.updatedTo).toEqual({ season: null, episode: 8 });
    expect(facts.completeEpisodes).toBe(false);
    expect(facts.warnings.some((warning) => warning.code === "OPEN_ENDED")).toBe(
      true,
    );
  });

  it("flags a 更新至 plus 全集 conflict", () => {
    const facts = parseReleaseFacts("某剧.更新至第20集.全24集.1080p");
    expect(facts.conflicts.some((conflict) => conflict.field === "completeness")).toBe(
      true,
    );
  });

  it("expands a multi-season pack and warns", () => {
    const facts = parseReleaseFacts("某剧.S01-S03.1080p.WEB-DL");
    expect(facts.seasons).toEqual([1, 2, 3]);
    expect(facts.multiSeason).toBe(true);
    expect(facts.warnings.some((warning) => warning.code === "MULTI_SEASON")).toBe(
      true,
    );
  });

  it("parses variety issues, dates, editions and segments", () => {
    const facts = parseReleaseFacts("综艺名.2026.第8期.上下.加更.2160p");
    expect(facts.issues).toContain(8);
    expect(facts.year).toBe(2026);
    expect(facts.segments).toEqual(["upper", "lower"]);
    expect(facts.edition).toBe("extra");
  });

  it("parses a full date as its own numbering space", () => {
    const facts = parseReleaseFacts("综艺名.2026.09.12.纯享版.1080p");
    expect(facts.dates).toEqual(["2026-09-12"]);
    expect(facts.edition).toBe("pure");
  });

  it("parses a compact date and does not confuse it with a year", () => {
    const facts = parseReleaseFacts("综艺名.20260912.第12期.1080p");
    expect(facts.dates).toEqual(["2026-09-12"]);
    expect(facts.year).toBeUndefined();
  });

  it("keeps unsupported fields unknown instead of guessing", () => {
    const facts = parseReleaseFacts("Some Show 1080p");
    expect(facts.source).toBeUndefined();
    expect(facts.codec).toBeUndefined();
    expect(facts.hdr).toBeUndefined();
    expect(facts.seasons).toEqual([]);
    expect(facts.episodes).toEqual([]);
    expect(facts.hasSubtitleClaim).toBe(false);
  });

  it("bounds a huge declared range", () => {
    const facts = parseReleaseFacts("某剧.全2000集.1080p");
    expect(facts.episodes.length).toBeLessThanOrEqual(400);
    expect(facts.warnings.some((warning) => warning.code === "SCOPE_TRUNCATED")).toBe(
      true,
    );
  });
});

describe("buildCoverage / evaluateTarget", () => {
  it("marks a season target covered by a claimed season pack but not verified", () => {
    const facts = parseReleaseFacts("某剧.S02.Complete.1080p.WEB-DL");
    const coverage = buildCoverage(facts, "series");
    const request = target({ kind: "series", mode: "whole", season: 2 });
    const evaluation = evaluateTarget(request, coverage);
    expect(evaluation.relation).toBe("covers");
    expect(coverage.completeness).toBe("claimed");
    expect(coverage.units).toContainEqual({ kind: "season", season: 2 });
  });

  it("treats a partial episode range as partial coverage with E09-E12 missing", () => {
    const facts = parseReleaseFacts("某剧.S02E01-E08.1080p.WEB-DL");
    const coverage = buildCoverage(facts, "series");
    const request = target({
      kind: "series",
      mode: "explicit",
      season: 2,
      episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    });
    const evaluation = evaluateTarget(request, coverage);
    expect(evaluation.relation).toBe("partial");
    expect(evaluation.missingSummary.join(" ")).toMatch(/E09/);
  });

  it("keeps an unscoped season pack unknown for a known season target", () => {
    const facts = parseReleaseFacts("某剧.S02E09.1080p");
    const coverage = buildCoverage(facts, "series");
    const unknownFacts = parseReleaseFacts("某剧.E09.1080p");
    const unknownCoverage = buildCoverage(unknownFacts, "series");
    const request = target({
      kind: "series",
      mode: "explicit",
      season: 2,
      episodes: [9],
    });
    expect(evaluateTarget(request, coverage).relation).toBe("covers");
    expect(evaluateTarget(request, unknownCoverage).relation).toBe("unknown");
  });

  it("never converts episodes into proof of a whole season", () => {
    const facts = parseReleaseFacts("某剧.S02E01-E08.1080p");
    const coverage = buildCoverage(facts, "series");
    const request = target({ kind: "series", mode: "whole", season: 2 });
    const evaluation = evaluateTarget(request, coverage);
    expect(evaluation.relation).toBe("partial");
    expect(evaluation.matchedCount).toBe(0);
  });

  it("does not cross seasons", () => {
    const facts = parseReleaseFacts("某剧.S01E01-E12.1080p");
    const coverage = buildCoverage(facts, "series");
    const request = target({ kind: "series", mode: "whole", season: 2 });
    expect(evaluateTarget(request, coverage).relation).toBe("other");
  });

  it("does not map issue numbers onto dates", () => {
    const facts = parseReleaseFacts("综艺.第12期.2160p");
    const coverage = buildCoverage(facts, "variety");
    const request = target({
      kind: "variety",
      mode: "explicit",
      dates: ["2026-03-01"],
    });
    expect(evaluateTarget(request, coverage).relation).toBe("unknown");
  });

  it("keeps variety editions in separate scopes", () => {
    const pure = buildCoverage(parseReleaseFacts("综艺.第8期.纯享.1080p"), "variety");
    const main = buildCoverage(parseReleaseFacts("综艺.第8期.正片.1080p"), "variety");
    expect(pure.edition).toBe("pure");
    expect(main.edition).toBe("main");
    expect(pure.units).toContainEqual({ kind: "issue", issue: 8 });
  });

  it("produces a movie unit for movie coverage", () => {
    const coverage = buildCoverage(
      parseReleaseFacts("Movie.2024.1080p.BluRay.x264"),
      "movie",
    );
    expect(coverage.scope).toBe("movie");
    expect(coverage.units).toEqual([{ kind: "movie" }]);
    const request = target({ kind: "movie", mode: "browse" });
    expect(targetUnits(request)).toEqual([{ kind: "movie" }]);
  });

  it("lists extra scope beyond the target", () => {
    const facts = parseReleaseFacts("某剧.S01-S02.Complete.1080p");
    const coverage = buildCoverage(facts, "series");
    const request = target({ kind: "series", mode: "whole", season: 2 });
    const evaluation = evaluateTarget(request, coverage);
    expect(evaluation.extraUnitCount).toBeGreaterThan(0);
    expect(coverage.multiSeason).toBe(true);
  });
});
