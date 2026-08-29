import { Check, CircleDashed } from "lucide-react";
import type { ReleaseSummary } from "../../shared/contracts";
import { EmptyState } from "./States";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "—";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex >= 3 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value) : "—";
}

export function formatCategories(categories: string[]): string {
  const leaves = [...new Set(categories.map((category) => category.split("/").filter(Boolean).at(-1)?.trim()).filter(Boolean))] as string[];
  const generic = new Set(["Movies", "TV", "Other", "SD", "HD", "General"]);
  const specific = leaves.filter((category) => !generic.has(category));
  const visible = (specific.length > 0 ? specific : leaves).slice(0, 4);
  if (visible.length === 0) return "未分类";
  const remaining = (specific.length > 0 ? specific : leaves).length - visible.length;
  return `${visible.join(" / ")}${remaining > 0 ? ` +${remaining}` : ""}`;
}

export function ReleaseRow({
  release,
  index,
  selected,
  loading,
  onSelect
}: {
  release: ReleaseSummary;
  index: number;
  selected: boolean;
  loading: boolean;
  onSelect: (release: ReleaseSummary, index: number) => void;
}) {
  const categoryText = formatCategories(release.categories);
  const qualityText = [release.resolution, release.codec].filter(Boolean).join("  |  ") || "规格未知";

  return (
    <li className={`release-row ${selected ? "is-selected" : ""}`}>
      <div className="release-index" aria-hidden="true">
        <span>{String(index).padStart(2, "0")}</span>
        {selected ? (
          <span className="selected-check">
            <Check size={15} strokeWidth={2.6} />
          </span>
        ) : null}
      </div>
      <div className="release-copy">
        <h3>{release.title}</h3>
        <p className="release-quality">{qualityText}</p>
        <p className="release-stats">
          <span>{formatBytes(release.size)}</span>
          <span aria-hidden="true">|</span>
          <span>做种: {formatNumber(release.seeders)}</span>
          <span aria-hidden="true">|</span>
          <span>{categoryText}</span>
        </p>
      </div>
      <button
        className={`outline-button release-select ${selected ? "is-selected" : ""}`}
        type="button"
        aria-label={selected ? "已选择" : "选择"}
        aria-pressed={selected}
        disabled={loading}
        onClick={() => onSelect(release, index)}
      >
        {loading ? <CircleDashed className="spin" size={17} aria-hidden="true" /> : selected ? "已选择" : "选择"}
      </button>
    </li>
  );
}

export function ReleaseList({
  releases,
  total,
  selectedId,
  selectingId,
  onSelect
}: {
  releases: ReleaseSummary[];
  total: number;
  selectedId: string | null;
  selectingId: string | null;
  onSelect: (release: ReleaseSummary, index: number) => void;
}) {
  return (
    <section className="release-list-panel" aria-labelledby="release-list-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">搜索结果</p>
          <h2 id="release-list-title">片源列表</h2>
        </div>
        {total > 0 ? <span className="result-count">{total} 个结果</span> : null}
      </div>
      {releases.length === 0 ? (
        <EmptyState title="没有匹配的片源" detail="换个片名、年份或豆瓣链接再试一次。" />
      ) : (
        <ol className="release-list">
          {releases.map((release, index) => (
            <ReleaseRow
              key={release.id}
              release={release}
              index={index + 1}
              selected={release.id === selectedId}
              loading={release.id === selectingId}
              onSelect={onSelect}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

export { formatNumber };
