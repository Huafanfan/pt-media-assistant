import { ChevronRight, CircleDashed, RefreshCw, Star } from "lucide-react";
import { useId, useRef } from "react";
import type {
  DiscoveryCollectionId,
  DiscoveryItem,
  DiscoveryReleaseResponse
} from "../../shared/contracts";
import "../discovery.css";

const COLLECTIONS: ReadonlyArray<{ id: DiscoveryCollectionId; label: string }> = [
  { id: "movie-hot", label: "热门电影" },
  { id: "movie-weekly", label: "口碑电影" },
  { id: "tv-hot", label: "热门剧集" },
  { id: "tv-weekly", label: "口碑剧集" },
  { id: "top250", label: "Top 250" }
];

type DiscoveryAvailability = DiscoveryReleaseResponse | null | undefined;
type AvailabilityById = Readonly<Record<string, DiscoveryAvailability>> | ReadonlyMap<string, DiscoveryAvailability>;

export type DiscoveryBrowserProps = {
  collection: DiscoveryCollectionId;
  items: DiscoveryItem[];
  loading: boolean;
  error: string | null;
  selectedItemId: string | null;
  availabilityById: AvailabilityById;
  checkingIds: ReadonlySet<string> | readonly string[];
  onCollectionChange: (collection: DiscoveryCollectionId) => void;
  onSelectItem: (item: DiscoveryItem) => void;
  onRetry: () => void;
};

function hasId(ids: ReadonlySet<string> | readonly string[], id: string): boolean {
  return "has" in ids ? ids.has(id) : ids.includes(id);
}

function getAvailability(availabilityById: AvailabilityById, id: string): DiscoveryAvailability {
  return availabilityById instanceof Map
    ? availabilityById.get(id)
    : (availabilityById as Readonly<Record<string, DiscoveryAvailability>>)[id];
}

function formatRank(rank: number): string {
  if (!Number.isFinite(rank)) return "—";
  return String(Math.max(0, Math.floor(rank))).padStart(2, "0");
}

function formatRating(rating: number | undefined): string {
  return typeof rating === "number" && Number.isFinite(rating) ? rating.toFixed(1) : "—";
}

function availabilityCount(response: DiscoveryReleaseResponse): number {
  return Number.isFinite(response.total) ? Math.max(0, response.total) : response.releases.length;
}

type AvailabilityView = {
  label: string;
  className: "is-pending" | "is-checking" | "is-available" | "is-possible" | "is-unavailable";
  checking: boolean;
};

function getAvailabilityView(
  response: DiscoveryAvailability,
  checking: boolean
): AvailabilityView {
  if (checking) {
    return { label: "检查中", className: "is-checking", checking: true };
  }
  if (!response) {
    return { label: "待检查", className: "is-pending", checking: false };
  }
  const count = availabilityCount(response);
  if (response.status === "available") {
    return { label: `有资源 ${count}`, className: "is-available", checking: false };
  }
  if (response.status === "possible") {
    return { label: `可能匹配 ${count}`, className: "is-possible", checking: false };
  }
  return { label: "暂未找到", className: "is-unavailable", checking: false };
}

function itemAccessibleName(item: DiscoveryItem, availability: AvailabilityView): string {
  const details = [
    `${item.title}，第 ${item.rank} 名`,
    item.originalTitle ? `原名 ${item.originalTitle}` : null,
    item.year ? `${item.year} 年` : null,
    typeof item.rating === "number" ? `评分 ${formatRating(item.rating)}` : null,
    item.genres.length > 0 ? item.genres.join("、") : null,
    availability.label
  ].filter((value): value is string => Boolean(value));
  return details.join("，");
}

function changeByOffset(collection: DiscoveryCollectionId, offset: number): DiscoveryCollectionId {
  const currentIndex = COLLECTIONS.findIndex((entry) => entry.id === collection);
  const nextIndex = (currentIndex + offset + COLLECTIONS.length) % COLLECTIONS.length;
  return COLLECTIONS[nextIndex].id;
}

