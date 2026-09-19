import {
  assistantTurnRequestSchema,
  type AssistantStreamEvent,
} from "../shared/assistant.js";
import { AssistantService } from "./ai/orchestrator.js";
import { WebRecommendationService } from "./ai/web-recommendation.js";
import {
  TavilySearchProvider,
  type WebSearchProvider,
} from "./ai/web-search.js";
import { PassThrough } from "node:stream";
import { AssistantError, ConversationStore } from "./ai/conversation-store.js";
import {
  providerFromConfig,
  type CompatibleChatProvider,
} from "./ai/provider.js";
import type { AssistantDiscovery } from "./ai/tools.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { ZodError, z } from "zod";

import type {
  ApiErrorBody,
  DiscoveryActorProfile,
  DiscoveryCollectionResponse,
  DiscoveryItemDetails,
  DiscoveryMediaSearchResponse,
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
import { HistoryStore } from "./history-store.js";
import { NasGuard, type NasPreflight } from "./nas.js";
import {
  ProwlarrClient,
  ReleaseNotFoundError,
  type JsonObject,
} from "./prowlarr.js";
import { parseQuery, parseSearchRequest } from "./parser.js";
import { QBittorrentClient, type RawTorrent } from "./qbittorrent.js";

const APP_VERSION = "0.1.0";

export type ProwlarrService = Pick<
  ProwlarrClient,
  "search" | "getRelease" | "grab" | "check"
>;
export type QBittorrentService = Pick<
  QBittorrentClient,
  "listTorrents" | "duplicateForRelease" | "check" | "torrentAction"
>;
export type NasService = Pick<NasGuard, "preflight" | "storage">;
export type DiscoveryServiceContract = Pick<
  DiscoveryService,
  "list" | "getReleases"
> & {
  getDetails?: DiscoveryService["getDetails"];
  getPoster?: DiscoveryService["getPoster"];
  getMediaDetails?: DiscoveryService["getMediaDetails"];
  getMedia?: DiscoveryService["getMedia"];
  getMediaPoster?: DiscoveryService["getMediaPoster"];
  getMediaReleases?: DiscoveryService["getMediaReleases"];
  searchMedia?: DiscoveryService["searchMedia"];
  getActorProfile?: DiscoveryService["getActorProfile"];
  getActorAvatar?: DiscoveryService["getActorAvatar"];
  getActorWorkPoster?: DiscoveryService["getActorWorkPoster"];
};

export type AppServices = {
  webSearch?: WebSearchProvider;
  config?: AppConfig;
  aiProvider?: CompatibleChatProvider;
  history?: HistoryStore;
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
const grabBodySchema = z.object({
  releaseId: releaseIdSchema,
  confirm: z.literal(true),
});
const torrentActionSchema = z
  .object({
    action: z.enum(["pause", "resume", "remove"]),
    // Single task only: batch control is explicitly out of scope. Hashes are
    // re-validated in the adapter, and the client can never submit "all".
    hashes: z.array(z.string().regex(/^[A-Za-z0-9]{32,64}$/u)).length(1),
  })
  .strict();
const discoveryCollectionSchema = z.enum([
  "movie-hot",
  "movie-weekly",
  "tv-hot",
  "tv-weekly",
  "top250",
]);
const discoveryItemIdSchema = z.string().regex(/^\d{1,16}$/u);
const discoveryCollectionParamsSchema = z.object({
  collection: discoveryCollectionSchema,
});
const discoveryItemParamsSchema = z.object({
  collection: discoveryCollectionSchema,
  itemId: discoveryItemIdSchema,
});
const discoveryActorParamsSchema = z.object({ actorId: discoveryItemIdSchema });
const discoveryActorWorkParamsSchema = z.object({
  actorId: discoveryItemIdSchema,
  workId: discoveryItemIdSchema,
});
const discoveryMediaTypeSchema = z.enum(["movie", "tv"]);
const discoveryMediaParamsSchema = z.object({
  mediaType: discoveryMediaTypeSchema,
  itemId: discoveryItemIdSchema,
});
const seenBodySchema = z
  .object({
    mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    mediaType: discoveryMediaTypeSchema,
    title: z.string().trim().min(1).max(240),
  })
  .strict();
const seenParamsSchema = z.object({
  mediaType: discoveryMediaTypeSchema,
  mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
});
const discoveryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});
const discoveryActorQuerySchema = discoveryQuerySchema.extend({
  name: z.string().trim().min(1).max(80),
});
const discoveryMediaSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(80),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});
const discoveryMediaReleaseQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

