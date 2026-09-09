import { CircleAlert, CircleDashed, EyeOff, RefreshCw, Search } from "lucide-react";
import type { AssistantAvailability, AssistantRecommendationCard } from "../../shared/assistant";
import type { DiscoveryReleaseResponse } from "../../shared/contracts";
import { formatBytes } from "./ReleaseList";

function availabilityLabel(availability: AssistantAvailability): { label: string; className: string } {
  switch (availability) {
    case "available": return { label: "有资源", className: "is-available" };
    case "possible": return { label: "可能匹配", className: "is-possible" };
    case "error": return { label: "检查失败", className: "is-error" };
    case "unchecked": return { label: "尚未检查", className: "is-unchecked" };
    default: return { label: "暂未找到", className: "is-unavailable" };
  }
}

function isExpired(card: AssistantRecommendationCard, snapshot?: DiscoveryReleaseResponse): boolean {
  const expires = snapshot?.actionableUntil ?? snapshot?.expiresAt ?? card.actionableUntil ?? card.expiresAt;
  return Boolean(expires && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= Date.now());
}

export function AssistantRecommendations({
  cards,
  selectedCardId,
  onSelect,
  onFallback,
  error,
  errorCode,
  loading,
  snapshots = {}
}: {
  cards: AssistantRecommendationCard[];
  selectedCardId: string | null;
  onSelect: (card: AssistantRecommendationCard) => void;
  onFallback: () => void;
  error: string | null;
  errorCode?: string;
  loading: boolean;
  snapshots?: Readonly<Record<string, DiscoveryReleaseResponse>>;
}) {
  return (
    <section className="assistant-recommendations" aria-label="AI 推荐结果">
      <header className="assistant-results-heading">
        <h2>推荐作品</h2>
        {cards.length > 0 ? <span className="result-count">{cards.length} 部</span> : null}
      </header>

      {loading ? (
        <div className="assistant-state" role="status" aria-live="polite">
          <CircleDashed className="spin" size={18} aria-hidden="true" />
          <span>正在查找推荐…</span>
        </div>
      ) : null}

      {error ? (
        <div className="assistant-state assistant-state-error" role="alert">
          <CircleAlert size={19} aria-hidden="true" />
          <div>
            <strong>{errorCode === "CONVERSATION_EXPIRED" ? "这段对话已过期" : "AI 推荐暂时不可用"}</strong>
            <p>{error}</p>
            <button className="outline-button assistant-fallback-button" type="button" onClick={onFallback}>
              <Search size={16} aria-hidden="true" />按片名搜索
            </button>
          </div>
        </div>
      ) : null}

      <div className="assistant-card-list">
        {cards.map((card, index) => {
          const availability = availabilityLabel(card.availability);
          const expired = isExpired(card, snapshots[card.cardId]);
          return (
            <article className={`assistant-card${selectedCardId === card.cardId ? " is-selected" : ""}`} key={card.cardId}>
              <header className="assistant-card-heading">
                <span className="assistant-card-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="assistant-card-title">
                  <h3>{card.title}</h3>
                  <p>
                    {card.year || "年份未知"}
                    <span aria-hidden="true"> · </span>
                    {card.mediaType === "tv" ? "剧集" : "电影"}
                    {card.originalTitle ? <><span aria-hidden="true"> · </span>{card.originalTitle}</> : null}
                  </p>
                </div>
                <span className={`assistant-availability ${availability.className}`}>{expired ? "引用已过期" : availability.label}</span>
              </header>

              {card.reason || card.summary ? <p className="assistant-card-description">{card.reason || card.summary}</p> : null}

              {card.constraintResults.some((constraint) => constraint.status !== "met") ? (
                <div className="assistant-constraints" aria-label={`${card.title} 约束检查`}>
                  {card.constraintResults.filter((constraint) => constraint.status !== "met").slice(0, 3).map((constraint) => (
                    <span className={`assistant-constraint is-${constraint.status}`} key={`${constraint.key}-${constraint.detail}`}>
                      {constraint.status === "not_met" ? <EyeOff size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
                      {constraint.detail || (constraint.status === "not_met" ? "未满足" : "未知")}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="assistant-card-footer">
                <button className="outline-button assistant-open-button" type="button" onClick={() => onSelect(card)}>
                  {expired ? <><RefreshCw size={15} aria-hidden="true" />查看并刷新</> : "查看详情"}
                </button>
              </div>

              {card.rankedReleases.length > 0 ? (
                <details className="assistant-release-details">
                  <summary>{card.rankedReleases.length} 个优先片源</summary>
                  <ol className="assistant-release-list" aria-label={`${card.title} 推荐片源`}>
                    {card.rankedReleases.map((release) => (
                      <li key={release.id}>
                        <span className="assistant-release-rank">{String(release.rank).padStart(2, "0")}</span>
                        <span className="assistant-release-copy">
                          <strong>{release.title}</strong>
                          <span>
                            {release.resolution || "规格未知"}
                            <span aria-hidden="true"> · </span>
                            {formatBytes(release.size)}
                            <span aria-hidden="true"> · </span>
                            做种 {release.seeders > 0 ? release.seeders : "未知"}
                            {release.freeleechState === "yes" || release.freeleech ? <span className="assistant-freeleech">免费</span> : null}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export { isExpired };
export default AssistantRecommendations;
