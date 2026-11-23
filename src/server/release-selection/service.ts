import { createHash } from "node:crypto";

import type { DiscoveryMedia, ReleaseSummary } from "../../shared/contracts.js";
import {
  RELEASE_SELECTION_ALGORITHM_VERSION,
  releaseSelectionRequestSchema,
  selectionAssistRequestSchema,
  type FieldEvidence,
  type ReleaseSelectionRequest,
  type ReleaseSelectionResponse,
  type ReleaseWarning,
  type SelectionAssistRequest,
  type SelectionAssistResponse,
  type SelectionErrorCode,
  type SelectionSnapshotSummary,
} from "../../shared/release-selection.js";
import type { DiscoverySnapshotView } from "../discovery.js";
import {
  SelectionAssistService,
  buildExtraEvidence,
} from "./assist.js";
import { rankSelection, type SelectionMediaIdentity } from "./ranking.js";
import { SearchSnapshotRegistry } from "./snapshots.js";

/**
 * Resolves a bounded snapshot reference and assembles the rules response.
 * Snapshot resolution is strictly read-only: an expired or revoked snapshot
 * returns an error and the user must explicitly refresh.
 */

export class SelectionError extends Error {
  public readonly code: SelectionErrorCode;

  public constructor(code: SelectionErrorCode, message: string) {
    super(message);
    this.name = "SelectionError";
    this.code = code;
  }
}

export type SelectionDiscoveryLookup = {
  getReleaseSnapshot?: (
    mediaType: "movie" | "tv",
    itemId: string,
  ) => DiscoverySnapshotView | undefined;
};

export type SelectionServiceOptions = {
  discovery?: SelectionDiscoveryLookup;
  searchSnapshots?: SearchSnapshotRegistry;
  assist?: SelectionAssistService;
  now?: () => number;
};

