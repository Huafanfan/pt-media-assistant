import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/client/api";
import { ApiError } from "../../src/client/api";
import { App } from "../../src/client/App";
import { formatCategories } from "../../src/client/components/ReleaseList";
import { defaultAssistantPreferences, type AssistantTurnResponse } from "../../src/shared/assistant";

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
  posterUrl: "/api/discovery/collections/movie-hot/items/36808876/poster?page=1&limit=10",
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

const searchMediaItem = {
  id: "1293000",
  title: "星际穿越",
  posterUrl: "/api/discovery/media/movie/1293000/poster",
  originalTitle: "Interstellar",
  year: "2014",
  rating: 8.6,
  mediaType: "movie" as const,
  genres: ["科幻"],
  summary: "一支探险队穿越虫洞寻找新家园。",
  sourceUrl: "https://movie.douban.com/subject/1293000/"
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
    searchDiscoveryMedia: vi.fn().mockResolvedValue({ query: "", total: 1, items: [searchMediaItem] }),
    getDiscoveryCollection: vi.fn().mockResolvedValue({
      collection: "movie-hot" as const,
      updatedAt: "2026-08-29T00:00:00.000Z",
      stale: false,
      page: 1,
      pageSize: 10,
      total: 1,
      hasNext: false,
      items: [discoveryItem]
    }),
    getDiscoveryDetails: vi.fn().mockResolvedValue({
      itemId: discoveryItem.id,
      actors: [{ name: "演员甲" }, { name: "演员乙" }],
      directors: ["导演甲"]
    }),
    getDiscoveryMediaDetails: vi.fn().mockResolvedValue({
      itemId: discoveryItem.id,
      actors: [{ name: "演员甲" }, { name: "演员乙" }],
      directors: ["导演甲"]
    }),
    getDiscoveryActor: vi.fn().mockResolvedValue({
      id: "actor-1",
      name: "演员甲",
      latinName: "Actor A",
      intro: "演员 / 导演",
      works: [],
      page: 1,
      pageSize: 10,
      total: 0,
      hasNext: false
    }),
    getDiscoveryReleases: vi.fn().mockResolvedValue({
      itemId: discoveryItem.id,
      query: "The Odyssey 2026",
      status: "available" as const,
      checkedAt: "2026-08-29T00:00:01.000Z",
      total: 1,
      releases: [release]
    }),
    getDiscoveryMediaReleases: vi.fn().mockResolvedValue({
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
    refreshDiscoveryMediaReleases: vi.fn().mockResolvedValue({
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
    torrentAction: vi.fn().mockResolvedValue({ ok: true }),
    getHistory: vi.fn().mockResolvedValue({ seen: [], preferences: defaultAssistantPreferences() }),
    markSeen: vi.fn().mockResolvedValue(undefined),
    unmarkSeen: vi.fn().mockResolvedValue(undefined),
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

async function searchOnce() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "搜索" }));
  const input = await screen.findByPlaceholderText("输入电影或剧集名称");
  await user.type(input, "星际穿越");
  await user.click(screen.getByRole("button", { name: "发送搜索" }));
  await screen.findByRole("button", { name: "星际穿越，2014，电影" });
  return user;
}

describe("片源助手客户端", () => {
  it.each([false, true])('updates an open recommendation inspector without replacing an explicit refresh (%s)', async (manualRefresh) => {
    const client = makeClient();
    let emit!: (value: AssistantTurnResponse) => void;
    let finish!: (value: AssistantTurnResponse) => void;
    let initial!: AssistantTurnResponse;
    client.createAssistantTurnStream = vi.fn(async (request, _csrf, onSnapshot) => {
      emit = onSnapshot;
      initial = { conversationId: '11111111-1111-4111-8111-111111111111', turnId: '22222222-2222-4222-8222-222222222222', clientTurnId: request.clientTurnId,
        text: '推荐这1部。', preferences: defaultAssistantPreferences(), warnings: [], phase: 'checking', recommendations: [{
          cardId: 'card_live_12345678', mediaId: searchMediaItem.id, mediaType: 'movie', title: searchMediaItem.title, year: searchMediaItem.year, genres: [],
          summary: searchMediaItem.summary, reason: '适合科幻观影。', evidenceIds: [], constraintResults: [], availability: 'unchecked', rankedReleases: [], identityStatus: 'verified',
        }] };
      onSnapshot(initial);
      return new Promise<AssistantTurnResponse>(resolve => { finish = resolve; });
    });
    render(<App client={client} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'AI 推荐' }));
    await user.type(screen.getByLabelText('描述想看的类型和要求'), '科幻电影');
    await user.click(screen.getByRole('button', { name: '发送搜索' }));
    await user.click(await screen.findByRole('button', { name: '查看详情' }));
    await screen.findByText('这部作品尚未检查片源，请显式刷新后查看候选。');
    if (manualRefresh) {
      vi.mocked(client.refreshDiscoveryMediaReleases).mockResolvedValue({ itemId: searchMediaItem.id, query: 'manual', status: 'available', checkedAt: new Date().toISOString(), snapshotId: 'manual_snapshot_1234', total: 1, releases: [{ ...release, title: '手动刷新版本' }] });
      await user.click(screen.getByRole('button', { name: '重新检查片源' }));
      await screen.findByText('手动刷新版本');
    }
    const complete: AssistantTurnResponse = { ...initial, phase: 'complete', recommendations: [{ ...initial.recommendations[0]!, availability: 'available', checkedAt: new Date().toISOString(), snapshotId: 'stream_snapshot_1234',
      rankedReleases: [{ ...release, resolution: '2160p', title: '后台查到的版本', rank: 1, reasonCodes: [], matchStatus: 'confirmed' }] }] };
    await act(async () => { emit(complete); finish(complete); });
    const candidates = await screen.findByRole('radiogroup', { name: '候选片源列表' });
    expect(within(candidates).getByText(manualRefresh ? '手动刷新版本' : '后台查到的版本')).toBeInTheDocument();
    expect(client.grab).not.toHaveBeenCalled();
  });
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
    await screen.findByPlaceholderText("输入电影或剧集名称");
    expect(client.pair).toHaveBeenCalledWith({ code: "123456" });
  });

  it("opens with a discovery list and reuses the existing release preview flow", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    expect(await screen.findByText("奥德赛")).not.toBeNull();
    expect(await screen.findByText("有资源 1")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: /奥德赛，第 1 名/ }));
    expect(await screen.findByRole("button", { name: "演员甲" })).not.toBeNull();
    expect(await screen.findByRole("button", { name: "演员乙" })).not.toBeNull();
    expect(await screen.findByText(release.title)).not.toBeNull();
    await user.click(screen.getByRole("radio", { name: /Interstellar\.2014/ }));

    expect(await screen.findByText("已选择 · 01")).not.toBeNull();
    expect(client.grabPreview).toHaveBeenCalledWith("release-1", "csrf-test");
    expect(client.grab).not.toHaveBeenCalled();
  });

  it("opens the actor index and returns to the selected work", async () => {
    const client = makeClient();
    vi.mocked(client.getDiscoveryActor).mockResolvedValue({
      id: "actor-1",
      name: "演员甲",
      latinName: "Actor A",
      intro: "演员 / 导演",
      works: [{
        id: "work-1",
        title: "演员甲的电影",
        year: "2025",
        rating: 8.8,
        mediaType: "movie",
        genres: ["剧情"],
        summary: "一段故事。",
        sourceUrl: "https://movie.douban.com/subject/work-1/"
      }],
      page: 1,
      pageSize: 10,
      total: 1,
      hasNext: false
    });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /奥德赛，第 1 名/ }));
    await user.click(await screen.findByRole("button", { name: "演员甲" }));

    expect(await screen.findByRole("heading", { name: "演员甲" })).toBeInTheDocument();
    expect(await screen.findByText("演员甲的电影")).toBeInTheDocument();
    expect(client.getDiscoveryActor).toHaveBeenCalledWith("演员甲", "csrf-test", 1, 10);

    await user.click(screen.getByRole("button", { name: "返回作品详情" }));
    expect(await screen.findByRole("heading", { name: "奥德赛", level: 2 })).toBeInTheDocument();
  });

  it("uses the forced refresh API for discovery inspector retries", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /奥德赛，第 1 名/ }));
    await screen.findByText(release.title);
    await user.click(screen.getByRole("button", { name: "重新检查片源" }));

    await waitFor(() => expect(client.refreshDiscoveryMediaReleases).toHaveBeenCalledWith(
      "movie",
      discoveryItem.id,
      "csrf-test",
      10
    ));
    expect(client.getDiscoveryMediaReleases).toHaveBeenCalledWith("movie", discoveryItem.id, "csrf-test", 10);
  });

  it("renders a user query and works only, leaving releases to the selected work", async () => {
    const client = makeClient();
    render(<App client={client} />);

    await searchOnce();

    expect(screen.getByRole("button", { name: "星际穿越，2014，电影" })).not.toBeNull();
    expect(screen.getByText("找到 1 部作品，选择作品查看详情和片源。")).not.toBeNull();
    expect(screen.getByRole("button", { name: "星际穿越，2014，电影" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "选择" })).not.toBeInTheDocument();
    expect(client.searchDiscoveryMedia).toHaveBeenCalledWith("星际穿越", "csrf-test", 10);
    expect(client.search).not.toHaveBeenCalled();
  });

  it("runs an explicit release-only fallback without changing the media-first default", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "搜索" }));
    await user.click(screen.getByRole("tab", { name: "片源直搜" }));
    const input = screen.getByPlaceholderText("输入片名、1080p、10GB 以内等条件");
    await user.type(input, "星际穿越 1080p 10GB 以内");
    await user.click(screen.getByRole("button", { name: "发送搜索" }));

    expect(await screen.findByText(release.title)).toBeInTheDocument();
    expect(client.search).toHaveBeenCalledWith({ query: "星际穿越 1080p 10GB 以内", limit: 20 }, "csrf-test");
    expect(client.searchDiscoveryMedia).not.toHaveBeenCalled();
    expect(screen.getByText(/关键词 星际穿越/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "选择" }));
    expect(await screen.findByText("已选择 · 01")).toBeInTheDocument();
    expect(client.grabPreview).toHaveBeenCalledWith("release-1", "csrf-test");
    expect(client.grab).not.toHaveBeenCalled();
  });

  it("opens title suggestions in the same media inspector as discovery entries", async () => {
    const client = makeClient();
    const media = searchMediaItem;
    vi.mocked(client.searchDiscoveryMedia).mockResolvedValue({ query: "星际穿越", total: 1, items: [media] });
    vi.mocked(client.getDiscoveryMediaDetails).mockResolvedValue({
      itemId: media.id,
      actors: [{ name: "演员甲" }],
      directors: ["导演甲"]
    });
    vi.mocked(client.getDiscoveryMediaReleases).mockResolvedValue({
      itemId: media.id,
      query: "Interstellar 2014",
      status: "available",
      checkedAt: "2026-08-29T00:00:01.000Z",
      total: 1,
      releases: [release]
    });
    render(<App client={client} />);
    const user = await searchOnce();

    await user.click(await screen.findByRole("button", { name: "星际穿越，2014，电影" }));

    expect(await screen.findByRole("heading", { name: "星际穿越", level: 2 })).toBeInTheDocument();
    expect(await screen.findByText(release.title)).toBeInTheDocument();
    await waitFor(() => {
      expect(client.getDiscoveryMediaDetails).toHaveBeenCalledWith("movie", media.id, "csrf-test");
      expect(client.getDiscoveryMediaReleases).toHaveBeenCalledWith("movie", media.id, "csrf-test", 10);
    });
  });

  it("keeps actor details in the current search inspector and clears them only when changing mode", async () => {
    const client = makeClient();
    vi.mocked(client.getDiscoveryMediaDetails).mockResolvedValue({
      itemId: searchMediaItem.id,
      actors: [{ name: "演员甲" }],
      directors: ["导演甲"]
    });
    vi.mocked(client.getDiscoveryActor).mockResolvedValue({
      id: "actor-1",
      name: "演员甲",
      latinName: "Actor A",
      intro: "演员 / 导演",
      works: [],
      page: 1,
      pageSize: 10,
      total: 0,
      hasNext: false
    });
    render(<App client={client} />);
    const user = await searchOnce();

    await user.click(screen.getByRole("button", { name: "星际穿越，2014，电影" }));
    await user.click(await screen.findByRole("button", { name: "演员甲" }));

    expect(await screen.findByRole("heading", { name: "演员甲" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "影视作品" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "搜索" })).toHaveAttribute("aria-selected", "true");
    expect(client.getDiscoveryActor).toHaveBeenCalledWith("演员甲", "csrf-test", 1, 10);

    await user.click(screen.getByRole("tab", { name: "发现" }));
    expect(await screen.findByRole("tab", { name: "热门电影" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "演员甲" })).not.toBeInTheDocument();
  });

  it("previews on selection and only sends confirm:true after explicit grab", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = await searchOnce();

    await user.click(screen.getByRole("button", { name: "星际穿越，2014，电影" }));
    await screen.findByText(release.title);
    await user.click(screen.getByRole("radio", { name: /Interstellar\.2014/ }));
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
    const user = await searchOnce();

    await user.click(screen.getByRole("button", { name: "星际穿越，2014，电影" }));
    await screen.findByText(release.title);
    await user.click(screen.getByRole("radio", { name: /Interstellar\.2014/ }));
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
    const user = await searchOnce();

    await user.click(screen.getByRole("button", { name: "星际穿越，2014，电影" }));
    await screen.findByText(release.title);
    await user.click(screen.getByRole("radio", { name: /Interstellar\.2014/ }));
    expect(await screen.findByText("已有相同任务")).not.toBeNull();
    expect(screen.getByRole("button", { name: "加入下载" })).toBeDisabled();
    expect(client.grab).not.toHaveBeenCalled();
  });

  it("marks a work as seen and unmarks it from the shared history", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /奥德赛，第 1 名/ }));
    await user.click(await screen.findByRole("button", { name: "标记已看" }));
    await waitFor(() => expect(client.markSeen).toHaveBeenCalledWith(
      { mediaId: discoveryItem.id, mediaType: "movie", title: discoveryItem.title },
      "csrf-test"
    ));
    expect(await screen.findByRole("button", { name: "取消已看" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消已看" }));
    await waitFor(() => expect(client.unmarkSeen).toHaveBeenCalledWith("movie", discoveryItem.id, "csrf-test"));
    expect(await screen.findByRole("button", { name: "标记已看" })).toBeInTheDocument();
  });

  it("opens a read-only service status dialog that separates configured from enabled", async () => {
    const client = makeClient();
    vi.mocked(client.getHealth).mockResolvedValue({
      status: "ok",
      version: "test",
      pairingRequired: false,
      services: { prowlarr: true, qbittorrent: true, nasMounted: true },
      capabilities: {
        ai: { enabled: true, configured: true, model: "deepseek-flash" },
        webSearch: { enabled: false, configured: true },
        grab: { enabled: false },
        persistence: { enabled: true }
      }
    });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "服务状态" }));
    const dialog = await screen.findByRole("dialog", { name: "服务与能力状态" });
    expect(within(dialog).getByText("deepseek-flash")).toBeInTheDocument();
    expect(within(dialog).getByText("AI 推荐").closest("li")).toHaveTextContent("已启用");
    expect(within(dialog).getByText("联网搜索").closest("li")).toHaveTextContent("已配置 · 未启用");
    expect(within(dialog).getByText("下载开关").closest("li")).toHaveTextContent("已关闭");
    expect(within(dialog).getByText("已看与偏好持久化").closest("li")).toHaveTextContent("已启用");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps focus inside the status dialog and returns it to the trigger", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    const trigger = await screen.findByRole("button", { name: "服务状态" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "服务与能力状态" });
    const close = within(dialog).getByRole("button", { name: "关闭状态窗口" });
    expect(document.activeElement).toBe(close);

    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens the task view and pauses a task through the protected action route", async () => {
    const client = makeClient();
    const torrentHash = "a".repeat(40);
    vi.mocked(client.getTorrents).mockResolvedValue([{
      hash: torrentHash,
      name: "Interstellar 2014 2160p",
      progress: 0.42,
      state: "downloading",
      size: 20 * 1024 ** 3,
      downloadSpeed: 5 * 1024 ** 2,
      uploadSpeed: 0,
      eta: 600,
      savePath: "/Volumes/YourNAS/pt"
    }]);
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("tab", { name: "任务" }));
    expect(await screen.findByText("Interstellar 2014 2160p")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(client.torrentAction).toHaveBeenCalledWith({ action: "pause", hashes: [torrentHash] }, "csrf-test"));
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
