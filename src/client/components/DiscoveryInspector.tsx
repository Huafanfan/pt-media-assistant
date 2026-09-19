import {
  Circle,
  CircleDashed,
  CircleDot,
  Eye,
  EyeOff,
  RefreshCw,
  Star,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  DiscoveryActor,
  DiscoveryItemDetails,
  DiscoveryMedia,
  DiscoveryReleaseResponse,
  ReleaseSummary,
} from "../../shared/contracts";
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
  seen?: boolean;
  seenPending?: boolean;
  onToggleSeen?: () => void;
};

const RELEASE_PAGE_SIZE = 10;

type ReleaseSort = "default" | "seeders" | "size" | "newest";
type ReleaseFilters = {
  season: string;
  resolution: string;
  codec: string;
  indexer: string;
  freeleech: boolean;
};

function formatRating(rating: number | undefined): string {
  return typeof rating === "number" && Number.isFinite(rating)
    ? rating.toFixed(1)
    : "—";
}

function formatCount(value: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("zh-CN").format(Math.max(0, value))
    : "—";
}

function releaseAccessibilityName(
  release: ReleaseSummary,
  selected: boolean,
): string {
  const details = [
    release.title,
    release.resolution || "规格未知",
    formatBytes(release.size),
    `做种 ${formatCount(release.seeders)}`,
    release.freeleech ? "免费" : null,
    selected ? "已选择" : "未选择",
  ].filter((value): value is string => Boolean(value));
  return details.join("，");
}

const DEFAULT_RELEASE_FILTERS: ReleaseFilters = {
  season: "all",
  resolution: "all",
  codec: "all",
  indexer: "all",
  freeleech: false,
};

