import { describe, expect, it } from "vitest";

import type { ReleaseSummary } from "../../src/shared/contracts.js";
import {
  defaultSelectionPreferences,
  selectionPreferencesSchema,
  selectionTargetSchema,
  type ReleaseSelectionResponse,
  type SelectionPreferences,
  type SelectionTarget,
} from "../../src/shared/release-selection.js";
import {
  matchWorkIdentity,
  rankSelection,
  type SelectionMediaIdentity,
} from "../../src/server/release-selection/ranking.js";
import { parseReleaseFacts } from "../../src/server/release-selection/parser.js";

function release(
  id: string,
  title: string,
  overrides: Partial<ReleaseSummary> = {},
): ReleaseSummary {
  return {
    id,
    title,
    indexer: "TJUPT",
    protocol: "torrent",
    size: 10 * 1024 ** 3,
    seeders: 5,
    leechers: 1,
    grabs: 3,
    ageDays: 2,
    categories: ["Movies"],
    freeleech: false,
    freeleechState: "no",
    evidence: {
      resolution: "title_inferred",
      codec: "title_inferred",
      size: "upstream",
      seeders: "upstream",
      season: "title_inferred",
    },
    ...overrides,
  };
}

function target(value: Record<string, unknown>): SelectionTarget {
  return selectionTargetSchema.parse(value);
}

function preferences(value: Record<string, unknown> = {}): SelectionPreferences {
  return selectionPreferencesSchema.parse(value);
}

const movie: SelectionMediaIdentity = {
  mediaType: "movie",
  itemId: "1",
  title: "测试电影",
  originalTitle: "Test Movie",
  year: "2024",
};

const series: SelectionMediaIdentity = {
  mediaType: "tv",
  itemId: "2",
  title: "测试剧集",
  originalTitle: "Test Series",
  year: "2024",
};

function rank(
  media: SelectionMediaIdentity | null,
  releases: ReleaseSummary[],
  selectionTarget: SelectionTarget,
  selectionPreferences: SelectionPreferences = preferences(),
) {
  return rankSelection({
    media,
    releases,
    target: selectionTarget,
    preferences: selectionPreferences,
  });
}

function ids(releases: { releaseId: string }[]): string[] {
  return releases.map((entry) => entry.releaseId);
}

describe("matchWorkIdentity", () => {
  it("rejects a release whose explicit year conflicts with the work", () => {
    const facts = parseReleaseFacts("Test.Movie.2023.1080p.BluRay.x264");
    const result = matchWorkIdentity(movie, facts);
    expect(result.status).toBe("conflict");
  });

  it("keeps a movie without a year as possible, not matched", () => {
    const facts = parseReleaseFacts("Test.Movie.1080p.BluRay.x264");
    expect(matchWorkIdentity(movie, facts).status).toBe("possible");
  });

  it("treats a TV title-token match as work-level matched", () => {
    const facts = parseReleaseFacts("Test.Series.S02E01.1080p.WEB-DL");
    expect(matchWorkIdentity(series, facts).status).toBe("matched");
  });

  it("rejects an unrelated work", () => {
    const facts = parseReleaseFacts("Another.Movie.2024.1080p.WEB-DL");
    expect(matchWorkIdentity(movie, facts).status).toBe("conflict");
  });
});

