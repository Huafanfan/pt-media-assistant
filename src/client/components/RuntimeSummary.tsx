import type { NasStorageSummary, TorrentSummary } from "../../shared/contracts";

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** exponent).toFixed(exponent >= 3 ? 1 : 0)} ${units[exponent]}`;
}

type RuntimeStatusBarProps = {
  storage: NasStorageSummary | null;
  storageLoading: boolean;
  torrents: TorrentSummary[];
};

export function RuntimeStatusBar({
  storage,
  storageLoading,
  torrents
}: RuntimeStatusBarProps) {
  const active = torrents.filter((torrent) => torrent.progress < 1);
  const storageText = storage?.ready
    ? `NAS 剩余 ${formatBytes(storage.freeBytes)}`
    : storageLoading
      ? "NAS 状态检查中"
      : "NAS 剩余不可用";

  return (
    <p className={`runtime-status ${storage?.ready ? "is-healthy" : "is-degraded"}`} aria-label="运行状态">
      <span className="status-dot" aria-hidden="true" />
      <span>{storageText}</span>
      <span className="runtime-status-separator" aria-hidden="true">·</span>
      <span>下载中 {active.length}</span>
    </p>
  );
}