type ResolvedSnapshot = {
  id: string;
  kind: "discovery" | "search";
  query: string;
  checkedAt: string;
  expiresAt: string | null;
  actionableUntil: string | null;
  media: SelectionMediaIdentity | null;
  summary: SelectionSnapshotSummary["media"];
  releases: ReleaseSummary[];
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function revisionOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function identityFromMedia(media: DiscoveryMedia): SelectionMediaIdentity {
  return {
    mediaType: media.mediaType,
    itemId: media.id,
    title: media.title,
    ...(media.originalTitle ? { originalTitle: media.originalTitle } : {}),
    ...(media.year ? { year: media.year } : {}),
  };
}

export class SelectionService {
  private readonly discovery?: SelectionDiscoveryLookup;
  private readonly searchSnapshots: SearchSnapshotRegistry;
  private readonly now: () => number;
  private assistService?: SelectionAssistService;

  public constructor(options: SelectionServiceOptions = {}) {
    this.discovery = options.discovery;
    this.searchSnapshots =
      options.searchSnapshots ?? new SearchSnapshotRegistry();
    this.assistService = options.assist;
    this.now = options.now ?? Date.now;
  }

  /** The AI provider is created after the routes; attach it once available. */
  public configureAssist(service: SelectionAssistService | undefined): void {
    this.assistService = service;
  }

  /** Called by the direct-search route so the browser can reference it later. */
  public registerSearchSnapshot(
    query: string,
    releases: ReleaseSummary[],
  ): { snapshotId: string; checkedAt: string; expiresAt: string } {
    const snapshot = this.searchSnapshots.register(query, releases);
    return {
      snapshotId: snapshot.id,
      checkedAt: snapshot.checkedAt,
      expiresAt: snapshot.expiresAt,
    };
  }

  public clearSearchSnapshots(): void {
    this.searchSnapshots.clear();
  }

  public preview(request: ReleaseSelectionRequest): ReleaseSelectionResponse {
    const parsed = releaseSelectionRequestSchema.parse(request);
    return this.buildResponse(this.resolveSnapshot(parsed), parsed);
  }

  /**
   * One bounded on-demand AI request.  Any failure returns the rules result
   * together with an explicit warning, never an error page.
   */
  public async assist(
    ownerId: string,
    request: SelectionAssistRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<SelectionAssistResponse> {
    const parsed = selectionAssistRequestSchema.parse(request);
    const snapshot = this.resolveSnapshot(parsed);
    const rules = this.buildResponse(snapshot, parsed);
    const fallback = (warning: ReleaseWarning): SelectionAssistResponse => ({
      analysis: "rule_fallback",
      analyzedCandidateCount: 0,
      totalCandidateCount: rules.totalCandidates,
      text: warning.message,
      preferenceDraft: null,
      parseSuggestions: [],
      selection: rules,
      warnings: [warning],
    });
    if (!this.assistService) {
      return fallback({
        code: "AI_DISABLED",
        message: "AI 未启用，已保留规则结果。",
      });
    }
    if (options.signal?.aborted) {
      throw new SelectionError("AI_CANCELLED", "AI 请求已取消。");
    }
    const outcome = await this.assistService.run({
      ownerId,
      request: parsed,
      rules,
      snapshot: rules.snapshot,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.signal?.aborted) {
      throw new SelectionError("AI_CANCELLED", "AI 请求已取消。");
    }
    // The AI call is asynchronous: a refresh/expiry during the wait must
    // invalidate the answer rather than resurrecting an old snapshot.
    let latest: ResolvedSnapshot | null = null;
    try {
      latest = this.resolveSnapshot(parsed);
    } catch {
      latest = null;
    }
    // A snapshot that disappeared or was replaced while the model ran is a
    // closed state: fail so the client cannot keep using an unusable view.
    if (!latest || latest.id !== snapshot.id) {
      throw new SelectionError(
        "SNAPSHOT_EXPIRED",
        "候选快照已失效，AI 结果已丢弃，请刷新后重试。",
      );
    }
    if (!outcome.ok) return fallback(outcome.warning);
    const extraEvidence = buildExtraEvidence(
      outcome.part.parseSuggestions,
      snapshot.releases,
    );
    const applied = Object.keys(extraEvidence).length > 0;
    return {
      analysis: outcome.cached
        ? "cached"
        : outcome.analyzedCount < rules.totalCandidates
          ? "partial"
          : "complete",
      analyzedCandidateCount: outcome.analyzedCount,
      totalCandidateCount: rules.totalCandidates,
      text: outcome.part.text,
      preferenceDraft: outcome.part.preferenceDraft,
      parseSuggestions: outcome.part.parseSuggestions,
      selection: applied
        ? this.buildResponse(snapshot, parsed, extraEvidence)
        : rules,
      warnings: applied
        ? [
            {
              code: "AI_EVIDENCE_APPLIED",
              message: "AI 建议已核对原文，仅影响解释与软排序，不改变硬条件",
            },
          ]
        : [],
    };
  }

  private buildResponse(
    snapshot: ResolvedSnapshot,
    request: ReleaseSelectionRequest,
    extraEvidence?: Record<string, FieldEvidence[]>,
  ): ReleaseSelectionResponse {
    const ranked = rankSelection({
      media: snapshot.media,
      releases: snapshot.releases,
      target: request.target,
      preferences: request.preferences,
      snapshotCheckedAt: snapshot.checkedAt,
      nowMs: this.now(),
      ...(extraEvidence ? { extraEvidence } : {}),
    });
    const checkedAt = snapshot.checkedAt;
    return {
      snapshot: {
        id: snapshot.id,
        kind: snapshot.kind,
        query: snapshot.query,
        checkedAt,
        expiresAt: snapshot.expiresAt,
        actionableUntil: snapshot.actionableUntil,
        stale: false,
        releaseCount: snapshot.releases.length,
        media: snapshot.summary,
      },
      target: request.target,
      preferences: request.preferences,
      revision: {
        snapshotId: snapshot.id,
        targetRevision: revisionOf(request.target),
        preferencesRevision: revisionOf(request.preferences),
        algorithmVersion: RELEASE_SELECTION_ALGORITHM_VERSION,
        checkedAt,
      },
      groups: ranked.groups,
      recommendations: ranked.recommendations,
      availabilityPending: ranked.availabilityPending,
      overlaps: ranked.overlaps,
      warnings: ranked.warnings,
      totalCandidates: ranked.totalCandidates,
      eligibleCount: ranked.eligibleCount,
      recommendedCount: ranked.recommendations.length,
    };
  }

  private resolveSnapshot(request: ReleaseSelectionRequest): ResolvedSnapshot {
    const reference = request.snapshot;
    if (reference.kind === "discovery") {
      const view = this.discovery?.getReleaseSnapshot?.(
        reference.mediaType,
        reference.itemId,
      );
      if (!view) {
        throw new SelectionError(
          "SNAPSHOT_NOT_FOUND",
          "当前没有可用的片源快照，请先刷新候选",
        );
      }
      if (view.snapshotId !== reference.snapshotId) {
        throw new SelectionError(
          "SNAPSHOT_EXPIRED",
          "候选快照已更新，请刷新后重新选择",
        );
      }
      return {
        id: view.snapshotId,
        kind: "discovery",
        query: view.response.query,
        checkedAt: view.response.checkedAt,
        expiresAt: view.response.expiresAt ?? null,
        actionableUntil: view.response.actionableUntil ?? null,
        media: identityFromMedia(view.media),
        summary: {
          mediaType: view.media.mediaType,
          itemId: view.media.id,
          title: view.media.title,
          ...(view.media.originalTitle
            ? { originalTitle: view.media.originalTitle }
            : {}),
          ...(view.media.year ? { year: view.media.year } : {}),
        },
        releases: view.response.releases,
      };
    }

    const snapshot = this.searchSnapshots.resolve(reference.snapshotId);
    if (!snapshot) {
      throw new SelectionError(
        "SNAPSHOT_EXPIRED",
        "搜索快照已过期，请重新搜索后再选择",
      );
    }
    return {
      id: snapshot.id,
      kind: "search",
      query: snapshot.query,
      checkedAt: snapshot.checkedAt,
      expiresAt: snapshot.expiresAt,
      actionableUntil: snapshot.expiresAt,
      media: null,
      summary: null,
      releases: snapshot.releases,
    };
  }
}
