import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReleaseSummary } from "../../src/shared/contracts";
import {
  selectionPreferencesSchema,
  selectionTargetSchema,
  type ReleaseSelectionRequest,
  type ReleaseSelectionResponse,
  type SelectionAssistResponse,
} from "../../src/shared/release-selection";
import {
  filterTorrentNames,
  parseOwnedUnits,
} from "../../src/client/components/release-selection-labels";
import {
  ReleaseSelectionPanel,
} from "../../src/client/components/ReleaseSelectionPanel";
import { SelectionPanel } from "../../src/client/components/SelectionPanel";
import { rankSelection } from "../../src/server/release-selection/ranking";

const media = {
  mediaType: "movie" as const,
  itemId: "1",
  title: "测试电影",
  originalTitle: "Test Movie",
  year: "2024",
};

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
    size: 5 * 1024 ** 3,
    seeders: 12,
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
      season: "unknown",
    },
    ...overrides,
  };
}

function buildResponse(warningMessage?: string): ReleaseSelectionResponse {
  const target = selectionTargetSchema.parse({ kind: "movie", mode: "browse" });
  const preferences = selectionPreferencesSchema.parse({});
  const ranked = rankSelection({
    media,
    releases: [release("rel-aaaaaaaa", "Test.Movie.2024.1080p.WEB-DL.x264")],
    target,
    preferences,
  });
  return {
    snapshot: {
      id: "snap-aaaaaaaa",
      kind: "discovery",
      query: "Test Movie 2024",
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      actionableUntil: new Date(Date.now() + 60_000).toISOString(),
      stale: false,
      releaseCount: 1,
      media: {
        mediaType: "movie",
        itemId: "1",
        title: "测试电影",
        year: "2024",
      },
    },
    target,
    preferences,
    revision: {
      snapshotId: "snap-aaaaaaaa",
      targetRevision: "target-1",
      preferencesRevision: "prefs-1",
      algorithmVersion: "selection-1",
      checkedAt: new Date().toISOString(),
    },
    groups: ranked.groups,
    recommendations: ranked.recommendations,
    availabilityPending: ranked.availabilityPending,
    overlaps: ranked.overlaps,
    warnings: warningMessage
      ? [{ code: "TEST", message: warningMessage }]
      : ranked.warnings,
    totalCandidates: ranked.totalCandidates,
    eligibleCount: ranked.eligibleCount,
    recommendedCount: ranked.recommendations.length,
  };
}

const snapshotRef = {
  kind: "discovery" as const,
  mediaType: "movie" as const,
  itemId: "1",
  snapshotId: "snap-aaaaaaaa",
};

