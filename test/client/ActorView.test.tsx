import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryActorProfile } from "../../src/shared/contracts";
import { ActorView } from "../../src/client/components/ActorView";

const profile: DiscoveryActorProfile = {
  id: "1048026",
  name: "演员甲",
  latinName: "Actor A",
  avatarUrl: "/api/discovery/actors/1048026/avatar",
  intro: "演员 / 导演",
  works: [{
    id: "1295644",
    title: "一部电影",
    posterUrl: "/api/discovery/media/movie/1295644/poster",
    year: "2024",
    rating: 8.8,
    mediaType: "movie",
    genres: ["剧情"],
    summary: "一段故事。",
    role: "演员",
    sourceUrl: "https://movie.douban.com/subject/1295644/"
  }],
  page: 1,
  pageSize: 10,
  total: 21,
  hasNext: true
};

function renderView(overrides: Partial<React.ComponentProps<typeof ActorView>> = {}) {
  const props: React.ComponentProps<typeof ActorView> = {
    profile,
    page: 1,
    loading: false,
    error: null,
    onBack: vi.fn(),
    onSelectWork: vi.fn(),
    onPageChange: vi.fn(),
    onRetry: vi.fn(),
    ...overrides
  };
  render(<ActorView {...props} />);
  return props;
}

describe("ActorView", () => {
  it("shows profile, filmography and paging controls", async () => {
    const user = userEvent.setup();
    const props = renderView();

    expect(screen.getByRole("heading", { name: "演员甲" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "影视作品" })).toBeInTheDocument();
    expect(screen.getByText("一部电影")).toBeInTheDocument();
    expect(screen.getByText("共 21 部")).toBeInTheDocument();
    expect(screen.getByText("第 1 页 · 1–1 / 21")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /一部电影/ }));
    expect(props.onSelectWork).toHaveBeenCalledWith(profile.works[0]);

    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(props.onPageChange).toHaveBeenCalledWith(2);
  });

  it("exposes back, retry, loading and error states", async () => {
    const user = userEvent.setup();
    const props = renderView({ profile: null, error: "服务不可用" });
    expect(screen.getByRole("alert")).toHaveTextContent("服务不可用");
    await user.click(screen.getByRole("button", { name: "重试" }));
    await user.click(screen.getByRole("button", { name: "返回作品详情" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(props.onBack).toHaveBeenCalledTimes(1);

    cleanup();
    renderView({ profile: null, loading: true });
    expect(screen.getByRole("status")).toHaveTextContent("正在载入演员资料");
  });
});
