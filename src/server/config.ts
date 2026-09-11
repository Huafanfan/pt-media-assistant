import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 4178;
export const DEFAULT_PROWLARR_URL = "http://127.0.0.1:9696";
// qBittorrent's local-auth bypass distinguishes the configured hostname;
// this machine accepts localhost while rejecting the numeric loopback alias.
export const DEFAULT_QBITTORRENT_URL = "http://localhost:8080";
// Keep the useful local macOS default without baking a developer username into
// the repository. Set PT_MEDIA_NAS_PATH explicitly for another mount layout.
export const DEFAULT_NAS_PATH = join(homedir(), "Media", "pt");
export const DEFAULT_SESSION_COOKIE = "pt_media_session";
export const DEFAULT_NAS_SENTINEL_NAME = ".pt-media-assistant-mounted";
export const RELEASE_CACHE_TTL_MS = 15 * 60 * 1000;
export const UPSTREAM_TIMEOUT_MS = 65 * 1000;
export const DEFAULT_AI_MODEL = "deepseek-flash";
export const LEGACY_LUNA_MODEL = "gpt-5.6-luna";
export const DEEPSEEK_MODEL = "deepseek-flash";
export const DEFAULT_AI_PROVIDER_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_AI_TURN_TIMEOUT_MS = 60 * 1000;

export type NasCheckMode = "smbfs" | "sentinel";

export type AppConfig = {
  host: string;
  port: number;
  prowlarrUrl: string;
  prowlarrApiKey?: string;
  prowlarrProxyToken?: string;
  qbittorrentUrl: string;
  nasPath: string;
  nasCheckMode: NasCheckMode;
  nasSentinelName: string;
  nasSentinelPath?: string;
  nasStatusPath?: string;
  pairingCode: string;
  sessionTtlMs: number;
  releaseCacheTtlMs: number;
  upstreamTimeoutMs: number;
  configuredOrigin?: string;
  allowGrab: boolean;
  trustLan: boolean;
  /** AI settings are optional for backwards-compatible test/deployment configs. */
  aiEnabled?: boolean;
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  aiProviderTimeoutMs?: number;
  aiTurnTimeoutMs?: number;
  aiWebEnabled?: boolean;
  tavilyApiKey?: string;
};

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function readSecretFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const path = readEnv(env, name);
  if (!path || !path.startsWith("/") || path.includes("\0")) return undefined;
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PT_MEDIA_PORT must be a valid TCP port");
  }
  return port;
}

function parseUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must be an http(s) URL`);
  }
  // Keep the configured origin stable and avoid accidental path concatenation.
  return url.toString().replace(/\/$/u, "");
}

/**
 * Discover the Prowlarr API key without ever returning it through a log. The
 * caller may hold it in memory for the upstream client, but no browser route
 * includes it.
 */
export function discoverProwlarrApiKey(
  env: NodeJS.ProcessEnv = process.env,
  configPath = join(homedir(), "Library", "Application Support", "Prowlarr", "config.xml"),
): string | undefined {
  const fromEnv = readEnv(env, "PROWLARR_API_KEY");
  if (fromEnv) return fromEnv;
  const fromSecretFile = readSecretFile(env, "PROWLARR_API_KEY_FILE");
  if (fromSecretFile) return fromSecretFile;
  if (!existsSync(configPath)) return undefined;
  try {
    const xml = readFileSync(configPath, "utf8");
    const match = /<ApiKey>\s*([^<\s]+)\s*<\/ApiKey>/iu.exec(xml);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function parsePairingCode(env: NodeJS.ProcessEnv): string {
  const value = readEnv(env, "PT_MEDIA_PAIRING_CODE");
  if (!value) {
    // PairingService replaces an empty value with cryptographically unrelated
    // random digits at construction; config only carries the optional marker.
    return "";
  }
  if (!/^\d{6}$/u.test(value)) {
    throw new Error("PT_MEDIA_PAIRING_CODE must contain exactly six digits");
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return /^(?:1|true|yes|on)$/iu.test(value);
}

function parsePositiveInteger(value: string | undefined, fallback: number, field: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseAiBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    return parsed.toString().replace(/\/$/u, "");
  } catch { return undefined; }
}

function parseNasCheckMode(value: string | undefined): NasCheckMode {
  if (!value || value === "smbfs") return "smbfs";
  if (value === "sentinel") return "sentinel";
  throw new Error("PT_MEDIA_NAS_CHECK_MODE must be smbfs or sentinel");
}

function parseNasSentinelName(value: string | undefined): string {
  const name = value ?? DEFAULT_NAS_SENTINEL_NAME;
  if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u.test(name)) {
    throw new Error("PT_MEDIA_NAS_SENTINEL must be a hidden file name");
  }
  return name;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configuredOrigin = readEnv(env, "PT_MEDIA_ORIGIN");
  if (configuredOrigin) parseUrl(configuredOrigin, "PT_MEDIA_ORIGIN");

  const nasPath = readEnv(env, "PT_MEDIA_NAS_PATH") ?? DEFAULT_NAS_PATH;
  if (!nasPath.startsWith("/") || nasPath.includes("\0")) {
    throw new Error("PT_MEDIA_NAS_PATH must be an absolute local path");
  }
  const nasSentinelPath = readEnv(env, "PT_MEDIA_NAS_SENTINEL_PATH");
  if (nasSentinelPath && (!nasSentinelPath.startsWith("/") || nasSentinelPath.includes("\0"))) {
    throw new Error("PT_MEDIA_NAS_SENTINEL_PATH must be an absolute local path");
  }
  const nasStatusPath = readEnv(env, "PT_MEDIA_NAS_STATUS_PATH");
  if (nasStatusPath && (!nasStatusPath.startsWith("/") || nasStatusPath.includes("\0"))) {
    throw new Error("PT_MEDIA_NAS_STATUS_PATH must be an absolute local path");
  }

  const aiEnabled = parseBoolean(readEnv(env, "PT_MEDIA_AI_ENABLED"));
  // Select URL and credential as one pair. DeepSeek takes precedence over
  // the previous gateways, but a partial DeepSeek configuration must not
  // borrow a URL or key from either of them.
  const useDeepSeek = Boolean(readEnv(env, "DS_BASE_URL") || readEnv(env, "DS_AUTH_TOKEN") || readEnv(env, "DS_AUTH_TOKEN_FILE"));
  const useIvan = !useDeepSeek && Boolean(readEnv(env, "IVAN_ONLINE_API_URL") || readEnv(env, "IVAN_ONLINE_API_KEY") || readEnv(env, "IVAN_ONLINE_API_KEY_FILE"));
  const aiBaseUrl = parseAiBaseUrl(readEnv(env, useDeepSeek ? "DS_BASE_URL" : useIvan ? "IVAN_ONLINE_API_URL" : "TRANS_STATION_BASE_URL"));
  const aiApiKey = useDeepSeek
    ? readEnv(env, "DS_AUTH_TOKEN") ?? readSecretFile(env, "DS_AUTH_TOKEN_FILE")
    : useIvan
      ? readEnv(env, "IVAN_ONLINE_API_KEY") ?? readSecretFile(env, "IVAN_ONLINE_API_KEY_FILE")
      : readEnv(env, "TRANS_STATION_API_KEY") ?? readSecretFile(env, "TRANS_STATION_API_KEY_FILE");
  const aiModel = readEnv(env, "PT_MEDIA_AI_MODEL") ?? DEFAULT_AI_MODEL;
  const aiProviderTimeoutMs = parsePositiveInteger(
    readEnv(env, "PT_MEDIA_AI_PROVIDER_TIMEOUT_MS"),
    DEFAULT_AI_PROVIDER_TIMEOUT_MS,
    "PT_MEDIA_AI_PROVIDER_TIMEOUT_MS",
  );
  const aiTurnTimeoutMs = parsePositiveInteger(
    readEnv(env, "PT_MEDIA_AI_TURN_TIMEOUT_MS"),
    DEFAULT_AI_TURN_TIMEOUT_MS,
    "PT_MEDIA_AI_TURN_TIMEOUT_MS",
  );

  return {
    host: readEnv(env, "PT_MEDIA_HOST") ?? DEFAULT_HOST,
    port: parsePort(readEnv(env, "PT_MEDIA_PORT")),
    prowlarrUrl: parseUrl(readEnv(env, "PROWLARR_URL") ?? DEFAULT_PROWLARR_URL, "PROWLARR_URL"),
    prowlarrApiKey: discoverProwlarrApiKey(env),
    prowlarrProxyToken: readSecretFile(env, "PROWLARR_PROXY_TOKEN_FILE"),
    qbittorrentUrl: parseUrl(readEnv(env, "QBITTORRENT_URL") ?? DEFAULT_QBITTORRENT_URL, "QBITTORRENT_URL"),
    nasPath,
    nasCheckMode: parseNasCheckMode(readEnv(env, "PT_MEDIA_NAS_CHECK_MODE")),
    nasSentinelName: parseNasSentinelName(readEnv(env, "PT_MEDIA_NAS_SENTINEL")),
    ...(nasSentinelPath ? { nasSentinelPath } : {}),
    ...(nasStatusPath ? { nasStatusPath } : {}),
    pairingCode: parsePairingCode(env),
    sessionTtlMs: 12 * 60 * 60 * 1000,
    releaseCacheTtlMs: RELEASE_CACHE_TTL_MS,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    allowGrab: parseBoolean(readEnv(env, "PT_MEDIA_ALLOW_GRAB")),
    trustLan: parseBoolean(readEnv(env, "PT_MEDIA_TRUST_LAN"), true),
    aiEnabled,
    ...(aiBaseUrl ? { aiBaseUrl } : {}),
    ...(aiApiKey ? { aiApiKey } : {}),
    aiModel,
    aiProviderTimeoutMs,
    aiTurnTimeoutMs,
    aiWebEnabled: parseBoolean(readEnv(env, "PT_MEDIA_AI_WEB_ENABLED")),
    tavilyApiKey: readEnv(env, "TAVILY_API_KEY") ?? readSecretFile(env, "TAVILY_API_KEY_FILE"),
    ...(configuredOrigin ? { configuredOrigin: parseUrl(configuredOrigin, "PT_MEDIA_ORIGIN") } : {}),
  };
}