function requestIp(request: FastifyRequest): string {
  return request.ip || "unknown";
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  code?: string,
): FastifyReply {
  const body: ApiErrorBody = code ? { error, code } : { error };
  return reply.code(statusCode).type("application/json").send(body);
}

function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  config: AppConfig,
): FastifyReply {
  return reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.configuredOrigin?.startsWith("https://") ?? false,
    path: "/",
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

function sessionFromRequest(
  request: FastifyRequest,
  sessions: SessionStore,
): Session | undefined {
  return sessions.get(getSessionId(request));
}

function isUnsafeMethod(request: FastifyRequest): boolean {
  return (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.method !== "OPTIONS"
  );
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
  const originValid = hasExactOrigin(request, configuredOrigin, {
    requireOrigin: isUnsafeMethod(request),
  });
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
  return sendError(
    reply,
    502,
    "Upstream service unavailable",
    "UPSTREAM_UNAVAILABLE",
  );
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
): Promise<
  | {
      release: ReleaseSummary;
      raw: JsonObject;
      nas: NasPreflight;
      duplicate: boolean;
    }
  | undefined
> {
  const selected = prowlarr.getRelease(releaseId);
  const nasResult = await nas.preflight();
  const duplicate = await duplicateCheck(
    qbittorrent,
    selected.raw,
    selected.summary.title,
  );
  return {
    release: selected.summary,
    raw: selected.raw,
    nas: nasResult,
    duplicate,
  };
}

export async function createApp(
  services: AppServices = {},
): Promise<FastifyInstance> {
  const config = services.config ?? loadConfig();
  const sessionStore =
    services.sessions ?? new SessionStore({ ttlMs: config.sessionTtlMs });
  const pairing =
    services.pairing ??
    new PairingService({
      pairingCode: config.pairingCode || undefined,
      sessionStore,
    });
  const sessions = services.sessions ?? pairing.sessions;
  const prowlarr =
    services.prowlarr ??
    new ProwlarrClient({
      baseUrl: config.prowlarrUrl,
      apiKey: config.prowlarrApiKey,
      proxyToken: config.prowlarrProxyToken,
      timeoutMs: config.upstreamTimeoutMs,
    });
  const qbittorrent =
    services.qbittorrent ??
    new QBittorrentClient({
      baseUrl: config.qbittorrentUrl,
    });
  const nas =
    services.nas ??
    new NasGuard({
      targetPath: config.nasPath,
      checkMode: config.nasCheckMode,
      sentinelName: config.nasSentinelName,
      sentinelPath: config.nasSentinelPath,
      statusFilePath: config.nasStatusPath,
    });
  const discovery =
    services.discovery ?? new DiscoveryService(new DoubanClient(), prowlarr);
  // Durable seen records and AI preferences are family-shared; without a data
  // directory (hand-built test configs) the store stays in memory only.
  const history =
    services.history ??
    new HistoryStore({
      path: config.dataDir ? join(config.dataDir, "history.json") : undefined,
    });
  const conversationStore = new ConversationStore(Date.now, {
    preferences: () => history.preferences(),
    seenIds: () => history.knownSeenIds(),
  });

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

  const staticRoot =
    services.staticRoot ?? resolve(process.cwd(), "dist", "client");
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      wildcard: false,
      index: false,
      decorateReply: true,
    });
  }

  app.get("/api/live", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({ status: "ok" }),
  );

  app.get(
    "/api/health",
    {
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
    },
    async (_request, reply): Promise<ServiceHealth> => {
      const [prowlarrReady, qbittorrentReady, nasResult] = await Promise.all([
        prowlarr.check().catch(() => false),
        qbittorrent.check().catch(() => false),
        nas
          .preflight()
          .catch(
            () =>
              ({
                mounted: false,
                directoryExists: false,
                ready: false,
              }) as NasPreflight,
          ),
      ]);
      const servicesReady = {
        prowlarr: prowlarrReady,
        qbittorrent: qbittorrentReady,
        nasMounted: nasResult.ready,
      };
      return reply.header("Cache-Control", "no-store").send({
        status: Object.values(servicesReady).every(Boolean) ? "ok" : "degraded",
        version: APP_VERSION,
        pairingRequired: !config.trustLan && sessions.size === 0,
        services: servicesReady,
        // Capability report only: presence of a key is reported as
        // "configured", never as "ready". No keys, URLs, or paths here, and
        // the health route never performs a paid model or search request.
        capabilities: {
          ai: {
            enabled: config.aiEnabled === true,
            configured: Boolean(config.aiBaseUrl && config.aiApiKey),
            ...(config.aiEnabled && config.aiModel
              ? { model: config.aiModel }
              : {}),
          },
          webSearch: {
            enabled: config.aiEnabled === true && config.aiWebEnabled === true,
            configured: Boolean(config.tavilyApiKey),
          },
          grab: { enabled: config.allowGrab },
          persistence: {
            enabled: history.enabled,
            ...(history.loadError ? { error: history.loadError } : {}),
          },
        },
      });
    },
  );

  app.post(
    "/api/auth/pair",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      // Pairing is public, but an explicitly supplied Origin must still be an
      // exact same-origin request. Missing Origin is accepted for CLI/manual use.
      if (
        !hasExactOrigin(request, config.configuredOrigin, {
          requireOrigin: false,
        })
      ) {
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
        if (result.retryAfterSeconds > 0)
          reply.header("Retry-After", String(result.retryAfterSeconds));
        return sendError(
          reply,
          result.retryAfterSeconds > 0 ? 429 : 401,
          "Pairing failed",
          "PAIRING_FAILED",
        );
      }
      return setSessionCookie(
        reply.header("Cache-Control", "no-store"),
        result.sessionId,
        config,
      ).send({ paired: true, csrfToken: result.csrfToken });
    },
  );

  app.get(
    "/api/session",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (
        !hasExactOrigin(request, config.configuredOrigin, {
          requireOrigin: false,
        })
      ) {
        return sendError(reply, 403, "Forbidden", "ORIGIN_INVALID");
      }
      const sessionId = getSessionId(request);
      const session = sessions.get(sessionId);
      if (session) {
        return reply
          .header("Cache-Control", "no-store")
          .send({ paired: true, csrfToken: session.csrfToken });
      }
      if (sessionId) reply.clearCookie(SESSION_COOKIE, { path: "/" });
      if (config.trustLan && isPrivateNetworkIp(requestIp(request))) {
        const created = sessions.create();
        return setSessionCookie(
          reply.header("Cache-Control", "no-store"),
          created.sessionId,
          config,
        ).send({ paired: true, csrfToken: created.session.csrfToken });
      }
      return reply.header("Cache-Control", "no-store").send({ paired: false });
    },
  );

  app.get(
    "/api/discovery/actors",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getActorProfile !== "function")
        return genericUpstreamError(reply);
      let query: z.infer<typeof discoveryActorQuerySchema>;
      try {
        query = discoveryActorQuerySchema.parse(request.query);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const response: DiscoveryActorProfile = await discovery.getActorProfile(
          query.name,
          query.page ?? 1,
          query.limit ?? 10,
        );
        return reply.send(response);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/actors/:actorId/avatar",
    {
      config: { rateLimit: { max: 60, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getActorAvatar !== "function")
        return genericUpstreamError(reply);
      let params: z.infer<typeof discoveryActorParamsSchema>;
      try {
        params = discoveryActorParamsSchema.parse(request.params);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const asset = await discovery.getActorAvatar(params.actorId);
        return reply
          .header("Cache-Control", "private, max-age=86400")
          .header("X-Content-Type-Options", "nosniff")
          .type(asset.contentType)
          .send(asset.body);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/actors/:actorId/works/:workId/poster",
    {
      config: { rateLimit: { max: 60, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getActorWorkPoster !== "function")
        return genericUpstreamError(reply);
      let params: z.infer<typeof discoveryActorWorkParamsSchema>;
      try {
        params = discoveryActorWorkParamsSchema.parse(request.params);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const asset = await discovery.getActorWorkPoster(
          params.actorId,
          params.workId,
        );
        return reply
          .header("Cache-Control", "private, max-age=86400")
          .header("X-Content-Type-Options", "nosniff")
          .type(asset.contentType)
          .send(asset.body);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/media",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.searchMedia !== "function")
        return genericUpstreamError(reply);
      let query: z.infer<typeof discoveryMediaSearchQuerySchema>;
      try {
        query = discoveryMediaSearchQuerySchema.parse(request.query);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const response: DiscoveryMediaSearchResponse =
          await discovery.searchMedia(query.query, query.limit ?? 10);
        return reply.send(response);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/media/:mediaType/:itemId/details",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getMediaDetails !== "function")
        return genericUpstreamError(reply);
      let params: z.infer<typeof discoveryMediaParamsSchema>;
      try {
        params = discoveryMediaParamsSchema.parse(request.params);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const response: DiscoveryItemDetails = await discovery.getMediaDetails(
          params.mediaType,
          params.itemId,
        );
        return reply.send(response);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/media/:mediaType/:itemId/poster",
    {
      config: { rateLimit: { max: 60, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getMediaPoster !== "function")
        return genericUpstreamError(reply);
      let params: z.infer<typeof discoveryMediaParamsSchema>;
      try {
        params = discoveryMediaParamsSchema.parse(request.params);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const asset = await discovery.getMediaPoster(
          params.mediaType,
          params.itemId,
        );
        return reply
          .header("Cache-Control", "private, max-age=86400")
          .header("X-Content-Type-Options", "nosniff")
          .type(asset.contentType)
          .send(asset.body);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/media/:mediaType/:itemId/releases",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getMediaReleases !== "function")
        return genericUpstreamError(reply);
      let params: z.infer<typeof discoveryMediaParamsSchema>;
      let query: z.infer<typeof discoveryMediaReleaseQuerySchema>;
      try {
        params = discoveryMediaParamsSchema.parse(request.params);
        query = discoveryMediaReleaseQuerySchema.parse(request.query);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const response: DiscoveryReleaseResponse =
          await discovery.getMediaReleases(
            params.mediaType,
            params.itemId,
            query.limit ?? 10,
          );
        return reply.send(response);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.post(
    "/api/discovery/media/:mediaType/:itemId/releases/refresh",
    {
      config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getMediaReleases !== "function")
        return genericUpstreamError(reply);
      let params: z.infer<typeof discoveryMediaParamsSchema>;
      let query: z.infer<typeof discoveryMediaReleaseQuerySchema>;
      try {
        params = discoveryMediaParamsSchema.parse(request.params);
        query = discoveryMediaReleaseQuerySchema.parse(request.query);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const response: DiscoveryReleaseResponse =
          await discovery.getMediaReleases(
            params.mediaType,
            params.itemId,
            query.limit ?? 10,
            { forceRefresh: true },
          );
        return reply.send(response);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/collections/:collection/items",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      let params: z.infer<typeof discoveryCollectionParamsSchema>;
      let query: z.infer<typeof discoveryQuerySchema>;
      try {
        params = discoveryCollectionParamsSchema.parse(request.params);
        query = discoveryQuerySchema.parse(request.query);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const response: DiscoveryCollectionResponse = await discovery.list(
          params.collection,
          query.page ?? 1,
          query.limit ?? 10,
        );
        return reply.send(response);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/collections/:collection/items/:itemId/details",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getDetails !== "function")
        return genericUpstreamError(reply);
      let params: z.infer<typeof discoveryItemParamsSchema>;
      let query: z.infer<typeof discoveryQuerySchema>;
      try {
        params = discoveryItemParamsSchema.parse(request.params);
        query = discoveryQuerySchema.parse(request.query);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const response: DiscoveryItemDetails = await discovery.getDetails(
          params.collection,
          params.itemId,
          query.page ?? 1,
          query.limit ?? 10,
        );
        return reply.send(response);
      } catch (error) {
        if (error instanceof DiscoveryItemNotFoundError) {
          return sendError(
            reply,
            404,
            "Discovery item not found",
            "DISCOVERY_ITEM_NOT_FOUND",
          );
        }
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/collections/:collection/items/:itemId/poster",
    {
      config: { rateLimit: { max: 60, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      if (typeof discovery.getPoster !== "function")
        return genericUpstreamError(reply);
      let params: z.infer<typeof discoveryItemParamsSchema>;
      let query: z.infer<typeof discoveryQuerySchema>;
      try {
        params = discoveryItemParamsSchema.parse(request.params);
        query = discoveryQuerySchema.parse(request.query);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const asset = await discovery.getPoster(
          params.collection,
          params.itemId,
          query.page ?? 1,
          query.limit ?? 10,
        );
        return reply
          .header("Cache-Control", "private, max-age=86400")
          .header("X-Content-Type-Options", "nosniff")
          .type(asset.contentType)
          .send(asset.body);
      } catch (error) {
        if (error instanceof DiscoveryItemNotFoundError) {
          return sendError(
            reply,
            404,
            "Discovery item not found",
            "DISCOVERY_ITEM_NOT_FOUND",
          );
        }
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/discovery/collections/:collection/items/:itemId/releases",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      let params: z.infer<typeof discoveryItemParamsSchema>;
      let query: z.infer<typeof discoveryQuerySchema>;
      try {
        params = discoveryItemParamsSchema.parse(request.params);
        query = discoveryQuerySchema.parse(request.query);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const response: DiscoveryReleaseResponse =
          query.page === undefined
            ? await discovery.getReleases(
                params.collection,
                params.itemId,
                query.limit ?? 10,
              )
            : await discovery.getReleases(
                params.collection,
                params.itemId,
                query.limit ?? 10,
                { page: query.page },
              );
        return reply.send(response);
      } catch (error) {
        if (error instanceof DiscoveryItemNotFoundError) {
          return sendError(
            reply,
            404,
            "Discovery item not found",
            "DISCOVERY_ITEM_NOT_FOUND",
          );
        }
        return genericUpstreamError(reply);
      }
    },
  );

  app.post(
    "/api/discovery/collections/:collection/items/:itemId/releases/refresh",
    {
      config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
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
          {
            forceRefresh: true,
            ...(query.page === undefined ? {} : { page: query.page }),
          },
        );
        return reply.send(response);
      } catch (error) {
        if (error instanceof DiscoveryItemNotFoundError) {
          return sendError(
            reply,
            404,
            "Discovery item not found",
            "DISCOVERY_ITEM_NOT_FOUND",
          );
        }
        return genericUpstreamError(reply);
      }
    },
  );

  const aiProvider = config.aiEnabled
    ? (services.aiProvider ??
      (config.aiApiKey ? providerFromConfig(config) : undefined))
    : undefined;
  const webSearch =
    services.webSearch ??
    (config.tavilyApiKey
      ? new TavilySearchProvider({ apiKey: config.tavilyApiKey })
      : {
          async search() {
            return {
              results: [],
              status: "unavailable" as const,
              cached: false,
            };
          },
        });
  const assistant =
    aiProvider &&
    discovery.searchMedia &&
    discovery.getMedia &&
    discovery.getMediaDetails &&
    discovery.getMediaReleases
      ? config.aiWebEnabled
        ? new WebRecommendationService(
            aiProvider,
            discovery as AssistantDiscovery,
            webSearch,
            {
              timeoutMs: config.aiTurnTimeoutMs,
              history,
              store: conversationStore,
            },
          )
        : new AssistantService(aiProvider, discovery as AssistantDiscovery, {
            timeoutMs: config.aiTurnTimeoutMs,
            history,
            store: conversationStore,
          })
      : undefined;
  app.addHook("onClose", async () => {
    assistant?.close();
  });
  const aiFailure = (reply: FastifyReply, error: unknown) => {
    const failure =
      error instanceof AssistantError
        ? error
        : new AssistantError("AI_UNAVAILABLE");
    if (failure.retryAfter)
      reply.header("Retry-After", String(failure.retryAfter));
    const labels: Record<string, string> = {
      AI_DISABLED: "AI 推荐尚未启用，请按片名搜索。",
      AI_UNAVAILABLE: "AI 推荐服务暂不可用，请稍后重试。",
      AI_TIMEOUT: "推荐服务响应超时，请稍后重试。",
      AI_CANCELLED: "本轮推荐已取消。",
      AI_BUDGET_EXCEEDED: "已达到查询上限，请稍后重试。",
      CONVERSATION_EXPIRED: "对话已过期，请清空后重新开始。",
      TURN_IN_PROGRESS: "已有推荐正在进行，请稍后重试。",
      AI_INVALID_OUTPUT: "AI 回复未通过验证，请重试。",
      TURN_NOT_FOUND: "没有找到该轮推荐。",
    };
    return reply
      .code(failure.status)
      .send({
        error: labels[failure.code] ?? "AI 推荐暂不可用。",
        code: failure.code,
      });
  };
  app.post("/api/assistant/turns", async (request, reply) => {
    if (!authenticate(request, reply, sessions, config.configuredOrigin))
      return;
    reply.header("Cache-Control", "no-store");
    if (!assistant)
      return aiFailure(
        reply,
        new AssistantError(config.aiEnabled ? "AI_UNAVAILABLE" : "AI_DISABLED"),
      );
    const parsed = assistantTurnRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once("aborted", onClose);
    reply.raw.once("close", onClose);
    const startedAt = Date.now();
    try {
      const result = await assistant.run(
        getSessionId(request)!,
        parsed.data,
        controller.signal,
      );
      request.log.info({
        event: "assistant_turn",
        turnId: result.turnId,
        durationMs: Date.now() - startedAt,
        usage: result.usage,
        recommendationCount: result.recommendations.length,
      });
      return result;
    } catch (error) {
      request.log.info({
        event: "assistant_turn_failed",
        durationMs: Date.now() - startedAt,
        code: error instanceof AssistantError ? error.code : "AI_UNAVAILABLE",
      });
      return aiFailure(reply, error);
    } finally {
      request.raw.off("aborted", onClose);
      reply.raw.off("close", onClose);
    }
  });
  app.post("/api/assistant/turns/stream", async (request, reply) => {
    if (!authenticate(request, reply, sessions, config.configuredOrigin))
      return;
    reply.header("Cache-Control", "no-store").header("X-Accel-Buffering", "no");
    if (!assistant)
      return aiFailure(
        reply,
        new AssistantError(config.aiEnabled ? "AI_UNAVAILABLE" : "AI_DISABLED"),
      );
    const parsed = assistantTurnRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    const output = new PassThrough();
    const controller = new AbortController();
    const startedAt = Date.now();
    let firstAt: number | undefined;
    const onClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once("aborted", onClose);
    reply.raw.once("close", onClose);
    const emit = (event: AssistantStreamEvent) => {
      if (controller.signal.aborted || output.destroyed) return;
      output.write(`${JSON.stringify(event)}\n`);
    };
    void (async () => {
      try {
        const owner = getSessionId(request)!;
        const result =
          assistant instanceof WebRecommendationService
            ? await assistant.run(
                owner,
                parsed.data,
                controller.signal,
                (data) => {
                  if (
                    firstAt === undefined &&
                    (data.recommendations.length ||
                      data.pendingRecommendations?.length)
                  )
                    firstAt = Date.now();
                  emit({ type: "snapshot", data });
                },
                (metric) =>
                  request.log.info({ event: "assistant_stage", ...metric }),
              )
            : await assistant.run(owner, parsed.data, controller.signal);
        if (!(assistant instanceof WebRecommendationService))
          emit({ type: "snapshot", data: { ...result, phase: "complete" } });
        request.log.info({
          event: "assistant_turn",
          durationMs: Date.now() - startedAt,
          firstRecommendationMs:
            firstAt === undefined ? null : firstAt - startedAt,
          turnId: result.turnId,
          usage: result.usage,
          recommendationCount: result.recommendations.length,
        });
      } catch (error) {
        const code =
          error instanceof AssistantError ? error.code : "AI_UNAVAILABLE";
        emit({
          type: "error",
          code,
          error:
            code === "AI_TIMEOUT"
              ? "推荐服务响应超时，已展示的内容仍可查看。"
              : code === "AI_CANCELLED"
                ? "本轮推荐已取消。"
                : code === "CONVERSATION_EXPIRED"
                  ? "对话已过期，请清空后重新开始。"
                  : "推荐服务暂时不可用，请稍后重试。",
        });
        request.log.info({
          event: "assistant_turn_failed",
          durationMs: Date.now() - startedAt,
          code,
        });
      } finally {
        request.raw.off("aborted", onClose);
        reply.raw.off("close", onClose);
        output.end();
      }
    })();
    return reply.type("application/x-ndjson; charset=utf-8").send(output);
  });
  app.post("/api/assistant/turns/:turnId/cancel", async (request, reply) => {
    if (!authenticate(request, reply, sessions, config.configuredOrigin))
      return;
    reply.header("Cache-Control", "no-store");
    const parsed = z
      .object({ turnId: z.string().uuid() })
      .strict()
      .safeParse(request.params);
    if (!parsed.success)
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    try {
      if (!assistant) throw new AssistantError("AI_DISABLED");
      assistant.cancel(getSessionId(request)!, parsed.data.turnId);
      return { cancelled: true };
    } catch (e) {
      return aiFailure(reply, e);
    }
  });
  app.delete("/api/assistant/conversations/:id", async (request, reply) => {
    if (!authenticate(request, reply, sessions, config.configuredOrigin))
      return;
    reply.header("Cache-Control", "no-store");
    const parsed = z
      .object({ id: z.string().uuid() })
      .strict()
      .safeParse(request.params);
    if (!parsed.success)
      return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
    try {
      if (!assistant) throw new AssistantError("AI_DISABLED");
      assistant.remove(getSessionId(request)!, parsed.data.id);
      return { deleted: true };
    } catch (e) {
      return aiFailure(reply, e);
    }
  });

  app.post(
    "/api/search",
    {
      config: { rateLimit: { max: 20, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      let parsed: ReturnType<typeof parseSearchRequest>;
      try {
        parsed = parseSearchRequest(request.body);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      try {
        const result: SearchResponse = await prowlarr.search(
          parsed.intent,
          parsed.limit,
        );
        // Keep the user's visible query in the response while the upstream only
        // receives the normalized search term.
        return reply
          .header("Cache-Control", "no-store")
          .send({ ...result, query: parsed.query });
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.post(
    "/api/grab/preview",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      let body: z.infer<typeof grabPreviewBodySchema>;
      try {
        body = parseBody(grabPreviewBodySchema, request.body);
      } catch {
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      }
      let prepared: Awaited<ReturnType<typeof preflightGrab>>;
      try {
        prepared = await preflightGrab(
          prowlarr,
          qbittorrent,
          nas,
          body.releaseId,
        );
      } catch (error) {
        if (error instanceof ReleaseNotFoundError)
          return sendError(
            reply,
            404,
            "Release not found",
            "RELEASE_NOT_FOUND",
          );
        return genericUpstreamError(reply);
      }
      if (!prepared)
        return sendError(reply, 404, "Release not found", "RELEASE_NOT_FOUND");
      const response: GrabPreviewResponse = {
        release: prepared.release,
        destination: normalizeDestination(config.nasPath),
        nasMounted: prepared.nas.ready,
        duplicate: prepared.duplicate,
        initialState: "started",
      };
      return reply.header("Cache-Control", "no-store").send(response);
    },
  );

  app.post(
    "/api/grab",
    {
      config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      let body: z.infer<typeof grabBodySchema>;
      try {
        body = parseBody(grabBodySchema, request.body);
      } catch {
        return sendError(
          reply,
          400,
          "Explicit confirmation required",
          "CONFIRM_REQUIRED",
        );
      }
      // This guard is intentionally before release lookup, NAS checks, and any
      // Prowlarr request. Production must opt in explicitly after acceptance.
      if (!config.allowGrab)
        return sendError(reply, 503, "Grab is not enabled", "GRAB_DISABLED");
      let prepared: Awaited<ReturnType<typeof preflightGrab>>;
      try {
        prepared = await preflightGrab(
          prowlarr,
          qbittorrent,
          nas,
          body.releaseId,
        );
      } catch (error) {
        if (error instanceof ReleaseNotFoundError)
          return sendError(
            reply,
            404,
            "Release not found",
            "RELEASE_NOT_FOUND",
          );
        return genericUpstreamError(reply);
      }
      if (!prepared)
        return sendError(reply, 404, "Release not found", "RELEASE_NOT_FOUND");
      if (!prepared.nas.ready)
        return sendError(reply, 503, "NAS is not ready", "NAS_NOT_READY");
      if (prepared.duplicate)
        return sendError(
          reply,
          409,
          "Release already exists",
          "DUPLICATE_RELEASE",
        );
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
    },
  );

  app.get(
    "/api/torrents",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      try {
        const torrents: TorrentSummary[] = await qbittorrent.listTorrents();
        return reply.header("Cache-Control", "no-store").send(torrents);
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.post(
    "/api/torrents/actions",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      reply.header("Cache-Control", "no-store");
      const parsed = torrentActionSchema.safeParse(request.body);
      if (!parsed.success)
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      try {
        await qbittorrent.torrentAction(parsed.data.action, parsed.data.hashes);
        // Log the action and count only; task names are user data.
        request.log.info({
          event: "torrent_action",
          action: parsed.data.action,
          count: parsed.data.hashes.length,
        });
        return reply.send({ ok: true });
      } catch {
        return genericUpstreamError(reply);
      }
    },
  );

  app.get(
    "/api/history",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      return reply.header("Cache-Control", "no-store").send(history.snapshot());
    },
  );

  app.post(
    "/api/history/seen",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      reply.header("Cache-Control", "no-store");
      const parsed = seenBodySchema.safeParse(request.body);
      if (!parsed.success)
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      if (
        !history.markSeen({
          ...parsed.data,
          markedAt: new Date().toISOString(),
        })
      ) {
        return sendError(
          reply,
          503,
          "History write failed",
          "HISTORY_WRITE_FAILED",
        );
      }
      return reply.send({ ok: true });
    },
  );

  app.delete(
    "/api/history/seen/:mediaType/:mediaId",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      reply.header("Cache-Control", "no-store");
      const parsed = seenParamsSchema.safeParse(request.params);
      if (!parsed.success)
        return sendError(reply, 400, "Invalid request", "INVALID_REQUEST");
      if (!history.unmarkSeen(parsed.data.mediaType, parsed.data.mediaId)) {
        return sendError(
          reply,
          503,
          "History write failed",
          "HISTORY_WRITE_FAILED",
        );
      }
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/storage",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      // Capacity is operational state, so it follows the same session and
      // exact-origin checks as the other protected GET routes. It is also
      // explicitly non-cacheable because a mount can change during a session.
      reply.header("Cache-Control", "no-store");
      if (!authenticate(request, reply, sessions, config.configuredOrigin))
        return;
      try {
        const storage: NasStorageSummary = await nas.storage();
        return reply.send(storage);
      } catch {
        return sendError(
          reply,
          503,
          "NAS storage unavailable",
          "NAS_STORAGE_UNAVAILABLE",
        );
      }
    },
  );

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/"))
      return sendError(reply, 404, "Not found", "NOT_FOUND");
    const indexPath = resolve(staticRoot, "index.html");
    if (existsSync(indexPath)) return reply.sendFile("index.html");
    return sendError(reply, 404, "Not found", "NOT_FOUND");
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      error instanceof ZodError
        ? 400
        : typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? Math.min(
              599,
              Math.max(
                400,
                Number((error as { statusCode: number }).statusCode),
              ),
            )
          : 500;
    // Do not include error.message: upstream messages can contain URLs or
    // provider identifiers. The structured event contains no request URL.
    request.log.warn({ event: "request_error", statusCode }, "request failed");
    return sendError(
      reply,
      statusCode,
      statusCode === 400 ? "Invalid request" : "Internal server error",
      "REQUEST_FAILED",
    );
  });

  return app;
}

// Re-exporting these schemas keeps route validation easy to test without
// coupling tests to Fastify internals.
export {
  grabBodySchema,
  grabPreviewBodySchema,
  pairBodySchema,
  releaseIdSchema,
};
export { parseQuery };
