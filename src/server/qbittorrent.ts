import type { TorrentSummary } from "../shared/contracts.js";

export type QbFetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class QBittorrentError extends Error {
  public constructor(message = "qBittorrent service unavailable") {
    super(message);
    this.name = "QBittorrentError";
  }
}

export type RawTorrent = Record<string, unknown>;

function textValue(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function numberValue(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedProgress(value: unknown): number {
  return Math.min(1, Math.max(0, numberValue(value)));
}

/** Reduce qBittorrent's large torrent object to fields safe for the browser. */
export function sanitizeTorrent(raw: RawTorrent): TorrentSummary {
  const hash = textValue(raw.hash ?? raw.infohash_v1 ?? raw.infoHash ?? raw.infohash_v2).slice(0, 128);
  const name = textValue(raw.name, "Untitled torrent").slice(0, 240);
  return {
    hash,
    name,
    progress: boundedProgress(raw.progress),
    state: textValue(raw.state, "unknown").slice(0, 40),
    size: Math.max(0, numberValue(raw.size)),
    downloadSpeed: Math.max(0, numberValue(raw.dlspeed ?? raw.downloadSpeed)),
    uploadSpeed: Math.max(0, numberValue(raw.upspeed ?? raw.uploadSpeed)),
    eta: Math.max(0, Math.floor(numberValue(raw.eta))),
    savePath: textValue(raw.save_path ?? raw.savePath).slice(0, 1024),
  };
}

export function sanitizeTorrents(value: unknown): TorrentSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is RawTorrent => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map(sanitizeTorrent);
}

function stripReleaseExtension(title: string): string {
  return title.replace(/\.(?:mkv|mp4|avi|mov|wmv|webm|ts)$/iu, "");
}

/** Conservative title key: punctuation and release brackets are ignored. */
export function normalizeTitle(title: string): string {
  return stripReleaseExtension(title)
    .toLocaleLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/gu, " ")
    .replace(/\b(?:2160p|1080p|720p|4k|uhd|x26[45]|h\.?26[45]|hevc|av1)\b/giu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function hashCandidates(value: RawTorrent | Record<string, unknown>): string[] {
  return [value.hash, value.infohash_v1, value.infohash_v2, value.infoHash]
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9]{20,128}$/u.test(item));
}

export function hasDuplicate(
  release: RawTorrent | Record<string, unknown>,
  torrents: RawTorrent[],
  fallbackTitle?: string,
): boolean {
  const releaseHashes = new Set(hashCandidates(release));
  if (releaseHashes.size > 0) {
    if (torrents.some((torrent) => hashCandidates(torrent).some((hash) => releaseHashes.has(hash)))) {
      return true;
    }
  }
  const releaseTitle = textValue(release.title ?? release.name ?? fallbackTitle);
  const normalizedRelease = normalizeTitle(releaseTitle);
  if (!normalizedRelease) return false;
  return torrents.some((torrent) => {
    const normalizedTorrent = normalizeTitle(textValue(torrent.name));
    return normalizedTorrent.length > 0 && normalizedTorrent === normalizedRelease;
  });
}

export type QBittorrentClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  fetchImpl?: QbFetchLike;
};

type QbResponse = { response: Response; body: string };

export class QBittorrentClient {
  public readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: QbFetchLike;
  private sessionCookie?: string;

  public constructor(options: QBittorrentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = Math.max(5_000, options.timeoutMs ?? 15_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private endpoint(path: string): URL {
    return new URL(path, `${this.baseUrl}/`);
  }

  private async rawRequest(path: string, init: RequestInit = {}): Promise<QbResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("Referer", `${this.baseUrl}/`);
    headers.set("Origin", this.baseUrl);
    if (this.sessionCookie) headers.set("Cookie", this.sessionCookie);
    try {
      const response = await this.fetchImpl(this.endpoint(path), {
        ...init,
        headers,
        signal: controller.signal,
      });
      const body = await response.text();
      const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
      const cookies = getSetCookie?.call(response.headers) ?? [];
      if (cookies.length > 0) this.sessionCookie = cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
      return { response, body };
    } catch {
      throw new QBittorrentError();
    } finally {
      clearTimeout(timer);
    }
  }

  private async login(): Promise<void> {
    if (!this.username || this.password === undefined) throw new QBittorrentError();
    const body = new URLSearchParams({ username: this.username, password: this.password }).toString();
    const { response, body: text } = await this.rawRequest("/api/v2/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok || text.trim() !== "Ok.") throw new QBittorrentError();
  }

  private async request(path: string, init: RequestInit = {}, retryLogin = true): Promise<string> {
    const { response, body } = await this.rawRequest(path, init);
    if ((response.status === 401 || response.status === 403) && retryLogin && this.username && this.password !== undefined) {
      await this.login();
      return this.request(path, init, false);
    }
    if (!response.ok) throw new QBittorrentError();
    return body;
  }

  public async version(): Promise<string> {
    return (await this.request("/api/v2/app/version", { method: "GET" })).trim().slice(0, 80);
  }

  public async webApiVersion(): Promise<string> {
    return (await this.request("/api/v2/app/webapiVersion", { method: "GET" })).trim().slice(0, 80);
  }

  public async listTorrents(): Promise<TorrentSummary[]> {
    const body = await this.request("/api/v2/torrents/info?filter=all", { method: "GET" });
    try {
      return sanitizeTorrents(JSON.parse(body));
    } catch {
      throw new QBittorrentError();
    }
  }

  public async duplicateForRelease(release: RawTorrent | Record<string, unknown>, fallbackTitle?: string): Promise<boolean> {
    const body = await this.request("/api/v2/torrents/info?filter=all", { method: "GET" });
    try {
      const parsed = JSON.parse(body);
      const rawTorrents = Array.isArray(parsed) ? parsed : [];
      return hasDuplicate(release, rawTorrents as RawTorrent[], fallbackTitle);
    } catch {
      throw new QBittorrentError();
    }
  }

  public async check(): Promise<boolean> {
    try {
      await this.version();
      return true;
    } catch {
      return false;
    }
  }
}