describe("rankSelection movies", () => {
  it("A01: offers distinct tradeoffs for one movie", () => {
    const releases = [
      release("quality-1", "Test.Movie.2024.2160p.UHD.BluRay.REMUX.HDR10.x265", {
        size: 60 * 1024 ** 3,
        seeders: 10,
      }),
      release("balanced-1", "Test.Movie.2024.1080p.WEB-DL.x264", {
        size: 5 * 1024 ** 3,
        seeders: 40,
      }),
      release("compact-1", "Test.Movie.2024.720p.WEB-DL.x264", {
        size: 1.5 * 1024 ** 3,
        seeders: 6,
      }),
    ];
    const result = rank(
      movie,
      releases,
      target({ kind: "movie", mode: "browse" }),
      preferences({
        preset: "balanced",
        resolution: { value: "1080p", strength: "preferred" },
      }),
    );
    expect(result.recommendations).toHaveLength(3);
    expect(result.recommendations.map((entry) => entry.recommendationRole)).toEqual([
      "balanced_pick",
      "quality_pick",
      "compact_pick",
    ]);
    expect(ids(result.recommendations)).toEqual([
      "balanced-1",
      "quality-1",
      "compact-1",
    ]);
    expect(new Set(ids(result.recommendations)).size).toBe(3);
  });

  it("A02: an explicit year conflict never becomes a recommendation", () => {
    const releases = [
      release("wrong-year", "Test.Movie.2023.2160p.BluRay.REMUX.x265", {
        size: 60 * 1024 ** 3,
      }),
      release("right-year", "Test.Movie.2024.1080p.WEB-DL.x264"),
    ];
    const result = rank(movie, releases, target({ kind: "movie", mode: "browse" }));
    expect(ids(result.recommendations)).toEqual(["right-year"]);
    const wrong = result.releases.find((entry) => entry.releaseId === "wrong-year");
    expect(wrong?.identity).toBe("conflict");
  });

  it("A03: an unknown required field is never treated as satisfied", () => {
    const releases = [
      release("no-subs", "Test.Movie.2024.1080p.WEB-DL.x264"),
    ];
    const result = rank(
      movie,
      releases,
      target({ kind: "movie", mode: "browse" }),
      preferences({
        subtitles: [{ language: "zh", strength: "required" }],
      }),
    );
    expect(result.recommendations).toHaveLength(0);
    const constraint = result.releases[0]?.constraintResults.find(
      (entry) => entry.key === "subtitle:zh",
    );
    expect(constraint?.status).toBe("unknown");
  });

  it("A22: a size limit over an unknown size is not silently relaxed", () => {
    const releases = [
      release("unknown-size", "Test.Movie.2024.1080p.WEB-DL.x264", {
        size: 0,
        evidence: {
          resolution: "title_inferred",
          codec: "title_inferred",
          size: "unknown",
          seeders: "upstream",
          season: "unknown",
        },
      }),
    ];
    const result = rank(
      movie,
      releases,
      target({ kind: "movie", mode: "browse" }),
      preferences({ maxSizeBytes: 20 * 1024 ** 3 }),
    );
    expect(result.recommendations).toHaveLength(0);
    expect(
      result.releases[0]?.constraintResults.find(
        (entry) => entry.key === "maxSizeBytes",
      )?.status,
    ).toBe("unknown");
  });

  it("A13: zero or unknown seeders go to availability-pending", () => {
    const releases = [
      release("zero", "Test.Movie.2024.1080p.WEB-DL.x264", { seeders: 0 }),
      release("unknown", "Test.Movie.2024.1080p.WEB-DL.x265", {
        seeders: 0,
        evidence: {
          resolution: "title_inferred",
          codec: "title_inferred",
          size: "upstream",
          seeders: "unknown",
          season: "unknown",
        },
      }),
    ];
    const result = rank(movie, releases, target({ kind: "movie", mode: "browse" }));
    expect(result.recommendations).toHaveLength(0);
    expect(result.availabilityPending).toHaveLength(2);
    expect(
      result.warnings.some((warning) => warning.code === "NO_CONFIRMED_SEEDERS"),
    ).toBe(true);
  });

  it("keeps the full snapshot ranked, not only the first page", () => {
    const releases = Array.from({ length: 25 }, (_, index) =>
      release(`r${String(index).padStart(2, "0")}`, `Test.Movie.2024.1080p.WEB-DL.x264`, {
        size: (index + 1) * 1024 ** 3,
        seeders: index + 1,
      }),
    );
    const result = rank(movie, releases, target({ kind: "movie", mode: "browse" }));
    expect(result.totalCandidates).toBe(25);
    expect(result.groups[0]?.releases).toHaveLength(25);
    expect(result.releases[24]?.releaseId).toBeDefined();
  });
});

