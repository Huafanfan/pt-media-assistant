import { randomUUID } from "node:crypto";

import type { ReleaseSummary } from "../../shared/contracts.js";

/**
 * Direct-search releases have no Douban media identity, so they are kept in a
 * separate bounded registry.  A snapshot is only usable while every opaque
 * release reference is still alive in the Prowlarr cache.
 */

export const SEARCH_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
export const SEARCH_SNAPSHOT_MAX_ENTRIES = 20;
export const SEARCH_SNAPSHOT_MAX_RELEASES = 60;

export type SearchSnapshot = {
  id: string;
  query: string;
  checkedAt: string;
  expiresAt: string;
  releases: ReleaseSummary[];
};

export type SearchSnapshotRegistryOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  idFactory?: () => string;
  /** Returns false once the opaque Prowlarr reference is gone. */
  isReleaseAlive?: (id: string) => boolean;
  /**
   * Called when a snapshot leaves the registry so its opaque Prowlarr
   * references can be released with it.  A revoked snapshot must not stay
   * downloadable through the old IDs.
   */
  onEvict?: (releaseIds: string[]) => void;
};

export class SearchSnapshotRegistry {
  private readonly entries = new Map<string, SearchSnapshot>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly isReleaseAlive?: (id: string) => boolean;
  private readonly onEvict?: (releaseIds: string[]) => void;

  public constructor(options: SearchSnapshotRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? SEARCH_SNAPSHOT_TTL_MS;
    this.maxEntries = options.maxEntries ?? SEARCH_SNAPSHOT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.isReleaseAlive = options.isReleaseAlive;
    this.onEvict = options.onEvict;
  }

  private drop(id: string): void {
    const snapshot = this.entries.get(id);
    if (!snapshot) return;
    this.entries.delete(id);
    this.onEvict?.(snapshot.releases.map((release) => release.id));
  }

  public register(query: string, releases: ReleaseSummary[]): SearchSnapshot {
    this.evictExpired();
    const now = this.now();
    const snapshot: SearchSnapshot = {
      id: this.idFactory(),
      query: query.slice(0, 240),
      checkedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      releases: releases.slice(0, SEARCH_SNAPSHOT_MAX_RELEASES),
    };
    this.entries.set(snapshot.id, snapshot);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.drop(oldest);
    }
    return snapshot;
  }

  public resolve(snapshotId: string): SearchSnapshot | undefined {
    const snapshot = this.entries.get(snapshotId);
    if (!snapshot) return undefined;
    if (Date.parse(snapshot.expiresAt) <= this.now()) {
      this.drop(snapshotId);
      return undefined;
    }
    const isAlive = this.isReleaseAlive;
    if (isAlive && snapshot.releases.some((release) => !isAlive(release.id))) {
      this.drop(snapshotId);
      return undefined;
    }
    return snapshot;
  }

  public clear(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  public get size(): number {
    return this.entries.size;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, snapshot] of this.entries) {
      if (Date.parse(snapshot.expiresAt) <= now) this.drop(id);
    }
  }
}
