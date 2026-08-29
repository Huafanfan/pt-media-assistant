import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { FastifyRequest } from "fastify";

export const SESSION_COOKIE = "pt_media_session";
export const CSRF_HEADER = "x-csrf-token";
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_PAIRING_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_PAIRING_MAX_ATTEMPTS = 5;

export type Session = {
  csrfToken: string;
  expiresAt: number;
};

export type PairResult =
  | { paired: true; sessionId: string; csrfToken: string }
  | { paired: false; retryAfterSeconds: number };

export type PairAttemptLimiterOptions = {
  maxAttempts?: number;
  windowMs?: number;
  now?: () => number;
};

type AttemptRecord = { count: number; resetAt: number };

/** Small in-memory limiter used specifically for the boot-time pairing code. */
export class PairAttemptLimiter {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  public constructor(options: PairAttemptLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_PAIRING_MAX_ATTEMPTS;
    this.windowMs = options.windowMs ?? DEFAULT_PAIRING_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  public check(ip: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const existing = this.attempts.get(ip);
    if (!existing || existing.resetAt <= now) {
      this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (existing.count >= this.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public reset(ip: string): void {
    this.attempts.delete(ip);
  }

  public clearExpired(): void {
    const now = this.now();
    for (const [ip, record] of this.attempts) {
      if (record.resetAt <= now) this.attempts.delete(ip);
    }
  }
}

export type SessionStoreOptions = {
  ttlMs?: number;
  now?: () => number;
};

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  public create(): { sessionId: string; session: Session } {
    const sessionId = randomBytes(32).toString("base64url");
    const session: Session = {
      csrfToken: randomBytes(32).toString("base64url"),
      expiresAt: this.now() + this.ttlMs,
    };
    this.sessions.set(sessionId, session);
    return { sessionId, session };
  }

  public get(sessionId: string | undefined): Session | undefined {
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  public delete(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  public clearExpired(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
  }

  public get size(): number {
    return this.sessions.size;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function validatePairingCode(code: string, expectedCode: string): boolean {
  if (!/^\d{6}$/u.test(code) || !/^\d{6}$/u.test(expectedCode)) return false;
  return constantTimeEqual(code, expectedCode);
}

export type PairingServiceOptions = {
  pairingCode?: string;
  sessionStore?: SessionStore;
  limiter?: PairAttemptLimiter;
  now?: () => number;
};

export class PairingService {
  public readonly pairingCode: string;
  public readonly sessions: SessionStore;
  public readonly limiter: PairAttemptLimiter;

  public constructor(options: PairingServiceOptions = {}) {
    this.pairingCode = options.pairingCode && /^\d{6}$/u.test(options.pairingCode)
      ? options.pairingCode
      : generatePairingCode();
    this.sessions = options.sessionStore ?? new SessionStore({ now: options.now });
    this.limiter = options.limiter ?? new PairAttemptLimiter({ now: options.now });
  }

  public pair(code: string, ip: string): PairResult {
    const attempt = this.limiter.check(ip);
    if (!attempt.allowed) return { paired: false, retryAfterSeconds: attempt.retryAfterSeconds };
    if (!validatePairingCode(code, this.pairingCode)) {
      return { paired: false, retryAfterSeconds: 0 };
    }
    this.limiter.reset(ip);
    const created = this.sessions.create();
    return { paired: true, sessionId: created.sessionId, csrfToken: created.session.csrfToken };
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Validate the browser's exact origin/host pair. A configured origin can be
 * used when a reverse proxy terminates TLS; otherwise the request host is the
 * only accepted host and the origin must be HTTP on that same host.
 */
export function hasExactOrigin(
  request: Pick<FastifyRequest, "headers">,
  configuredOrigin?: string,
  options: { requireOrigin?: boolean } = {},
): boolean {
  const host = headerValue(request.headers.host);
  const origin = headerValue(request.headers.origin);
  if (!host) return false;
  if (!origin) return options.requireOrigin === false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return false;
  }

  if (configuredOrigin) {
    try {
      const configured = new URL(configuredOrigin);
      return parsed.origin === configured.origin && parsed.host === host;
    } catch {
      return false;
    }
  }

  return parsed.protocol === "http:" && parsed.host === host;
}

export function getSessionId(request: Pick<FastifyRequest, "cookies">): string | undefined {
  return request.cookies?.[SESSION_COOKIE];
}

export function hasValidCsrfToken(request: Pick<FastifyRequest, "headers">, session: Session): boolean {
  const token = headerValue(request.headers[CSRF_HEADER]);
  if (!token || token.length > 256) return false;
  return constantTimeEqual(token, session.csrfToken);
}

/**
 * Allow passwordless sessions only for loopback, RFC1918, IPv4 link-local,
 * IPv6 unique-local, and IPv6 link-local peers. Fastify does not trust proxy
 * headers, so this value comes from the actual socket rather than X-Forwarded-For.
 */
export function isPrivateNetworkIp(value: string): boolean {
  let address = value.trim().toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice(7);
  address = address.split("%", 1)[0] ?? address;

  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [first, second] = octets;
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second !== undefined && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (version === 6) {
    if (address === "::1") return true;
    const firstHextet = Number.parseInt(address.split(":", 1)[0] || "0", 16);
    return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
  }
  return false;
}
