import { CircleDashed, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReleaseSummary } from "../../shared/contracts";
import {
  selectionTargetSchema,
  type RankedRelease,
  type ReleaseSelectionRequest,
  type ReleaseSelectionResponse,
  type SelectionAssistRequest,
  type SelectionAssistResponse,
  type SelectionContentKind,
  type SelectionEdition,
  type SelectionLanguage,
  type SelectionPreferences,
  type SelectionSegment,
  type SelectionSnapshotRef,
  type SelectionTarget,
  type SelectionTargetMode,
} from "../../shared/release-selection";
import { formatBytes, formatNumber } from "./ReleaseList";
import {
  COMPLETENESS_LABELS,
  EDITION_LABELS,
  GROUP_LABELS,
  LANGUAGE_LABELS,
  REASON_LABELS,
  ROLE_LABELS,
  filterTorrentNames,
  firstUnitSortKey,
  ownedHintText,
  ownedProgress,
  parseDateList,
  parseNumberList,
  parseOwnedUnits,
  rankedToReleaseSummary,
  summarizeCoverage,
} from "./release-selection-labels";

const GROUP_PAGE_SIZE = 10;

export type ReleaseSelectionAssist = {
  enabled: boolean;
  run: (
    request: SelectionAssistRequest,
    csrfToken: string,
    options?: { signal?: AbortSignal },
  ) => Promise<SelectionAssistResponse>;
};

export type ReleaseSelectionPanelProps = {
  snapshot: SelectionSnapshotRef;
  csrfToken: string;
  defaultKind: SelectionContentKind;
  loadSelection: (
    request: ReleaseSelectionRequest,
    csrfToken: string,
  ) => Promise<ReleaseSelectionResponse>;
  selectedReleaseId: string | null;
  selectingId: string | null;
  onSelectRelease: (release: ReleaseSummary, ranked: RankedRelease) => void;
  onShowRawList?: () => void;
  assist?: ReleaseSelectionAssistant;
  /** qBittorrent task names used only for local "not downloaded first" ordering. */
  torrentNames?: string[];
};

// Kept as a separate alias so callers can pass a partially configured assist.
export type ReleaseSelectionAssistant = ReleaseSelectionAssist;

function snapshotFailureCode(cause: unknown): string | null {
  const code = (cause as { code?: unknown })?.code;
  return code === "SNAPSHOT_EXPIRED" || code === "SNAPSHOT_NOT_FOUND"
    ? code
    : null;
}

function snapshotKeyOf(snapshot: SelectionSnapshotRef): string {
  return snapshot.kind === "discovery"
    ? `discovery:${snapshot.mediaType}:${snapshot.itemId}:${snapshot.snapshotId}`
    : `search:${snapshot.snapshotId}`;
}

function buildTarget(input: {
  kind: SelectionContentKind;
  mode: SelectionTargetMode;
  season: number | null;
  year: string | null;
  episodes: string;
  issues: string;
  dates: string;
  segments: SelectionSegment[];
  edition: SelectionEdition | null;
}): { target: SelectionTarget | null; overflow: boolean } {
  const { kind, mode } = input;
  if (kind === "movie") {
    return {
      target: selectionTargetSchema.parse({ kind, mode: "browse" }),
      overflow: false,
    };
  }
  const episodes =
    kind === "series"
      ? parseNumberList(input.episodes)
      : { values: [] as number[], overflow: false };
  const issues =
    kind === "variety"
      ? parseNumberList(input.issues)
      : { values: [] as number[], overflow: false };
  const dates =
    kind === "variety"
      ? parseDateList(input.dates)
      : { values: [] as string[], overflow: false };
  const segments = kind === "variety" ? input.segments : [];
  const overflow = episodes.overflow || issues.overflow || dates.overflow;
  const effectiveMode: SelectionTargetMode =
    mode === "explicit" &&
    episodes.values.length === 0 &&
    issues.values.length === 0 &&
    dates.values.length === 0 &&
    segments.length === 0
      ? "browse"
      : mode;
  const candidate = {
    kind,
    mode: effectiveMode,
    season: kind === "series" || kind === "variety" ? input.season : null,
    year: input.year,
    episodes: episodes.values,
    issues: issues.values,
    dates: dates.values,
    segments,
    edition: kind === "variety" ? input.edition : null,
  };
  const parsed = selectionTargetSchema.safeParse(candidate);
  return {
    target:
      !overflow && parsed.success ? parsed.data : null,
    overflow,
  };
}

const SOURCE_LABELS: Record<string, string> = {
  remux: "REMUX",
  bluray: "Blu-ray",
  webdl: "WEB-DL",
  webrip: "WEBRip",
  hdtv: "HDTV",
  dvd: "DVD",
  other: "其他来源",
};