function renderPanel(
  loadSelection: (
    request: ReleaseSelectionRequest,
    csrfToken: string,
  ) => Promise<ReleaseSelectionResponse>,
  overrides: Partial<React.ComponentProps<typeof ReleaseSelectionPanel>> = {},
) {
  return render(
    <ReleaseSelectionPanel
      snapshot={snapshotRef}
      csrfToken="csrf"
      defaultKind="movie"
      loadSelection={loadSelection}
      selectedReleaseId={null}
      selectingId={null}
      onSelectRelease={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("ReleaseSelectionPanel", () => {
  it("renders recommendations and groups from the rules response", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    renderPanel(loadSelection);
    expect(await screen.findByText("均衡首选")).toBeTruthy();
    expect(screen.getByText("全部候选")).toBeTruthy();
    await waitFor(() => expect(loadSelection).toHaveBeenCalledTimes(1));
    expect(loadSelection.mock.calls[0]?.[0]?.target.kind).toBe("movie");
  });

  it("selects the mapped release summary", async () => {
    const onSelectRelease = vi.fn();
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    renderPanel(loadSelection, { onSelectRelease });
    const buttons = await screen.findAllByRole("button", { name: /选择|已选择/u });
    await userEvent.click(buttons[0]!);
    expect(onSelectRelease).toHaveBeenCalledTimes(1);
    expect(onSelectRelease.mock.calls[0]?.[0].id).toBe("rel-aaaaaaaa");
  });

  it("reloads with a new preset when the user switches", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    renderPanel(loadSelection);
    await waitFor(() => expect(loadSelection).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "画质规格优先" }));
    await waitFor(() => {
      const last = loadSelection.mock.calls.at(-1)?.[0];
      expect(last?.preferences.preset).toBe("quality");
    });
  });

  it("ignores a stale response that arrives after a newer one", async () => {
    let resolveFirst!: (value: ReleaseSelectionResponse) => void;
    const loadSelection = vi.fn(
      (request: ReleaseSelectionRequest, _csrfToken: string) => {
        if (request.preferences.preset === "balanced") {
          return new Promise<ReleaseSelectionResponse>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(buildResponse("新结果"));
      },
    );
    renderPanel(loadSelection);
    await waitFor(() => expect(loadSelection).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "小体积优先" }));
    expect(await screen.findByText("新结果")).toBeTruthy();
    resolveFirst(buildResponse("旧结果"));
    await waitFor(() => {
      expect(screen.queryByText("旧结果")).toBeNull();
      expect(screen.getByText("新结果")).toBeTruthy();
    });
  });

  it("shows an error state when the snapshot expired", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) => {
        throw new Error("候选快照已更新，请刷新后重新选择");
      },
    );
    renderPanel(loadSelection);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/快照已更新/u)).toBeTruthy();
  });

  it("shows the unverified-work warning for direct search", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) => {
        const response = buildResponse();
        return {
          ...response,
          snapshot: { ...response.snapshot, kind: "search" as const, media: null },
          warnings: [
            {
              code: "IDENTITY_UNVERIFIED",
              message: "尚未确认作品身份，只整理候选字段，不给出确定首选",
            },
          ],
        };
      },
    );
    renderPanel(loadSelection, {
      snapshot: { kind: "search", snapshotId: "snap-aaaaaaaa" },
      defaultKind: "movie",
    });
    expect(await screen.findByText(/尚未确认作品身份/u)).toBeTruthy();
  });

  it("only calls AI on click and shows the verified result", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    const run = vi.fn(async (): Promise<SelectionAssistResponse> => {
      const response = buildResponse();
      return {
        analysis: "complete",
        analyzedCandidateCount: 1,
        totalCandidateCount: 1,
        text: "AI 说明文本",
        preferenceDraft: null,
        parseSuggestions: [],
        selection: response,
        warnings: [],
      };
    });
    renderPanel(loadSelection, { assist: { enabled: true, run } });
    expect(run).not.toHaveBeenCalled();
    await screen.findByText("均衡首选");
    await userEvent.click(screen.getByRole("button", { name: /AI 帮我比较/u }));
    expect(await screen.findByText("AI 说明文本")).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps rules usable when AI fails", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    const run = vi.fn(async () => {
      throw new Error("AI 服务不可用");
    });
    renderPanel(loadSelection, { assist: { enabled: true, run } });
    await screen.findByText("均衡首选");
    await userEvent.click(screen.getByRole("button", { name: /AI 帮我比较/u }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("均衡首选")).toBeTruthy();
  });

  it("drops a late AI answer when the target changes", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    let resolveAi!: (value: SelectionAssistResponse) => void;
    const run = vi.fn(
      () =>
        new Promise<SelectionAssistResponse>((resolve) => {
          resolveAi = resolve;
        }),
    );
    renderPanel(loadSelection, { assist: { enabled: true, run } });
    await screen.findByText("均衡首选");
    await userEvent.click(screen.getByRole("button", { name: /AI 帮我比较/u }));
    await userEvent.click(screen.getByRole("button", { name: "小体积优先" }));
    resolveAi({
      analysis: "complete",
      analyzedCandidateCount: 1,
      totalCandidateCount: 1,
      text: "旧AI结果",
      preferenceDraft: null,
      parseSuggestions: [],
      selection: buildResponse(),
      warnings: [],
    });
    await waitFor(() => expect(screen.queryByText("旧AI结果")).toBeNull());
  });

  it("applies the server-recomputed selection from AI", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    const run = vi.fn(async (): Promise<SelectionAssistResponse> => ({
      analysis: "complete",
      analyzedCandidateCount: 1,
      totalCandidateCount: 1,
      text: "AI 已完成",
      preferenceDraft: null,
      parseSuggestions: [],
      selection: buildResponse("AI 更新后的规则结果"),
      warnings: [],
    }));
    renderPanel(loadSelection, { assist: { enabled: true, run } });
    await screen.findByText("均衡首选");
    await userEvent.click(screen.getByRole("button", { name: /AI 帮我比较/u }));
    expect(await screen.findByText("AI 更新后的规则结果")).toBeTruthy();
  });

  it("sends variety season, year and segment targets", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    renderPanel(loadSelection, {
      defaultKind: "variety",
      snapshot: { kind: "search", snapshotId: "snap-aaaaaaaa" },
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "按期/日期" }),
    );
    await userEvent.type(screen.getByLabelText("综艺季"), "2");
    await userEvent.type(screen.getByLabelText("综艺年份"), "2026");
    await userEvent.type(screen.getByLabelText(/期数/u), "8");
    await userEvent.click(screen.getByLabelText("上"));
    await waitFor(() => {
      const last = loadSelection.mock.calls.at(-1)?.[0];
      expect(last?.target.kind).toBe("variety");
      expect(last?.target.season).toBe(2);
      expect(last?.target.year).toBe("2026");
      expect(last?.target.issues).toEqual([8]);
      expect(last?.target.segments).toEqual(["upper"]);
    });
  });
});

