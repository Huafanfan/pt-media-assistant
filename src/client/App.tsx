import { useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, CircleAlert, CircleX, Film, LoaderCircle, Search } from "lucide-react";
import type { GrabPreviewResponse, SearchResponse, TorrentAction } from "../shared/contracts";
import { apiClient, type ApiClient } from "./api";
import { PairingGate } from "./components/PairingGate";
import { SearchTable } from "./components/SearchTable";
import { ServiceHealthIndicator } from "./components/ServiceHealthIndicator";
import { TaskView } from "./components/TaskView";
import { useRuntimeStatus } from "./hooks/useRuntimeStatus";
import { useServiceBootstrap } from "./hooks/useServiceBootstrap";
import "./simple.css";
import "./tasks.css";

export function readableError(error: unknown): string {
  return (error instanceof Error ? error.message : "请求失败，请稍后重试。")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

type DownloadOutcome = { id: string; title: string; ok: boolean; message: string };

export function App({ client = apiClient }: { client?: ApiClient } = {}) {
  const bootstrap = useServiceBootstrap(client);
  const [pairedSession, setPairedSession] = useState<typeof bootstrap.session>(null);
  const session = pairedSession ?? bootstrap.session;
  const paired = Boolean(session?.paired);
  const csrf = session?.csrfToken ?? "";
  const runtime = useRuntimeStatus(client, csrf, paired);
  const [page, setPage] = useState<"search" | "tasks">("search");
  const [query, setQuery] = useState("");
  const [resolution, setResolution] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadPhase, setDownloadPhase] = useState<"preflight" | "confirm" | null>(null);
  const [outcomes, setOutcomes] = useState<DownloadOutcome[]>([]);
  // A ref closes the double-click window before React commits disabled controls.
  const downloadLock = useRef(false);
  const searchLock = useRef(false);
  const [taskPending, setTaskPending] = useState(false);
  const taskLock = useRef(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [pairPending, setPairPending] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pairPending || pairCode.length !== 6) return;
    setPairPending(true);
    setPairError(null);
    try {
      const value = await client.pair({ code: pairCode });
      setPairedSession(value.csrfToken ? value : await client.getSession());
      setPairCode("");
    } catch (error) { setPairError(readableError(error)); }
    finally { setPairPending(false); }
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = query.trim();
    if (!term || !csrf || searchLock.current || downloadLock.current) return;
    searchLock.current = true;
    setSearching(true);
    setSearchError(null);
    setResults(null);
    setSelected(new Set());
    setOutcomes([]);
    try { setResults(await client.search({ query: term, limit: 50 }, csrf)); }
    catch (error) { setSearchError(readableError(error)); }
    finally { searchLock.current = false; setSearching(false); }
  }

  function toggle(ids: string[], checked: boolean) {
    if (downloadLock.current) return;
    setSelected(current => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  }

  async function download() {
    if (!csrf || downloadLock.current || searchLock.current) return;
    const batch = results?.releases.filter(release => selected.has(release.id)) ?? [];
    if (!batch.length) return;
    downloadLock.current = true;
    setDownloading(true);
    setOutcomes([]);
    try {
      for (const release of batch) {
        setDownloadPhase("preflight");
        let preview: GrabPreviewResponse;
        try {
          preview = await client.grabPreview(release.id, csrf);
          if (preview.release.id !== release.id) throw new Error("片源信息已变化，请重新搜索。");
          if (!preview.nasMounted) throw new Error("NAS 未就绪，未添加下载。");
          if (preview.duplicate) throw new Error("任务已存在，无需重复下载。");
        } catch (error) {
          setOutcomes(current => [...current, { id: release.id, title: release.title, ok: false, message: readableError(error) }]);
          continue;
        }
        try {
          // Only this explicit Download selected action can confirm a grab.
          setDownloadPhase("confirm");
          const result = await client.grab({ releaseId: preview.release.id, confirm: true }, csrf);
          setOutcomes(current => [...current, {
            id: release.id, title: release.title, ok: result.accepted,
            message: result.accepted ? (result.initialState === "stopped" ? "已添加（暂停状态）" : "已添加到下载任务") : result.message,
          }]);
          if (result.accepted) setSelected(current => { const next = new Set(current); next.delete(release.id); return next; });
        } catch (error) {
          setOutcomes(current => [...current, { id: release.id, title: release.title, ok: false, message: `${readableError(error)} 请先到任务页核对是否已添加。` }]);
        }
      }
      await runtime.refresh(false);
    } finally { downloadLock.current = false; setDownloading(false); setDownloadPhase(null); }
  }

  async function taskAction(action: TorrentAction, hashes: string[]): Promise<boolean> {
    if (!csrf || !client.torrentAction || taskLock.current) return false;
    taskLock.current = true;
    setTaskPending(true);
    setTaskError(null);
    try {
      const result = await client.torrentAction({ action, hashes }, csrf);
      await runtime.refresh(false);
      return result.ok;
    } catch (error) { setTaskError(readableError(error)); return false; }
    finally { taskLock.current = false; setTaskPending(false); }
  }

  const selectedCount = results?.releases.filter(release => selected.has(release.id)).length ?? 0;
  const allowGrab = bootstrap.health?.capabilities?.grab.enabled !== false;
  const addedCount = outcomes.filter(item => item.ok).length;
  const notAddedCount = outcomes.length - addedCount;
  const downloadBatchCount = selectedCount + addedCount;
  const activeDownloadIndex = Math.min(outcomes.length + 1, downloadBatchCount);
  const feedbackTone = downloading ? "pending" : notAddedCount === 0 ? "success" : addedCount === 0 ? "error" : "warning";

  return <div className="simple-app">
    <header className="app-header">
      <a href="#search" className="brand" onClick={() => setPage("search")}><span className="brand-mark"><Film size={20} strokeWidth={1.8} aria-hidden="true" /></span><span>片源助手</span></a>
      <nav aria-label="主导航">
        <button type="button" aria-current={page === "search" ? "page" : undefined} onClick={() => setPage("search")}>搜索</button>
        <button type="button" aria-current={page === "tasks" ? "page" : undefined} onClick={() => setPage("tasks")}>任务</button>
      </nav>
      <div className="header-actions">
        <ServiceHealthIndicator health={bootstrap.health} loading={bootstrap.healthLoading} error={bootstrap.healthError} onRefresh={bootstrap.refreshHealth} />
        <a className="server-link" href="http://192.168.1.2:18083/"><ArrowLeft aria-hidden="true" />服务导航</a>
      </div>
    </header>
    {bootstrap.loading ? <main className="connection-state" role="status">正在连接片源服务…</main>
    : !session ? <main className="connection-state"><h1>暂时无法连接</h1><p role="alert">{bootstrap.sessionError}</p><button type="button" onClick={() => void bootstrap.reload()}>重试</button></main>
    : !paired ? <PairingGate code={pairCode} onCodeChange={setPairCode} onSubmit={pair} loading={pairPending} error={pairError} />
    : <main className="app-main">
      {page === "search" ? <section aria-label="搜索片源">
        <h1 className="sr-only">搜索片源</h1>
        <form className="search-form" role="search" onSubmit={event => void search(event)}>
          <label className="search-input"><Search size={19} aria-hidden="true" /><span className="sr-only">片名或发布名</span><input type="search" placeholder="搜索片名或发布名" value={query} maxLength={240} onChange={event => { setQuery(event.target.value); setResults(null); setSelected(new Set()); setOutcomes([]); setSearchError(null); }} disabled={downloading || searching} /></label>
          <button className="primary-button search-submit" type="submit" disabled={!query.trim() || searching || downloading || !csrf} aria-busy={searching}>{searching ? <><LoaderCircle className="spin" size={16} aria-hidden="true" />搜索中…</> : "搜索"}</button>
          <label className="resolution-filter"><span className="sr-only">清晰度</span><select value={resolution} onChange={event => { setResolution(event.target.value); setSelected(new Set()); }} disabled={downloading}><option value="">清晰度：不限</option><option value="2160p">4K / 2160p</option><option value="1080p">1080p</option><option value="720p">720p</option></select></label>
        </form>
        {searchError ? <p className="inline-error" role="alert">{searchError}</p> : null}
        {!csrf ? <p className="inline-error" role="alert">会话已失效，请刷新页面。</p> : null}
        {!allowGrab ? <p className="inline-error" role="alert">下载操作当前关闭，仍可搜索和查看任务。</p> : null}
        {downloading || outcomes.length ? <div className="download-feedback" data-tone={feedbackTone}>
          <div className="feedback-heading"><strong className="feedback-summary" role="status" aria-live="polite">
            {downloading
              ? <><LoaderCircle className="spin" size={16} aria-hidden="true" />{downloadPhase === "confirm" ? "正在提交下载请求" : "正在检查下载条件"}（{activeDownloadIndex} / {downloadBatchCount}）</>
              : <>{notAddedCount === 0 ? <CheckCircle2 size={16} aria-hidden="true" /> : addedCount === 0 ? <CircleX size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}已添加 {addedCount} 个，未添加 {notAddedCount} 个</>}
          </strong><button className="text-button" type="button" onClick={() => setPage("tasks")}>查看任务</button></div>
          <ul>{outcomes.map(item => <li key={item.id} className={item.ok ? "feedback-ok" : "feedback-error"}>
            <span className="feedback-title" title={item.title}>{item.title}</span>
            <span className="feedback-outcome"><strong className="feedback-status">
              {item.ok ? <CheckCircle2 size={15} aria-hidden="true" /> : <CircleX size={15} aria-hidden="true" />}
              {item.ok ? "已添加" : "未添加"}
            </strong><span className="feedback-message">{item.message}</span></span>
          </li>)}</ul>
        </div> : null}
        <SearchTable releases={results?.releases ?? []} resolution={resolution} selected={selected} onToggle={toggle} searching={searching} searched={Boolean(results)} downloading={downloading} downloadDisabled={!allowGrab || !csrf} onDownload={() => void download()} />
      </section> : <TaskView torrents={runtime.torrents} loading={runtime.torrentsLoading} error={runtime.torrentsError} actionError={taskError} actionPending={taskPending || !csrf || !client.torrentAction} onRefresh={() => void runtime.refresh()} onAction={taskAction} />}
    </main>}
  </div>;
}