function ReleaseFacts({
  ranked,
  ownedHint,
}: {
  ranked: RankedRelease;
  ownedHint?: string | null;
}) {
  const coverage = ranked.coverage;
  return (
    <div className="sel-facts">
      <span className="sel-fact">
        标题标注（未核验）：{summarizeCoverage(coverage)}
      </span>
      {ownedHint ? <span className="sel-owned">{ownedHint}</span> : null}
      <span className="sel-fact">
        {ranked.resolution ?? "规格未知"}
        {ranked.source ? ` · ${SOURCE_LABELS[ranked.source] ?? ranked.source}` : ""}
        {ranked.codec ? ` · ${ranked.codec}` : ""}
        {ranked.hdr ? ` · ${ranked.hdr.toUpperCase()}` : ""}
      </span>
      <span className="sel-fact">
        {ranked.sizeKnown ? formatBytes(ranked.size) : "体积未知"}
      </span>
      <span className="sel-fact">
        做种 {ranked.seedersKnown ? formatNumber(ranked.seeders) : "未知"}
      </span>
      <span className="sel-fact">
        {ranked.freeleechState === "yes"
          ? "免费"
          : ranked.freeleechState === "no"
            ? "非免费"
            : "免费未知"}
      </span>
      <span className="sel-fact">
        完整性：
        {coverage.scope === "movie"
          ? "不适用"
          : COMPLETENESS_LABELS[coverage.completeness]}
      </span>
    </div>
  );
}

