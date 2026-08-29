import { Download, HardDrive, RefreshCw } from "lucide-react";
import type { NasStorageSummary, TorrentSummary } from "../../shared/contracts";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** exponent).toFixed(exponent >= 3 ? 1 : 0)} ${units[exponent]}`;
}

export function RuntimeSummary({
  storage,
  torrents,
  loading,
  onRefresh
}: {
  storage: NasStorageSummary | null;
  torrents: TorrentSummary[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const active = torrents.filter((torrent) => torrent.progress < 1);
  return (
    <section className="runtime-mini" aria-label="运行状态摘要">
      <div>
        <HardDrive size={16} aria-hidden="true" />
        <span>NAS 剩余</span>
        <strong>{storage?.ready ? formatBytes(storage.freeBytes) : "暂不可用"}</strong>
      </div>
      <div>
        <Download size={16} aria-hidden="true" />
        <span>进行中</span>
        <strong>{active.length}</strong>
      </div>
      <button type="button" onClick={onRefresh} disabled={loading} aria-label="刷新运行状态">
        <RefreshCw className={loading ? "spin" : undefined} size={16} aria-hidden="true" />
      </button>
    </section>
  );
}
