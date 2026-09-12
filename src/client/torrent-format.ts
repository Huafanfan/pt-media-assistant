import type { TorrentSummary } from "../shared/contracts";

export function torrentStateLabel(state: string): string {
  const labels: Record<string, string> = {
    downloading: "下载中",
    forcedDL: "强制下载",
    metaDL: "获取元数据",
    checkingDL: "校验中",
    stalledDL: "等待数据",
    stoppedDL: "已暂停",
    pausedDL: "已暂停",
    queuedDL: "排队中",
    uploading: "做种中",
    forcedUP: "强制做种",
    stalledUP: "等待做种",
    queuedUP: "排队做种",
    checkingUP: "做种校验中",
    pausedUP: "已暂停做种",
    stoppedUP: "已停止做种",
    checkingResumeData: "恢复数据校验",
    moving: "移动中",
    allocating: "分配空间",
    error: "错误",
    missingFiles: "文件缺失"
  };
  return labels[state] ?? state;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = bytesPerSecond;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex >= 2 ? 1 : 0)} ${units[unitIndex]}`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 8_640_000) return "未知";
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.ceil(seconds / 3_600)} 小时`;
}

export function isPausedTorrent(state: string): boolean {
  return /paused|stopped/iu.test(state);
}

/** Active means "still downloading or transferring", not merely unfinished. */
export function isActiveTorrent(torrent: TorrentSummary): boolean {
  return torrent.progress < 1 || /(?:DL|downloading|queued)/iu.test(torrent.state);
}

export function activeTorrents(torrents: TorrentSummary[]): TorrentSummary[] {
  return torrents
    .filter(isActiveTorrent)
    .sort((left, right) => right.downloadSpeed - left.downloadSpeed || left.name.localeCompare(right.name))
    .slice(0, 3);
}
