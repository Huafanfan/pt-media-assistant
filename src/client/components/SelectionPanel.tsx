import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Download,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  X
} from "lucide-react";
import type { GrabResponse, NasStorageSummary, TorrentSummary } from "../../shared/contracts";
import { DESTINATION_PATH } from "../api";
import type { SelectionState } from "../types";
import { activeTorrents, formatEta, formatRate, torrentStateLabel } from "../torrent-format";
import { formatBytes, formatCategories } from "./ReleaseList";

function stateLabel(state: "started" | "stopped"): string {
  return state === "started" ? "已开始" : "已停止";
}

export function StorageMeter({
  storage,
  loading,
  error
}: {
  storage: NasStorageSummary | null;
  loading: boolean;
  error: string | null;
}) {
  const usedRatio = storage && storage.totalBytes > 0
    ? Math.max(0, Math.min(1, storage.usedBytes / storage.totalBytes))
    : 0;

  return (
    <section className="storage-status" aria-labelledby="storage-title">
      <div className="runtime-section-heading">
        <div>
          <h3 id="storage-title">存储空间</h3>
          <p>{storage?.ready ? "NAS 已连接" : loading ? "正在读取…" : "NAS 状态未知"}</p>
        </div>
        <HardDrive size={19} strokeWidth={1.7} aria-hidden="true" />
      </div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {storage ? (
        <>
          <div
            className="storage-track"
            role="progressbar"
            aria-label="NAS 已用空间"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usedRatio * 100)}
          >
            <span style={{ width: `${usedRatio * 100}%` }} />
          </div>
          <div className="storage-figures">
            <span>已用 {formatBytes(storage.usedBytes)}</span>
            <strong>剩余 {formatBytes(storage.freeBytes)}</strong>
          </div>
          <p className="storage-path">共 {formatBytes(storage.totalBytes)} · {storage.path || DESTINATION_PATH}</p>
        </>
      ) : null}
    </section>
  );
}