describe("rankSelection series", () => {
  it("A04: never crosses seasons", () => {
    const releases = [
      release("season-1", "Test.Series.S01E01-E12.1080p.WEB-DL", {
        categories: ["TV"],
      }),
      release("season-2", "Test.Series.S02E01-E12.1080p.WEB-DL", {
        categories: ["TV"],
      }),
    ];
    const result = rank(
      series,
      releases,
      target({
        kind: "series",
        mode: "explicit",
        season: 2,
        episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      }),
    );
    expect(ids(result.recommendations)).toEqual(["season-2"]);
    const wrong = result.releases.find((entry) => entry.releaseId === "season-1");
    expect(wrong?.group).toBe("other_scope");
  });

  it("A05: a single episode never outranks a whole-season target", () => {
    const releases = [
      release("single", "Test.Series.S02E09.1080p.WEB-DL", {
        size: 1 * 1024 ** 3,
        categories: ["TV"],
      }),
    ];
    const result = rank(
      series,
      releases,
      target({ kind: "series", mode: "whole", season: 2 }),
    );
    expect(result.recommendations).toHaveLength(0);
    expect(result.releases[0]?.group).toBe("partial_coverage");
  });

  it("A06: 全集 is a claim, not verified completeness", () => {
    const releases = [
      release("complete", "Test.Series.S02.Complete.1080p.WEB-DL", {
        categories: ["TV"],
      }),
    ];
    const result = rank(
      series,
      releases,
      target({ kind: "series", mode: "whole", season: 2 }),
    );
    expect(result.recommendations[0]?.coverage.completeness).toBe("claimed");
    expect(
      result.recommendations[0]?.reasonCodes,
    ).toContain("COMPLETENESS_CLAIMED");
  });

  it("requires verification when the user asks for it", () => {
    const releases = [
      release("complete", "Test.Series.S02.Complete.1080p.WEB-DL", {
        categories: ["TV"],
      }),
    ];
    const result = rank(
      series,
      releases,
      target({ kind: "series", mode: "whole", season: 2 }),
      preferences({ verifiedCompletenessRequired: true }),
    );
    expect(result.recommendations).toHaveLength(0);
    expect(
      result.releases[0]?.constraintResults.find(
        (entry) => entry.key === "verifiedCompleteness",
      )?.status,
    ).toBe("unknown");
  });

  it("A07: 更新至 is never treated as complete", () => {
    const releases = [
      release("ongoing", "Test.Series.S02.更新至E08.1080p.WEB-DL", {
        categories: ["TV"],
      }),
    ];
    const result = rank(
      series,
      releases,
      target({ kind: "series", mode: "whole", season: 2 }),
    );
    expect(result.releases[0]?.coverage.completeness).toBe("unknown");
    expect(result.releases[0]?.coverage.openEnded).toBe(true);
    expect(result.recommendations).toHaveLength(0);
  });

  it("A08: a multi-season pack shows extra scope", () => {
    const releases = [
      release("multi", "Test.Series.S01-S03.1080p.WEB-DL", {
        categories: ["TV"],
        size: 120 * 1024 ** 3,
      }),
    ];
    const result = rank(
      series,
      releases,
      target({ kind: "series", mode: "whole", season: 2 }),
    );
    const entry = result.releases[0];
    expect(entry?.coverage.multiSeason).toBe(true);
    expect(entry?.warnings.some((warning) => warning.code === "EXTRA_SCOPE")).toBe(
      true,
    );
  });

  it("A09: reports complement/overlap clues without merging", () => {
    const releases = [
      release("part-a", "Test.Series.S02E01-E08.1080p.WEB-DL", {
        categories: ["TV"],
      }),
      release("part-b", "Test.Series.S02E09-E12.1080p.WEB-DL", {
        categories: ["TV"],
      }),
    ];
    const result = rank(
      series,
      releases,
      target({
        kind: "series",
        mode: "explicit",
        season: 2,
        episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      }),
    );
    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0]?.kind).toBe("complement");
    expect(result.recommendations).toHaveLength(0);
  });

  it("A14: never repeats the same candidate across roles", () => {
    const releases = [
      release("only", "Test.Series.S02.Complete.1080p.WEB-DL", {
        categories: ["TV"],
      }),
    ];
    const result = rank(
      series,
      releases,
      target({ kind: "series", mode: "whole", season: 2 }),
    );
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.recommendationRole).toBe("balanced_pick");
  });
});

