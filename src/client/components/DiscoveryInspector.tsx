import { Circle, CircleDashed, CircleDot, RefreshCw, Star, X } from "lucide-react";
import type { DiscoveryItem, DiscoveryReleaseResponse, ReleaseSummary } from "../../shared/contracts";
import { formatBytes } from "./ReleaseList";
import "../discovery.css";

export type DiscoveryInspectorProps = {
  item: DiscoveryItem | null;
  releaseResponse: DiscoveryReleaseResponse | null;
  loading: boolean;
  error: string | null;
  selectedReleaseId: string | null;
  selectingId: string | null;
  onSelectRelease: (release: ReleaseSummary) => void;
  onClose: () => void;
  onRetry: () => void;
};

function formatRating(rating: number | undefined): string {
  return typeof rating === "number" && Number.isFinite(rating) ? rating.toFixed(1) : "—";
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(Math.max(0, value)) : "—";
}

function releaseAccessibilityName(release: ReleaseSummary, selected: boolean): string {
  const details = [
    release.title,
    release.resolution || "规格未知",
    formatBytes(release.size),
    `做种 ${formatCount(release.seeders)}`,
    release.freeleech ? "免费" : null,
    selected ? "已选择" : "未选择"
  ].filter((value): value is string => Boolean(value));
  return details.join("，");
}

function statusSummary(response: DiscoveryReleaseResponse): string {
  if (response.status === "available") return `有资源 ${response.total}`;
  if (response.status === "possible") return `可能匹配 ${response.total}`;
  return "暂未找到";
}

export function DiscoveryInspector({
  item,
  releaseResponse,
  loading,
  error,
  selectedReleaseId,
  selectingId,
  onSelectRelease,
  onClose,
  onRetry
}: DiscoveryInspectorProps) {
  const itemHeading = item?.title ?? "候选片源";
  const hasResponse = Boolean(releaseResponse && !error);
  const releases = releaseResponse?.releases ?? [];

  return (
    <aside className={`discovery-inspector${item ? "" : " is-empty"}`} aria-labelledby="discovery-inspector-title">
      <div className="discovery-inspector-drag-handle" aria-hidden="true" />
      <header className="discovery-inspector-heading">
        <div className="discovery-inspector-heading-copy">
          <h2 id="discovery-inspector-title">{itemHeading}</h2>
          {item ? (
            <p className="discovery-inspector-item-meta">
              {item.originalTitle || "原名未知"}
              {item.year ? <span>{item.year}</span> : null}
            </p>
          ) : null}
        </div>
        {item ? (
          <button className="discovery-icon-button" type="button" onClick={onClose} aria-label="关闭候选片源">
            <X size={21} aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <div className="discovery-inspector-scroll">
        {!item ? (
          <div className="discovery-inspector-empty" role="status">
            <strong>选择一个条目</strong>
            <p>选中榜单条目后，这里会显示候选片源。</p>
          </div>
        ) : (
          <>
            <section className="discovery-selected-item" aria-label="所选榜单条目">
              <div className="discovery-selected-item-rating">
                <Star size={17} strokeWidth={1.8} fill="currentColor" aria-hidden="true" />
                <span>{formatRating(item.rating)}</span>
              </div>
              <p>{item.genres.length > 0 ? item.genres.join(" / ") : "未分类"}</p>
              <p className="discovery-selected-item-summary">{item.summary || "暂无简介"}</p>
            </section>

            <section className="discovery-release-section" aria-labelledby="discovery-release-title">
              <header className="discovery-release-heading">
                <div>
                  <h3 id="discovery-release-title">候选片源</h3>
                  <p>
                    {hasResponse
                      ? `${statusSummary(releaseResponse as DiscoveryReleaseResponse)} · ${releases.length} 个当前候选`
                      : "选择片源后仍需在现有面板确认下载"}
                  </p>
                </div>
                <button
                  className="discovery-icon-button discovery-refresh-button"
                  type="button"
                  onClick={onRetry}
                  disabled={loading}
                  aria-label="重新检查片源"
                >
                  <RefreshCw className={loading ? "discovery-spin" : ""} size={18} aria-hidden="true" />
                </button>
              </header>

              {loading ? (
                <div className="discovery-inspector-state discovery-inspector-loading" role="status" aria-live="polite">
                  <CircleDashed className="discovery-spin" size={19} aria-hidden="true" />
                  <span>正在检查片源…</span>
                </div>
              ) : error ? (
                <div className="discovery-inspector-state discovery-inspector-error" role="alert">
                  <strong>片源检查失败</strong>
                  <p>{error}</p>
                  <button className="discovery-retry-button" type="button" onClick={onRetry}>
                    <RefreshCw size={16} aria-hidden="true" />
                    重试检查
                  </button>
                </div>
              ) : !releaseResponse ? (
                <div className="discovery-inspector-state discovery-inspector-empty-state" role="status">
                  <strong>尚未检查片源</strong>
                  <p>检查后会在这里列出可供比较的候选。</p>
                  <button className="discovery-retry-button" type="button" onClick={onRetry}>
                    <RefreshCw size={16} aria-hidden="true" />
                    检查片源
                  </button>
                </div>
              ) : releases.length === 0 ? (
                <div className="discovery-inspector-state discovery-inspector-empty-state" role="status">
                  <strong>{releaseResponse.status === "unavailable" ? "暂未找到候选片源" : "暂无候选片源"}</strong>
                  <p>可以稍后重新检查，或回到榜单选择其他条目。</p>
                  <button className="discovery-retry-button" type="button" onClick={onRetry}>
                    <RefreshCw size={16} aria-hidden="true" />
                    重新检查
                  </button>
                </div>
              ) : (
                <>
                  <div className="discovery-release-columns" aria-hidden="true">
                    <span>类型 / 发布</span>
                    <span>分辨率</span>
                    <span>大小</span>
                    <span>做种</span>
                  </div>
                  <div className="discovery-release-list" role="radiogroup" aria-label="候选片源列表">
                    {releases.map((release) => {
                      const selected = release.id === selectedReleaseId;
                      const selecting = release.id === selectingId;
                      const disabled = Boolean(selectingId && !selecting);
                      const quality = release.resolution || "规格未知";
                      return (
                        <button
                          className={`discovery-release-option${selected ? " is-selected" : ""}`}
                          key={release.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={releaseAccessibilityName(release, selected)}
                          disabled={disabled || selecting}
                          onClick={() => onSelectRelease(release)}
                        >
                          <span className="discovery-release-selector" aria-hidden="true">
                            {selected ? <CircleDot size={20} strokeWidth={2} /> : <Circle size={20} strokeWidth={1.7} />}
                          </span>
                          <span className="discovery-release-title-group">
                            <span className="discovery-release-title" title={release.title}>{release.title}</span>
                            <span className="discovery-release-source">
                              {release.protocol === "torrent" ? "TORRENT" : release.protocol.toUpperCase()}
                              <span aria-hidden="true">·</span>
                              {release.indexer}
                              {release.freeleech ? <em>免费</em> : null}
                            </span>
                          </span>
                          <span className="discovery-release-value discovery-release-resolution">{quality}</span>
                          <span className="discovery-release-value">{formatBytes(release.size)}</span>
                          <span className="discovery-release-seeders">
                            {selecting ? <CircleDashed className="discovery-spin" size={16} aria-hidden="true" /> : null}
                            <span>{formatCount(release.seeders)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </section>

            <p className="discovery-inspector-note">选择候选后，最终确认仍由现有选择面板完成。</p>
          </>
        )}
      </div>
    </aside>
  );
}

export default DiscoveryInspector;
