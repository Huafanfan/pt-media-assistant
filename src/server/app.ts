import { existsSync } from "node:fs";
import { resolve } from "node:path";

import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import type {
  ApiErrorBody,
  DiscoveryCollectionResponse,
  DiscoveryReleaseResponse,
  GrabPreviewResponse,
  GrabResponse,
  NasStorageSummary,
  ReleaseSummary,
  SearchResponse,
  ServiceHealth,
  TorrentSummary,
} from "../shared/contracts.js";
import {
  CSRF_HEADER,
  PairingService,
  SESSION_COOKIE,
  SessionStore,
  getSessionId,
  hasExactOrigin,
  hasValidCsrfToken,
  isPrivateNetworkIp,
  type Session,
} from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { DiscoveryItemNotFoundError, DiscoveryService } from "./discovery.js";
import { DoubanClient } from "./douban.js";
import { NasGuard, type NasPreflight } from "./nas.js";
import {
  ProwlarrClient,
  ReleaseNotFoundError,
  UpstreamError,
  type JsonObject,
} from "./prowlarr.js";
import { parseQuery, parseSearchRequest } from "./parser.js";
import { QBittorrentClient, QBittorrentError, type RawTorrent } from "./qbittorrent.js";

const APP_VERSION = "0.1.0";

export type ProwlarrService = Pick<ProwlarrClient, "search" | "getRelease" | "grab" | "check">;
export type QBittorrentService = Pick<QBittorrentClient, "listTorrents" | "duplicateForRelease" | "check">;
export type NasService = Pick<NasGuard, "preflight" | "storage">;
export type DiscoveryServiceContract = Pick<DiscoveryService, "list" | "getReleases">;

export type AppServices = {
  config?: AppConfig;
  pairing?: PairingService;
  sessions?: SessionStore;
  prowlarr?: ProwlarrService;
  qbittorrent?: QBittorrentService;
  nas?: NasService;
  discovery?: DiscoveryServiceContract;
  staticRoot?: string;
};

const pairBodySchema = z.object({ code: z.string().regex(/^\d{6}$/u) });
const releaseIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
const grabPreviewBodySchema = z.object({ releaseId: releaseIdSchema });
const grabBodySchema = z.object({ releaseId: releaseIdSchema, confirm: z.literal(true) });
const discoveryCollectionSchema = z.enum(["movie-hot", "movie-weekly", "tv-hot", "tv-weekly", "top250"]);
const discoveryItemIdSchema = z.string().regex(/^\d{1,16}$/u);
const discoveryCollectionParamsSchema = z.object({ collection: discoveryCollectionSchema });
const discoveryItemParamsSchema = z.object({ collection: discoveryCollectionSchema, itemId: discoveryItemIdSchema });
const discoveryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(20).optional() });

function requestIp(request: FastifyRequest): string {
  return request.ip || "unknown";
}

function sendError(reply: FastifyReply, statusCode: number, error: string, code?: string): FastifyReply {
  const body: ApiErrorBody = code ? { error, code } : { error };
  return reply.code(statusCode).type("application/json").send(body);
}

function setSessionCookie(reply: FastifyReply, sessionId: string, config: AppConfig): FastifyReply {
  return reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.configuredOrigin?.startsWith("https://") ?? false,
    path: "/",
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

function sessionFromRequest(request: FastifyRequest, sessions: SessionStore): Session | undefined {
  return sessions.get(getSessionId(request));
}

function isUnsafeMethod(request: FastifyRequest): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

/**
 * Authentication and browser-origin checks are intentionally kept together so
 * every protected route gets the same behavior and generic failure messages.
 */
function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: SessionStore,
  configuredOrigin?: string,
): Session | undefined {
  const originValid = hasExactOrigin(request, configuredOrigin, { requireOrigin: isUnsafeMethod(request) });
  if (!originValid) {
    sendError(reply, 403, "Forbidden", "ORIGIN_INVALID");
    return undefined;
  }
  const session = sessionFromRequest(request, sessions);
  if (!session) {
    sendError(reply, 401, "Authentication required", "SESSION_REQUIRED");
    return undefined;
  }
  if (isUnsafeMethod(request) && !hasValidCsrfToken(request, session)) {
    sendError(reply, 403, "Forbidden", "CSRF_INVALID");
    return undefined;
  }
  return session;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body);
}

function genericUpstreamError(reply: FastifyReply): FastifyReply {
  return sendError(reply, 502, "Upstream service unavailable", "UPSTREAM_UNAVAILABLE");
}

