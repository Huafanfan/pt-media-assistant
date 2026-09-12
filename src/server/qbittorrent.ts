import type { TorrentAction, TorrentSummary } from "../shared/contracts.js";

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
  private controlEndpoints?: { pause: string; resume: string };

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

  private async execute(path: string, init: RequestInit = {}, retryLogin = true): Promise<QbResponse> {
    const result = await this.rawRequest(path, init);
    if ((result.response.status === 401 || result.response.status === 403) && retryLogin && this.username && this.password !== undefined) {
      await this.login();
      return this.execute(path, init, false);
    }
    return result;
  }

  private async request(path: string, init: RequestInit = {}, retryLogin = true): Promise<string> {
    const { response, body } = await this.execute(path, init, retryLogin);
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

  /**
   * qBittorrent 5.x renamed pause/resume to stop/start (Web API 2.11+).
   * Choose the endpoint from the upstream API version once per process, and
   * fall back exactly once when the gateway disagrees. No blind retries.
   */
  private async preferredControlEndpoints(): Promise<{ pause: string; resume: string }> {
    if (this.controlEndpoints) return this.controlEndpoints;
    let version = "";
    try {
      version = await this.webApiVersion();
    } catch {
      version = "";
    }
    const [major = 0, minor = 0] = version.split(".").map((value) => Number.parseInt(value, 10));
    const modern = major > 2 || (major === 2 && minor >= 11);
    this.controlEndpoints = modern ? { pause: "stop", resume: "start" } : { pause: "pause", resume: "resume" };
    return this.controlEndpoints;
  }

  /**
   * Pause, resume, or remove exactly one torrent record. Removal always
   * keeps the downloaded files: the browser contract only exposes task
   * removal. Hashes are re-validated here even though the route already
   * checks them, so no batch or `all` submission can reach upstream.
   */
  public async torrentAction(action: TorrentAction, hashes: string[]): Promise<void> {
    const normalized = [...new Set(hashes.map((hash) => hash.trim().toLowerCase()))];
    if (normalized.length !== 1) throw new QBittorrentError();
    if (!/^[a-z0-9]{32,64}$/u.test(normalized[0]!)) throw new QBittorrentError();
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (action === "remove") {
      const body = new URLSearchParams({ hashes: normalized.join("|"), deleteFiles: "false" });
      const result = await this.execute("/api/v2/torrents/delete", { method: "POST", headers, body: body.toString() });
      if (!result.response.ok) throw new QBittorrentError();
      return;
    }
    const endpoints = await this.preferredControlEndpoints();
    const primary = action === "pause" ? endpoints.pause : endpoints.resume;
    const body = new URLSearchParams({ hashes: normalized.join("|") }).toString();
    const result = await this.execute(`/api/v2/torrents/${primary}`, { method: "POST", headers, body });
    if (result.response.ok) return;
    if (result.response.status === 404) {
      const alternate = action === "pause"
        ? (primary === "stop" ? "pause" : "stop")
        : (primary === "start" ? "resume" : "start");
      const fallback = await this.execute(`/api/v2/torrents/${alternate}`, { method: "POST", headers, body });
      if (fallback.response.ok) {
        this.controlEndpoints = action === "pause"
          ? { ...endpoints, pause: alternate }
          : { ...endpoints, resume: alternate };
        return;
      }
    }
    throw new QBittorrentError();
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