describe("R1/R8/R11 regression", () => {
  it("keeps the hard free filter and every applied draft field", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    const draft = selectionPreferencesSchema.parse({
      preset: "quality",
      freeleechPreferred: true,
      maxSizeBytes: 1_000_000_000,
      subtitles: [{ language: "zh", strength: "required" }],
    });
    const run = vi.fn(async (): Promise<SelectionAssistResponse> => ({
      analysis: "complete",
      analyzedCandidateCount: 1,
      totalCandidateCount: 1,
      text: "AI 已完成",
      preferenceDraft: draft,
      parseSuggestions: [],
      selection: buildResponse(),
      warnings: [],
    }));
    renderPanel(loadSelection, { assist: { enabled: true, run } });
    await screen.findByText("均衡首选");
    await userEvent.click(screen.getByRole("button", { name: /AI 帮我比较/u }));
    await userEvent.click(
      await screen.findByRole("button", { name: "应用条件" }),
    );
    await userEvent.click(screen.getByLabelText(/只看免费/u));
    await waitFor(() => {
      const last = loadSelection.mock.calls.at(-1)?.[0];
      expect(last?.preferences.freeleechOnly).toBe(true);
      expect(last?.preferences.freeleechPreferred).toBe(false);
      expect(last?.preferences.maxSizeBytes).toBe(1_000_000_000);
      expect(last?.preferences.subtitles).toEqual([
        { language: "zh", strength: "required" },
      ]);
    });
  });

  it("repeats the evidence level and unmet constraints in the confirm panel", async () => {
    const response = buildResponse();
    const base = response.groups[0]?.releases[0];
    if (!base) throw new Error("fixture missing");
    const ranked = {
      ...base,
      coverage: { ...base.coverage, scope: "episodes" as const },
      constraintResults: [
        { key: "maxSizeBytes", status: "not_met" as const, detail: "总体积超过限制" },
      ],
    };
    const releaseSummary = {
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
      freeleech: ranked.freeleech,
      freeleechState: ranked.freeleechState,
    };
    render(
      <SelectionPanel
        selection={{ release: releaseSummary, index: 1, preview: null, ranked }}
        previewError={null}
        expanded
        confirmLoading={false}
        grabResult={null}
        storage={null}
        storageLoading={false}
        storageError={null}
        torrents={[]}
        torrentsLoading={false}
        torrentsError={null}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onRefreshRuntime={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/标题标注范围（未核验）/u),
    ).toBeInTheDocument();
    expect(screen.getByText("总体积超过限制")).toBeInTheDocument();
  });
});

