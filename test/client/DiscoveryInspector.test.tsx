import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryItem, DiscoveryReleaseResponse, ReleaseSummary } from "../../src/shared/contracts";
import { DiscoveryInspector } from "../../src/client/components/DiscoveryInspector";

const item: DiscoveryItem = {
  id: "subject-4",
  title: "百年孤独 第二季",
  posterUrl: "/api/discovery/collections/tv-hot/items/subject-4/poster?page=1&limit=10",
  originalTitle: "Cien Años de Soledad S02",
  year: "2024",
  rating: 9.3,
  ratingCount: 8240,
  rank: 4,
  mediaType: "tv",
  genres: ["剧情", "奇幻", "历史"],
  summary: "布恩迪亚家族的命运继续交织，爱、战争与预言在马孔多延续。",
  sourceUrl: "https://movie.douban.com/subject/4/"
};

const release = (overrides: Partial<ReleaseSummary> = {}): ReleaseSummary => ({
  id: "release-1",
  title: "Cien.Años.de.Soledad.S02.1080p.WEB-DL",
  indexer: "RARBG",
  protocol: "torrent",
  size: 21.3 * 1024 ** 3,
  seeders: 128,
  leechers: 2,
  grabs: 4,
  ageDays: 3,
  categories: ["TV"],
  resolution: "1080p",
  codec: "H.264",
  freeleech: true,
  ...overrides
});

const response: DiscoveryReleaseResponse = {
  itemId: item.id,
  query: item.title,
  status: "available",
  checkedAt: "2026-08-29T00:00:00.000Z",
  total: 2,
  releases: [
    release(),
    release({
      id: "release-2",
      title: "Cien.Años.de.Soledad.S02.720p.WEBRip",
      indexer: "影视工业网",
      size: 19.6 * 1024 ** 3,
      seeders: 86,
      resolution: "720p",
      freeleech: false
    })
  ]
};

function renderInspector(overrides: Partial<React.ComponentProps<typeof DiscoveryInspector>> = {}) {
  const props: React.ComponentProps<typeof DiscoveryInspector> = {
    item,
    details: null,
    detailsLoading: false,
    detailsError: null,
    releaseResponse: response,
    loading: false,
    error: null,
    selectedReleaseId: null,
    selectingId: null,
    onSelectRelease: vi.fn(),
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onRetryDetails: vi.fn(),
    ...overrides
  };
  render(<DiscoveryInspector {...props} />);
  return props;
}

describe("DiscoveryInspector", () => {
  it("renders the selected item and radio-style candidate releases", async () => {
    const user = userEvent.setup();
    const props = renderInspector({
      selectedReleaseId: "release-1",
      details: { itemId: item.id, actors: [{ name: "演员甲" }, { name: "演员乙" }], directors: ["导演甲"] }
    });

    expect(screen.getByRole("heading", { name: "百年孤独 第二季" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "演员甲" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "演员乙" })).toBeInTheDocument();
    expect(screen.getByText("导演甲")).toBeInTheDocument();
    const candidateList = screen.getByRole("radiogroup", { name: "候选片源列表" });
    expect(within(candidateList).getByText("1080p")).toBeInTheDocument();
    expect(within(candidateList).getByText("21.3 GB")).toBeInTheDocument();
    expect(within(candidateList).getByText("免费")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Cien\.Años\.de\.Soledad\.S02.*已选择/ })).toHaveAttribute("aria-checked", "true");

    const radios = screen.getAllByRole("radio");
    await user.click(radios[1]);
    expect(props.onSelectRelease).toHaveBeenCalledWith(response.releases[1]);
    expect(screen.getByRole("radio", { name: /720p.*未选择/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: /加入下载|查看片源/ })).not.toBeInTheDocument();
  });

  it("renders empty item and empty candidate states", () => {
    cleanup();
    renderInspector({ item: null, releaseResponse: null });
    expect(screen.getByRole("status")).toHaveTextContent("选择一个条目");

    cleanup();
    renderInspector({ releaseResponse: { ...response, status: "unavailable", total: 0, releases: [] } });
    expect(screen.getByRole("status")).toHaveTextContent("暂未找到候选片源");
    expect(screen.getByRole("button", { name: "重新检查" })).toBeInTheDocument();
  });

  it("renders loading and error states and exposes retry/close controls", async () => {
    const user = userEvent.setup();
    cleanup();
    const loadingProps = renderInspector({ loading: true });
    expect(screen.getByRole("status")).toHaveTextContent("正在检查片源");
    expect(screen.getByRole("button", { name: "重新检查片源" })).toBeDisabled();

    cleanup();
    const errorProps = renderInspector({ error: "服务暂时不可用" });
    expect(screen.getByRole("alert")).toHaveTextContent("服务暂时不可用");
    await user.click(screen.getByRole("button", { name: "重试检查" }));
    expect(errorProps.onRetry).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "关闭候选片源" }));
    expect(errorProps.onClose).toHaveBeenCalledTimes(1);
    expect(loadingProps.onRetry).not.toHaveBeenCalled();
  });

  it("paginates the cached candidate snapshot without losing candidate order", async () => {
    const user = userEvent.setup();
    const releases = Array.from({ length: 12 }, (_, index) => release({
      id: `release-${index + 1}`,
      title: `Candidate ${index + 1}`
    }));
    cleanup();
    renderInspector({
      releaseResponse: { ...response, total: releases.length, releases }
    });

    expect(screen.getByText("Candidate 1")).toBeInTheDocument();
    expect(screen.getByText("Candidate 10")).toBeInTheDocument();
    expect(screen.queryByText("Candidate 11")).not.toBeInTheDocument();
    expect(screen.getByText("第 1 页 · 1–10 / 12")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.queryByText("Candidate 1")).not.toBeInTheDocument();
    expect(screen.getByText("Candidate 11")).toBeInTheDocument();
    expect(screen.getByText("Candidate 12")).toBeInTheDocument();
    expect(screen.getByText("第 2 页 · 11–12 / 12")).toBeInTheDocument();
  });

  it("filters and sorts the cached snapshot locally without selecting or re-querying", async () => {
    const user = userEvent.setup();
    const candidates = [
      release({ id: "s1", title: "Show S01 1080p", season: 1, seeders: 10, size: 10 * 1024 ** 3 }),
      release({ id: "s2", title: "Show S02 2160p", season: 2, resolution: "2160p", seeders: 50, size: 30 * 1024 ** 3 }),
      release({ id: "s3", title: "Show S02 720p", season: 2, resolution: "720p", seeders: 5, size: 5 * 1024 ** 3, freeleech: false })
    ];
    cleanup();
    const props = renderInspector({ releaseResponse: { ...response, total: candidates.length, releases: candidates } });

    await user.selectOptions(screen.getByRole("combobox", { name: /季/ }), "2");
    expect(screen.queryByText("Show S01 1080p")).not.toBeInTheDocument();
    expect(screen.getByText("Show S02 2160p")).toBeInTheDocument();
    expect(screen.getByText("Show S02 720p")).toBeInTheDocument();

    // Sorting applies to the filtered snapshot only and never triggers a preview.
    await user.selectOptions(screen.getByRole("combobox", { name: /排序/ }), "seeders");
    expect(screen.getAllByRole("radio")[0]).toHaveAccessibleName(/Show S02 2160p/);
    expect(props.onSelectRelease).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: "仅免费" }));
    expect(screen.getByText("Show S02 2160p")).toBeInTheDocument();
    expect(screen.queryByText("Show S02 720p")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /分辨率/ }), "720p");
    expect(screen.getByText("没有符合筛选的候选")).toBeInTheDocument();
  });
});
