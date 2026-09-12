import { useState } from "react";
import { CircleAlert, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import type { TorrentAction, TorrentSummary } from "../../shared/contracts";
import { formatEta, formatRate, isPausedTorrent, torrentStateLabel } from "../torrent-format";
import { formatBytes } from "./ReleaseList";
import { LoadingState } from "./States";

type TaskFilter = "all" | "downloading" | "completed" | "paused";

const FILTER_LABELS: Record<TaskFilter, string> = {
  all: "全部",
  downloading: "下载中",
  completed: "已完成",
  paused: "已暂停"
};

function classify(torrent: TorrentSummary): Exclude<TaskFilter, "all"> {
  if (torrent.progress >= 1) return "completed";
  if (isPausedTorrent(torrent.state)) return "paused";
  return "downloading";
}

function TaskRow({
  torrent,
  actionPending,
  confirming,
  onAskRemove,
  onCancelRemove,
  onAction
}: {
  torrent: TorrentSummary;
  actionPending: boolean;
  confirming: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onAction: (action: TorrentAction, hashes: string[]) => Promise<boolean>;
}) {
  const kind = classify(torrent);
  const paused = isPausedTorrent(torrent.state);
  const progress = Math.max(0, Math.min(1, torrent.progress));
  const percentage = Math.round(progress * 100);

  return (
    <li className={`task-row is-${kind}`}>
      <div className="task-row-heading">
        <h3>{torrent.name}</h3>
        <span className={`task-state is-${kind}`}>{torrentStateLabel(torrent.state)}</span>
      </div>
      <div
        className="task-progress-track"
        role="progressbar"
        aria-label={`${torrent.name} 下载进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <div className="task-meta">
        <strong>{percentage}%</strong>
        <span>{formatBytes(torrent.size * progress)} / {formatBytes(torrent.size)}</span>
        {torrent.downloadSpeed > 0 ? <span>↓ {formatRate(torrent.downloadSpeed)}</span> : null}
        {torrent.uploadSpeed > 0 ? <span>↑ {formatRate(torrent.uploadSpeed)}</span> : null}
        {kind === "downloading" ? <span>剩余 {formatEta(torrent.eta)}</span> : null}
      </div>
      <div className="task-actions">
        {confirming ? (
          <>
            <span className="task-confirm-note"><CircleAlert size={15} aria-hidden="true" />仅移除任务，保留已下载文件</span>
            <button
              className="outline-button task-remove"
              type="button"
              disabled={actionPending}
              onClick={() => void onAction("remove", [torrent.hash]).then((ok) => { if (ok) onCancelRemove(); })}
            >
              {actionPending ? "正在移除…" : "确认移除"}
            </button>
            <button className="text-button" type="button" disabled={actionPending} onClick={onCancelRemove}>取消</button>
          </>
        ) : (
          <>
            <button
              className="outline-button"
              type="button"
              disabled={actionPending}
              onClick={() => void onAction(paused ? "resume" : "pause", [torrent.hash])}
            >
              {paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
              {paused ? "继续" : "暂停"}
            </button>
            <button className="outline-button task-remove" type="button" disabled={actionPending} onClick={onAskRemove}>
              <Trash2 size={15} aria-hidden="true" />移除
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export function TaskView({
  torrents,
  loading,
  error,
  actionError,
  actionPending,
  onRefresh,
  onAction
}: {
  torrents: TorrentSummary[];
  loading: boolean;
  error: string | null;
  actionError: string | null;
  actionPending: boolean;
  onRefresh: () => void;
  onAction: (action: TorrentAction, hashes: string[]) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [confirmHash, setConfirmHash] = useState<string | null>(null);

  const counts: Record<TaskFilter, number> = { all: torrents.length, downloading: 0, completed: 0, paused: 0 };
  for (const torrent of torrents) counts[classify(torrent)] += 1;

  const visible = (filter === "all" ? torrents : torrents.filter((torrent) => classify(torrent) === filter))
    .slice()
    .sort((left, right) =>
      Number(right.progress < 1) - Number(left.progress < 1)
      || right.downloadSpeed - left.downloadSpeed
      || left.name.localeCompare(right.name));

  return (
    <section className="task-view" aria-label="下载任务">
      <header className="task-view-heading">
        <div>
          <h1>下载任务</h1>
          <p>{counts.downloading > 0 ? `${counts.downloading} 个进行中 · 共 ${counts.all} 个任务` : `共 ${counts.all} 个任务`}</p>
        </div>
        <button className="icon-button small-icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label="刷新任务列表">
          <RefreshCw className={loading ? "spin" : ""} size={18} aria-hidden="true" />
        </button>
      </header>

      {actionError ? <p className="inline-error" role="alert">{actionError}</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="task-filters" role="tablist" aria-label="任务筛选">
        {(Object.keys(FILTER_LABELS) as TaskFilter[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={filter === key ? "is-active" : undefined}
            onClick={() => setFilter(key)}
          >
            {FILTER_LABELS[key]}
            <span className="task-filter-count">{counts[key]}</span>
          </button>
        ))}
      </div>

      {loading && torrents.length === 0 ? <LoadingState label="正在读取任务…" /> : null}
      {!loading && visible.length === 0 ? (
        <p className="muted-line">{torrents.length === 0 ? "qBittorrent 里还没有任务。" : "这个筛选下没有任务。"}</p>
      ) : null}

      <ul className="task-list">
        {visible.map((torrent) => (
          <TaskRow
            key={torrent.hash || torrent.name}
            torrent={torrent}
            actionPending={actionPending}
            confirming={confirmHash === torrent.hash}
            onAskRemove={() => setConfirmHash(torrent.hash)}
            onCancelRemove={() => setConfirmHash(null)}
            onAction={onAction}
          />
        ))}
      </ul>
    </section>
  );
}

export default TaskView;
