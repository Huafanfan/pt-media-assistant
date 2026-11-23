import { useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import type { TorrentAction, TorrentSummary } from "../../shared/contracts";
import {
    formatEta,
    formatRate,
    isPausedTorrent,
    torrentStateLabel,
} from "../torrent-format";
import { formatBytes } from "./ReleaseList";
import { LoadingState } from "./States";

type TaskFilter = "all" | "downloading" | "paused" | "completed";

const FILTER_LABELS: Record<TaskFilter, string> = {
    all: "全部",
    downloading: "下载中",
    paused: "已暂停",
    completed: "已完成",
};

function classify(torrent: TorrentSummary): Exclude<TaskFilter, "all"> {
    if (isPausedTorrent(torrent.state)) return "paused";
    if (torrent.progress >= 1) return "completed";
    return "downloading";
}

function TaskRow({
    torrent,
    actionPending,
    onAction,
}: {
    torrent: TorrentSummary;
    actionPending: boolean;
    onAction: (action: TorrentAction, hashes: string[]) => Promise<boolean>;
}) {
    const kind = classify(torrent);
    const paused = isPausedTorrent(torrent.state);
    const complete = torrent.progress >= 1;
    const progress = Math.max(0, Math.min(1, torrent.progress));
    const percentage = Math.round(progress * 100);
    const stateTone = /error|missingFiles/iu.test(torrent.state)
        ? "is-error"
        : `is-${kind}`;

    return (
        <tr className={`task-row is-${kind}`}>
            <th className="task-name-cell" scope="row" title={torrent.name}>
                {torrent.name}
            </th>
            <td className="task-progress-cell">
                <div className="task-progress-summary">
                    <strong>{percentage}%</strong>
                    <span>
                        {formatBytes(torrent.size * progress)} / {formatBytes(torrent.size)}
                    </span>
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
            </td>
            <td className="task-value-cell">{formatRate(torrent.downloadSpeed)}</td>
            <td className="task-value-cell">
                {complete || paused ? "—" : formatEta(torrent.eta)}
            </td>
            <td>
                <span className={`task-state ${stateTone}`}>
                    {torrentStateLabel(torrent.state)}
                </span>
            </td>
            <td className="task-action-cell">
                {complete && !paused ? (
                    <span className="task-no-action" aria-label="已完成">
                        —
                    </span>
                ) : (
                    <button
                        className="task-action-button"
                        type="button"
                        disabled={actionPending}
                        onClick={() =>
                            void onAction(paused ? "resume" : "pause", [torrent.hash])
                        }
                    >
                        {paused ? (
                            <Play size={15} aria-hidden="true" />
                        ) : (
                            <Pause size={15} aria-hidden="true" />
                        )}
                        {paused ? "继续" : "暂停"}
                    </button>
                )}
            </td>
        </tr>
    );
}

export function TaskView({
    torrents,
    loading,
    error,
    actionError,
    actionPending,
    onRefresh,
    onAction,
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

    const counts: Record<TaskFilter, number> = {
        all: torrents.length,
        downloading: 0,
        paused: 0,
        completed: 0,
    };
    for (const torrent of torrents) counts[classify(torrent)] += 1;

    const visible = (
        filter === "all"
            ? torrents
            : torrents.filter((torrent) => classify(torrent) === filter)
    )
        .slice()
        .sort(
            (left, right) =>
                Number(right.progress < 1) - Number(left.progress < 1) ||
                right.downloadSpeed - left.downloadSpeed ||
                left.name.localeCompare(right.name),
        );

    return (
        <section className="task-view" aria-labelledby="task-view-title">
            <header className="task-header">
                <div>
                    <h1 id="task-view-title">下载任务</h1>
                    <p>任务进度自动更新。</p>
                </div>
                <button
                    className="task-refresh-button"
                    type="button"
                    onClick={onRefresh}
                    disabled={loading}
                >
                    <RefreshCw
                        className={loading ? "spin" : undefined}
                        size={16}
                        aria-hidden="true"
                    />
                    刷新
                </button>
            </header>

            {actionError ? (
                <p className="task-error" role="alert">
                    {actionError}
                </p>
            ) : null}
            {error ? (
                <p className="task-error" role="alert">
                    {error}
                </p>
            ) : null}

            <div className="task-filters" role="tablist" aria-label="任务筛选">
                {(Object.keys(FILTER_LABELS) as TaskFilter[]).map((key) => (
                    <button
                        key={key}
                        className={`task-filter-button${filter === key ? " is-active" : ""}`}
                        type="button"
                        role="tab"
                        aria-label={`${FILTER_LABELS[key]} ${counts[key]}`}
                        aria-selected={filter === key}
                        onClick={() => setFilter(key)}
                    >
                        {FILTER_LABELS[key]}
                        <span className="task-filter-count">{counts[key]}</span>
                    </button>
                ))}
            </div>

            {loading && torrents.length === 0 ? (
                <LoadingState label="正在读取任务…" />
            ) : null}
            {!loading && visible.length === 0 ? (
                <p className="task-empty" role="status">
                    {torrents.length === 0
                        ? "qBittorrent 里还没有任务。"
                        : "这个筛选下没有任务。"}
                </p>
            ) : null}

            {visible.length > 0 ? (
                <div
                    className="task-table-scroll"
                    role="region"
                    aria-label="可横向滚动的下载任务表格"
                    tabIndex={0}
                >
                    <table className="task-table" aria-label="下载任务列表">
                        <thead>
                            <tr>
                                <th className="task-name-column" scope="col">名称</th>
                                <th className="task-progress-column" scope="col">进度</th>
                                <th scope="col">下载速度</th>
                                <th scope="col">剩余时间</th>
                                <th scope="col">状态</th>
                                <th className="task-action-column" scope="col">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((torrent) => (
                                <TaskRow
                                    key={torrent.hash || torrent.name}
                                    torrent={torrent}
                                    actionPending={actionPending}
                                    onAction={onAction}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}
        </section>
    );
}

export default TaskView;
