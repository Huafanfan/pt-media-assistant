import { FormEvent, useState } from "react";
import type { DiscoveryCollectionId, DiscoveryItem, GrabResponse, ReleaseSummary } from "../shared/contracts";
import { ApiError, apiClient, type ApiClient } from "./api";
import { AppHeader } from "./components/AppHeader";
import { ChatThread } from "./components/ChatThread";
import { DiscoveryBrowser } from "./components/DiscoveryBrowser";
import { DiscoveryInspector } from "./components/DiscoveryInspector";
import { ModeSwitch, type AppMode } from "./components/ModeSwitch";
import { PairingGate } from "./components/PairingGate";
import { QueryComposer } from "./components/QueryComposer";
import { ReleaseList } from "./components/ReleaseList";
import { RuntimeSummary } from "./components/RuntimeSummary";
import { ErrorMessage, LoadingState, OfflineState } from "./components/States";
import { SelectionPanel } from "./components/SelectionPanel";
import { useRuntimeStatus } from "./hooks/useRuntimeStatus";
import { useDiscovery } from "./hooks/useDiscovery";
import { useServiceBootstrap } from "./hooks/useServiceBootstrap";
import type { ChatMessage, SearchState, SelectionState } from "./types";
import "./styles.css";
import "./discovery-shell.css";

function readableError(error: unknown): string {
  if (error instanceof ApiError && error.code === "GRAB_DISABLED") {
    return "下载操作当前关闭，已保留所选片源。";
  }
  const message = error instanceof Error ? error.message : "请求失败，请稍后再试。";
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "请求失败，请稍后再试。";
}

