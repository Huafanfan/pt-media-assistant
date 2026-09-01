import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/client/api";
import { ApiError } from "../../src/client/api";
import { App } from "../../src/client/App";
import { formatCategories } from "../../src/client/components/ReleaseList";

const release = {
  id: "release-1",
  title: "Interstellar.2014.2160p.BluRay.x265.10bit.AAC5.1-TJUPT",
  indexer: "TJUPT",
  protocol: "torrent" as const,
  size: 19.8 * 1024 ** 3,
  seeders: 78,
  leechers: 3,
  grabs: 12,
  ageDays: 4,
  categories: ["科幻", "冒险"],
  resolution: "4K",
  codec: "HEVC",
  freeleech: false
};

const discoveryItem = {
  id: "36808876",
  title: "奥德赛",
  originalTitle: "The Odyssey",
  year: "2026",
  rating: 8.5,
  ratingCount: 12345,
  rank: 1,
  mediaType: "movie" as const,
  genres: ["动作", "冒险"],
  summary: "英雄在漫长归途中面对神明与命运。",
  sourceUrl: "https://movie.douban.com/subject/36808876/"
};

function makeClient({ paired = true, grab = vi.fn().mockResolvedValue({ accepted: true, message: "已发送", initialState: "started" as const }) } = {}) {
  const client: ApiClient = {
    getSession: vi.fn().mockResolvedValue({ paired, csrfToken: paired ? "csrf-test" : undefined }),
    getHealth: vi.fn().mockResolvedValue({
      status: "ok",
      version: "test",
      pairingRequired: !paired,
      services: { prowlarr: true, qbittorrent: true, nasMounted: true }
    }),
    pair: vi.fn().mockResolvedValue({ paired: true, csrfToken: "csrf-test" }),
    search: vi.fn().mockResolvedValue({
      query: "星际穿越",
      intent: { searchTerm: "星际穿越" },
      total: 1,
      elapsedMs: 42,
      releases: [release]
    }),
    getDiscoveryCollection: vi.fn().mockResolvedValue({
      collection: "movie-hot" as const,
      updatedAt: "2026-08-29T00:00:00.000Z",
      stale: false,
      items: [discoveryItem]
    }),
    getDiscoveryReleases: vi.fn().mockResolvedValue({
      itemId: discoveryItem.id,
      query: "The Odyssey 2026",
      status: "available" as const,
      checkedAt: "2026-08-29T00:00:01.000Z",
      total: 1,
      releases: [release]
    }),
    refreshDiscoveryReleases: vi.fn().mockResolvedValue({
      itemId: discoveryItem.id,
      query: "The Odyssey 2026",
      status: "available" as const,
      checkedAt: "2026-08-29T00:00:02.000Z",
      total: 1,
      releases: [release]
    }),
    grabPreview: vi.fn().mockResolvedValue({
      release,
      destination: "/Volumes/YourNAS/pt",
      nasMounted: true,
      duplicate: false,
      initialState: "started"
    }),
    grab,
    getTorrents: vi.fn().mockResolvedValue([]),
    getStorage: vi.fn().mockResolvedValue({
      path: "/Volumes/YourNAS/pt",
      mounted: true,
      ready: true,
      totalBytes: 5.4 * 1024 ** 4,
      usedBytes: 4 * 1024 ** 4,
      freeBytes: 1.4 * 1024 ** 4
    })
  };
  return client;
}

async function searchOnce(client: ApiClient) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "搜索" }));
  const input = await screen.findByPlaceholderText("输入片名、年份或豆瓣链接");
  await user.type(input, "星际穿越");
  await user.click(screen.getByRole("button", { name: "发送搜索" }));
  await screen.findByText("Interstellar.2014.2160p.BluRay.x265.10bit.AAC5.1-TJUPT");
  return user;
}

