import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryItem, DiscoveryReleaseResponse } from "../../src/shared/contracts";
import { DiscoveryBrowser } from "../../src/client/components/DiscoveryBrowser";

const item = (overrides: Partial<DiscoveryItem> = {}): DiscoveryItem => ({
  id: "subject-1",
  title: "奥德赛",
  originalTitle: "The Odyssey",
  year: "2024",
  rating: 8.7,
  ratingCount: 12345,
  rank: 1,
  mediaType: "movie",
  genres: ["动作", "冒险", "奇幻"],
  summary: "英雄踏上漫长归途，面对神明、怪物与人性的考验。",
  sourceUrl: "https://movie.douban.com/subject/1/",
  ...overrides
});

const response = (overrides: Partial<DiscoveryReleaseResponse> = {}): DiscoveryReleaseResponse => ({
  itemId: "subject-1",
  query: "奥德赛",
  status: "available",
  checkedAt: "2026-08-29T00:00:00.000Z",
  total: 2,
  releases: [],
  ...overrides
});

function renderBrowser(overrides: Partial<React.ComponentProps<typeof DiscoveryBrowser>> = {}) {
  const props: React.ComponentProps<typeof DiscoveryBrowser> = {
    collection: "movie-hot",
    items: [item()],
    loading: false,
    error: null,
    selectedItemId: null,
    availabilityById: {},
    checkingIds: new Set<string>(),
    onCollectionChange: vi.fn(),
    onSelectItem: vi.fn(),
    onRetry: vi.fn(),
    ...overrides
  };
  render(<DiscoveryBrowser {...props} />);
  return props;
}

describe("DiscoveryBrowser", () => {
  it("renders semantic collection tabs and switches collections", async () => {
    const user = userEvent.setup();
    const props = renderBrowser();
    const tabs = screen.getAllByRole("tab");

    expect(tabs).toHaveLength(5);
    expect(screen.getByRole("tab", { name: "热门电影" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "口碑电影" })).toHaveAttribute("aria-selected", "false");

    await user.click(screen.getByRole("tab", { name: "口碑电影" }));
    expect(props.onCollectionChange).toHaveBeenCalledWith("movie-weekly");
  });

  it("supports tablist keyboard navigation and selecting an item", async () => {
    const user = userEvent.setup();
    const props = renderBrowser({ selectedItemId: "subject-1" });
    const firstTab = screen.getByRole("tab", { name: "热门电影" });

    firstTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(props.onCollectionChange).toHaveBeenCalledWith("movie-weekly");
    expect(screen.getByRole("tab", { name: "口碑电影" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: /奥德赛/ }));
    expect(props.onSelectItem).toHaveBeenCalledWith(expect.objectContaining({ id: "subject-1" }));
    expect(screen.getByRole("button", { name: /奥德赛/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("tabindex", "0");
  });

  it("renders pending, checking, available, possible, and unavailable states", () => {
    const items = [
      item({ id: "pending", title: "电影一", rank: 1 }),
      item({ id: "checking", title: "电影二", rank: 2 }),
      item({ id: "available", title: "电影三", rank: 3 }),
      item({ id: "possible", title: "电影四", rank: 4 }),
      item({ id: "unavailable", title: "电影五", rank: 5 })
    ];
    renderBrowser({
      items,
      checkingIds: new Set(["checking"]),
      availabilityById: {
        available: response({ itemId: "available", status: "available", total: 3 }),
        possible: response({ itemId: "possible", status: "possible", total: 4 }),
        unavailable: response({ itemId: "unavailable", status: "unavailable", total: 0 })
      }
    });

    expect(screen.getByText("待检查")).toBeInTheDocument();
    expect(screen.getByText("检查中")).toBeInTheDocument();
    expect(screen.getByText("有资源 3")).toBeInTheDocument();
    expect(screen.getByText("可能匹配 4")).toBeInTheDocument();
    expect(screen.getByText("暂未找到")).toBeInTheDocument();
    expect(screen.getByText("有资源 3").closest(".discovery-availability")).toHaveClass("is-available");
  });

  it("shows loading, empty, and error states with retry controls", async () => {
    const user = userEvent.setup();
    const loadingProps = renderBrowser({ loading: true });
    expect(screen.getByRole("status")).toHaveTextContent("正在载入榜单");
    expect(loadingProps.onRetry).not.toHaveBeenCalled();

    cleanup();
    const errorProps = renderBrowser({ error: "网络暂时不可用" });
    expect(screen.getByRole("alert")).toHaveTextContent("网络暂时不可用");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(errorProps.onRetry).toHaveBeenCalledTimes(1);

    cleanup();
    renderBrowser({ items: [] });
    expect(screen.getByRole("status")).toHaveTextContent("这个榜单还没有条目");
  });
});
