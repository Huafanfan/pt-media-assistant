import { CircleDashed, Film, Tv } from "lucide-react";
import type { DiscoveryMedia } from "../../shared/contracts";
import { DiscoveryPoster } from "./DiscoveryPoster";
import "../discovery.css";

export type MediaSearchResultsProps = {
  items: DiscoveryMedia[];
  loading: boolean;
  error: string | null;
  selectedItemId: string | null;
  onSelect: (item: DiscoveryMedia) => void;
};

export function MediaSearchResults({ items, loading, error, selectedItemId, onSelect }: MediaSearchResultsProps) {
  if (!loading && !error && items.length === 0) return null;

  return (
    <section className="media-search-results" aria-label="作品搜索结果">
      <header className="media-search-results-heading">
        <div>
          <span className="media-search-results-kicker">MEDIA MATCHES</span>
          <h2>作品</h2>
        </div>
        {items.length > 0 ? <span>{items.length} 个建议</span> : null}
      </header>
      {loading ? (
        <div className="media-search-results-state" role="status" aria-live="polite">
          <CircleDashed className="discovery-spin" size={17} aria-hidden="true" />
          <span>正在匹配电影和剧集…</span>
        </div>
      ) : error ? (
        <p className="media-search-results-error" role="status">作品匹配暂时不可用</p>
      ) : (
        <div className="media-search-results-list">
          {items.map((item) => {
            const selected = item.id === selectedItemId;
            const mediaType = item.mediaType === "tv" ? "剧集" : "电影";
            return (
              <button
                className={`media-search-result${selected ? " is-selected" : ""}`}
                key={`${item.mediaType}:${item.id}`}
                type="button"
                aria-pressed={selected}
                aria-label={`${item.title}${item.year ? `，${item.year}` : ""}，${mediaType}`}
                onClick={() => onSelect(item)}
              >
                <DiscoveryPoster src={item.posterUrl} title={item.title} alt={`${item.title} 海报`} className="media-search-result-poster" />
                <span className="media-search-result-copy">
                  <strong>{item.title}</strong>
                  <span>
                    {item.year || "年份未知"}
                    <span aria-hidden="true"> · </span>
                    {item.mediaType === "tv" ? <Tv size={13} aria-hidden="true" /> : <Film size={13} aria-hidden="true" />}
                    {mediaType}
                  </span>
                  {item.summary ? <em>{item.summary}</em> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default MediaSearchResults;
