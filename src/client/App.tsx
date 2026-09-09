import { FormEvent, useRef, useState } from "react";
import type {
  DiscoveryActor,
  DiscoveryActorWork,
  DiscoveryCollectionId,
  DiscoveryItem,
  DiscoveryMedia,
  DiscoveryReleaseResponse,
  GrabResponse,
  ReleaseSummary
} from "../shared/contracts";
import type { AssistantRecommendationCard } from "../shared/assistant";
import { ApiError, apiClient, type ApiClient } from "./api";
import { AppHeader } from "./components/AppHeader";
import { ActorView } from "./components/ActorView";
import { AssistantPreferences } from "./components/AssistantPreferences";
import { AssistantRecommendations } from "./components/AssistantRecommendations";
import { AssistantThread } from "./components/AssistantThread";
import { ChatThread } from "./components/ChatThread";
import { DiscoveryBrowser } from "./components/DiscoveryBrowser";
import { MediaInspector } from "./components/MediaInspector";
import { MediaSearchResults } from "./components/MediaSearchResults";
import { ModeSwitch, type AppMode } from "./components/ModeSwitch";
import { PairingGate } from "./components/PairingGate";
import { QueryComposer } from "./components/QueryComposer";
import { RuntimeStatusBar } from "./components/RuntimeSummary";
import { LoadingState, OfflineState } from "./components/States";
import { SelectionPanel } from "./components/SelectionPanel";
import { useRuntimeStatus } from "./hooks/useRuntimeStatus";
import { useDiscovery } from "./hooks/useDiscovery";
import { useDiscoveryActor } from "./hooks/useDiscoveryActor";
import { useMediaInspector } from "./hooks/useMediaInspector";
import { useAssistant } from "./hooks/useAssistant";
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
  return `找到 ${total} 部作品，选择作品查看详情和片源。`;
}

function assistantCardMedia(card: AssistantRecommendationCard): DiscoveryMedia {
  return {
    id: card.mediaId,
    title: card.title,
    ...(card.originalTitle ? { originalTitle: card.originalTitle } : {}),
    ...(card.year ? { year: card.year } : {}),
    mediaType: card.mediaType,
    genres: card.genres,
    summary: card.summary,
    sourceUrl: ""
  };
}

function assistantCardReleases(card: AssistantRecommendationCard): DiscoveryReleaseResponse {
  return {
    ...(card.snapshotId ? { snapshotId: card.snapshotId } : {}),
    ...(card.expiresAt ? { expiresAt: card.expiresAt } : {}),
    ...(card.actionableUntil ? { actionableUntil: card.actionableUntil } : {}),
    itemId: card.mediaId,
    query: `${card.title}${card.year ? ` ${card.year}` : ""}`,
    status: card.availability === "available" ? "available" : card.availability === "possible" ? "possible" : "unavailable",
    checkedAt: card.checkedAt ?? new Date(0).toISOString(),
    total: card.rankedReleases.length,
    releases: card.rankedReleases
  };
}

function assistantReleaseResponseExpired(response: DiscoveryReleaseResponse | null | undefined): boolean {
  const expires = response?.actionableUntil ?? response?.expiresAt;
  return Boolean(expires && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= Date.now());
}

function assistantDownloadIntent(message: string): boolean {
  return /(?:下载|加入下载|抓取)|(?:帮我|我要|我想).{0,12}(?:下|抓)/u.test(message);
}

function parseAssistantOrdinal(value: string): number | null {
  if (/^\d+$/u.test(value)) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
  }
  const direct: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (direct[value]) return direct[value];
  if (value.length === 2 && value.startsWith("十")) {
    const ones = direct[value[1] ?? ""];
    return ones ? 10 + ones : null;
  }
  if (value.length === 2 && value.endsWith("十")) {
    const tens = direct[value[0] ?? ""];
    return tens ? tens * 10 : null;
  }
  if (value.length === 3 && value[1] === "十") {
    const tens = direct[value[0] ?? ""];
    const ones = direct[value[2] ?? ""];
    return tens && ones ? tens * 10 + ones : null;
  }
  return null;
}

