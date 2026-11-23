import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TaskView } from "../../src/client/components/TaskView";
import type { TorrentSummary } from "../../src/shared/contracts";

const base: TorrentSummary = {
  hash: "a".repeat(40),
  name: "Interstellar 2160p",
  progress: 0.4,
  state: "downloading",
  size: 20 * 1024 ** 3,
  downloadSpeed: 5 * 1024 ** 2,
  uploadSpeed: 1024,
  eta: 600,
  savePath: "/data/pt",
};
const paused: TorrentSummary = {
  ...base,
  hash: "b".repeat(40),
  name: "Old Movie 1080p",
  progress: 0.2,
  state: "pausedDL",
  downloadSpeed: 0,
  eta: 0,
};
const completed: TorrentSummary = {
  ...base,
  hash: "c".repeat(40),
  name: "Finished Show",
  progress: 1,
  state: "uploading",
  downloadSpeed: 0,
  eta: 0,
};

function renderView(overrides: Partial<Parameters<typeof TaskView>[0]> = {}) {
  const onAction = vi.fn(async () => true);
  const onRefresh = vi.fn();
  render(
    <TaskView
      torrents={[base, paused, completed]}
      loading={false}
      error={null}
      actionError={null}
      actionPending={false}
      onRefresh={onRefresh}
      onAction={onAction}
      {...overrides}
    />,
  );
  return { onAction, onRefresh };
}

describe("下载任务视图", () => {
  it("shows a compact table with progress, downloaded size, speed, ETA and state", async () => {
    const user = userEvent.setup();
    const { onRefresh } = renderView();

    expect(screen.getByRole("heading", { name: "下载任务" })).toBeInTheDocument();
    expect(screen.getByText("任务进度自动更新。")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "下载任务列表" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "可横向滚动的下载任务表格" }),
    ).toHaveAttribute("tabindex", "0");

    const row = screen.getByRole("row", { name: /Interstellar 2160p/ });
    expect(row).toHaveTextContent("40%");
    expect(row).toHaveTextContent(/8\.0 GB \/ 20\.0 GB/);
    expect(row).toHaveTextContent("5.0 MB/s");
    expect(row).toHaveTextContent("10 分钟");
    expect(row).toHaveTextContent("下载中");
    expect(
      within(row).getByRole("progressbar", {
        name: "Interstellar 2160p 下载进度",
      }),
    ).toHaveAttribute("aria-valuenow", "40");

    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("filters by status and counts tasks, treating full progress as completed", async () => {
    const user = userEvent.setup();
    renderView();

    expect(screen.getByRole("tab", { name: "全部 3" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "下载中 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "已暂停 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "已完成 1" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "已暂停 1" }));
    expect(screen.getByRole("row", { name: /Old Movie 1080p/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Interstellar 2160p/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "已完成 1" }));
    const completedRow = screen.getByRole("row", { name: /Finished Show/ });
    expect(completedRow).toBeInTheDocument();
    expect(within(completedRow).queryByRole("button")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "下载中 1" }));
    expect(screen.getByRole("row", { name: /Interstellar 2160p/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Finished Show/ })).not.toBeInTheDocument();
  });

  it("pauses and resumes tasks using the matching torrent hash", async () => {
    const user = userEvent.setup();
    const { onAction } = renderView();

    const downloadingRow = screen.getByRole("row", { name: /Interstellar 2160p/ });
    await user.click(within(downloadingRow).getByRole("button", { name: "暂停" }));
    expect(onAction).toHaveBeenCalledWith("pause", [base.hash]);

    const pausedRow = screen.getByRole("row", { name: /Old Movie 1080p/ });
    await user.click(within(pausedRow).getByRole("button", { name: "继续" }));
    expect(onAction).toHaveBeenCalledWith("resume", [paused.hash]);
    expect(screen.queryByRole("button", { name: /移除/ })).not.toBeInTheDocument();
  });

  it("keeps a 100% paused seeding task in the paused filter and resumable", async () => {
    const user = userEvent.setup();
    const pausedSeeder: TorrentSummary = {
      ...completed,
      hash: "f".repeat(40),
      name: "Paused Seeder",
      state: "pausedUP",
    };
    const { onAction } = renderView({ torrents: [pausedSeeder] });

    expect(screen.getByRole("tab", { name: "已暂停 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "已完成 0" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "已暂停 1" }));

    const row = screen.getByRole("row", { name: /Paused Seeder/ });
    expect(row).toHaveTextContent("100%");
    expect(row).toHaveTextContent("已暂停做种");
    await user.click(within(row).getByRole("button", { name: "继续" }));
    expect(onAction).toHaveBeenCalledWith("resume", [pausedSeeder.hash]);
  });

  it("disables task actions while a request is pending", () => {
    renderView({ actionPending: true });
    for (const button of screen.getAllByRole("button", { name: /暂停|继续/ })) {
      expect(button).toBeDisabled();
    }
  });

  it("shows loading, empty and refresh/action error states", () => {
    const { rerender } = render(
      <TaskView
        torrents={[]}
        loading
        error={null}
        actionError={null}
        actionPending={false}
        onRefresh={vi.fn()}
        onAction={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByText("正在读取任务…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();

    rerender(
      <TaskView
        torrents={[]}
        loading={false}
        error="无法读取任务"
        actionError="操作失败"
        actionPending={false}
        onRefresh={vi.fn()}
        onAction={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByText("qBittorrent 里还没有任务。")).toBeInTheDocument();
    expect(screen.getByText("无法读取任务")).toHaveAttribute("role", "alert");
    expect(screen.getByText("操作失败")).toHaveAttribute("role", "alert");
  });

  it("shows truthful error and waiting labels from qBittorrent", () => {
    const errored: TorrentSummary = {
      ...base,
      hash: "d".repeat(40),
      name: "Broken Archive",
      state: "error",
    };
    const waiting: TorrentSummary = {
      ...base,
      hash: "e".repeat(40),
      name: "Waiting Archive",
      state: "stalledDL",
    };
    renderView({ torrents: [errored, waiting] });

    expect(screen.getByRole("row", { name: /Broken Archive/ })).toHaveTextContent("错误");
    expect(screen.getByRole("row", { name: /Waiting Archive/ })).toHaveTextContent("等待数据");
  });

  it("explains when the selected filter has no matches", async () => {
    const user = userEvent.setup();
    renderView({ torrents: [completed] });

    await user.click(screen.getByRole("tab", { name: "已暂停 0" }));
    expect(screen.getByRole("status")).toHaveTextContent("这个筛选下没有任务。");
  });
});