function equalFilters(left: ReleaseFilters, right: ReleaseFilters): boolean {
  return (
    left.season === right.season &&
    left.resolution === right.resolution &&
    left.codec === right.codec &&
    left.indexer === right.indexer &&
    left.freeleech === right.freeleech
  );
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
  onSelectActor,
  seen = false,
  seenPending = false,
  onToggleSeen,
}: MediaInspectorProps) {
  const itemHeading = item?.title ?? "候选片源";
  const hasResponse = Boolean(releaseResponse && !error);
  const releases = releaseResponse?.releases ?? [];
  const [releasePage, setReleasePage] = useState(1);
  const [releaseFilters, setReleaseFilters] = useState<ReleaseFilters>(
    DEFAULT_RELEASE_FILTERS,
  );
  const [releaseSort, setReleaseSort] = useState<ReleaseSort>("default");

  const seasonOptions = useMemo(
    () =>
      [
        ...new Set(
          releases.flatMap((release) =>
            typeof release.season === "number" ? [release.season] : [],
          ),
        ),
      ].sort((left, right) => left - right),
    [releases],
  );
  const resolutionOptions = useMemo(
    () => [
      ...new Set(
        releases.flatMap((release) =>
          release.resolution ? [release.resolution] : [],
        ),
      ),
    ],
    [releases],
  );
  const codecOptions = useMemo(
    () => [
      ...new Set(
        releases.flatMap((release) => (release.codec ? [release.codec] : [])),
      ),
    ],
    [releases],
  );
  const indexerOptions = useMemo(
    () =>
      [
        ...new Set(releases.map((release) => release.indexer).filter(Boolean)),
      ].sort((left, right) => left.localeCompare(right)),
    [releases],
  );

  // Drop a selected value when the current snapshot no longer offers it, so
  // a refresh can never leave the list filtered by an invisible control.
  const effectiveFilters = useMemo<ReleaseFilters>(
    () => ({
      season:
        releaseFilters.season === "all" ||
        seasonOptions.includes(Number(releaseFilters.season))
          ? releaseFilters.season
          : "all",
      resolution:
        releaseFilters.resolution === "all" ||
        resolutionOptions.includes(releaseFilters.resolution)
          ? releaseFilters.resolution
          : "all",
      codec:
        releaseFilters.codec === "all" ||
        codecOptions.includes(releaseFilters.codec)
          ? releaseFilters.codec
          : "all",
      indexer:
        releaseFilters.indexer === "all" ||
        indexerOptions.includes(releaseFilters.indexer)
          ? releaseFilters.indexer
          : "all",
      freeleech: releaseFilters.freeleech,
    }),
    [
      releaseFilters,
      seasonOptions,
      resolutionOptions,
      codecOptions,
      indexerOptions,
    ],
  );

  useEffect(() => {
    setReleaseFilters((current) =>
      equalFilters(current, effectiveFilters) ? current : effectiveFilters,
    );
  }, [effectiveFilters]);

  // Filtering and sorting are local to the bounded server snapshot; no extra
  // PT request is created by changing a control.
  const sortedReleases = useMemo(() => {
    const filtered = releases.filter((release) => {
      if (
        effectiveFilters.season !== "all" &&
        String(release.season ?? "") !== effectiveFilters.season
      )
        return false;
      if (
        effectiveFilters.resolution !== "all" &&
        release.resolution !== effectiveFilters.resolution
      )
        return false;
      if (
        effectiveFilters.codec !== "all" &&
        release.codec !== effectiveFilters.codec
      )
        return false;
      if (
        effectiveFilters.indexer !== "all" &&
        release.indexer !== effectiveFilters.indexer
      )
        return false;
      if (
        effectiveFilters.freeleech &&
        !(release.freeleech || release.freeleechState === "yes")
      )
        return false;
      return true;
    });
    if (releaseSort === "seeders")
      return [...filtered].sort((left, right) => right.seeders - left.seeders);
    if (releaseSort === "size")
      return [...filtered].sort((left, right) => left.size - right.size);
    if (releaseSort === "newest")
      return [...filtered].sort((left, right) => left.ageDays - right.ageDays);
    return filtered;
  }, [releases, effectiveFilters, releaseSort]);

  const releaseTotal = sortedReleases.length;
  const releasePageCount = Math.max(
    1,
    Math.ceil(releaseTotal / RELEASE_PAGE_SIZE),
  );
  const activeReleasePage = Math.min(releasePage, releasePageCount);
  const releaseStart = (activeReleasePage - 1) * RELEASE_PAGE_SIZE;
  const visibleReleases = sortedReleases.slice(
    releaseStart,
    releaseStart + RELEASE_PAGE_SIZE,
  );
  const releaseEnd = releaseStart + visibleReleases.length;
  const filtersActive =
    !equalFilters(effectiveFilters, DEFAULT_RELEASE_FILTERS) ||
    releaseSort !== "default";

  // A different work always starts with a clean filter state and page.
  useEffect(() => {
    setReleaseFilters(DEFAULT_RELEASE_FILTERS);
    setReleaseSort("default");
    setReleasePage(1);
  }, [item?.mediaType, item?.id]);

  useEffect(() => {
    setReleasePage(1);
  }, [item?.mediaType, item?.id, effectiveFilters, releaseSort]);

  useEffect(() => {
    if (releasePage > releasePageCount) setReleasePage(releasePageCount);
  }, [releasePage, releasePageCount]);

  return (
    <aside
      className={`discovery-inspector${item ? "" : " is-empty"}`}
      aria-labelledby="discovery-inspector-title"
    >
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
          <button
            className="discovery-icon-button"
            type="button"
            onClick={onClose}
            aria-label="关闭候选片源"
          >
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
            <section
              className="discovery-selected-item"
              aria-label="所选榜单条目"
            >
              <div className="discovery-selected-item-overview">
                <DiscoveryPoster
                  src={item.posterUrl}
                  title={item.title}
                  alt={`${item.title} 海报`}
                  className="discovery-selected-item-poster"
                />
                <div className="discovery-selected-item-copy">
                  <div className="discovery-selected-item-rating">
                    <Star
                      size={17}
                      strokeWidth={1.8}
                      fill="currentColor"
                      aria-hidden="true"
                    />
                    <span>{formatRating(item.rating)}</span>
                  </div>
                  <p>
                    {item.genres.length > 0
                      ? item.genres.join(" / ")
                      : "未分类"}
                  </p>
                  <p className="discovery-selected-item-summary">
                    {item.summary || "暂无简介"}
                  </p>
                  {onToggleSeen ? (
                    <div className="discovery-seen-row">
                      <button
                        className={`outline-button discovery-seen-button${seen ? " is-seen" : ""}`}
                        type="button"
                        onClick={onToggleSeen}
                        disabled={seenPending}
                        aria-pressed={seen}
                      >
                        {seen ? (
                          <EyeOff size={15} aria-hidden="true" />
                        ) : (
                          <Eye size={15} aria-hidden="true" />
                        )}
                        {seenPending
                          ? "正在更新…"
                          : seen
                            ? "取消已看"
                            : "标记已看"}
                      </button>
                      {seen ? (
                        <span className="discovery-seen-note">
                          已看过的作品不会再被 AI 推荐
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <section className="discovery-cast" aria-label="演职员">
                <div className="discovery-cast-row">
                  <span className="discovery-cast-label">主演</span>
                  {detailsLoading ? (
                    <span className="discovery-cast-muted">正在读取…</span>
                  ) : null}
                  {!detailsLoading && detailsError ? (
                    <>
                      <span className="discovery-cast-muted">暂时不可用</span>
                      <button
                        className="discovery-inline-action"
                        type="button"
                        onClick={onRetryDetails}
                      >
                        重试
                      </button>
                    </>
                  ) : null}
                  {!detailsLoading &&
                  !detailsError &&
                  details?.actors.length ? (
                    <span className="discovery-cast-names">
                      {details.actors.map((actor, index) => (
                        <span
                          key={`${actor.id ?? actor.name}-${index}`}
                          className="discovery-cast-person"
                        >
                          {index > 0 ? (
                            <span
                              className="discovery-cast-separator"
                              aria-hidden="true"
                            >
                              {" "}
                              ·{" "}
                            </span>
                          ) : null}
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
                  {!detailsLoading &&
                  !detailsError &&
                  details &&
                  details.actors.length === 0 ? (
                    <span className="discovery-cast-muted">暂无资料</span>
                  ) : null}
                </div>
                {!detailsLoading &&
                !detailsError &&
                details?.directors.length ? (
                  <div className="discovery-cast-row">
                    <span className="discovery-cast-label">导演</span>
                    <span className="discovery-cast-names">
                      {details.directors.join(" · ")}
                    </span>
                  </div>
                ) : null}
              </section>
            </section>

            <section
              className="discovery-release-section"
              aria-labelledby="discovery-release-title"
            >
              <header className="discovery-release-heading">
                <div>
                  <h3 id="discovery-release-title">候选片源</h3>
                  <p>
                    {hasResponse
                      ? `${statusSummary(releaseResponse as DiscoveryReleaseResponse)} · ${releaseTotal} 个当前候选`
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
                  <RefreshCw
                    className={loading ? "discovery-spin" : ""}
                    size={18}
                    aria-hidden="true"
                  />
                </button>
              </header>

              {loading ? (
                <div
                  className="discovery-inspector-state discovery-inspector-loading"
                  role="status"
                  aria-live="polite"
                >
                  <CircleDashed
                    className="discovery-spin"
                    size={19}
                    aria-hidden="true"
                  />
                  <span>正在检查片源…</span>
                </div>
              ) : error ? (
                <div
                  className="discovery-inspector-state discovery-inspector-error"
                  role="alert"
                >
                  <strong>片源检查失败</strong>
                  <p>{error}</p>
                  <button
                    className="discovery-retry-button"
                    type="button"
                    onClick={onRetry}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    重试检查
                  </button>
                </div>
              ) : !releaseResponse ? (
                <div
                  className="discovery-inspector-state discovery-inspector-empty-state"
                  role="status"
                >
                  <strong>尚未检查片源</strong>
                  <p>检查后会在这里列出可供比较的候选。</p>
                  <button
                    className="discovery-retry-button"
                    type="button"
                    onClick={onRetry}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    检查片源
                  </button>
                </div>
              ) : releases.length === 0 ? (
                <div
                  className="discovery-inspector-state discovery-inspector-empty-state"
                  role="status"
                >
                  <strong>
                    {releaseResponse.status === "unavailable"
                      ? "暂未找到候选片源"
                      : "暂无候选片源"}
                  </strong>
                  <p>可以稍后重新检查，或回到榜单选择其他条目。</p>
                  <button
                    className="discovery-retry-button"
                    type="button"
                    onClick={onRetry}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    重新检查
                  </button>
                </div>
              ) : (
                <>
                  <div
                    className="discovery-release-filters"
                    aria-label="片源筛选与排序"
                  >
                    {seasonOptions.length > 0 ? (
                      <label className="discovery-filter">
                        <span>季（推断）</span>
                        <select
                          value={effectiveFilters.season}
                          title="季信息由发布标题推断，仅用于筛选，不代表已确认季集匹配"
                          onChange={(event) =>
                            setReleaseFilters((current) => ({
                              ...current,
                              season: event.target.value,
                            }))
                          }
                        >
                          <option value="all">全部</option>
                          {seasonOptions.map((season) => (
                            <option key={season} value={String(season)}>
                              第 {season} 季
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {resolutionOptions.length > 1 ? (
                      <label className="discovery-filter">
                        <span>分辨率</span>
                        <select
                          value={effectiveFilters.resolution}
                          onChange={(event) =>
                            setReleaseFilters((current) => ({
                              ...current,
                              resolution: event.target.value,
                            }))
                          }
                        >
                          <option value="all">全部</option>
                          {resolutionOptions.map((resolution) => (
                            <option key={resolution} value={resolution}>
                              {resolution}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {codecOptions.length > 1 ? (
                      <label className="discovery-filter">
                        <span>编码</span>
                        <select
                          value={effectiveFilters.codec}
                          onChange={(event) =>
                            setReleaseFilters((current) => ({
                              ...current,
                              codec: event.target.value,
                            }))
                          }
                        >
                          <option value="all">全部</option>
                          {codecOptions.map((codec) => (
                            <option key={codec} value={codec}>
                              {codec}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {indexerOptions.length > 1 ? (
                      <label className="discovery-filter">
                        <span>索引器</span>
                        <select
                          value={effectiveFilters.indexer}
                          onChange={(event) =>
                            setReleaseFilters((current) => ({
                              ...current,
                              indexer: event.target.value,
                            }))
                          }
                        >
                          <option value="all">全部</option>
                          {indexerOptions.map((indexer) => (
                            <option key={indexer} value={indexer}>
                              {indexer}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="discovery-filter is-checkbox">
                      <input
                        type="checkbox"
                        checked={releaseFilters.freeleech}
                        onChange={(event) =>
                          setReleaseFilters((current) => ({
                            ...current,
                            freeleech: event.target.checked,
                          }))
                        }
                      />
                      <span>仅免费</span>
                    </label>
                    <label className="discovery-filter">
                      <span>排序</span>
                      <select
                        value={releaseSort}
                        onChange={(event) =>
                          setReleaseSort(event.target.value as ReleaseSort)
                        }
                      >
                        <option value="default">默认</option>
                        <option value="seeders">做种多</option>
                        <option value="size">体积小</option>
                        <option value="newest">最新</option>
                      </select>
                    </label>
                    <button
                      className="discovery-filter-reset"
                      type="button"
                      disabled={!filtersActive}
                      onClick={() => {
                        setReleaseFilters(DEFAULT_RELEASE_FILTERS);
                        setReleaseSort("default");
                      }}
                    >
                      清除筛选
                    </button>
                  </div>
                  {visibleReleases.length > 0 ? (
                    <>
                      <div
                        className="discovery-release-columns"
                        aria-hidden="true"
                      >
                        <span>类型 / 发布</span>
                        <span>分辨率</span>
                        <span>大小</span>
                        <span>做种</span>
                      </div>
                      <div
                        className="discovery-release-list"
                        role="radiogroup"
                        aria-label="候选片源列表"
                      >
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
                              aria-label={releaseAccessibilityName(
                                release,
                                selected,
                              )}
                              disabled={disabled || selecting}
                              onClick={() => onSelectRelease(release)}
                            >
                              <span
                                className="discovery-release-selector"
                                aria-hidden="true"
                              >
                                {selected ? (
                                  <CircleDot size={20} strokeWidth={2} />
                                ) : (
                                  <Circle size={20} strokeWidth={1.7} />
                                )}
                              </span>
                              <span className="discovery-release-title-group">
                                <span
                                  className="discovery-release-title"
                                  title={release.title}
                                >
                                  {release.title}
                                </span>
                                <span className="discovery-release-source">
                                  {release.protocol === "torrent"
                                    ? "TORRENT"
                                    : release.protocol.toUpperCase()}
                                  <span aria-hidden="true">·</span>
                                  {release.indexer}
                                  {typeof release.season === "number" ? (
                                    <em title="季信息由发布标题推断">
                                      第 {release.season} 季
                                    </em>
                                  ) : null}
                                  {release.freeleech ? <em>免费</em> : null}
                                </span>
                              </span>
                              <span className="discovery-release-value discovery-release-resolution">
                                {quality}
                              </span>
                              <span className="discovery-release-value">
                                {formatBytes(release.size)}
                              </span>
                              <span className="discovery-release-seeders">
                                {selecting ? (
                                  <CircleDashed
                                    className="discovery-spin"
                                    size={16}
                                    aria-hidden="true"
                                  />
                                ) : null}
                                <span>{formatCount(release.seeders)}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {releasePageCount > 1 ? (
                        <nav
                          className="discovery-pagination discovery-release-pagination"
                          aria-label="候选片源翻页"
                        >
                          <span className="discovery-pagination-summary">
                            第 {activeReleasePage} 页 · {releaseStart + 1}–
                            {releaseEnd} / {releaseTotal}
                          </span>
                          <div className="discovery-pagination-actions">
                            <button
                              className="discovery-pagination-button"
                              type="button"
                              disabled={activeReleasePage <= 1}
                              onClick={() =>
                                setReleasePage((current) =>
                                  Math.max(1, current - 1),
                                )
                              }
                            >
                              上一页
                            </button>
                            <button
                              className="discovery-pagination-button is-primary"
                              type="button"
                              disabled={activeReleasePage >= releasePageCount}
                              onClick={() =>
                                setReleasePage((current) =>
                                  Math.min(releasePageCount, current + 1),
                                )
                              }
                            >
                              下一页
                            </button>
                          </div>
                        </nav>
                      ) : null}
                    </>
                  ) : (
                    <div
                      className="discovery-inspector-state discovery-inspector-empty-state"
                      role="status"
                    >
                      <strong>没有符合筛选的候选</strong>
                      <p>调整或清除筛选条件后再试。</p>
                    </div>
                  )}
                </>
              )}
            </section>

            <p className="discovery-inspector-note">
              选择候选后，最终确认仍由现有选择面板完成。
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

export const DiscoveryInspector = MediaInspector;
export type DiscoveryInspectorProps = MediaInspectorProps;
export default MediaInspector;
