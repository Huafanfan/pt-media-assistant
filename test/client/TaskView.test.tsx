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
  it("lists every task with its state and filters by status", async () => {
    const user = userEvent.setup();
    renderView();

    expect(screen.getByText("Interstellar 2160p")).toBeInTheDocument();
    expect(screen.getByText("Old Movie 1080p")).toBeInTheDocument();
    expect(screen.getByText("Finished Show")).toBeInTheDocument();
    expect(screen.getByText("1 个进行中 · 共 3 个任务")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /已暂停/ }));
    expect(screen.queryByText("Interstellar 2160p")).not.toBeInTheDocument();
    expect(screen.getByText("Old Movie 1080p")).toBeInTheDocument();
  });

  it("pauses a downloading task and resumes a paused one with the exact hash", async () => {
    const user = userEvent.setup();
    const { onAction } = renderView();

    const downloadingRow = screen.getByText("Interstellar 2160p").closest("li");
    expect(downloadingRow).not.toBeNull();
    await user.click(
      within(downloadingRow as HTMLElement).getByRole("button", {
        name: "暂停",
      }),
    );
    expect(onAction).toHaveBeenCalledWith("pause", [base.hash]);

    const pausedRow = screen.getByText("Old Movie 1080p").closest("li");
    await user.click(
      within(pausedRow as HTMLElement).getByRole("button", { name: "继续" }),
    );
    expect(onAction).toHaveBeenCalledWith("resume", [paused.hash]);
  });

  it("requires a second confirmation before removing a task and only removes the record", async () => {
    const user = userEvent.setup();
    const { onAction } = renderView();

    const row = screen
      .getByText("Interstellar 2160p")
      .closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "移除" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(
      within(row).getByText("仅移除任务，保留已下载文件"),
    ).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "取消" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(
      within(row).getByRole("button", { name: "移除" }),
    ).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "移除" }));
    await user.click(within(row).getByRole("button", { name: "确认移除" }));
    expect(onAction).toHaveBeenCalledWith("remove", [base.hash]);
  });

  it("disables task controls while an action is pending", () => {
    renderView({ actionPending: true });
    for (const button of screen.getAllByRole("button", {
      name: /暂停|继续|移除/,
    })) {
      expect(button).toBeDisabled();
    }
  });

  it("shows the empty state when qBittorrent has no tasks", () => {
    renderView({ torrents: [] });
    expect(screen.getByText("qBittorrent 里还没有任务。")).toBeInTheDocument();
  });

  it("lists family-shared seen records and can unmark them", async () => {
    const user = userEvent.setup();
    const onUnmarkSeen = vi.fn();
    const entry = {
      mediaId: "1293000",
      mediaType: "movie" as const,
      title: "星际穿越",
      markedAt: "2026-09-12T10:00:00.000Z",
    };
    renderView({ seenItems: [entry], onUnmarkSeen });

    expect(
      screen.getByRole("heading", { name: "已看记录" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消已看" }));
    expect(onUnmarkSeen).toHaveBeenCalledWith(entry);
  });
});