describe("rankSelection variety", () => {
  const varietyMedia: SelectionMediaIdentity = {
    mediaType: "tv",
    itemId: "3",
    title: "综艺",
  };

  it("A10: 正片 and 纯享 are not interchangeable", () => {
    const releases = [
      release("pure", "综艺.第8期.纯享.1080p", { categories: ["TV"] }),
      release("main", "综艺.第8期.正片.1080p", { categories: ["TV"] }),
    ];
    const result = rank(
      varietyMedia,
      releases,
      target({
        kind: "variety",
        mode: "explicit",
        issues: [8],
        edition: "main",
      }),
    );
    expect(ids(result.recommendations)).toEqual(["main"]);
    expect(
      result.releases.find((entry) => entry.releaseId === "pure")?.group,
    ).toBe("covers_target");
    expect(
      result.releases
        .find((entry) => entry.releaseId === "pure")
        ?.constraintResults.find((entry) => entry.key === "edition")?.status,
    ).toBe("not_met");
  });

  it("A11: dates and issue numbers stay in separate spaces", () => {
    const releases = [
      release("issue", "综艺.第12期.1080p", { categories: ["TV"] }),
    ];
    const result = rank(
      null,
      releases,
      target({
        kind: "variety",
        mode: "explicit",
        dates: ["2026-03-01"],
      }),
    );
    expect(result.recommendations).toHaveLength(0);
    expect(result.releases[0]?.group).toBe("unknown_scope");
  });

  it("A12: keeps upper/lower segments and does not count files as episodes", () => {
    const releases = [
      release("upper", "综艺.第8期.上.1080p", { categories: ["TV"] }),
      release("lower", "综艺.2026.03.01.下.1080p", { categories: ["TV"] }),
    ];
    const result = rank(
      null,
      releases,
      target({
        kind: "variety",
        mode: "explicit",
        issues: [8],
        segments: ["upper"],
      }),
    );
    const upper = result.releases.find((entry) => entry.releaseId === "upper");
    const lower = result.releases.find((entry) => entry.releaseId === "lower");
    expect(upper?.coverage.segments).toEqual(["upper"]);
    expect(lower?.coverage.scope).toBe("dates");
  });
});

describe("rankSelection browse and identity", () => {
  it("A21: direct search without identity keeps candidates unverified", () => {
    const releases = [
      release("unknown-work", "Some.Show.S02E01-E08.1080p", { categories: ["TV"] }),
    ];
    const result = rank(
      null,
      releases,
      target({ kind: "series", mode: "explicit", season: 2, episodes: [1, 2] }),
    );
    expect(result.recommendations).toHaveLength(0);
    expect(
      result.releases[0]?.warnings.some(
        (warning) => warning.code === "IDENTITY_UNVERIFIED",
      ),
    ).toBe(true);
  });

  it("browse mode gives no cross-season pick", () => {
    const releases = [
      release("s1", "Test.Series.S01.1080p.WEB-DL", { categories: ["TV"] }),
      release("s2", "Test.Series.S02.1080p.WEB-DL", { categories: ["TV"] }),
    ];
    const result = rank(series, releases, target({ kind: "series", mode: "browse" }));
    expect(result.recommendations).toHaveLength(0);
    expect(result.groups[0]?.key).toBe("browse_scope");
    expect(
      result.warnings.some((warning) => warning.code === "BROWSE_ALL"),
    ).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const releases = [
      release("b", "Test.Movie.2024.1080p.WEB-DL.x264", { seeders: 5 }),
      release("a", "Test.Movie.2024.1080p.WEB-DL.x264", { seeders: 5 }),
    ];
    const first = rank(movie, releases, target({ kind: "movie", mode: "browse" }));
    const second = rank(movie, releases, target({ kind: "movie", mode: "browse" }));
    expect(ids(first.releases)).toEqual(ids(second.releases));
    expect(first.recommendations.map((entry) => entry.releaseId)).toEqual(
      second.recommendations.map((entry) => entry.releaseId),
    );
  });

  it("keeps default preferences pure", () => {
    const defaults = defaultSelectionPreferences();
    expect(defaults.preset).toBe("balanced");
    expect(defaults.freeleechOnly).toBe(false);
    expect(JSON.parse(JSON.stringify(defaults))).toEqual(defaults);
  });

  it("produces a schema-valid response shape", () => {
    const result = rank(movie, [release("m1", "Test.Movie.2024.1080p.WEB-DL.x264")], target({ kind: "movie", mode: "browse" }));
    // Sanity: recommendations and groups must stay bounded by the contract.
    expect(result.recommendations.length).toBeLessThanOrEqual(3);
    expect(result.releases.length).toBeLessThanOrEqual(60);
    expect(result.overlaps.length).toBeLessThanOrEqual(20);
    const shape: Pick<ReleaseSelectionResponse, "groups" | "recommendations"> = {
      groups: result.groups,
      recommendations: result.recommendations,
    };
    expect(shape.groups.length).toBeLessThanOrEqual(6);
  });
});
