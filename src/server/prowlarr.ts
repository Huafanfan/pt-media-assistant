import { randomBytes } from "node:crypto";

import type { ParsedIntent, ReleaseSummary, SearchResponse } from "../shared/contracts.js";
import { UPSTREAM_TIMEOUT_MS } from "./config.js";

export type JsonObject = Record<string, unknown>;
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
  public constructor(message = "Upstream service unavailable") {
    super(message);
    this.name = "UpstreamError";
  }
}

export class ReleaseNotFoundError extends Error {
  public constructor() {
    super("Release is no longer available");
    this.name = "ReleaseNotFoundError";
  }
}

type CachedRelease = {
  release: JsonObject;
  expiresAt: number;
};

export type ReleaseCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  idFactory?: () => string;
};

/** Opaque, short-lived mapping from browser IDs to full Prowlarr resources. */
export class ReleaseCache {
  private readonly entries = new Map<string, CachedRelease>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  public constructor(options: ReleaseCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => randomBytes(18).toString("base64url"));
  }

  public put(release: JsonObject): string {
    this.evictExpired();
    let id = this.idFactory();
    while (this.entries.has(id)) id = this.idFactory();
    this.entries.set(id, { release, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    return id;
  }

  public get(id: string): JsonObject | undefined {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(id)) return undefined;
    const cached = this.entries.get(id);
    if (!cached) return undefined;
    if (cached.expiresAt <= this.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return cached.release;
  }

  public delete(id: string): void {
    this.entries.delete(id);
  }

  public get size(): number {
    return this.entries.size;
  }

  public evictExpired(): void {
    const now = this.now();
    for (const [id, cached] of this.entries) {
      if (cached.expiresAt <= now) this.entries.delete(id);
    }
  }
}

function stringValue(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedString(value: unknown, fallback = "", max = 240): string {
  return stringValue(value, fallback).slice(0, max);
}

function numberValue(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function integerValue(value: unknown, fallback = 0): number {
  return Math.max(0, Math.floor(numberValue(value, fallback)));
}

function getRawObjectValue(raw: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return undefined;
}

function normalizeResolution(value: unknown): ReleaseSummary["resolution"] {
  const text = stringValue(value).toLowerCase();
  if (/4k|2160/iu.test(text)) return "2160p";
  if (/1080/iu.test(text)) return "1080p";
  if (/720/iu.test(text)) return "720p";
  return undefined;
}

function inferResolution(title: string, raw: JsonObject): ReleaseSummary["resolution"] {
  return normalizeResolution(getRawObjectValue(raw, "resolution", "quality")) ?? normalizeResolution(title);
}

function inferCodec(title: string, raw: JsonObject): string | undefined {
  const direct = boundedString(getRawObjectValue(raw, "codec", "videoCodec"), "", 40);
  if (direct) return direct;
  const match = /\b(?:x26[45]|h\.?26[45]|hevc|av1|avc)\b/iu.exec(title);
  return match?.[0]?.toUpperCase();
}

function categoryNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      const name = boundedString(item, "", 80);
      if (name) names.add(name);
      return;
    }
    if (!item || typeof item !== "object") return;
    const object = item as JsonObject;
    const name = boundedString(object.name, "", 80);
    if (name) names.add(name);
    if (Array.isArray(object.subCategories)) object.subCategories.forEach(visit);
  };
  value.forEach(visit);
  return [...names].slice(0, 20);
}

function isFreeleech(raw: JsonObject): boolean {
  if (raw.freeleech === true || raw.isFreeleech === true || raw.freeLeech === true) return true;
  const flags = raw.indexerFlags;
  return Array.isArray(flags) && flags.some((flag) => /freeleech|free-leech|免费/iu.test(String(flag)));
}

/** Reduce one full Prowlarr ReleaseResource to the browser-safe contract. */
export function sanitizeRelease(raw: JsonObject, id: string): ReleaseSummary {
  const title = boundedString(getRawObjectValue(raw, "title", "sortTitle", "fileName"), "Untitled release");
  const ageDays = raw.age !== undefined
    ? numberValue(raw.age)
    : numberValue(raw.ageHours, 0) / 24;
  const protocol = stringValue(raw.protocol).toLowerCase() === "usenet" ? "usenet" : "torrent";
  return {
    id,
    title,
    indexer: boundedString(getRawObjectValue(raw, "indexer", "indexerName"), "Unknown indexer", 100),
    protocol,
    size: numberValue(raw.size),
    seeders: integerValue(raw.seeders),
    leechers: integerValue(raw.leechers),
    grabs: integerValue(raw.grabs),
    ageDays: Math.round(ageDays * 100) / 100,
    categories: categoryNames(raw.categories),
    ...(inferResolution(title, raw) ? { resolution: inferResolution(title, raw) } : {}),
    ...(inferCodec(title, raw) ? { codec: inferCodec(title, raw) } : {}),
    freeleech: isFreeleech(raw),
  };
}