export function assistantReferenceIndex(message: string): number | null {
  const match = message.match(/第\s*([0-9]+|[一二三四五六七八九十]+)\s*(?:部|个版本?|项)?/u);
  if (!match) return null;
  const value = parseAssistantOrdinal(match[1] ?? "");
  return value === null ? null : value - 1;
}

type MediaOrigin =
  | { kind: "collection"; collection: DiscoveryCollectionId; page: number }
  | { kind: "actor"; actorName: string }
  | { kind: "search"; query: string }
  | { kind: "assistant"; cardId: string };

type ActorNavigationEntry = {
  actorName: string | null;
  item: DiscoveryMedia;
  origin: MediaOrigin;
};

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
  const [mediaSearchItems, setMediaSearchItems] = useState<DiscoveryMedia[]>([]);
  const [mediaSearchLoading, setMediaSearchLoading] = useState(false);
  const [mediaSearchError, setMediaSearchError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [grabResult, setGrabResult] = useState<GrabResponse | null>(null);
  const assistant = useAssistant(client, csrfToken, paired);
  const [assistantSelectedCard, setAssistantSelectedCard] = useState<AssistantRecommendationCard | null>(null);
  const [assistantReleaseResponses, setAssistantReleaseResponses] = useState<Record<string, DiscoveryReleaseResponse>>({});
  const [assistantReleaseLoading, setAssistantReleaseLoading] = useState(false);
  const [assistantReleaseError, setAssistantReleaseError] = useState<string | null>(null);
  const assistantRefreshRevision = useRef(0);
  const runtime = useRuntimeStatus(client, csrfToken, paired);
  const discovery = useDiscovery(client, csrfToken, paired);
  const [selectedMediaItem, setSelectedMediaItem] = useState<DiscoveryMedia | null>(null);
  const [mediaOrigin, setMediaOrigin] = useState<MediaOrigin | null>(null);
  const [selectedActorName, setSelectedActorName] = useState<string | null>(null);
  const [actorHistory, setActorHistory] = useState<ActorNavigationEntry[]>([]);
  const [discoveryInspectorError, setDiscoveryInspectorError] = useState<string | null>(null);
  const [discoveryDetailsError, setDiscoveryDetailsError] = useState<string | null>(null);
  const actor = useDiscoveryActor(client, csrfToken, selectedActorName, paired && Boolean(selectedActorName));
  const standaloneMedia = useMediaInspector(
    client,
    csrfToken,
    selectedMediaItem,
    Boolean(selectedMediaItem && mediaOrigin && mediaOrigin.kind !== "collection"),
    mediaOrigin?.kind !== "assistant"
  );
  const runtimeStatus = paired ? (
    <RuntimeStatusBar
      storage={runtime.storage}
      storageLoading={runtime.storageLoading}
      torrents={runtime.torrents}
    />
  ) : null;
  const refreshAllStatus = () => {
    void Promise.allSettled([bootstrap.refreshHealth(), runtime.refresh()]);
  };
  const hasInspector = Boolean(selection || selectedMediaItem || selectedActorName);

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
      setMediaSearchError("会话已失效，请重新配对设备。");
      setSearchState("error");
      return;
    }

    setSearchState("loading");
    setMediaSearchItems([]);
    setMediaSearchError(null);
    setMediaSearchLoading(true);
    setSelection(null);
    setSelectionError(null);
    setInspectorExpanded(false);
    setGrabResult(null);
    setSelectedMediaItem(null);
    setMediaOrigin(null);
    setSelectedActorName(null);
    setActorHistory([]);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
    setMessages((current) => [
      ...current,
      { id: messageId(), role: "user", text: nextQuery, createdAt: Date.now() }
    ]);

    try {
      const response = await client.searchDiscoveryMedia(nextQuery, csrfToken, 10);
      setMediaSearchItems(response.items);
      setMediaSearchError(null);
      setMediaSearchLoading(false);
      setMessages((current) => [
        ...current,
        { id: messageId(), role: "assistant", text: initialAssistantMessage(response.total), createdAt: Date.now() }
      ]);
      setQuery("");
      setSearchState("success");
    } catch (error) {
      setMediaSearchLoading(false);
      const message = readableError(error);
      setMediaSearchItems([]);
      setMediaSearchError(message);
      setSearchState("error");
      setMessages((current) => [
        ...current,
        { id: messageId(), role: "assistant", text: "这次搜索没有完成，请检查服务状态后重试。", createdAt: Date.now() }
      ]);
    }
  };

  const handleAssistantCard = (card: AssistantRecommendationCard) => {
    if (confirmLoading) return;
    const existingSnapshot = assistantReleaseResponses[card.cardId];
    const snapshot = existingSnapshot ?? assistantCardReleases(card);
    assistantRefreshRevision.current += 1;
    setAssistantSelectedCard(card);
    setAssistantReleaseResponses((current) => ({
      ...current,
      [card.cardId]: current[card.cardId] ?? assistantCardReleases(card)
    }));
    setAssistantReleaseError(assistantReleaseResponseExpired(snapshot)
      ? "这张推荐的片源引用已过期，请显式刷新后重新选择。"
      : !existingSnapshot && card.availability === "error"
        ? "这部作品的片源检查失败，请显式刷新后重试。"
        : !existingSnapshot && card.availability === "unchecked"
          ? "这部作品尚未检查片源，请显式刷新后查看候选。"
          : null);
    setAssistantReleaseLoading(false);
    setSelectedMediaItem(assistantCardMedia(card));
    setMediaOrigin({ kind: "assistant", cardId: card.cardId });
    setSelectedActorName(null);
    setActorHistory([]);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
    resetReleaseSelection();
  };

  const handleAssistantSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = query.trim();
    if (!nextQuery || assistant.loading) return;
    // References such as “第二部” belong to the cards visible before this
    // turn. Keep that snapshot stable while the server generates the reply.
    const displayedCards = assistant.cards;
    const displayedSelection = assistantSelectedCard;
    setQuery("");
    const response = await assistant.submit(nextQuery);
    if (!response || !assistantDownloadIntent(nextQuery)) return;

    const requestedIndex = assistantReferenceIndex(nextQuery);
    const card = requestedIndex !== null
      ? displayedCards[requestedIndex]
      : displayedSelection;
    if (card) handleAssistantCard(card);
  };

  const handleSelect = async (release: ReleaseSummary, index: number) => {
    if (mediaOrigin?.kind === "assistant") {
      const snapshot = assistantReleaseResponses[mediaOrigin.cardId];
      if (assistantReleaseResponseExpired(snapshot)) {
        setAssistantReleaseError("片源引用已过期，请刷新后重新选择。"); return;
      }
    }
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

  const resetReleaseSelection = () => {
    if (confirmLoading) return;
    setSelection(null);
    setInspectorExpanded(false);
    setSelectionError(null);
    setGrabResult(null);
  };

  const handleModeChange = (nextMode: AppMode) => {
    if (nextMode === mode || confirmLoading) return;
    assistantRefreshRevision.current += 1;
    setMode(nextMode);
    setInspectorExpanded(false);
    setSelection(null);
    setSelectionError(null);
    setGrabResult(null);
    setSelectedMediaItem(null);
    setMediaOrigin(null);
    setAssistantSelectedCard(null);
    setAssistantReleaseError(null);
    setAssistantReleaseLoading(false);
    setSelectedActorName(null);
    setActorHistory([]);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
  };

  const handleCollectionChange = (collection: DiscoveryCollectionId) => {
    discovery.setCollection(collection);
    setInspectorExpanded(false);
    setSelectedMediaItem(null);
    setMediaOrigin(null);
    setSelectedActorName(null);
    setActorHistory([]);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
    resetReleaseSelection();
  };

  const handleDiscoveryPageChange = (page: number) => {
    discovery.setPage(page);
    setInspectorExpanded(false);
    setSelectedMediaItem(null);
    setMediaOrigin(null);
    setSelectedActorName(null);
    setActorHistory([]);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
    resetReleaseSelection();
  };

  const handleMediaItem = (item: DiscoveryMedia, origin: MediaOrigin) => {
    if (confirmLoading) return;
    if (origin.kind !== "actor") {
      setSelectedActorName(null);
      setActorHistory([]);
    }
    setSelectedMediaItem(item);
    setMediaOrigin(origin);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
    resetReleaseSelection();
    if (origin.kind === "collection") {
      void Promise.all([discovery.ensureAvailability(item), discovery.ensureDetails(item)]).then(([availability, details]) => {
        if (!availability) setDiscoveryInspectorError("这次片源检查没有完成，请稍后重试。");
        if (!details) setDiscoveryDetailsError("演职员信息暂时不可用，可以稍后重试。");
      });
    }
  };

  const handleDiscoveryItem = (item: DiscoveryItem) => {
    handleMediaItem(item, { kind: "collection", collection: discovery.collection, page: discovery.page });
  };

  const handleSelectActor = (selectedActor: DiscoveryActor) => {
    if (confirmLoading || !selectedMediaItem || !mediaOrigin) return;
    setActorHistory((current) => [...current, {
      actorName: selectedActorName,
      item: selectedMediaItem,
      origin: mediaOrigin
    }]);
    setSelectedMediaItem(null);
    setMediaOrigin(null);
    setSelectedActorName(selectedActor.name);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
    resetReleaseSelection();
  };

  const handleActorBack = () => {
    const previous = actorHistory[actorHistory.length - 1];
    if (!previous) {
      setSelectedActorName(null);
      setSelectedMediaItem(null);
      setMediaOrigin(null);
      return;
    }
    setActorHistory((current) => current.slice(0, -1));
    setSelectedActorName(previous.actorName);
    setSelectedMediaItem(previous.item);
    setMediaOrigin(previous.origin);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
  };

  const handleActorWork = (work: DiscoveryActorWork) => {
    if (!selectedActorName) return;
    handleMediaItem(work, { kind: "actor", actorName: selectedActorName });
  };

  const closeMediaInspector = () => {
    if (confirmLoading) return;
    assistantRefreshRevision.current += 1;
    setSelectedMediaItem(null);
    setMediaOrigin(null);
    setAssistantSelectedCard(null);
    setAssistantReleaseError(null);
    setAssistantReleaseLoading(false);
    setDiscoveryInspectorError(null);
    setDiscoveryDetailsError(null);
    setInspectorExpanded(false);
  };

  const retryDiscoveryItem = () => {
    if (!selectedMediaItem || !mediaOrigin) return;
    if (mediaOrigin.kind === "assistant") {
      if (!client.refreshDiscoveryMediaReleases) {
        setAssistantReleaseError("片源刷新暂时不可用，请按片名搜索。");
        return;
      }
      const cardId = mediaOrigin.cardId;
      const revision = assistantRefreshRevision.current + 1;
      assistantRefreshRevision.current = revision;
      setAssistantReleaseLoading(true);
      setAssistantReleaseError(null);
      void client.refreshDiscoveryMediaReleases(selectedMediaItem.mediaType, selectedMediaItem.id, csrfToken, 10)
        .then((response) => {
          if (assistantRefreshRevision.current !== revision) return;
          setAssistantReleaseResponses((current) => ({ ...current, [cardId]: response }));
          setAssistantSelectedCard((current) => current?.cardId === cardId
            ? {
                ...current,
                ...(response.checkedAt ? { checkedAt: response.checkedAt } : {}),
                ...(response.snapshotId ? { snapshotId: response.snapshotId } : {}),
                ...(response.expiresAt ? { expiresAt: response.expiresAt } : {}),
                ...(response.actionableUntil ? { actionableUntil: response.actionableUntil } : {})
              }
            : current);
        })
        .catch((error: unknown) => {
          if (assistantRefreshRevision.current !== revision) return;
          setAssistantReleaseError(readableError(error));
        })
        .finally(() => {
          if (assistantRefreshRevision.current === revision) setAssistantReleaseLoading(false);
        });
      return;
    }
    if (mediaOrigin.kind === "collection") {
      setDiscoveryInspectorError(null);
      void discovery.refreshAvailability(selectedMediaItem).then((result) => {
        if (!result) setDiscoveryInspectorError("这次片源检查没有完成，请稍后重试。");
      });
      return;
    }
    standaloneMedia.retryAvailability();
  };

  const retryDiscoveryDetails = () => {
    if (!selectedMediaItem || !mediaOrigin) return;
    if (mediaOrigin.kind === "collection") {
      setDiscoveryDetailsError(null);
      void discovery.ensureDetails(selectedMediaItem).then((result) => {
        if (!result) setDiscoveryDetailsError("演职员信息暂时不可用，可以稍后重试。");
      });
      return;
    }
    standaloneMedia.retryDetails();
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

  const collectionOrigin = mediaOrigin?.kind === "collection" ? mediaOrigin : null;
  const selectedDetails = selectedMediaItem && collectionOrigin
    ? discovery.detailsById[selectedMediaItem.id] ?? null
    : standaloneMedia.details;
  const selectedDetailsLoading = Boolean(selectedMediaItem && collectionOrigin
    ? discovery.detailsLoadingIds.has(selectedMediaItem.id)
    : standaloneMedia.detailsLoading);
  const selectedDetailsError = collectionOrigin ? discoveryDetailsError : standaloneMedia.detailsError;
  const selectedReleases = mediaOrigin?.kind === "assistant" ? assistantReleaseResponses[mediaOrigin.cardId] ?? null : selectedMediaItem && collectionOrigin
    ? discovery.availabilityById[selectedMediaItem.id] ?? null
    : standaloneMedia.releaseResponse;
  const selectedReleaseLoading = mediaOrigin?.kind === "assistant" ? assistantReleaseLoading : Boolean(selectedMediaItem && collectionOrigin
    ? discovery.checkingIds.has(selectedMediaItem.id)
    : standaloneMedia.releaseLoading);
  const selectedReleaseError = mediaOrigin?.kind === "assistant" ? assistantReleaseError : collectionOrigin ? discoveryInspectorError : standaloneMedia.releaseError;

  const mediaInspector = selectedMediaItem ? (
    <div className="discovery-inspector-stack">
      <MediaInspector
        item={selectedMediaItem}
        details={selectedDetails}
        detailsLoading={selectedDetailsLoading}
        detailsError={selectedDetailsError}
        releaseResponse={selectedReleases}
        loading={selectedReleaseLoading}
        error={selectedReleaseError}
        selectedReleaseId={null}
        selectingId={selectingId}
        onSelectRelease={(release) => {
          const releaseIndex = selectedReleases?.releases.findIndex((candidate) => candidate.id === release.id) ?? -1;
          const index = releaseIndex >= 0 ? releaseIndex + 1 : 1;
          void handleSelect(release, index);
        }}
        onClose={closeMediaInspector}
        onRetry={retryDiscoveryItem}
        onRetryDetails={retryDiscoveryDetails}
        onSelectActor={handleSelectActor}
      />
    </div>
  ) : null;

  const actorInspector = selectedActorName ? (
    <div className="discovery-inspector-stack">
      <ActorView
        profile={actor.profile}
        page={actor.page}
        loading={actor.loading}
        error={actor.error}
        onBack={handleActorBack}
        onSelectWork={handleActorWork}
        onPageChange={actor.setPage}
        onRetry={actor.retry}
      />
    </div>
  ) : null;

  const selectionPanel = selection ? (
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
  ) : null;

  const activeInspector = selectionPanel ?? mediaInspector ?? actorInspector;

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
      <AppHeader
        health={bootstrap.health}
        paired={paired}
        healthError={healthError}
        onRefresh={refreshAllStatus}
        runtimeStatus={runtimeStatus}
      />
      <main className={`app-layout ${mode === "discover" ? "is-discovery" : "search-shell"} ${hasInspector ? "has-inspector" : "no-inspector"}`}>
        {mode === "discover" ? (
          <>
            <section className="discovery-workspace" aria-label="发现影视">
              <div className="discovery-mode-toolbar">
                <ModeSwitch mode={mode} onChange={handleModeChange} />
              </div>
              {healthError ? <p className="workspace-warning" role="status">{healthError}</p> : null}
              <DiscoveryBrowser
                collection={discovery.collection}
                page={discovery.page}
                pageSize={discovery.pageSize}
                items={discovery.items}
                total={discovery.total}
                hasNext={discovery.hasNext}
                loading={discovery.loading}
                error={discovery.error}
                selectedItemId={selectedMediaItem?.id ?? null}
                availabilityById={discovery.availabilityById}
                checkingIds={discovery.checkingIds}
                onCollectionChange={handleCollectionChange}
                onPageChange={handleDiscoveryPageChange}
                onSelectItem={handleDiscoveryItem}
                onRetry={discovery.retryCollection}
              />
            </section>

            {activeInspector}
          </>
        ) : mode === "assistant" ? (
          <>
            <section className="chat-pane assistant-pane" aria-label="AI 推荐对话">
              <div className="search-mode-toolbar"><ModeSwitch mode={mode} onChange={handleModeChange} /></div>
              {assistant.messages.length > 0 ? (
                <div className="assistant-toolbar"><button type="button" className="text-button" onClick={() => { void assistant.clear(); resetReleaseSelection(); closeMediaInspector(); }}>清空对话</button></div>
              ) : null}
              <AssistantPreferences preferences={assistant.preferences} />
              <AssistantThread messages={assistant.messages} />
            </section>
            <aside className="results-pane" aria-label="推荐作品"><div className="results-scroll">
              <AssistantRecommendations cards={assistant.cards} snapshots={assistantReleaseResponses} selectedCardId={assistantSelectedCard?.cardId ?? null} onSelect={handleAssistantCard} onFallback={() => handleModeChange("search")} error={assistant.error} errorCode={assistant.errorCode} loading={assistant.loading} />
            </div></aside>
            {activeInspector}
            <div className="composer-dock"><QueryComposer value={query} onChange={setQuery} onSubmit={handleAssistantSubmit} loading={assistant.loading} disabled={!paired} onCancel={() => void assistant.cancel()} placeholder="例如：轻松的科幻电影，1080p，15GB 以内" inputLabel="描述想看的类型和要求" /></div>
          </>
        ) : (
          <>
            <section className="chat-pane" aria-label="作品搜索对话">
              <div className="search-mode-toolbar">
                <ModeSwitch mode={mode} onChange={handleModeChange} />
              </div>
              <ChatThread messages={messages} />
              {healthError ? <p className="workspace-warning" role="status">{healthError}</p> : null}
            </section>

            <aside className="results-pane" aria-label="作品搜索结果">
              <div className="results-scroll">
                <MediaSearchResults
                  items={mediaSearchItems}
                  loading={mediaSearchLoading}
                  error={mediaSearchError}
                  searched={searchState !== "idle"}
                  selectedItemId={mediaOrigin?.kind === "search" ? selectedMediaItem?.id ?? null : null}
                  onSelect={(item) => handleMediaItem(item, { kind: "search", query: item.title })}
                />
              </div>
            </aside>

            {activeInspector}

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