describe("F6 regression: a dead snapshot is a terminal view state", () => {
  it("clears the rules view when the snapshot is gone", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) => {
        if (loadSelection.mock.calls.length <= 1) return buildResponse();
        throw Object.assign(new Error("候选快照已失效"), {
          code: "SNAPSHOT_NOT_FOUND",
        });
      },
    );
    renderPanel(loadSelection);
    await screen.findByText("均衡首选");
    await userEvent.click(screen.getByRole("button", { name: "小体积优先" }));
    await waitFor(() => expect(screen.queryByText("均衡首选")).toBeNull());
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("G6 regression: the dead-snapshot state gates both async chains", () => {
  it("drops a late AI answer after the snapshot dies", async () => {
    let resolveAi!: (value: SelectionAssistResponse) => void;
    const run = vi.fn(
      () =>
        new Promise<SelectionAssistResponse>((resolve) => {
          resolveAi = resolve;
        }),
    );
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) => {
        if (loadSelection.mock.calls.length <= 1) return buildResponse();
        throw Object.assign(new Error("候选快照已失效"), {
          code: "SNAPSHOT_NOT_FOUND",
        });
      },
    );
    renderPanel(loadSelection, { assist: { enabled: true, run } });
    await screen.findByText("均衡首选");
    await userEvent.click(screen.getByRole("button", { name: /AI 帮我比较/u }));
    await userEvent.click(screen.getByRole("button", { name: "小体积优先" }));
    await screen.findByRole("alert");
    resolveAi({
      analysis: "complete",
      analyzedCandidateCount: 1,
      totalCandidateCount: 1,
      text: "旧AI结果",
      preferenceDraft: null,
      parseSuggestions: [],
      selection: buildResponse(),
      warnings: [],
    });
    await waitFor(() => expect(screen.queryByText("旧AI结果")).toBeNull());
  });

  it("does not start AI once the snapshot is dead", async () => {
    const run = vi.fn(async (): Promise<SelectionAssistResponse> => ({
      analysis: "complete",
      analyzedCandidateCount: 1,
      totalCandidateCount: 1,
      text: "不应出现",
      preferenceDraft: null,
      parseSuggestions: [],
      selection: buildResponse(),
      warnings: [],
    }));
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) => {
        throw Object.assign(new Error("候选快照已失效"), {
          code: "SNAPSHOT_EXPIRED",
        });
      },
    );
    renderPanel(loadSelection, { assist: { enabled: true, run } });
    await screen.findByRole("alert");
    await userEvent.type(screen.getByLabelText("自然语言偏好"), "第2季整季");
    await userEvent.click(screen.getByRole("button", { name: "解析为条件" }));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("K1 regression: the client never submits a truncated target", () => {
  it("shows an overflow error and sends no reduced range", async () => {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    renderPanel(loadSelection, { defaultKind: "series" });
    await waitFor(() => expect(loadSelection).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "指定集数" }));
    await userEvent.type(screen.getByLabelText(/集数/u), "1-301");
    expect(await screen.findByText(/超过上限/u)).toBeTruthy();
    // No request may carry the truncated 1–300 list (or an oversized one).
    for (const call of loadSelection.mock.calls) {
      expect(call[0].target.episodes.length).toBeLessThanOrEqual(300);
      expect(call[0].target.episodes.length).not.toBe(300);
    }
  });
});

