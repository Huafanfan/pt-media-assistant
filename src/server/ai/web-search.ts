import { createHash } from "node:crypto";
import { isIP } from "node:net";

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_QUERY_LENGTH = 400;
const MAX_RESULTS = 6;
const MAX_INCLUDE_DOMAINS = 12;

export type WebSearchResult = {
  id: string;
  title: string;
  url: string;
  content: string;
};

export type WebSearchResponse = {
  results: WebSearchResult[];
  status: "ok" | "unavailable";
  cached: boolean;
};

export type WebSearchProvider = {
  search(query: string, options?: { signal?: AbortSignal; includeDomains?: string[] }): Promise<WebSearchResponse>;
};

export type TavilySearchProviderOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
};

type CacheEntry = {
  response: WebSearchResponse;
  expiresAt: number;
};

function unavailable(): WebSearchResponse {
  return { results: [], status: "unavailable", cached: false };
}

function cloneResponse(response: WebSearchResponse, cached = response.cached): WebSearchResponse {
  return {
    results: response.results.map((result) => ({ ...result })),
    status: response.status,
    cached,
  };
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted", "AbortError");
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Resolve a promise while still observing a request signal. The underlying
 * promise is given rejection handlers so a late response-body failure cannot
 * become an unhandled rejection after a caller has cancelled the request.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeQuery(query: string): string | null {
  if (typeof query !== "string") return null;
  const normalized = query
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "";
  return normalized.length <= MAX_QUERY_LENGTH ? normalized : null;
}

function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function authorityFrom(value: string): string {
  return /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu.exec(value)?.[1] ?? "";
}

function hasExplicitPort(authority: string): boolean {
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) {
    const closingBracket = hostPort.indexOf("]");
    return closingBracket < 0 || hostPort.slice(closingBracket + 1).length > 0;
  }
  // URL normalizes explicit default ports away. Inspect the original
  // authority as well so every explicit port is rejected consistently.
  return /:\d*$/u.test(hostPort);
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".home.arpa")
    || hostname.endsWith(".intranet");
}

function isPublicDomain(hostname: string): boolean {
  const withoutTrailingDot = hostname.replace(/\.$/u, "");
  if (!withoutTrailingDot || isIP(withoutTrailingDot) !== 0 || isLocalHostname(withoutTrailingDot)) return false;
  if (withoutTrailingDot.length > 253 || !withoutTrailingDot.includes(".")) return false;
  return withoutTrailingDot.split(".").every((label) =>
    label.length > 0
      && label.length <= 63
      && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(label),
  );
}

function normalizeIncludeDomains(domains: string[] | undefined): string[] {
  if (!Array.isArray(domains)) return [];
  const normalized = new Set<string>();
  for (const value of domains) {
    if (typeof value !== "string") continue;
    const candidate = value.trim();
    // A domain filter is a hostname, never a URL or an authority with
    // credentials, a path, query, fragment, or port.
    if (!candidate || /[\s/:?#[\]@\\]/u.test(candidate)) continue;
    let parsed: URL;
    try {
      parsed = new URL(`https://${candidate}`);
    } catch {
      continue;
    }
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) continue;
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    if (isPublicDomain(hostname)) normalized.add(hostname);
  }
  return [...normalized].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).slice(0, MAX_INCLUDE_DOMAINS);
}

function safeResultUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  const authority = authorityFrom(candidate);
  if (!authority || authority.includes("@") || hasExplicitPort(authority)) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || !isPublicDomain(parsed.hostname)) return null;
  // A search-engine redirect ceases to identify any source after query
  // cleanup. Do not publish an unusable /link or /url as source evidence.
  if ((/(^|\.)baidu\.com$/u.test(parsed.hostname) && /^\/link\/?$/u.test(parsed.pathname))
    || (/(^|\.)google\.[a-z.]+$/u.test(parsed.hostname) && /^\/url\/?$/u.test(parsed.pathname))) return null;

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function stableId(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

function parseResults(value: unknown): WebSearchResult[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  let hasStructuredEntry = false;

  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.title !== "string"
      || typeof candidate.url !== "string"
      || typeof candidate.content !== "string") continue;
    hasStructuredEntry = true;

    const title = cleanText(candidate.title, 240);
    const url = safeResultUrl(candidate.url);
    if (!title || !url) continue;
    const id = stableId(url);
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      title,
      url,
      content: cleanText(candidate.content, 600),
    });
  }

  // A top-level results array with no result-shaped entries is a malformed
  // provider payload. A shaped entry with an unsafe URL is valid input that
  // was intentionally filtered to an empty safe result set.
  return hasStructuredEntry ? results.slice(0, MAX_RESULTS) : null;
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

/**
 * Server-side Tavily search adapter. It calls only Tavily's fixed search
 * endpoint, returns bounded source summaries, and never follows result URLs.
 */
export class TavilySearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(options: TavilySearchProviderOptions) {
    this.apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
    this.cacheTtlMs = boundedNumber(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0);
  }

  public async search(query: string, options: { signal?: AbortSignal; includeDomains?: string[] } = {}): Promise<WebSearchResponse> {
    throwIfAborted(options.signal);

    const normalizedQuery = normalizeQuery(query);
    if (normalizedQuery === "") return { results: [], status: "ok", cached: false };
    if (!normalizedQuery || !this.apiKey) return unavailable();
    const includeDomains = normalizeIncludeDomains(options.includeDomains);
    const cacheKey = JSON.stringify([normalizedQuery, includeDomains]);

    const now = this.now();
    if (this.cacheTtlMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        if (cached.expiresAt > now) {
          // Refresh insertion order so the bounded map behaves as a small LRU.
          this.cache.delete(cacheKey);
          this.cache.set(cacheKey, cached);
          return cloneResponse(cached.response, true);
        }
        this.cache.delete(cacheKey);
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await raceWithAbort(
        Promise.resolve(this.fetchImpl(TAVILY_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
          query: normalizedQuery,
          search_depth: "fast",
          max_results: MAX_RESULTS,
          include_answer: false,
          ...(includeDomains.length ? { include_domains: includeDomains } : {}),
        }),
          signal: controller.signal,
        })),
        controller.signal,
      );
      throwIfAborted(options.signal);
      if (typeof response.status !== "number" || response.status < 200 || response.status >= 300) return unavailable();

      const payload = await raceWithAbort(response.json() as Promise<unknown>, controller.signal);
      throwIfAborted(options.signal);
      if (timedOut || controller.signal.aborted) return unavailable();

      const results = parseResults((payload as { results?: unknown } | null)?.results);
      if (!results) return unavailable();
      const result: WebSearchResponse = { results, status: "ok", cached: false };

      throwIfAborted(options.signal);
      if (this.cacheTtlMs > 0 && !controller.signal.aborted) {
        while (this.cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        this.cache.set(cacheKey, {
          response: cloneResponse(result, false),
          expiresAt: this.now() + this.cacheTtlMs,
        });
      }
      return cloneResponse(result, false);
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (timedOut || controller.signal.aborted) return unavailable();
      // Do not expose upstream status, body, or exception text to callers.
      return unavailable();
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
