import { Circle, CircleDashed, CircleDot, RefreshCw, Star, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DiscoveryActor, DiscoveryItemDetails, DiscoveryMedia, DiscoveryReleaseResponse, ReleaseSummary } from "../../shared/contracts";
import { DiscoveryPoster } from "./DiscoveryPoster";
import { formatBytes } from "./ReleaseList";
import "../discovery.css";

export type MediaInspectorProps = {
  item: DiscoveryMedia | null;
  details: DiscoveryItemDetails | null;
  detailsLoading: boolean;
  detailsError: string | null;
  releaseResponse: DiscoveryReleaseResponse | null;
  loading: boolean;
  error: string | null;
  selectedReleaseId: string | null;
  selectingId: string | null;
  onSelectRelease: (release: ReleaseSummary) => void;
  onClose: () => void;
  onRetry: () => void;
  onRetryDetails: () => void;
  onSelectActor?: (actor: DiscoveryActor) => void;
};

const RELEASE_PAGE_SIZE = 10;

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

export function MediaInspector({
  item,
  details,
  detailsLoading,
  detailsError,
  releaseResponse,
  loading,
  error,
  selectedReleaseId,
  selectingId,
  onSelectRelease,
  onClose,
  onRetry,
  onRetryDetails,
  onSelectActor
}: MediaInspectorProps) {
  const itemHeading = item?.title ?? "候选片源";
  const hasResponse = Boolean(releaseResponse && !error);
  const releases = releaseResponse?.releases ?? [];
  const releaseTotal = Math.max(releases.length, releaseResponse?.total ?? 0);
  const [releasePage, setReleasePage] = useState(1);
  const releasePageCount = Math.max(1, Math.ceil(releaseTotal / RELEASE_PAGE_SIZE));
  const activeReleasePage = Math.min(releasePage, releasePageCount);
  const releaseStart = (activeReleasePage - 1) * RELEASE_PAGE_SIZE;
  const visibleReleases = releases.slice(releaseStart, releaseStart + RELEASE_PAGE_SIZE);
  const releaseEnd = releaseStart + visibleReleases.length;

  useEffect(() => {
    setReleasePage(1);
  }, [item?.id]);

  useEffect(() => {
    if (releasePage > releasePageCount) setReleasePage(releasePageCount);
  }, [releasePage, releasePageCount]);

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
              <div className="discovery-selected-item-overview">
                <DiscoveryPoster
                  src={item.posterUrl}
                  title={item.title}
                  alt={`${item.title} 海报`}
                  className="discovery-selected-item-poster"
                />
                <div className="discovery-selected-item-copy">
                  <div className="discovery-selected-item-rating">
                    <Star size={17} strokeWidth={1.8} fill="currentColor" aria-hidden="true" />
                    <span>{formatRating(item.rating)}</span>
                  </div>
                  <p>{item.genres.length > 0 ? item.genres.join(" / ") : "未分类"}</p>
                  <p className="discovery-selected-item-summary">{item.summary || "暂无简介"}</p>
                </div>
              </div>
              <section className="discovery-cast" aria-label="演职员">
                <div className="discovery-cast-row">
                  <span className="discovery-cast-label">主演</span>
                  {detailsLoading ? <span className="discovery-cast-muted">正在读取…</span> : null}
                  {!detailsLoading && detailsError ? (
                    <>
                      <span className="discovery-cast-muted">暂时不可用</span>
                      <button className="discovery-inline-action" type="button" onClick={onRetryDetails}>重试</button>
                    </>
                  ) : null}
                  {!detailsLoading && !detailsError && details?.actors.length ? (
                    <span className="discovery-cast-names">
                      {details.actors.map((actor, index) => (
                        <span key={`${actor.id ?? actor.name}-${index}`} className="discovery-cast-person">
                          {index > 0 ? <span className="discovery-cast-separator" aria-hidden="true"> · </span> : null}
                          <button
                            className="discovery-actor-button"
                            type="button"
                            onClick={() => onSelectActor?.(actor)}
                          >
                            {actor.name}
                          </button>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {!detailsLoading && !detailsError && details && details.actors.length === 0 ? (
                    <span className="discovery-cast-muted">暂无资料</span>
                  ) : null}
                </div>
                {!detailsLoading && !detailsError && details?.directors.length ? (
                  <div className="discovery-cast-row">
                    <span className="discovery-cast-label">导演</span>
                    <span className="discovery-cast-names">{details.directors.join(" · ")}</span>
                  </div>
                ) : null}
              </section>
            </section>

            <section className="discovery-release-section" aria-labelledby="discovery-release-title">
              <header className="discovery-release-heading">
                <div>
                  <h3 id="discovery-release-title">候选片源</h3>
                  <p>
                    {hasResponse
                      ? `${statusSummary(releaseResponse as DiscoveryReleaseResponse)} · ${visibleReleases.length} 个当前候选`
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
                    {visibleReleases.map((release) => {
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
                  {releasePageCount > 1 ? (
                    <nav className="discovery-pagination discovery-release-pagination" aria-label="候选片源翻页">
                      <span className="discovery-pagination-summary">
                        第 {activeReleasePage} 页 · {releaseStart + 1}–{releaseEnd} / {releaseTotal}
                      </span>
                      <div className="discovery-pagination-actions">
                        <button
                          className="discovery-pagination-button"
                          type="button"
                          disabled={activeReleasePage <= 1}
                          onClick={() => setReleasePage((current) => Math.max(1, current - 1))}
                        >
                          上一页
                        </button>
                        <button
                          className="discovery-pagination-button is-primary"
                          type="button"
                          disabled={activeReleasePage >= releasePageCount}
                          onClick={() => setReleasePage((current) => Math.min(releasePageCount, current + 1))}
                        >
                          下一页
                        </button>
                      </div>
                    </nav>
                  ) : null}
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

export const DiscoveryInspector = MediaInspector;
export type DiscoveryInspectorProps = MediaInspectorProps;
export default MediaInspector;
