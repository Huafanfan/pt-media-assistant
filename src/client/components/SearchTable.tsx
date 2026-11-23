import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import type { ReleaseSummary } from "../../shared/contracts";
import { formatBytes } from "./ReleaseList";

const PAGE_SIZE = 20;
function number(value: number): string { return Number.isFinite(value) && value >= 0 ? value.toLocaleString("zh-CN") : "—"; }
function age(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1 / 24) return "1 小时内";
  if (value < 1) return `${Math.floor(value * 24)} 小时前`;
  return `${Math.floor(value)} 天前`;
}
function matchesResolution(release: ReleaseSummary, resolution: string): boolean {
  if (!resolution) return true;
  const value = release.resolution ?? release.title;
  return resolution === "2160p" ? /(?:2160p?|4k)/i.test(value) : new RegExp(resolution, "i").test(value);
}

export function SearchTable({ releases, resolution, selected, onToggle, searching, searched, downloading, downloadDisabled, onDownload }: {
  releases: ReleaseSummary[]; resolution: string; selected: Set<string>;
  onToggle: (ids: string[], checked: boolean) => void;
  searching: boolean; searched: boolean; downloading: boolean; downloadDisabled: boolean; onDownload: () => void;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [releases, resolution]);
  const filtered = releases.filter(release => matchesResolution(release, resolution));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selectedCount = releases.filter(release => selected.has(release.id)).length;
  const visibleSelected = visible.filter(release => selected.has(release.id)).length;
  const all = visible.length > 0 && visibleSelected === visible.length;
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (checkbox.current) checkbox.current.indeterminate = visibleSelected > 0 && !all; }, [all, visibleSelected]);
  return <div className="search-results" aria-busy={searching}>
    <div className="results-toolbar"><div><strong>{filtered.length} 个结果</strong><span>已选 {selectedCount} 个</span>{releases.length >= 50 ? <small>本次最多显示 50 条</small> : null}</div><button type="button" className="primary-button" onClick={onDownload} disabled={selectedCount === 0 || downloading || searching || downloadDisabled}><Download size={17} aria-hidden="true" />{downloading ? "正在添加…" : `下载所选${selectedCount ? `（${selectedCount}）` : ""}`}</button></div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="片源结果列表">
      <table className="release-table"><thead><tr>
        <th className="check-cell"><input ref={checkbox} type="checkbox" aria-label="选择本页全部片源" checked={all} disabled={!visible.length || downloading} onChange={event => onToggle(visible.map(release => release.id), event.target.checked)} /></th>
        <th scope="col" className="title-cell">标题</th><th scope="col">发布时间</th><th scope="col">体积</th><th scope="col">做种</th><th scope="col">下载中</th>
      </tr></thead><tbody>{visible.map(release => <tr key={release.id} className={selected.has(release.id) ? "is-selected" : undefined}>
        <td className="check-cell"><input id={`release-${release.id}`} type="checkbox" aria-label={`选择 ${release.title}`} checked={selected.has(release.id)} disabled={downloading} onChange={event => onToggle([release.id], event.target.checked)} /></td>
        <td className="title-cell"><label htmlFor={`release-${release.id}`} className="release-name">{release.title}</label><p className="release-detail">{[release.resolution, release.codec, release.source, release.hdr, release.indexer].filter(Boolean).join(" / ")}</p></td>
        <td>{age(release.ageDays)}</td><td>{release.evidence?.size === "unknown" ? "—" : formatBytes(release.size)}</td><td className="seed-count">{release.evidence?.seeders === "unknown" ? "—" : number(release.seeders)}</td><td>{number(release.leechers)}</td>
      </tr>)}</tbody></table>
    </div>
    {searching ? <div className="table-empty search-pending" role="status" aria-live="polite">
      <span className="search-pending-message"><LoaderCircle className="spin" size={18} aria-hidden="true" />正在搜索片源…</span>
      <span className="search-pending-detail">等待当前查询返回结果。</span>
    </div> : !visible.length ? <div className="table-empty" role="status">{!searched ? "输入片名或发布名开始搜索" : releases.length ? "没有符合清晰度的片源" : "没有找到片源，试试其他片名或英文名"}</div> : null}
    <footer className="table-footer"><span>{filtered.length ? `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)} 条，共 ${filtered.length} 条` : "0 条"}</span><div className="pagination"><button type="button" disabled={currentPage === 1} onClick={() => setPage(current => current - 1)}>上一页</button><span aria-label={`第 ${currentPage} 页，共 ${pageCount} 页`}>{currentPage}</span><button type="button" disabled={currentPage === pageCount} onClick={() => setPage(current => current + 1)}>下一页</button></div></footer>
  </div>;
}