function normalizeDestination(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

async function duplicateCheck(
  qbittorrent: QBittorrentService,
  rawRelease: JsonObject,
  title: string,
): Promise<boolean> {
  return qbittorrent.duplicateForRelease(rawRelease as RawTorrent, title);
}

async function preflightGrab(
  prowlarr: ProwlarrService,
  qbittorrent: QBittorrentService,
  nas: NasService,
  releaseId: string,
): Promise<{ release: ReleaseSummary; raw: JsonObject; nas: NasPreflight; duplicate: boolean } | undefined> {
  const selected = prowlarr.getRelease(releaseId);
  const nasResult = await nas.preflight();
  const duplicate = await duplicateCheck(qbittorrent, selected.raw, selected.summary.title);
  return { release: selected.summary, raw: selected.raw, nas: nasResult, duplicate };
}

export async function createApp(services: AppServices = {}): Promise<FastifyInstance> {
  const config = services.config ?? loadConfig();
  const sessionStore = services.sessions ?? new SessionStore({ ttlMs: config.sessionTtlMs });
  const pairing = services.pairing ?? new PairingService({
    pairingCode: config.pairingCode || undefined,
    sessionStore,
  });
  const sessions = services.sessions ?? pairing.sessions;
  const prowlarr = services.prowlarr ?? new ProwlarrClient({
    baseUrl: config.prowlarrUrl,
    apiKey: config.prowlarrApiKey,
    proxyToken: config.prowlarrProxyToken,
    timeoutMs: config.upstreamTimeoutMs,
  });
  const qbittorrent = services.qbittorrent ?? new QBittorrentClient({
    baseUrl: config.qbittorrentUrl,
  });
  const nas = services.nas ?? new NasGuard({
    targetPath: config.nasPath,
    checkMode: config.nasCheckMode,
    sentinelName: config.nasSentinelName,
    sentinelPath: config.nasSentinelPath,
    statusFilePath: config.nasStatusPath,
  });
  const discovery = services.discovery ?? new DiscoveryService(new DoubanClient(), prowlarr);

  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    logger: {
      level: "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-api-key",
          "headers.authorization",
          "headers.cookie",
          "headers.x-api-key",
          "apiKey",
          "api_key",
          "guid",
          "*.guid",
          "downloadUrl",
          "*.downloadUrl",
          "infoUrl",
          "*.infoUrl",
          "url",
          "*.url",
        ],
        censor: "[REDACTED]",
      },
    },
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  const staticRoot = services.staticRoot ?? resolve(process.cwd(), "dist", "client");
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      wildcard: false,
      index: false,
      decorateReply: true,
    });
  }

  app.get("/api/live", async (_request, reply) => reply
    .header("Cache-Control", "no-store")
    .send({ status: "ok" }));

  app.get("/api/health", {
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
  }, async (_request, reply): Promise<ServiceHealth> => {
    const [prowlarrReady, qbittorrentReady, nasResult] = await Promise.all([
      prowlarr.check().catch(() => false),
      qbittorrent.check().catch(() => false),
      nas.preflight().catch(() => ({ mounted: false, directoryExists: false, ready: false } as NasPreflight)),
    ]);
    const servicesReady = {
      prowlarr: prowlarrReady,
      qbittorrent: qbittorrentReady,
      nasMounted: nasResult.ready,
    };
    return reply
      .header("Cache-Control", "no-store")
      .send({
        status: Object.values(servicesReady).every(Boolean) ? "ok" : "degraded",
        version: APP_VERSION,
        pairingRequired: !config.trustLan && sessions.size === 0,
        services: servicesReady,
      });
  });

  app.post("/api/auth/pair", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    // Pairing is public, but an explicitly supplied Origin must still be an
    // exact same-origin request. Missing Origin is accepted for CLI/manual use.
    if (!hasExactOrigin(request, config.configuredOrigin, { requireOrigin: false })) {
      return sendError(reply, 403, "Forbidden", "ORIGIN_INVALID");
    }
    let body: z.infer<typeof pairBodySchema>;
    try {
      body = parseBody(pairBodySchema, request.body);
    } catch {
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    }
    const result = pairing.pair(body.code, requestIp(request));
    if (!result.paired) {
      if (result.retryAfterSeconds > 0) reply.header("Retry-After", String(result.retryAfterSeconds));
      return sendError(reply, result.retryAfterSeconds > 0 ? 429 : 401, "Pairing failed", "PAIRING_FAILED");
    }
    return setSessionCookie(reply.header("Cache-Control", "no-store"), result.sessionId, config)
      .send({ paired: true, csrfToken: result.csrfToken });
  });

  app.get("/api/session", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!hasExactOrigin(request, config.configuredOrigin, { requireOrigin: false })) {
      return sendError(reply, 403, "Forbidden", "ORIGIN_INVALID");
    }
    const sessionId = getSessionId(request);
    const session = sessions.get(sessionId);
    if (session) {
      return reply.header("Cache-Control", "no-store").send({ paired: true, csrfToken: session.csrfToken });
    }
    if (sessionId) reply.clearCookie(SESSION_COOKIE, { path: "/" });
    if (config.trustLan && isPrivateNetworkIp(requestIp(request))) {
      const created = sessions.create();
      return setSessionCookie(reply.header("Cache-Control", "no-store"), created.sessionId, config)
        .send({ paired: true, csrfToken: created.session.csrfToken });
    }
    return reply.header("Cache-Control", "no-store").send({ paired: false });
  });

  app.get("/api/discovery/collections/:collection/items", {
    config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!authenticate(request, reply, sessions, config.configuredOrigin)) return;
    let params: z.infer<typeof discoveryCollectionParamsSchema>;
    let query: z.infer<typeof discoveryQuerySchema>;
    try {
      params = discoveryCollectionParamsSchema.parse(request.params);
      query = discoveryQuerySchema.parse(request.query);
    } catch {
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    }
    try {
      const response: DiscoveryCollectionResponse = await discovery.list(params.collection, query.limit ?? 10);
      return reply.send(response);
    } catch {
      return genericUpstreamError(reply);
    }
  });

  app.get("/api/discovery/collections/:collection/items/:itemId/releases", {
    config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!authenticate(request, reply, sessions, config.configuredOrigin)) return;
    let params: z.infer<typeof discoveryItemParamsSchema>;
    let query: z.infer<typeof discoveryQuerySchema>;
    try {
      params = discoveryItemParamsSchema.parse(request.params);
      query = discoveryQuerySchema.parse(request.query);
    } catch {
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    }
    try {
      const response: DiscoveryReleaseResponse = await discovery.getReleases(
        params.collection,
        params.itemId,
        query.limit ?? 10,
      );
      return reply.send(response);
    } catch (error) {
      if (error instanceof DiscoveryItemNotFoundError) {
        return sendError(reply, 404, "Discovery item not found", "DISCOVERY_ITEM_NOT_FOUND");
      }
      return genericUpstreamError(reply);
    }
  });

  app.post("/api/discovery/collections/:collection/items/:itemId/releases/refresh", {
    config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!authenticate(request, reply, sessions, config.configuredOrigin)) return;
    let params: z.infer<typeof discoveryItemParamsSchema>;
    let query: z.infer<typeof discoveryQuerySchema>;
    try {
      params = discoveryItemParamsSchema.parse(request.params);
      query = discoveryQuerySchema.parse(request.query);
    } catch {
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    }
    try {
      const response: DiscoveryReleaseResponse = await discovery.getReleases(
        params.collection,
        params.itemId,
        query.limit ?? 10,
        { forceRefresh: true },
      );
      return reply.send(response);
    } catch (error) {
      if (error instanceof DiscoveryItemNotFoundError) {
        return sendError(reply, 404, "Discovery item not found", "DISCOVERY_ITEM_NOT_FOUND");
      }
      return genericUpstreamError(reply);
    }
  });

  app.post("/api/search", {
    config: { rateLimit: { max: 20, timeWindow: "10 minutes" } },
  }, async (request, reply) => {
    if (!authenticate(request, reply, sessions, config.configuredOrigin)) return;
    let parsed: ReturnType<typeof parseSearchRequest>;
    try {
      parsed = parseSearchRequest(request.body);
    } catch {
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    }
    try {
      const result: SearchResponse = await prowlarr.search(parsed.intent, parsed.limit);
      // Keep the user's visible query in the response while the upstream only
      // receives the normalized search term.
      return reply.header("Cache-Control", "no-store").send({ ...result, query: parsed.query });
    } catch {
      return genericUpstreamError(reply);
    }
  });

  app.post("/api/grab/preview", {
    config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
  }, async (request, reply) => {
    if (!authenticate(request, reply, sessions, config.configuredOrigin)) return;
    let body: z.infer<typeof grabPreviewBodySchema>;
    try {
      body = parseBody(grabPreviewBodySchema, request.body);
    } catch {
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    }
    let prepared: Awaited<ReturnType<typeof preflightGrab>>;
    try {
      prepared = await preflightGrab(prowlarr, qbittorrent, nas, body.releaseId);
    } catch (error) {
      if (error instanceof ReleaseNotFoundError) return sendError(reply, 404, "Release not found", "RELEASE_NOT_FOUND");
      return genericUpstreamError(reply);
    }
    if (!prepared) return sendError(reply, 404, "Release not found", "RELEASE_NOT_FOUND");
    const response: GrabPreviewResponse = {
      release: prepared.release,
      destination: normalizeDestination(config.nasPath),
      nasMounted: prepared.nas.ready,
      duplicate: prepared.duplicate,
      initialState: "started",
    };
    return reply.header("Cache-Control", "no-store").send(response);
  });

  app.post("/api/grab", {
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
  }, async (request, reply) => {
    if (!authenticate(request, reply, sessions, config.configuredOrigin)) return;
    let body: z.infer<typeof grabBodySchema>;
    try {
      body = parseBody(grabBodySchema, request.body);
    } catch {
      return sendError(reply, 400, "Explicit confirmation required", "CONFIRM_REQUIRED");
    }
    // This guard is intentionally before release lookup, NAS checks, and any
    // Prowlarr request. Production must opt in explicitly after acceptance.
    if (!config.allowGrab) return sendError(reply, 503, "Grab is not enabled", "GRAB_DISABLED");
    let prepared: Awaited<ReturnType<typeof preflightGrab>>;
    try {
      prepared = await preflightGrab(prowlarr, qbittorrent, nas, body.releaseId);
    } catch (error) {
      if (error instanceof ReleaseNotFoundError) return sendError(reply, 404, "Release not found", "RELEASE_NOT_FOUND");
      return genericUpstreamError(reply);
    }
    if (!prepared) return sendError(reply, 404, "Release not found", "RELEASE_NOT_FOUND");
    if (!prepared.nas.ready) return sendError(reply, 503, "NAS is not ready", "NAS_NOT_READY");
    if (prepared.duplicate) return sendError(reply, 409, "Release already exists", "DUPLICATE_RELEASE");
    try {
      await prowlarr.grab(prepared.raw);
    } catch {
      return genericUpstreamError(reply);
    }
    const response: GrabResponse = {
      accepted: true,
      message: "Release sent to qBittorrent",
      initialState: "started",
    };
    return reply.header("Cache-Control", "no-store").send(response);
  });

  app.get("/api/torrents", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!authenticate(request, reply, sessions, config.configuredOrigin)) return;
    try {
      const torrents: TorrentSummary[] = await qbittorrent.listTorrents();
      return reply.header("Cache-Control", "no-store").send(torrents);
    } catch {
      return genericUpstreamError(reply);
    }
  });

  app.get("/api/storage", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    // Capacity is operational state, so it follows the same session and
    // exact-origin checks as the other protected GET routes. It is also
    // explicitly non-cacheable because a mount can change during a session.
    reply.header("Cache-Control", "no-store");
    if (!authenticate(request, reply, sessions, config.configuredOrigin)) return;
    try {
      const storage: NasStorageSummary = await nas.storage();
      return reply.send(storage);
    } catch {
      return sendError(reply, 503, "NAS storage unavailable", "NAS_STORAGE_UNAVAILABLE");
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) return sendError(reply, 404, "Not found", "NOT_FOUND");
    const indexPath = resolve(staticRoot, "index.html");
    if (existsSync(indexPath)) return reply.sendFile("index.html");
    return sendError(reply, 404, "Not found", "NOT_FOUND");
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof ZodError
      ? 400
      : typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? Math.min(599, Math.max(400, Number((error as { statusCode: number }).statusCode)))
        : 500;
    // Do not include error.message: upstream messages can contain URLs or
    // provider identifiers. The structured event contains no request URL.
    request.log.warn({ event: "request_error", statusCode }, "request failed");
    return sendError(reply, statusCode, statusCode === 400 ? "Invalid request" : "Internal server error", "REQUEST_FAILED");
  });

  return app;
}

// Re-exporting these schemas keeps route validation easy to test without
// coupling tests to Fastify internals.
export { grabBodySchema, grabPreviewBodySchema, pairBodySchema, releaseIdSchema };
export { parseQuery };