function ReleaseWarnings({ ranked }: { ranked: RankedRelease }) {
  const notes = [
    ...ranked.warnings.map((warning) => warning.message),
    ...ranked.reasonCodes
      .filter(
        (code) =>
          code === "EXTRA_SCOPE" ||
          code === "MULTI_SEASON_EXTRA" ||
          code === "ONGOING_RELEASE" ||
          code === "SIZE_UNKNOWN" ||
          code === "SEEDERS_UNKNOWN" ||
          code === "ZERO_SEEDERS",
      )
      .map((code) => REASON_LABELS[code]),
  ];
  if (notes.length === 0) return null;
  return (
    <ul className="sel-notes">
      {[...new Set(notes)].slice(0, 4).map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

function ConstraintNotes({ ranked }: { ranked: RankedRelease }) {
  const unmet = ranked.constraintResults.filter(
    (result) => result.status !== "met",
  );
  if (unmet.length === 0) return null;
  return (
    <ul className="sel-notes">
      {unmet.slice(0, 4).map((result) => (
        <li key={result.key}>{result.detail}</li>
      ))}
    </ul>
  );
}

function ReleaseEvidence({ ranked }: { ranked: RankedRelease }) {
  return (
    <details className="sel-evidence">
      <summary>原始发布名与依据</summary>
      <p className="sel-evidence-title">{ranked.title}</p>
      <ul>
        {ranked.evidence.slice(0, 12).map((entry, index) => (
          <li key={`${entry.field}-${index}`}>
            {entry.field}：{entry.value}
            {entry.raw ? `（原文：${entry.raw}）` : ""}
            {entry.source === "upstream" ? " · 上游字段" : entry.source === "ai" ? " · AI 建议" : " · 标题"}
          </li>
        ))}
      </ul>
      {ranked.warnings.length > 0 ? (
        <ul className="sel-evidence-warnings">
          {ranked.warnings.map((warning) => (
            <li key={`${warning.code}-${warning.message}`}>{warning.message}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function ReleaseOption({
  ranked,
  selected,
  selecting,
  disabled,
  ownedHint,
  onSelect,
}: {
  ranked: RankedRelease;
  selected: boolean;
  selecting: boolean;
  disabled: boolean;
  ownedHint?: string | null;
  onSelect: (ranked: RankedRelease) => void;
}) {
  return (
    <li className={`sel-release${selected ? " is-selected" : ""}`}>
      <div className="sel-release-main">
        <div className="sel-release-heading">
          <span className="sel-release-title" title={ranked.title}>
            {ranked.title}
          </span>
          <span className="sel-release-source">
            {ranked.indexer}
            {ranked.identity === "possible" ? <em>身份待确认</em> : null}
          </span>
        </div>
        <ReleaseFacts ranked={ranked} ownedHint={ownedHint} />
        <ConstraintNotes ranked={ranked} />
        <ReleaseWarnings ranked={ranked} />
        <ReleaseEvidence ranked={ranked} />
      </div>
      <button
        className={`outline-button sel-select${selected ? " is-selected" : ""}`}
        type="button"
        aria-pressed={selected}
        disabled={disabled || selecting}
        onClick={() => onSelect(ranked)}
      >
        {selecting ? <CircleDashed className="spin" size={16} aria-hidden="true" /> : null}
        {selected ? "已选择" : "选择"}
      </button>
    </li>
  );
}

function RecommendationCard({
  ranked,
  selected,
  selecting,
  disabled,
  ownedHint,
  onSelect,
}: {
  ranked: RankedRelease;
  selected: boolean;
  selecting: boolean;
  disabled: boolean;
  ownedHint?: string | null;
  onSelect: (ranked: RankedRelease) => void;
}) {
  const role = ranked.recommendationRole;
  return (
    <li className={`sel-card${selected ? " is-selected" : ""}`}>
      <div className="sel-card-role">
        {role ? ROLE_LABELS[role] : "推荐候选"}
      </div>
      <div className="sel-card-body">
        <p className="sel-card-title" title={ranked.title}>
          {ranked.title}
        </p>
        <ReleaseFacts ranked={ranked} ownedHint={ownedHint} />
        <ul className="sel-card-reasons">
          {ranked.reasonCodes.slice(0, 5).map((code) => (
            <li key={code}>{REASON_LABELS[code]}</li>
          ))}
        </ul>
        <ConstraintNotes ranked={ranked} />
        <ReleaseWarnings ranked={ranked} />
        <ReleaseEvidence ranked={ranked} />
      </div>
      <button
        className={`outline-button sel-select${selected ? " is-selected" : ""}`}
        type="button"
        aria-pressed={selected}
        disabled={disabled || selecting}
        onClick={() => onSelect(ranked)}
      >
        {selecting ? <CircleDashed className="spin" size={16} aria-hidden="true" /> : null}
        {selected ? "已选择" : "选择"}
      </button>
    </li>
  );
}

export function ReleaseSelectionPanel({
  snapshot,
  csrfToken,
  defaultKind,
  loadSelection,
  selectedReleaseId,
  selectingId,
  onSelectRelease,
  onShowRawList,
  assist,
  torrentNames = [],
}: ReleaseSelectionPanelProps) {
  const key = snapshotKeyOf(snapshot);
  // Only ask when the type is actually unclear: a Douban movie is a movie, a
  // TV entry may still be a series or a variety show, direct search is unknown.
  const mediaKind: "movie" | "tv" | null =
    snapshot.kind === "discovery" ? snapshot.mediaType : null;
  const kindOptions: SelectionContentKind[] =
    mediaKind === "movie"
      ? []
      : mediaKind === "tv"
        ? ["series", "variety"]
        : ["movie", "series", "variety"];
  const [kind, setKind] = useState<SelectionContentKind>(defaultKind);
  const [mode, setMode] = useState<SelectionTargetMode>("browse");
  const [season, setSeason] = useState<number | null>(null);
  const [episodesText, setEpisodesText] = useState("");
  const [issuesText, setIssuesText] = useState("");
  const [datesText, setDatesText] = useState("");
  const [edition, setEdition] = useState<SelectionEdition | null>("main");
  const [yearText, setYearText] = useState("");
  const [segments, setSegments] = useState<SelectionSegment[]>([]);
  const [preset, setPreset] = useState<SelectionPreferences["preset"]>("balanced");
  const [freeleechOnly, setFreeleechOnly] = useState(false);
  const [freeleechPreferred, setFreeleechPreferred] = useState(false);
  const [resolution, setResolution] = useState<SelectionPreferences["resolution"]>(null);
  const [maxSizeBytes, setMaxSizeBytes] = useState<number | null>(null);
  const [maxSizeInput, setMaxSizeInput] = useState<string | null>(null);
  const [subtitlePreferences, setSubtitlePreferences] = useState<
    SelectionPreferences["subtitles"]
  >([]);
  const [audioPreferences, setAudioPreferences] = useState<
    SelectionPreferences["audio"]
  >([]);
  const [verified, setVerified] = useState(false);

  const [response, setResponse] = useState<ReleaseSelectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotDead, setSnapshotDead] = useState(false);
  const [pageByGroup, setPageByGroup] = useState<Record<string, number>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [assistText, setAssistText] = useState("");
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [assistResult, setAssistResult] = useState<SelectionAssistResponse | null>(null);
  const requestSeq = useRef(0);

  // A different work always starts with a clean target and no stale rows.
  useEffect(() => {
    setKind(defaultKind);
    setMode("browse");
    setSeason(null);
    setEpisodesText("");
    setIssuesText("");
    setDatesText("");
    setEdition("main");
    setYearText("");
    setSegments([]);
    setSnapshotDead(false);
    setResponse(null);
    setError(null);
    setAssistResult(null);
    setPageByGroup({});
    setOpenGroups({});
  }, [key, defaultKind]);

  const builtTarget = useMemo(
    () =>
      buildTarget({
        kind,
        mode,
        season,
        year:
          kind !== "movie" && /^\d{4}$/u.test(yearText.trim())
            ? yearText.trim()
            : null,
        episodes: episodesText,
        issues: issuesText,
        dates: datesText,
        segments: kind === "variety" ? segments : [],
        edition,
      }),
    [
      kind,
      mode,
      season,
      yearText,
      episodesText,
      issuesText,
      datesText,
      segments,
      edition,
    ],
  );

  const maxSizeDisplay =
    maxSizeInput ??
    (maxSizeBytes
      ? String(Math.round((maxSizeBytes / 1024 ** 3) * 1000000) / 1000000)
      : "");

  const preferences = useMemo<SelectionPreferences>(
    () => ({
      preset,
      freeleechOnly,
      // The contract forbids both flags at once; the hard filter wins.
      freeleechPreferred: freeleechOnly ? false : freeleechPreferred,
      resolution,
      maxSizeBytes,
      subtitles: subtitlePreferences,
      audio: audioPreferences,
      verifiedCompletenessRequired: verified,
    }),
    [
    preset,
    freeleechOnly,
    freeleechPreferred,
    resolution,
    maxSizeBytes,
    subtitlePreferences,
    audioPreferences,
    verified,
  ]);

  const target = builtTarget.target;
  const targetOverflow = builtTarget.overflow;
  const owned = useMemo(() => {
    // Only tasks that plausibly belong to the current work may mark episodes
    // as downloaded.
    const media = response?.snapshot.media ?? null;
    const candidates = [
      ...(media?.title ? [media.title] : []),
      ...(media?.originalTitle ? [media.originalTitle] : []),
      ...(media === null && response?.snapshot.query
        ? [response.snapshot.query]
        : []),
    ];
    return parseOwnedUnits(filterTorrentNames(torrentNames, candidates));
  }, [torrentNames, response?.snapshot.media, response?.snapshot.query]);
  const ownedHintsEnabled =
    (kind === "series" || kind === "variety") && owned.total > 0;
  const ownedHintFor = useCallback(
    (ranked: RankedRelease): string | null =>
      ownedHintsEnabled ? ownedHintText(ownedProgress(ranked, owned)) : null,
    [owned, ownedHintsEnabled],
  );
  // Series/variety always read small-to-large; rows whose units are already
  // downloaded move to the end.  The server rank stays the tie-breaker.
  const episodeSortEnabled = kind === "series" || kind === "variety";
  const orderReleases = useCallback(
    (list: RankedRelease[]): RankedRelease[] => {
      if (!episodeSortEnabled) return list;
      const orderValue = (ranked: RankedRelease): [number, number, number] => {
        const first = firstUnitSortKey(ranked);
        if (first === null) return [2, Number.MAX_SAFE_INTEGER, 0];
        const progress = owned.total > 0 ? ownedProgress(ranked, owned) : null;
        if (progress && progress.sortFirst === null) return [1, first, 0];
        return [0, first, progress?.missingCount ?? 0];
      };
      return [...list].sort((left, right) => {
        const leftKey = orderValue(left);
        const rightKey = orderValue(right);
        return (
          leftKey[0] - rightKey[0] ||
          leftKey[1] - rightKey[1] ||
          leftKey[2] - rightKey[2] ||
          left.rank - right.rank
        );
      });
    },
    [episodeSortEnabled, owned],
  );

  const preferencesKey = JSON.stringify(preferences);
  const targetKey = target ? JSON.stringify(target) : "invalid";

  // Switching the target or a filter always returns to the first page, while
  // the selected release stays untouched in the parent.
  useEffect(() => {
    setPageByGroup({});
  }, [targetKey, preferencesKey]);

  const assistSeq = useRef(0);
  const assistAbortRef = useRef<AbortController | null>(null);

  /**
   * One terminal transition for a dead snapshot: rules and AI generations are
   * both invalidated, in-flight work is cancelled and stale drafts are gone.
   */
  const invalidateView = useCallback((message: string) => {
    requestSeq.current += 1;
    assistSeq.current += 1;
    assistAbortRef.current?.abort();
    setSnapshotDead(true);
    setResponse(null);
    setAssistResult(null);
    setAssistError(null);
    setAssistBusy(false);
    setLoading(false);
    setError(message);
  }, []);

  // Any target/preference/snapshot change invalidates an in-flight or late AI
  // answer so an old draft can never be applied to the new goal.
  useEffect(() => {
    assistSeq.current += 1;
    assistAbortRef.current?.abort();
    setAssistResult(null);
    setAssistError(null);
    setAssistBusy(false);
  }, [key, targetKey, preferencesKey]);

  useEffect(
    () => () => {
      assistSeq.current += 1;
      assistAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!target || snapshotDead || targetOverflow) return;
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    let cancelled = false;
    setLoading(true);
    loadSelection({ snapshot, target, preferences }, csrfToken)
      .then((result) => {
        if (cancelled || requestSeq.current !== requestId) return;
        setResponse(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled || requestSeq.current !== requestId) return;
        const message =
          cause instanceof Error && cause.message
            ? cause.message
            : "片源排序没有完成，请稍后重试。";
        if (snapshotFailureCode(cause)) {
          invalidateView(message);
          return;
        }
        setError(message);
      })
      .finally(() => {
        if (cancelled || requestSeq.current !== requestId) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    key,
    targetKey,
    preferencesKey,
    csrfToken,
    snapshotDead,
    targetOverflow,
    invalidateView,
  ]);

  const select = useCallback(
    (ranked: RankedRelease) => {
      onSelectRelease(rankedToReleaseSummary(ranked), ranked);
    },
    [onSelectRelease],
  );

  const seasonOptions = useMemo(() => {
    const seasons = new Set<number>();
    for (const group of response?.groups ?? []) {
      for (const entry of group.releases) {
        for (const value of entry.coverage.seasons) seasons.add(value);
      }
    }
    if (season !== null) seasons.add(season);
    return [...seasons].sort((left, right) => left - right);
  }, [response, season]);

  const runAssist = useCallback(
    async (assistMode: "compare" | "preferences") => {
      if (!assist?.enabled || !target || assistBusy || snapshotDead) return;
      if (assistMode === "preferences" && !assistText.trim()) return;
      setAssistBusy(true);
      setAssistError(null);
      const requestId = assistSeq.current + 1;
      assistSeq.current = requestId;
      assistAbortRef.current?.abort();
      const controller = new AbortController();
      assistAbortRef.current = controller;
      try {
        const result = await assist.run(
          {
            snapshot,
            target,
            preferences,
            mode: assistMode,
            ...(assistMode === "preferences" ? { message: assistText.trim() } : {}),
          },
          csrfToken,
          { signal: controller.signal },
        );
        if (assistSeq.current !== requestId) return;
        setAssistResult(result);
        setResponse(result.selection);
      } catch (cause) {
        if (assistSeq.current !== requestId || controller.signal.aborted) return;
        if (snapshotFailureCode(cause)) {
          invalidateView(
            cause instanceof Error && cause.message
              ? cause.message
              : "候选快照已失效，请刷新后重新选择。",
          );
          return;
        }
        setAssistError(
          cause instanceof Error && cause.message
            ? cause.message
            : "AI 未完成，规则结果仍然可用。",
        );
      } finally {
        if (assistSeq.current === requestId) setAssistBusy(false);
      }
    },
    [
      assist,
      target,
      preferences,
      assistText,
      assistBusy,
      snapshot,
      csrfToken,
      snapshotDead,
      invalidateView,
    ],
  );

  const applyDraft = useCallback(() => {
    const draft = assistResult?.preferenceDraft;
    if (!draft) return;
    setPreset(draft.preset);
    setFreeleechOnly(draft.freeleechOnly);
    setFreeleechPreferred(draft.freeleechOnly ? false : draft.freeleechPreferred);
    setResolution(draft.resolution);
    setMaxSizeBytes(draft.maxSizeBytes);
    setMaxSizeInput(null);
    setSubtitlePreferences(draft.subtitles);
    setAudioPreferences(draft.audio);
    setVerified(draft.verifiedCompletenessRequired);
  }, [assistResult]);

  const snapshotWarnings = response?.warnings ?? [];

  return (
    <section className="sel-panel" aria-labelledby="sel-panel-title">
      <header className="sel-header">
        <div>
          <h3 id="sel-panel-title">候选片源理解与推荐</h3>
        </div>
        {onShowRawList ? (
          <button className="sel-link" type="button" onClick={onShowRawList}>
            查看原始列表
          </button>
        ) : null}
      </header>

      <section className="sel-target" aria-label="观看目标">
        {kindOptions.length > 1 ? (
          <div className="sel-kind-switch" role="group" aria-label="内容类型">
            {kindOptions.map((value) => (
            <button
              key={value}
              type="button"
              className={`sel-toggle${kind === value ? " is-active" : ""}`}
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value);
                setMode("browse");
                setSeason(null);
                setEpisodesText("");
                setIssuesText("");
                setDatesText("");
              }}
              >
                {value === "movie" ? "电影" : value === "series" ? "电视剧" : "综艺"}
              </button>
            ))}
          </div>
        ) : null}

        {kind === "series" ? (
          <div className="sel-range">
            <label className="sel-field">
              <span>季</span>
              <select
                value={season === null ? "" : String(season)}
                onChange={(event) =>
                  setSeason(event.target.value ? Number(event.target.value) : null)
                }
              >
                <option value="">选择季</option>
                {seasonOptions.map((value) => (
                  <option key={value} value={String(value)}>
                    第 {value} 季
                  </option>
                ))}
              </select>
            </label>
            <label className="sel-field">
              <span>输入季号</span>
              <input
                type="number"
                min={1}
                max={50}
                aria-label="输入季号"
                value={season ?? ""}
                placeholder="1-50"
                onChange={(event) =>
                  setSeason(
                    event.target.value ? Number(event.target.value) : null,
                  )
                }
              />
            </label>
            <div className="sel-mode" role="group" aria-label="目标范围">
              {(
                [
                  ["whole", "整季"],
                  ["explicit", "指定集数"],
                  ["browse", "浏览全部"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`sel-toggle${mode === value ? " is-active" : ""}`}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === "explicit" ? (
              <label className="sel-field sel-field-wide">
                <span>集数（如 1-12,15）</span>
                <input
                  type="text"
                  value={episodesText}
                  placeholder="1-12,15"
                  onChange={(event) => setEpisodesText(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {kind === "variety" ? (
          <div className="sel-range">
            <div className="sel-mode" role="group" aria-label="目标范围">
              {(
                [
                  ["explicit", "按期/日期"],
                  ["browse", "浏览全部"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`sel-toggle${mode === value ? " is-active" : ""}`}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === "explicit" ? (
              <>
                <label className="sel-field">
                  <span>期数（如 8-12）</span>
                  <input
                    type="text"
                    value={issuesText}
                    placeholder="8-12"
                    onChange={(event) => setIssuesText(event.target.value)}
                  />
                </label>
                <label className="sel-field">
                  <span>日期（如 2026-09-12）</span>
                  <input
                    type="text"
                    value={datesText}
                    placeholder="2026-09-12"
                    onChange={(event) => setDatesText(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            <label className="sel-field">
              <span>季（标题标注，可留空）</span>
              <input
                type="number"
                min={1}
                max={50}
                aria-label="综艺季"
                value={season ?? ""}
                placeholder="可留空"
                onChange={(event) =>
                  setSeason(
                    event.target.value ? Number(event.target.value) : null,
                  )
                }
              />
            </label>
            <label className="sel-field">
              <span>年份（四位数，可留空）</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={4}
                aria-label="综艺年份"
                value={yearText}
                placeholder="例如 2026"
                onChange={(event) => setYearText(event.target.value)}
              />
            </label>
            <div className="sel-field">
              <span>分段</span>
              <div className="sel-mode">
                {(["upper", "lower"] as const).map((value) => (
                  <label key={value} className="sel-field is-checkbox">
                    <input
                      type="checkbox"
                      checked={segments.includes(value)}
                      onChange={(event) =>
                        setSegments((current) =>
                          event.target.checked
                            ? [...current, value]
                            : current.filter((entry) => entry !== value),
                        )
                      }
                    />
                    <span>{value === "upper" ? "上" : "下"}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="sel-field">
              <span>节目版本</span>
              <select
                value={edition ?? ""}
                onChange={(event) =>
                  setEdition((event.target.value || null) as SelectionEdition | null)
                }
              >
                {(["main", "extra", "pure", "member", "preview", "bonus"] as const).map(
                  (value) => (
                    <option key={value} value={value}>
                      {EDITION_LABELS[value]}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
        ) : null}
      </section>

      <section className="sel-preferences" aria-label="排序与过滤">
        <div className="sel-mode" role="group" aria-label="排序预设">
          {(
            [
              ["balanced", "均衡优先"],
              ["quality", "画质规格优先"],
              ["compact", "小体积优先"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`sel-toggle${preset === value ? " is-active" : ""}`}
              aria-pressed={preset === value}
              onClick={() => setPreset(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="sel-constraints">
          <label className="sel-field is-checkbox">
            <input
              type="checkbox"
              checked={freeleechOnly}
              onChange={(event) => {
                setFreeleechOnly(event.target.checked);
                if (event.target.checked) setFreeleechPreferred(false);
              }}
            />
            <span>只看免费</span>
          </label>
          <label className="sel-field">
            <span>清晰度</span>
            <select
              value={resolution ? `${resolution.strength}:${resolution.value}` : ""}
              onChange={(event) => {
                const [strength, value] = event.target.value.split(":");
                setResolution(
                  strength && value
                    ? {
                        strength: strength as "required" | "preferred",
                        value: value as "2160p" | "1080p" | "720p",
                      }
                    : null,
                );
              }}
            >
              <option value="">不限</option>
              <option value="preferred:1080p">优先 1080p</option>
              <option value="preferred:2160p">优先 2160p</option>
              <option value="required:1080p">必须 1080p</option>
              <option value="required:2160p">必须 2160p</option>
              <option value="required:720p">必须 720p</option>
            </select>
          </label>
          <label className="sel-field">
            <span>总量上限 GB</span>
            <input
              type="number"
              min={0}
              step="0.001"
              value={maxSizeDisplay}
              onChange={(event) => {
                const value = event.target.value;
                setMaxSizeInput(value);
                const amount = Number(value);
                setMaxSizeBytes(
                  Number.isFinite(amount) && amount > 0
                    ? Math.min(
                        Math.max(1, Math.round(amount * 1024 ** 3)),
                        10 * 1024 ** 4,
                      )
                    : null,
                );
              }}
            />
          </label>
          <label className="sel-field">
            <span>字幕</span>
            <select
              value={
                subtitlePreferences[0]
                  ? `${subtitlePreferences[0].strength}:${subtitlePreferences[0].language}`
                  : ""
              }
              onChange={(event) => {
                const [strength, language] = event.target.value.split(":");
                setSubtitlePreferences(
                  strength && language
                    ? [
                        {
                          strength: strength as "required" | "preferred",
                          language: language as SelectionLanguage,
                        },
                      ]
                    : [],
                );
              }}
            >
              <option value="">不限</option>
              <option value="preferred:zh">最好中文</option>
              <option value="required:zh">必须中文</option>
              <option value="preferred:zh-hant">最好繁中</option>
              <option value="preferred:en">最好英文</option>
            </select>
          </label>
          <label className="sel-field is-checkbox">
            <input
              type="checkbox"
              checked={verified}
              onChange={(event) => setVerified(event.target.checked)}
            />
            <span>必须核验完整</span>
          </label>
        </div>
      </section>

      {assist?.enabled ? (
        <section className="sel-assist" aria-label="AI 辅助">
          <div className="sel-assist-row">
            <button
              className="outline-button"
              type="button"
              disabled={assistBusy || !response}
              onClick={() => void runAssist("compare")}
            >
              <Sparkles size={15} aria-hidden="true" />
              {assistBusy ? "AI 正在分析…" : "AI 帮我比较"}
            </button>
            <input
              className="sel-assist-input"
              type="text"
              aria-label="自然语言偏好"
              value={assistText}
              placeholder="例如：第 2 季整季，20GB 以内，最好中文字幕"
              onChange={(event) => setAssistText(event.target.value)}
            />
            <button
              className="outline-button"
              type="button"
              disabled={
                assistBusy || !target || !assistText.trim() || snapshotDead
              }
              onClick={() => void runAssist("preferences")}
            >
              解析为条件
            </button>
          </div>
          {assistError ? (
            <p className="sel-assist-error" role="alert">
              {assistError}
            </p>
          ) : null}
          {assistResult ? (
            <div className="sel-assist-result" role="status">
              <p>
                {assistResult.text || "AI 没有补充说明。"}
                {assistResult.analyzedCandidateCount <
                assistResult.totalCandidateCount
                  ? `（AI 已分析 ${assistResult.analyzedCandidateCount}/${assistResult.totalCandidateCount} 项）`
                  : ""}
              </p>
              {assistResult.parseSuggestions.length > 0 ? (
                <ul>
                  {assistResult.parseSuggestions.map((suggestion) => (
                    <li key={`${suggestion.releaseId}-${suggestion.field}-${suggestion.value}`}>
                      {suggestion.field}：{suggestion.value}（原文：{suggestion.raw}）
                    </li>
                  ))}
                </ul>
              ) : null}
              {assistResult.preferenceDraft ? (
                <div className="sel-assist-draft">
                  <span>
                    条件草稿：
                    {assistResult.preferenceDraft.preset}
                    {assistResult.preferenceDraft.freeleechOnly
                      ? "、只看免费"
                      : assistResult.preferenceDraft.freeleechPreferred
                        ? "、优先免费"
                        : ""}
                    {assistResult.preferenceDraft.resolution
                      ? `、清晰度 ${assistResult.preferenceDraft.resolution.value}（${assistResult.preferenceDraft.resolution.strength === "required" ? "必须" : "优先"}）`
                      : ""}
                    {assistResult.preferenceDraft.maxSizeBytes
                      ? `、总量上限 ${formatBytes(assistResult.preferenceDraft.maxSizeBytes)}`
                      : ""}
                    {assistResult.preferenceDraft.subtitles.length > 0
                      ? `、字幕 ${assistResult.preferenceDraft.subtitles
                          .map(
                            (entry) =>
                              `${LANGUAGE_LABELS[entry.language]}（${entry.strength === "required" ? "必须" : "优先"}）`,
                          )
                          .join("、")}`
                      : ""}
                    {assistResult.preferenceDraft.audio.length > 0
                      ? `、音轨 ${assistResult.preferenceDraft.audio
                          .map(
                            (entry) =>
                              `${LANGUAGE_LABELS[entry.language]}（${entry.strength === "required" ? "必须" : "优先"}）`,
                          )
                          .join("、")}`
                      : ""}
                    {assistResult.preferenceDraft.verifiedCompletenessRequired
                      ? "、必须核验完整"
                      : ""}
                  </span>
                  <button className="outline-button" type="button" onClick={applyDraft}>
                    应用条件
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {!target ? (
        <div className="sel-state" role={targetOverflow ? "alert" : "status"}>
          <strong>
            {targetOverflow ? "输入范围超过上限" : "请先选择目标范围"}
          </strong>
          <p>
            {targetOverflow
              ? "最多支持 300 个集/期单元或 120 个日期，请缩小范围后再排序。"
              : kind === "series"
                ? "选择季和“整季”，或输入具体集数。"
                : "输入期数或日期后再排序。"}
          </p>
        </div>
      ) : loading && !response ? (
        <div className="sel-state" role="status" aria-live="polite">
          <CircleDashed className="spin" size={18} aria-hidden="true" />
          <span>正在整理候选…</span>
        </div>
      ) : error ? (
        <div className="sel-state sel-state-error" role="alert">
          <strong>候选排序没有完成</strong>
          <p>{error}</p>
          <p className="sel-state-hint">
            如果提示快照过期，请先刷新候选；规则排序本身不需要再次查询 PT。
          </p>
        </div>
      ) : response ? (
        <>
          {snapshotWarnings.length > 0 ? (
            <ul className="sel-snapshot-warnings">
              {snapshotWarnings.map((warning) => (
                <li key={`${warning.code}-${warning.message}`}>{warning.message}</li>
              ))}
            </ul>
          ) : null}

          <section className="sel-recommendations" aria-label="推荐卡" aria-busy={loading}>
            <h4>推荐（{response.recommendations.length}/3）</h4>
            {response.recommendations.length === 0 ? (
              <p className="sel-empty-note">
                没有满足全部硬条件的候选；可查看下方分组，或调整条件。不会强行凑推荐。
              </p>
            ) : (
              <ul className="sel-card-list">
                {response.recommendations.map((ranked) => (
                  <RecommendationCard
                    key={`card-${ranked.releaseId}`}
                    ranked={ranked}
                    selected={ranked.releaseId === selectedReleaseId}
                    selecting={ranked.releaseId === selectingId}
                    disabled={Boolean(selectingId && ranked.releaseId !== selectingId)}
                    ownedHint={ownedHintFor(ranked)}
                    onSelect={select}
                  />
                ))}
              </ul>
            )}
          </section>

          {response.groups.map((group) => {
            const page = pageByGroup[group.key] ?? 1;
            const open = openGroups[group.key] ?? group.key !== "other_scope";
            const orderedReleases = orderReleases(group.releases);
            const pageCount = Math.max(1, Math.ceil(orderedReleases.length / GROUP_PAGE_SIZE));
            const start = (Math.min(page, pageCount) - 1) * GROUP_PAGE_SIZE;
            const visible = orderedReleases.slice(start, start + GROUP_PAGE_SIZE);
            return (
              <section className="sel-group" key={group.key} aria-label={GROUP_LABELS[group.key]}>
                <button
                  className="sel-group-heading"
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenGroups((current) => ({ ...current, [group.key]: !open }))
                  }
                >
                  <span>{GROUP_LABELS[group.key]}</span>
                  <span className="sel-group-count">{group.releases.length}</span>
                </button>
                {open ? (
                  <>
                    {(() => {
                      const buckets = new Map<string, RankedRelease[]>();
                      for (const ranked of visible) {
                        const key = ranked.subgroup ?? "";
                        buckets.set(key, [
                          ...(buckets.get(key) ?? []),
                          ranked,
                        ]);
                      }
                      const renderOption = (ranked: RankedRelease) => (
                        <ReleaseOption
                          key={`${group.key}-${ranked.releaseId}`}
                          ranked={ranked}
                          selected={ranked.releaseId === selectedReleaseId}
                          selecting={ranked.releaseId === selectingId}
                          disabled={Boolean(
                            selectingId && ranked.releaseId !== selectingId,
                          )}
                          ownedHint={ownedHintFor(ranked)}
                          onSelect={select}
                        />
                      );
                      if (buckets.size <= 1) {
                        return (
                          <ul className="sel-release-list">
                            {visible.map(renderOption)}
                          </ul>
                        );
                      }
                      return [...buckets.entries()].map(([subgroup, list]) => (
                        <div key={`${group.key}-subgroup-${subgroup}`}>
                          {subgroup ? (
                            <p className="sel-subgroup">{subgroup}</p>
                          ) : null}
                          <ul className="sel-release-list">
                            {list.map(renderOption)}
                          </ul>
                        </div>
                      ));
                    })()}
                    {pageCount > 1 ? (
                      <div className="sel-pagination">
                        <button
                          className="sel-link"
                          type="button"
                          disabled={page <= 1}
                          onClick={() =>
                            setPageByGroup((current) => ({
                              ...current,
                              [group.key]: Math.max(1, page - 1),
                            }))
                          }
                        >
                          上一页
                        </button>
                        <span>
                          {Math.min(page, pageCount)} / {pageCount}
                        </span>
                        <button
                          className="sel-link"
                          type="button"
                          disabled={page >= pageCount}
                          onClick={() =>
                            setPageByGroup((current) => ({
                              ...current,
                              [group.key]: Math.min(pageCount, page + 1),
                            }))
                          }
                        >
                          下一页
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>
            );
          })}

          {response.availabilityPending.length > 0 ? (
            <section className="sel-group" aria-label="可用性待确认">
              <h4 className="sel-group-title">
                可用性待确认（{response.availabilityPending.length}）
              </h4>
              <ul className="sel-release-list">
                {orderReleases(response.availabilityPending).slice(0, GROUP_PAGE_SIZE).map((ranked) => (
                  <ReleaseOption
                    key={`pending-${ranked.releaseId}`}
                    ranked={ranked}
                    selected={ranked.releaseId === selectedReleaseId}
                    selecting={ranked.releaseId === selectingId}
                    disabled={Boolean(selectingId && ranked.releaseId !== selectingId)}
                    ownedHint={ownedHintFor(ranked)}
                    onSelect={select}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {response.overlaps.length > 0 ? (
            <section className="sel-overlaps" aria-label="候选间补齐线索">
              <h4>候选间线索</h4>
              <ul>
                {response.overlaps.slice(0, 6).map((overlap) => (
                  <li key={`${overlap.leftReleaseId}-${overlap.rightReleaseId}`}>
                    {overlap.note}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="sel-footnote">
            共 {response.totalCandidates} 个候选 · {response.eligibleCount} 个满足硬条件 · 快照{" "}
            {new Date(response.snapshot.checkedAt).toLocaleString("zh-CN")}
          </p>
        </>
      ) : null}
    </section>
  );
}