describe("片源助手客户端", () => {
  it("compresses nested Prowlarr categories for narrow screens", () => {
    expect(formatCategories(["Movies", "Movies/Foreign", "Movies/Other", "Movies/UHD", "Movies/BluRay", "Movies/3D"]))
      .toBe("Foreign / UHD / BluRay / 3D");
  });

  it("shows the focused six-digit pairing gate and pairs the device", async () => {
    const client = makeClient({ paired: false });
    render(<App client={client} />);

    const codeInput = await screen.findByLabelText("六位配对码");
    expect(document.activeElement).toBe(codeInput);
    const user = userEvent.setup();
    await user.type(codeInput, "12a3456");
    expect((codeInput as HTMLInputElement).value).toBe("123456");
    await user.click(screen.getByRole("button", { name: "配对设备" }));

    await user.click(await screen.findByRole("tab", { name: "搜索" }));
    await screen.findByPlaceholderText("输入片名、年份或豆瓣链接");
    expect(client.pair).toHaveBeenCalledWith({ code: "123456" });
  });

  it("opens with a discovery list and reuses the existing release preview flow", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    expect(await screen.findByText("奥德赛")).not.toBeNull();
    expect(await screen.findByText("有资源 1")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /奥德赛，第 1 名/ }));
    expect(await screen.findByText(release.title)).not.toBeNull();
    await user.click(screen.getByRole("radio", { name: /Interstellar\.2014/ }));

    expect(await screen.findByText("已选择 · 01")).not.toBeNull();
    expect(client.grabPreview).toHaveBeenCalledWith("release-1", "csrf-test");
    expect(client.grab).not.toHaveBeenCalled();
  });

  it("uses the forced refresh API for discovery inspector retries", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /奥德赛，第 1 名/ }));
    await screen.findByText(release.title);
    await user.click(screen.getByRole("button", { name: "重新检查片源" }));

    await waitFor(() => expect(client.refreshDiscoveryReleases).toHaveBeenCalledWith(
      "movie-hot",
      discoveryItem.id,
      "csrf-test"
    ));
    expect(client.getDiscoveryReleases).toHaveBeenCalledWith("movie-hot", discoveryItem.id, "csrf-test");
  });

  it("renders a user query, deterministic assistant message, and release row", async () => {
    const client = makeClient();
    render(<App client={client} />);

    await searchOnce(client);

    expect(screen.getByText("星际穿越")).not.toBeNull();
    expect(screen.getByText("找到 1 个匹配，已按做种数和体积排序。")).not.toBeNull();
    expect(screen.getByRole("button", { name: "选择" })).not.toBeNull();
    expect(client.search).toHaveBeenCalledWith({ query: "星际穿越", limit: 20 }, "csrf-test");
  });

  it("previews on selection and only sends confirm:true after explicit grab", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = await searchOnce(client);

    await user.click(screen.getByRole("button", { name: "选择" }));
    await screen.findByText("已选择 · 01");
    expect(client.grabPreview).toHaveBeenCalledWith("release-1", "csrf-test");
    expect(client.grab).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "加入下载" }));
    await waitFor(() => expect(client.grab).toHaveBeenCalledWith({ releaseId: "release-1", confirm: true }, "csrf-test"));
    expect(await screen.findByText("当前状态：已开始")).not.toBeNull();
    expect(client.getTorrents).toHaveBeenCalledWith("csrf-test");
  });

  it("keeps the selected release visible when a grab is disabled", async () => {
    const grab = vi.fn().mockRejectedValue(new ApiError("下载功能当前关闭。", 403, "GRAB_DISABLED"));
    const client = makeClient({ grab });
    render(<App client={client} />);
    const user = await searchOnce(client);

    await user.click(screen.getByRole("button", { name: "选择" }));
    await screen.findByText("已选择 · 01");
    await user.click(screen.getByRole("button", { name: "加入下载" }));

    expect(await screen.findByText("下载操作当前关闭，已保留所选片源。")).not.toBeNull();
    expect(screen.getByText("已选择 · 01")).not.toBeNull();
    expect(screen.getByText("/Volumes/YourNAS/pt")).not.toBeNull();
  });

  it("prevents confirmation when qBittorrent already has the release", async () => {
    const client = makeClient();
    vi.mocked(client.grabPreview).mockResolvedValue({
      release,
      destination: "/Volumes/YourNAS/pt",
      nasMounted: true,
      duplicate: true,
      initialState: "stopped"
    });
    render(<App client={client} />);
    const user = await searchOnce(client);

    await user.click(screen.getByRole("button", { name: "选择" }));
    expect(await screen.findByText("已有相同任务")).not.toBeNull();
    expect(screen.getByRole("button", { name: "加入下载" })).toBeDisabled();
    expect(client.grab).not.toHaveBeenCalled();
  });

  it("shows header health and runtime rows and refreshes runtime status", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    expect(await screen.findByText("TJUPT · qBittorrent · NAS 已连接")).not.toBeNull();
    expect(await screen.findByText(/1\.4 TB/)).not.toBeNull();
    expect(screen.getByText(/NAS 剩余/)).not.toBeNull();
    expect(screen.getByText(/下载中/)).not.toBeNull();

    vi.mocked(client.getStorage).mockClear();
    vi.mocked(client.getTorrents).mockClear();

    await user.click(screen.getByRole("button", { name: "刷新状态" }));
    await waitFor(() => {
      expect(client.getStorage).toHaveBeenCalledWith("csrf-test");
      expect(client.getTorrents).toHaveBeenCalledWith("csrf-test");
    });
  });

  it("refreshes status without replacing the current workspace", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    expect(await screen.findByRole("tab", { name: "热门电影" })).not.toBeNull();

    vi.mocked(client.getSession).mockImplementation(() => new Promise(() => undefined));
    await user.click(screen.getByRole("button", { name: "刷新状态" }));

    expect(screen.getByRole("tab", { name: "热门电影" })).not.toBeNull();
  });

  it("shows compact runtime status without opening the detail panel", async () => {
    const client = makeClient();
    vi.mocked(client.getTorrents).mockResolvedValue([{
      hash: "torrent-hash",
      name: "Interstellar 2014 2160p",
      progress: 0.72,
      state: "downloading",
      size: 20 * 1024 ** 3,
      downloadSpeed: 12.4 * 1024 ** 2,
      uploadSpeed: 0,
      eta: 18 * 60,
      savePath: "/Volumes/YourNAS/pt"
    }]);
    render(<App client={client} />);

    expect(await screen.findByText("NAS 剩余 1.4 TB")).not.toBeNull();
    expect(await screen.findByText("下载中 1")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "下载活动" })).not.toBeInTheDocument();
  });
});