function messageId(): string {
  return `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function initialAssistantMessage(total: number): string {
  return `找到 ${total} 个匹配，已按做种数和体积排序。`;
}

export function App({ client = apiClient }: { client?: ApiClient } = {}) {
  const bootstrap = useServiceBootstrap(client);
  const [sessionOverride, setSessionOverride] = useState<typeof bootstrap.session>(null);
  const session = sessionOverride ?? bootstrap.session;
  const paired = Boolean(session?.paired);
  const csrfToken = session?.csrfToken ?? "";

  const [pairCode, setPairCode] = useState("");
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [mode, setMode] = useState<AppMode>("discover");
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [resultTotal, setResultTotal] = useState(0);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [grabResult, setGrabResult] = useState<GrabResponse | null>(null);
  const runtime = useRuntimeStatus(client, csrfToken, paired);
  const discovery = useDiscovery(client, csrfToken, paired);
  const [selectedDiscoveryItem, setSelectedDiscoveryItem] = useState<DiscoveryItem | null>(null);
  const [discoveryInspectorError, setDiscoveryInspectorError] = useState<string | null>(null);

  const sessionFailure = !bootstrap.loading && !session && bootstrap.sessionError;
  const pairingView = !bootstrap.loading && !sessionFailure && !paired;

  const healthError = bootstrap.healthError;

  const handlePair = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pairCode.length !== 6 || pairingLoading) {
      setPairingError("请输入六位数字配对码。");
      return;
    }

    setPairingLoading(true);
    setPairingError(null);
    try {
      const pairedSession = await client.pair({ code: pairCode });
      if (pairedSession.paired && pairedSession.csrfToken) {
        setSessionOverride(pairedSession);
      } else {
        setSessionOverride(await client.getSession());
      }
      setPairCode("");
    } catch (error) {
      setPairingError(readableError(error));
    } finally {
      setPairingLoading(false);
    }
  };

  const handleSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = query.trim();
    if (!nextQuery || searchState === "loading") {
      return;
    }
    if (!csrfToken) {
      setSearchError("会话已失效，请重新配对设备。");
      setSearchState("error");
      return;
    }

    setSearchState("loading");
    setSearchError(null);
    setReleases([]);
    setResultTotal(0);
    setSelection(null);
    setSelectionError(null);
    setInspectorExpanded(false);
    setGrabResult(null);
    setMessages((current) => [
      ...current,
      { id: messageId(), role: "user", text: nextQuery, createdAt: Date.now() }
    ]);

    try {
      const response = await client.search({ query: nextQuery, limit: 20 }, csrfToken);
      setReleases(response.releases);
      setResultTotal(response.total);
      setMessages((current) => [
        ...current,
        { id: messageId(), role: "assistant", text: initialAssistantMessage(response.total), createdAt: Date.now() }
      ]);
      setQuery("");
      setSearchState("success");
    } catch (error) {
      const message = readableError(error);
      setSearchError(message);
      setSearchState("error");
      setMessages((current) => [
        ...current,
        { id: messageId(), role: "assistant", text: "这次搜索没有完成，请检查服务状态后重试。", createdAt: Date.now() }
      ]);
    }
  };

  const handleSelect = async (release: ReleaseSummary, index: number) => {
    if (!csrfToken || selectingId) {
      return;
    }
    setSelectingId(release.id);
    setSelection({ release, index, preview: null });
    setInspectorExpanded(true);
    setSelectionError(null);
    setGrabResult(null);
    try {
      const preview = await client.grabPreview(release.id, csrfToken);
      setSelection({ release, index, preview });
    } catch (error) {
      setSelectionError(readableError(error));
    } finally {
      setSelectingId(null);
    }
  };

  const handleCancel = () => {
    if (confirmLoading) {
      return;
    }
    setSelection(null);
    setInspectorExpanded(false);
    setSelectionError(null);
    setGrabResult(null);
  };

  const resetReleaseSelection = () => {
    if (confirmLoading) return;
    setSelection(null);
    setSelectionError(null);
    setGrabResult(null);
  };

  const handleModeChange = (nextMode: AppMode) => {
    if (nextMode === mode || confirmLoading) return;
    setMode(nextMode);
    setInspectorExpanded(false);
    setSelection(null);
    setSelectionError(null);
    setGrabResult(null);
    if (nextMode === "search") {
      setSelectedDiscoveryItem(null);
      setDiscoveryInspectorError(null);
    }
  };

  const handleCollectionChange = (collection: DiscoveryCollectionId) => {
    discovery.setCollection(collection);
    setInspectorExpanded(false);
    setSelectedDiscoveryItem(null);
    setDiscoveryInspectorError(null);
    resetReleaseSelection();
  };

  const handleDiscoveryItem = (item: DiscoveryItem) => {
    if (confirmLoading) return;
    setSelectedDiscoveryItem(item);
    setDiscoveryInspectorError(null);
    resetReleaseSelection();
    void discovery.ensureAvailability(item).then((result) => {
      if (!result) setDiscoveryInspectorError("这次片源检查没有完成，请稍后重试。");
    });
  };

  const retryDiscoveryItem = () => {
    if (!selectedDiscoveryItem) return;
    setDiscoveryInspectorError(null);
    void discovery.ensureAvailability(selectedDiscoveryItem).then((result) => {
      if (!result) setDiscoveryInspectorError("这次片源检查没有完成，请稍后重试。");
    });
  };

  const handleConfirm = async () => {
    const preview = selection?.preview;
    if (!preview || !csrfToken || !preview.nasMounted || preview.duplicate || confirmLoading || grabResult?.accepted) {
      return;
    }

    setConfirmLoading(true);
    setSelectionError(null);
    try {
      // The confirm flag is intentionally hard-coded at this final, explicit
      // action boundary. Selecting a release only asks for a preview.
      const result = await client.grab({ releaseId: preview.release.id, confirm: true }, csrfToken);
      setGrabResult(result);
      if (result.accepted) {
        void runtime.refresh(false);
      }
    } catch (error) {
      setSelectionError(readableError(error));
    } finally {
      setConfirmLoading(false);
    }
  };

  if (bootstrap.loading) {
    return (
      <div className="app-shell">
        <AppHeader health={bootstrap.health} paired={false} healthError={bootstrap.healthError} />
        <main className="boot-state">
          <LoadingState label="正在连接片源服务…" />
        </main>
      </div>
    );
  }

  if (sessionFailure) {
    return (
      <div className="app-shell">
        <AppHeader health={bootstrap.health} paired={false} healthError={bootstrap.healthError} onRefresh={bootstrap.reload} />
        <main className="boot-state">
          <OfflineState detail={bootstrap.sessionError ?? "请确认片源服务正在运行。"} />
          <button className="outline-button retry-button" type="button" onClick={() => void bootstrap.reload()}>
            重试连接
          </button>
        </main>
      </div>
    );
  }

  if (pairingView) {
    return (
      <div className="app-shell">
        <AppHeader health={bootstrap.health} paired={false} healthError={bootstrap.healthError} />
        <PairingGate
          code={pairCode}
          onCodeChange={(value) => {
            setPairCode(value);
            if (pairingError) setPairingError(null);
          }}
          onSubmit={handlePair}
          loading={pairingLoading}
          error={pairingError}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <AppHeader health={bootstrap.health} paired={paired} healthError={healthError} onRefresh={() => void bootstrap.reload()} />
      <main className={`app-layout ${mode === "discover" ? "is-discovery" : "search-shell"}`}>
        {mode === "discover" ? (
          <>
            <section className="discovery-workspace" aria-label="发现影视">
              <div className="discovery-mode-toolbar">
                <ModeSwitch mode={mode} onChange={handleModeChange} />
              </div>
              {healthError ? <p className="workspace-warning" role="status">{healthError}</p> : null}
              <DiscoveryBrowser
                collection={discovery.collection}
                items={discovery.items}
                loading={discovery.loading}
                error={discovery.error}
                selectedItemId={selectedDiscoveryItem?.id ?? null}
                availabilityById={discovery.availabilityById}
                checkingIds={discovery.checkingIds}
                onCollectionChange={handleCollectionChange}
                onSelectItem={handleDiscoveryItem}
                onRetry={discovery.retryCollection}
              />
            </section>

            {selection ? (
              <SelectionPanel
                selection={selection}
                previewError={selectionError}
                expanded={inspectorExpanded}
                confirmLoading={confirmLoading}
                grabResult={grabResult}
                storage={runtime.storage}
                storageLoading={runtime.storageLoading}
                storageError={runtime.storageError}
                torrents={runtime.torrents}
                torrentsLoading={runtime.torrentsLoading}
                torrentsError={runtime.torrentsError}
                onToggle={() => setInspectorExpanded((current) => !current)}
                onCancel={resetReleaseSelection}
                onConfirm={handleConfirm}
                onRefreshRuntime={() => void runtime.refresh()}
              />
            ) : selectedDiscoveryItem ? (
              <div className="discovery-inspector-stack">
                <DiscoveryInspector
                  item={selectedDiscoveryItem}
                  releaseResponse={discovery.availabilityById[selectedDiscoveryItem.id] ?? null}
                  loading={discovery.checkingIds.has(selectedDiscoveryItem.id)}
                  error={discoveryInspectorError}
                  selectedReleaseId={null}
                  selectingId={selectingId}
                  onSelectRelease={(release) => {
                    const response = discovery.availabilityById[selectedDiscoveryItem.id];
                    const releaseIndex = response?.releases.findIndex((candidate) => candidate.id === release.id) ?? -1;
                    const index = releaseIndex >= 0 ? releaseIndex + 1 : 1;
                    void handleSelect(release, index);
                  }}
                  onClose={() => {
                    setSelectedDiscoveryItem(null);
                    setDiscoveryInspectorError(null);
                    setInspectorExpanded(false);
                  }}
                  onRetry={retryDiscoveryItem}
                />
                <RuntimeSummary
                  storage={runtime.storage}
                  torrents={runtime.torrents}
                  loading={runtime.storageLoading || runtime.torrentsLoading}
                  onRefresh={() => void runtime.refresh()}
                />
              </div>
            ) : (
              <SelectionPanel
                selection={null}
                previewError={null}
                expanded={inspectorExpanded}
                confirmLoading={false}
                grabResult={null}
                storage={runtime.storage}
                storageLoading={runtime.storageLoading}
                storageError={runtime.storageError}
                torrents={runtime.torrents}
                torrentsLoading={runtime.torrentsLoading}
                torrentsError={runtime.torrentsError}
                onToggle={() => setInspectorExpanded((current) => !current)}
                onCancel={handleCancel}
                onConfirm={handleConfirm}
                onRefreshRuntime={() => void runtime.refresh()}
              />
            )}
          </>
        ) : (
          <>
            <section className="chat-pane" aria-label="片源查询对话">
              <div className="search-mode-toolbar">
                <ModeSwitch mode={mode} onChange={handleModeChange} />
              </div>
              <ChatThread messages={messages} />
              {healthError ? <p className="workspace-warning" role="status">{healthError}</p> : null}
            </section>

            <aside className="results-pane" aria-label="片源搜索结果">
              <div className="results-scroll">
                {searchState === "loading" ? <LoadingState label="正在查找片源…" /> : null}
                {searchState === "error" && searchError ? <ErrorMessage message={searchError} /> : null}
                {searchState !== "loading" ? (
                  <ReleaseList
                    releases={releases}
                    total={resultTotal}
                    selectedId={selection?.release.id ?? null}
                    selectingId={selectingId}
                    onSelect={handleSelect}
                  />
                ) : null}
              </div>
            </aside>

            <SelectionPanel
              selection={selection}
              previewError={selectionError}
              expanded={inspectorExpanded}
              confirmLoading={confirmLoading}
              grabResult={grabResult}
              storage={runtime.storage}
              storageLoading={runtime.storageLoading}
              storageError={runtime.storageError}
              torrents={runtime.torrents}
              torrentsLoading={runtime.torrentsLoading}
              torrentsError={runtime.torrentsError}
              onToggle={() => setInspectorExpanded((current) => !current)}
              onCancel={handleCancel}
              onConfirm={handleConfirm}
              onRefreshRuntime={() => void runtime.refresh()}
            />

            <div className="composer-dock">
              <QueryComposer
                value={query}
                onChange={setQuery}
                onSubmit={handleSearch}
                loading={searchState === "loading"}
                disabled={!paired}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
