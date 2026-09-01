import { ArrowLeft, CircleDashed, RefreshCw, Star, Tv } from "lucide-react";
import type { DiscoveryActorProfile, DiscoveryActorWork } from "../../shared/contracts";
import { DiscoveryPoster } from "./DiscoveryPoster";
import "../discovery.css";

export type ActorViewProps = {
  profile: DiscoveryActorProfile | null;
  page: number;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  onSelectWork: (work: DiscoveryActorWork) => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
};

function formatRating(rating: number | undefined): string {
  return typeof rating === "number" && Number.isFinite(rating) ? rating.toFixed(1) : "—";
}

export function ActorView({ profile, page, loading, error, onBack, onSelectWork, onPageChange, onRetry }: ActorViewProps) {
  const pageSize = profile?.pageSize ?? 10;
  const total = profile?.total ?? 0;
  const works = profile?.works ?? [];
  const start = profile ? (profile.page - 1) * pageSize : (page - 1) * pageSize;
  const end = start + works.length;
  const hasPrevious = page > 1;
  const hasNext = profile?.hasNext ?? false;

  return (
    <section className="actor-view" aria-label="演员资料">
      <header className="actor-view-header">
        <button className="actor-back-button" type="button" onClick={onBack}>
          <ArrowLeft size={17} aria-hidden="true" />
          返回作品详情
        </button>
        <span className="actor-view-kicker">演员索引</span>
      </header>

      {loading ? (
        <div className="discovery-state discovery-state-loading" role="status" aria-live="polite">
          <CircleDashed className="discovery-spin" size={20} aria-hidden="true" />
          <span>正在载入演员资料…</span>
        </div>
      ) : error ? (
        <div className="discovery-state discovery-state-error" role="alert">
          <strong>演员资料暂时不可用</strong>
          <p>{error}</p>
          <button className="discovery-retry-button" type="button" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" />
            重试
          </button>
        </div>
      ) : !profile ? (
        <div className="discovery-state" role="status">
          <strong>没有演员资料</strong>
          <p>返回作品详情后，可以继续查看其他演员。</p>
        </div>
      ) : (
        <div className="actor-view-scroll">
          <section className="actor-profile-card" aria-labelledby="actor-profile-title">
            <DiscoveryPoster
              src={profile.avatarUrl}
              title={profile.name}
              alt={`${profile.name} 头像`}
              className="actor-profile-avatar"
            />
            <div className="actor-profile-copy">
              <span className="actor-profile-label">PERSON / 演员</span>
              <h2 id="actor-profile-title">{profile.name}</h2>
              {profile.latinName ? <p className="actor-profile-latin">{profile.latinName}</p> : null}
              <p className="actor-profile-intro">{profile.intro}</p>
            </div>
          </section>

          <section className="actor-works-section" aria-labelledby="actor-works-title">
            <header className="actor-works-heading">
              <div>
                <span className="actor-profile-label">FILMOGRAPHY</span>
                <h3 id="actor-works-title">影视作品</h3>
              </div>
              <span className="actor-works-total">共 {total} 部</span>
            </header>
            {works.length > 0 ? (
              <div className="actor-work-grid">
                {works.map((work) => (
                  <button
                    className="actor-work-card"
                    key={work.id}
                    type="button"
                    onClick={() => onSelectWork(work)}
                  >
                    <DiscoveryPoster
                      src={work.posterUrl}
                      title={work.title}
                      alt={`${work.title} 海报`}
                      className="actor-work-poster"
                    />
                    <span className="actor-work-copy">
                      <strong title={work.title}>{work.title}</strong>
                      <span className="actor-work-meta">
                        {work.year || "年份未知"}
                        <span aria-hidden="true"> · </span>
                        {work.mediaType === "tv" ? <Tv size={13} aria-hidden="true" /> : null}
                        {work.mediaType === "tv" ? "剧集" : "电影"}
                      </span>
                      <span className="actor-work-rating">
                        <Star size={13} fill="currentColor" aria-hidden="true" />
                        {formatRating(work.rating)}
                      </span>
                      {work.role ? <span className="actor-work-role">{work.role}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="discovery-state discovery-state-empty" role="status">
                <strong>暂无影视作品</strong>
                <p>豆瓣暂时没有返回可展示的电影或剧集。</p>
              </div>
            )}
            {total > pageSize ? (
              <nav className="discovery-pagination actor-pagination" aria-label="演员影视作品翻页">
                <span className="discovery-pagination-summary">
                  第 {profile.page} 页 · {start + 1}–{end} / {total}
                </span>
                <div className="discovery-pagination-actions">
                  <button
                    className="discovery-pagination-button"
                    type="button"
                    disabled={!hasPrevious || loading}
                    onClick={() => onPageChange(page - 1)}
                  >
                    上一页
                  </button>
                  <button
                    className="discovery-pagination-button is-primary"
                    type="button"
                    disabled={!hasNext || loading}
                    onClick={() => onPageChange(page + 1)}
                  >
                    下一页
                  </button>
                </div>
              </nav>
            ) : null}
          </section>
        </div>
      )}
    </section>
  );
}

export default ActorView;