describe("owned-episode ordering", () => {
  it("parses downloaded episodes from qBittorrent task names", () => {
    const owned = parseOwnedUnits([
      "Test.Series.S02E01-E08.1080p.WEB-DL",
      "综艺.第3期.正片",
      "Other.Show.S01E05",
    ]);
    expect(owned.episodes.get(2)?.has(1)).toBe(true);
    expect(owned.episodes.get(2)?.has(8)).toBe(true);
    expect(owned.episodes.get(2)?.has(9)).toBe(false);
    expect(owned.episodes.get(1)?.has(5)).toBe(true);
    expect(owned.issues.has(3)).toBe(true);
  });

  it("ignores qBittorrent tasks from other works", () => {
    const filtered = filterTorrentNames(
      [
        "Test.Series.S02E01-E08.1080p",
        "Other.Show.S02E01-E08.1080p",
        "测试剧集.S02E01.1080p",
      ],
      ["Test Series", "测试剧集"],
    );
    expect(filtered).toEqual([
      "Test.Series.S02E01-E08.1080p",
      "测试剧集.S02E01.1080p",
    ]);
  });

  it("sorts not-downloaded episodes first and badges both rows", async () => {
    const target = selectionTargetSchema.parse({
      kind: "series",
      mode: "browse",
    });
    const preferences = selectionPreferencesSchema.parse({});
    const ranked = rankSelection({
      media: {
        mediaType: "tv",
        itemId: "2",
        title: "测试剧集",
        originalTitle: "Test Series",
        year: "2024",
      },
      releases: [
        release("rel-owned000", "Test.Series.S02E01-E08.1080p.WEB-DL", {
          categories: ["TV"],
        }),
        release("rel-missing0", "Test.Series.S02E09-E12.1080p.WEB-DL", {
          categories: ["TV"],
        }),
      ],
      target,
      preferences,
    });
    const response: ReleaseSelectionResponse = {
      snapshot: {
        id: "snap-aaaaaaaa",
        kind: "discovery",
        query: "Test Series",
        checkedAt: new Date().toISOString(),
        expiresAt: null,
        actionableUntil: null,
        stale: false,
        releaseCount: 2,
        media: {
          mediaType: "tv",
          itemId: "2",
          title: "测试剧集",
          originalTitle: "Test Series",
        },
      },
      target,
      preferences,
      revision: {
        snapshotId: "snap-aaaaaaaa",
        targetRevision: "target-1",
        preferencesRevision: "prefs-01",
        algorithmVersion: "selection-1",
        checkedAt: new Date().toISOString(),
      },
      groups: ranked.groups,
      recommendations: ranked.recommendations,
      availabilityPending: ranked.availabilityPending,
      overlaps: ranked.overlaps,
      warnings: ranked.warnings,
      totalCandidates: ranked.totalCandidates,
      eligibleCount: ranked.eligibleCount,
      recommendedCount: ranked.recommendations.length,
    };
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        response,
    );
    renderPanel(loadSelection, {
      defaultKind: "series",
      torrentNames: ["Test.Series.S02E01-E08.1080p.WEB-DL"],
    });
    await screen.findByText("已下载全部 8 集");
    const listTitles = Array.from(
      document.querySelectorAll(".sel-release-list .sel-release-title"),
    ).map((element) => element.textContent ?? "");
    expect(listTitles[0]).toContain("S02E09-E12");
    expect(screen.getByText("未下载 4 集 · 从 E09 开始")).toBeTruthy();
  });

  it("reads episodes small-to-large even without downloaded tasks", async () => {
    const target = selectionTargetSchema.parse({
      kind: "series",
      mode: "browse",
    });
    const preferences = selectionPreferencesSchema.parse({});
    const ranked = rankSelection({
      media: {
        mediaType: "tv",
        itemId: "2",
        title: "测试剧集",
        originalTitle: "Test Series",
        year: "2024",
      },
      releases: [
        release("rel-e05", "Test.Series.S02E05.1080p.WEB-DL", {
          categories: ["TV"],
        }),
        release("rel-e01", "Test.Series.S02E01.1080p.WEB-DL", {
          categories: ["TV"],
        }),
        release("rel-e03", "Test.Series.S02E03.1080p.WEB-DL", {
          categories: ["TV"],
        }),
      ],
      target,
      preferences,
    });
    const response: ReleaseSelectionResponse = {
      snapshot: {
        id: "snap-aaaaaaaa",
        kind: "discovery",
        query: "Test Series",
        checkedAt: new Date().toISOString(),
        expiresAt: null,
        actionableUntil: null,
        stale: false,
        releaseCount: 3,
        media: {
          mediaType: "tv",
          itemId: "2",
          title: "测试剧集",
          originalTitle: "Test Series",
        },
      },
      target,
      preferences,
      revision: {
        snapshotId: "snap-aaaaaaaa",
        targetRevision: "target-1",
        preferencesRevision: "prefs-01",
        algorithmVersion: "selection-1",
        checkedAt: new Date().toISOString(),
      },
      groups: ranked.groups,
      recommendations: ranked.recommendations,
      availabilityPending: ranked.availabilityPending,
      overlaps: ranked.overlaps,
      warnings: ranked.warnings,
      totalCandidates: ranked.totalCandidates,
      eligibleCount: ranked.eligibleCount,
      recommendedCount: ranked.recommendations.length,
    };
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        response,
    );
    renderPanel(loadSelection, { defaultKind: "series" });
    await waitFor(() =>
      expect(
        document.querySelectorAll(".sel-release-list .sel-release-title").length,
      ).toBe(3),
    );
    const listTitles = Array.from(
      document.querySelectorAll(".sel-release-list .sel-release-title"),
    ).map((element) => element.textContent ?? "");
    expect(listTitles.map((title) => title.match(/S02E0\d/u)?.[0])).toEqual([
      "S02E01",
      "S02E03",
      "S02E05",
    ]);
  });
});

describe("type switch visibility", () => {
  function renderWithSnapshot(
    snapshot: React.ComponentProps<typeof ReleaseSelectionPanel>["snapshot"],
  ) {
    const loadSelection = vi.fn(
      async (_request: ReleaseSelectionRequest, _csrfToken: string) =>
        buildResponse(),
    );
    renderPanel(loadSelection, { defaultKind: "movie", snapshot });
    return loadSelection;
  }

  it("hides the switch for a known movie", async () => {
    renderWithSnapshot({
      kind: "discovery",
      mediaType: "movie",
      itemId: "1",
      snapshotId: "snap-aaaaaaaa",
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "电影" })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "电视剧" })).toBeNull();
    expect(screen.queryByRole("button", { name: "综艺" })).toBeNull();
  });

  it("offers only series/variety for a TV work", async () => {
    renderWithSnapshot({
      kind: "discovery",
      mediaType: "tv",
      itemId: "2",
      snapshotId: "snap-aaaaaaaa",
    });
    expect(
      await screen.findByRole("button", { name: "电视剧" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "综艺" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "电影" })).toBeNull();
  });

  it("offers all three when the type is unknown", async () => {
    renderWithSnapshot({ kind: "search", snapshotId: "snap-aaaaaaaa" });
    expect(await screen.findByRole("button", { name: "电影" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "电视剧" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "综艺" })).toBeTruthy();
  });
});