export function sanitizeReleases(rawReleases: unknown[], cache: ReleaseCache): ReleaseSummary[] {
  const summaries: ReleaseSummary[] = [];
  for (const value of rawReleases) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as JsonObject;
    const id = cache.put(raw);
    summaries.push(sanitizeRelease(raw, id));
  }
  return summaries;
}

function matchesIntent(release: ReleaseSummary, intent: ParsedIntent): boolean {
  if (intent.maxSizeBytes !== undefined && release.size > intent.maxSizeBytes) return false;
  if (intent.freeleechOnly && !release.freeleech) return false;
  // A requested resolution is a hard constraint. Unknown-resolution entries
  // (for example soundtracks or books) must not leak into a 4K/1080p result.
  if (intent.resolution && release.resolution !== intent.resolution) return false;
  return true;
}

function asReleaseArray(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  if (value && typeof value === "object") {
    const releases = (value as JsonObject).releases;
    if (Array.isArray(releases)) return asReleaseArray(releases);
  }
  return [];
}

export type ProwlarrClientOptions = {
  baseUrl: string;
  apiKey?: string;
  proxyToken?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  cache?: ReleaseCache;
};

export class ProwlarrClient {
  public readonly baseUrl: string;
  public readonly cache: ReleaseCache;
  private readonly apiKey?: string;
  private readonly proxyToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  public constructor(options: ProwlarrClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.apiKey = options.apiKey;
    this.proxyToken = options.proxyToken;
    this.timeoutMs = Math.max(60_000, options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cache = options.cache ?? new ReleaseCache();
  }

  private endpoint(path: string): URL {
    return new URL(path, `${this.baseUrl}/`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("X-Api-Key", this.apiKey);
    if (this.proxyToken) headers.set("X-PT-Proxy-Token", this.proxyToken);
    try {
      const response = await this.fetchImpl(this.endpoint(path), {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw new UpstreamError();
      if (response.status === 204 || response.status === 205) return undefined;
      try {
        return await response.json();
      } catch {
        throw new UpstreamError();
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError();
    } finally {
      clearTimeout(timer);
    }
  }

  public async search(intent: ParsedIntent, limit = 20): Promise<SearchResponse> {
    const startedAt = Date.now();
    const endpoint = this.endpoint("/api/v1/search");
    endpoint.searchParams.set("query", intent.searchTerm);
    endpoint.searchParams.set("type", "search");
    endpoint.searchParams.set("limit", String(Math.min(50, Math.max(1, Math.floor(limit)))));
    endpoint.searchParams.set("offset", "0");

    const payload = await this.request(endpoint.pathname + endpoint.search, { method: "GET" });
    const rawReleases = asReleaseArray(payload);
    const all = sanitizeReleases(rawReleases, this.cache);
    const releases = all
      .filter((release) => matchesIntent(release, intent))
      .sort((left, right) => right.seeders - left.seeders || left.size - right.size);
    return {
      query: intent.searchTerm,
      intent,
      total: releases.length,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      releases: releases.slice(0, limit),
    };
  }

  public getRelease(releaseId: string): { summary: ReleaseSummary; raw: JsonObject } {
    const raw = this.cache.get(releaseId);
    if (!raw) throw new ReleaseNotFoundError();
    return { raw, summary: sanitizeRelease(raw, releaseId) };
  }

  /**
   * Prowlarr's GrabRelease contract is POST /api/v1/search with one complete
   * ReleaseResource JSON object. The cached object is sent unchanged so fields
   * such as guid/downloadUrl/infoUrl never come from the browser.
   */
  public async grab(rawRelease: JsonObject): Promise<void> {
    await this.request("/api/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rawRelease),
    });
  }

  public async grabById(releaseId: string): Promise<ReleaseSummary> {
    const { raw, summary } = this.getRelease(releaseId);
    await this.grab(raw);
    return summary;
  }

  public async check(): Promise<boolean> {
    try {
      await this.request("/api/v1/system/status", { method: "GET" });
      return true;
    } catch {
      return false;
    }
  }
}