export function DiscoveryBrowser({
  collection,
  items,
  loading,
  error,
  selectedItemId,
  availabilityById,
  checkingIds,
  onCollectionChange,
  onSelectItem,
  onRetry
}: DiscoveryBrowserProps) {
  const baseId = useId().replace(/:/g, "");
  const tabRefs = useRef<Partial<Record<DiscoveryCollectionId, HTMLButtonElement>>>({});

  const focusCollection = (nextCollection: DiscoveryCollectionId) => {
    onCollectionChange(nextCollection);
    tabRefs.current[nextCollection]?.focus();
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const currentCollection = event.currentTarget.dataset.collection as DiscoveryCollectionId | undefined;
    const activeCollection = currentCollection ?? collection;
    let nextCollection: DiscoveryCollectionId | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextCollection = changeByOffset(activeCollection, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextCollection = changeByOffset(activeCollection, -1);
    } else if (event.key === "Home") {
      nextCollection = COLLECTIONS[0].id;
    } else if (event.key === "End") {
      nextCollection = COLLECTIONS[COLLECTIONS.length - 1].id;
    }
    if (!nextCollection) return;
    event.preventDefault();
    focusCollection(nextCollection);
  };

  return (
    <section className="discovery-browser" aria-label="豆瓣榜单">
      <div
        className="discovery-tabs"
        role="tablist"
        aria-label="豆瓣榜单"
        aria-orientation="horizontal"
      >
        {COLLECTIONS.map((entry) => {
          const selected = entry.id === collection;
          return (
            <button
              key={entry.id}
              ref={(element) => {
                if (element) tabRefs.current[entry.id] = element;
              }}
              className={`discovery-tab${selected ? " is-selected" : ""}`}
              id={`${baseId}-tab-${entry.id}`}
              data-collection={entry.id}
              type="button"
              role="tab"
              aria-controls={`${baseId}-list`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onCollectionChange(entry.id)}
              onKeyDown={handleTabKeyDown}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <div
        className="discovery-list-region"
        id={`${baseId}-list`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${collection}`}
        aria-busy={loading}
        tabIndex={0}
      >
        {loading ? (
          <div className="discovery-state discovery-state-loading" role="status" aria-live="polite">
            <CircleDashed className="discovery-spin" size={20} aria-hidden="true" />
            <span>正在载入榜单…</span>
          </div>
        ) : error ? (
          <div className="discovery-state discovery-state-error" role="alert">
            <strong>榜单暂时不可用</strong>
            <p>{error}</p>
            <button className="discovery-retry-button" type="button" onClick={onRetry}>
              <RefreshCw size={16} aria-hidden="true" />
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="discovery-state discovery-state-empty" role="status">
            <strong>这个榜单还没有条目</strong>
            <p>稍后重试，或切换到其他榜单。</p>
            <button className="discovery-retry-button" type="button" onClick={onRetry}>
              <RefreshCw size={16} aria-hidden="true" />
              重新载入
            </button>
          </div>
        ) : (
          <ol className="discovery-list" aria-label={`${COLLECTIONS.find((entry) => entry.id === collection)?.label ?? "当前"}榜单`}>
            {items.map((item) => {
              const checking = hasId(checkingIds, item.id);
              const availability = getAvailabilityView(getAvailability(availabilityById, item.id), checking);
              const selected = item.id === selectedItemId;
              return (
                <li className={`discovery-item${selected ? " is-selected" : ""}`} key={item.id}>
                  <button
                    className="discovery-item-button"
                    type="button"
                    aria-label={itemAccessibleName(item, availability)}
                    aria-pressed={selected}
                    onClick={() => onSelectItem(item)}
                  >
                    <span className="discovery-rank" aria-hidden="true">
                      {formatRank(item.rank)}
                    </span>
                    <span className="discovery-item-copy">
                      <span className="discovery-item-title" role="heading" aria-level={3}>
                        {item.title}
                      </span>
                      <span className="discovery-item-original">
                        {item.originalTitle || "原名未知"}
                        {item.year ? <span>{item.year}</span> : null}
                      </span>
                      <span className="discovery-item-meta">
                        <span className="discovery-rating">
                          <Star size={16} strokeWidth={1.8} fill="currentColor" aria-hidden="true" />
                          <span>{formatRating(item.rating)}</span>
                        </span>
                        <span className="discovery-genres">
                          {item.genres.length > 0 ? item.genres.join(" / ") : "未分类"}
                        </span>
                      </span>
                      <span className="discovery-item-summary" title={item.summary}>
                        {item.summary || "暂无简介"}
                      </span>
                    </span>
                    <span className={`discovery-availability ${availability.className}`} aria-live="polite">
                      {availability.checking ? <CircleDashed className="discovery-spin" size={16} aria-hidden="true" /> : null}
                      <span>{availability.label}</span>
                    </span>
                    <ChevronRight className="discovery-item-chevron" size={22} strokeWidth={1.6} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

export { COLLECTIONS as discoveryCollections };

export default DiscoveryBrowser;