function TorrentProgressRow({ torrent }: { torrent: TorrentSummary }) {
  const progress = Math.max(0, Math.min(1, torrent.progress));
  const percentage = Math.round(progress * 100);
  return (
    <li className="torrent-row">
      <div className="torrent-title-line">
        <span className="torrent-name">{torrent.name}</span>
        <strong>{percentage}%</strong>
      </div>
      <div
        className="torrent-progress-track"
        role="progressbar"
        aria-label={`${torrent.name} 下载进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <div className="torrent-meta">
        <span>{torrentStateLabel(torrent.state)}</span>
        <span>↓ {formatRate(torrent.downloadSpeed)}</span>
        {torrent.uploadSpeed > 0 ? <span>↑ {formatRate(torrent.uploadSpeed)}</span> : null}
        <span>剩余 {formatEta(torrent.eta)}</span>
        <span>{formatBytes(torrent.size * progress)} / {formatBytes(torrent.size)}</span>
      </div>
    </li>
  );
}

export function TorrentList({
  torrents,
  loading,
  error,
  onRefresh
}: {
  torrents: TorrentSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const active = activeTorrents(torrents);
  return (
    <section className="torrent-status" aria-labelledby="torrent-status-title">
      <div className="runtime-section-heading">
        <div>
          <h3 id="torrent-status-title">下载活动</h3>
          <p>{active.length > 0 ? `${active.length} 个进行中任务` : "每 15 秒自动刷新"}</p>
        </div>
        <button className="icon-button small-icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label="刷新下载状态">
          <RefreshCw className={loading ? "spin" : ""} size={17} aria-hidden="true" />
        </button>
      </div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {loading && active.length === 0 ? <p className="muted-line">正在读取任务状态…</p> : null}
      {!loading && !error && active.length === 0 ? <p className="muted-line">暂无进行中的下载。</p> : null}
      {active.length > 0 ? (
        <ul className="torrent-list">
          {active.map((torrent) => <TorrentProgressRow torrent={torrent} key={torrent.hash} />)}
        </ul>
      ) : null}
    </section>
  );
}

export function SelectionPanel({
  selection,
  previewError,
  expanded,
  confirmLoading,
  grabResult,
  storage,
  storageLoading,
  storageError,
  torrents,
  torrentsLoading,
  torrentsError,
  onToggle,
  onCancel,
  onConfirm,
  onRefreshRuntime
}: {
  selection: SelectionState | null;
  previewError?: string | null;
  expanded: boolean;
  confirmLoading: boolean;
  grabResult: GrabResponse | null;
  storage: NasStorageSummary | null;
  storageLoading: boolean;
  storageError: string | null;
  torrents: TorrentSummary[];
  torrentsLoading: boolean;
  torrentsError: string | null;
  onToggle: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRefreshRuntime: () => void;
}) {
  const preview = selection?.preview ?? null;
  const release = preview?.release ?? selection?.release ?? null;
  const indexLabel = selection ? String(selection.index).padStart(2, "0") : "";
  const activeCount = activeTorrents(torrents).length;
  const canConfirm = Boolean(preview?.nasMounted && !preview.duplicate && !confirmLoading && !grabResult?.accepted);
  const collapsedSummary = release?.title
    ?? `${activeCount} 个下载 · ${storage ? `NAS 剩余 ${formatBytes(storage.freeBytes)}` : "正在读取 NAS"}`;

  return (
    <aside className={`selection-inspector ${expanded ? "is-expanded" : "is-collapsed"}`} aria-labelledby="inspector-title" aria-live="polite">
      <div className="inspector-drag-handle" aria-hidden="true" />
      <header className="inspector-heading">
        <div className="inspector-heading-copy">
          <h2 id="inspector-title">{selection ? `已选择 · ${indexLabel}` : "运行状态"}</h2>
          <p title={collapsedSummary}>{collapsedSummary}</p>
        </div>
        <div className="inspector-heading-actions">
          <button className="icon-button inspector-toggle" type="button" onClick={onToggle} aria-expanded={expanded} aria-label={expanded ? "收起检查器" : "展开检查器"}>
            {expanded ? <ChevronDown size={21} aria-hidden="true" /> : <ChevronUp size={21} aria-hidden="true" />}
          </button>
          {selection ? (
            <button className="icon-button inspector-close" type="button" onClick={onCancel} disabled={confirmLoading} aria-label="关闭已选择片源">
              <X size={21} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="inspector-scroll">
        {selection ? (
          <section className="selection-body" aria-label="已选择片源详情">
            {release ? <p className="selection-release-title">{release.title}</p> : null}
            {!preview && !previewError ? <p className="muted-line selection-loading">正在检查片源与 NAS…</p> : null}
            {previewError ? <p className="inline-error" role="alert">{previewError}</p> : null}
            {preview ? (
              <>
                <dl className="selection-details">
                  <div><dt>大小</dt><dd>{formatBytes(preview.release.size)}</dd></div>
                  <div><dt>做种</dt><dd>{preview.release.seeders}</dd></div>
                  <div><dt>类别</dt><dd>{formatCategories(preview.release.categories)}</dd></div>
                  <div><dt>下载到</dt><dd className="mono-value">{DESTINATION_PATH}</dd></div>
                </dl>

                <div className="selection-flags">
                  <span className={preview.nasMounted ? "flag-ok" : "flag-error"}>
                    <span className="status-dot" aria-hidden="true" />
                    {preview.nasMounted ? "NAS 已连接" : "NAS 未连接"}
                  </span>
                  {preview.duplicate ? (
                    <span className="flag-warning"><CircleAlert size={15} aria-hidden="true" />已有相同任务</span>
                  ) : null}
                </div>

                <div className="selection-actions">
                  <button className="outline-button cancel-button" type="button" onClick={onCancel} disabled={confirmLoading}>取消</button>
                  <button className="primary-button grab-button" type="button" onClick={onConfirm} disabled={!canConfirm}>
                    <Download size={19} strokeWidth={1.9} aria-hidden="true" />
                    {grabResult?.accepted ? "已加入下载" : confirmLoading ? "正在加入…" : "加入下载"}
                  </button>
                </div>

                <p className="selection-note">
                  <ShieldCheck size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span>确认前会再次校验片源、重复任务和 NAS。</span>
                </p>
              </>
            ) : null}

            {grabResult ? (
              <div className={`grab-result ${grabResult.accepted ? "is-accepted" : "is-rejected"}`} role="status">
                <CheckCircle2 size={17} aria-hidden="true" />
                <strong>{grabResult.accepted ? "已接受" : "未加入"}</strong>
                <span>{grabResult.message}</span>
                <span>当前状态：{stateLabel(grabResult.initialState)}</span>
              </div>
            ) : null}
          </section>
        ) : (
          <p className="inspector-empty">选择一个片源后，确认信息会固定显示在这里。</p>
        )}

        <StorageMeter storage={storage} loading={storageLoading} error={storageError} />
        <TorrentList torrents={torrents} loading={torrentsLoading} error={torrentsError} onRefresh={onRefreshRuntime} />
      </div>
    </aside>
  );
}
