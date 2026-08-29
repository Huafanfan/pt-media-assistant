import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/server/app.js";
import { PairingService, SessionStore, isPrivateNetworkIp } from "../../src/server/auth.js";
import { parseQuery } from "../../src/server/parser.js";
import { NasGuard, findSmbfsAncestor, parseMountOutput } from "../../src/server/nas.js";
import { ProwlarrClient, ReleaseCache, sanitizeRelease } from "../../src/server/prowlarr.js";

const config = {
  host: "0.0.0.0",
  port: 4178,
  prowlarrUrl: "http://127.0.0.1:9696",
  prowlarrApiKey: "test-only-key",
  qbittorrentUrl: "http://127.0.0.1:8080",
  nasPath: "/Volumes/YourNAS/pt",
  pairingCode: "123456",
  sessionTtlMs: 3_600_000,
  releaseCacheTtlMs: 900_000,
  upstreamTimeoutMs: 60_000,
  allowGrab: false,
  trustLan: true,
};

const readyNas = {
  preflight: vi.fn(async () => ({
    path: config.nasPath,
    mounted: true,
    directoryExists: true,
    ready: true,
    mountPoint: "/Volumes/YourNAS",
  })),
  storage: vi.fn(async () => ({
    path: config.nasPath,
    mounted: true,
    ready: true,
    totalBytes: 100 * 1024 ** 3,
    usedBytes: 40 * 1024 ** 3,
    freeBytes: 60 * 1024 ** 3,
  })),
};

function makeRelease(id = "abcdefghijklmnopqrst") {
  const raw = {
    title: "The Matrix 1999 1080p",
    guid: "private-guid",
    downloadUrl: "https://private.invalid/download",
    infoUrl: "https://private.invalid/info",
    protocol: "torrent",
    indexer: "TJUPT",
    size: 10,
    seeders: 20,
    leechers: 1,
    grabs: 4,
    age: 2,
    categories: [{ name: "Movies", subCategories: [{ name: "HD" }] }],
  };
  return {
    raw,
    summary: sanitizeRelease(raw, id),
  };
}

describe("natural language parser", () => {
  it("extracts title, resolution, size and freeleech without leaking control words", () => {
    expect(parseQuery("请找《流浪地球2》 4K 30GB以内 免费")).toEqual({
      searchTerm: "流浪地球2",
      resolution: "2160p",
      maxSizeBytes: 30 * 1024 ** 3,
      freeleechOnly: true,
    });
  });

  it("validates a bounded query", () => {
    expect(() => parseQuery(" ")).toThrow();
    expect(() => parseQuery("x".repeat(241))).toThrow();
  });
});

describe("trusted LAN allowlist", () => {
  it("accepts local/private peers and rejects public addresses", () => {
    expect(isPrivateNetworkIp("127.0.0.1")).toBe(true);
    expect(isPrivateNetworkIp("::ffff:10.0.0.42")).toBe(true);
    expect(isPrivateNetworkIp("172.31.4.8")).toBe(true);
    expect(isPrivateNetworkIp("fd12:3456::9")).toBe(true);
    expect(isPrivateNetworkIp("8.8.8.8")).toBe(false);
    expect(isPrivateNetworkIp("203.0.113.10")).toBe(false);
  });
});

describe("NAS preflight", () => {
  it("selects the longest smbfs ancestor and checks the directory", async () => {
    const output = [
      "/dev/disk1s1 on / (apfs, local, journaled)",
      "//nas/share on /Volumes/YourNAS (smbfs, nodev, nosuid)",
    ].join("\n");
    expect(parseMountOutput(output)).toHaveLength(2);
    expect(findSmbfsAncestor(parseMountOutput(output), config.nasPath)?.mountPoint).toBe(
      "/Volumes/YourNAS",
    );
    const run = vi.fn(async () => ({ stdout: output }));
    const guard = new NasGuard({
      targetPath: config.nasPath,
      execFile: run,
      stat: async () => ({ isDirectory: () => true }),
    });
    await expect(guard.preflight()).resolves.toMatchObject({ ready: true, mounted: true, directoryExists: true });
    expect(run).toHaveBeenCalledWith("/sbin/mount", [], expect.objectContaining({ shell: false }));
  });

  it("calculates JSON-safe capacity from bigint statfs after a ready smbfs preflight", async () => {
    const output = "//nas/share on /Volumes/YourNAS (smbfs, nodev, nosuid)";
    const statfs = vi.fn(async () => ({
      bsize: 4096n,
      blocks: 100n,
      bfree: 25n,
      bavail: 20n,
    }));
    const guard = new NasGuard({
      targetPath: config.nasPath,
      execFile: vi.fn(async () => ({ stdout: output })),
      stat: async () => ({ isDirectory: () => true }),
      statfs,
    });

    const result = await guard.storage();

    expect(result).toEqual({
      path: config.nasPath,
      mounted: true,
      ready: true,
      totalBytes: 409_600,
      usedBytes: 327_680,
      freeBytes: 81_920,
    });
    expect(statfs).toHaveBeenCalledWith(config.nasPath);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("does not call statfs when the target fails the smbfs preflight", async () => {
    const statfs = vi.fn(async () => ({ bsize: 4096n, blocks: 100n, bfree: 50n, bavail: 50n }));
    const guard = new NasGuard({
      targetPath: config.nasPath,
      execFile: vi.fn(async () => ({ stdout: "/dev/disk1s1 on / (apfs, local, journaled)" })),
      stat: async () => ({ isDirectory: () => true }),
      statfs,
    });

    await expect(guard.storage()).resolves.toEqual({
      path: config.nasPath,
      mounted: false,
      ready: false,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
    });
    expect(statfs).not.toHaveBeenCalled();
  });
});

describe("opaque release sanitization", () => {
  it("keeps provider fields server-side and returns an opaque id", () => {
    const cached = new ReleaseCache({ idFactory: () => "opaque-release-id-123456" });
    const { raw } = makeRelease();
    const id = cached.put(raw);
    const summary = sanitizeRelease(cached.get(id)!, id);
    expect(id).not.toContain("private");
    expect(JSON.stringify(summary)).not.toContain("guid");
    expect(JSON.stringify(summary)).not.toContain("downloadUrl");
    expect(JSON.stringify(summary)).not.toContain("infoUrl");
    expect(summary).toMatchObject({ id, title: raw.title, indexer: "TJUPT" });
  });
});

describe("Prowlarr search constraints", () => {
  it("treats resolution as strict and ranks matching releases by seeders", async () => {
    const releases = [
      { title: "Movie Original Soundtrack FLAC", protocol: "torrent", size: 1, seeders: 200 },
      { title: "Movie 2160p low-seed", protocol: "torrent", size: 5, seeders: 3 },
      { title: "Movie 1080p", protocol: "torrent", size: 4, seeders: 500 },
      { title: "Movie 4K high-seed", protocol: "torrent", size: 8, seeders: 40 },
    ];
    const client = new ProwlarrClient({
      baseUrl: "http://127.0.0.1:9696",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(releases), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
      cache: new ReleaseCache({ idFactory: (() => {
        let index = 0;
        return () => `opaque-release-${String(++index).padStart(8, "0")}`;
      })() }),
    });

    const result = await client.search({ searchTerm: "Movie", resolution: "2160p" });

    expect(result.releases.map((release) => release.title)).toEqual([
      "Movie 4K high-seed",
      "Movie 2160p low-seed",
    ]);
  });
});

describe("Fastify authentication and grab guard", () => {
  it("auto-creates a LAN session while retaining CSRF and exact-origin checks", async () => {
    const release = makeRelease();
    const prowlarr = {
      search: vi.fn(async (intent: never) => ({ query: intent.searchTerm, intent, total: 0, elapsedMs: 0, releases: [] })),
      getRelease: vi.fn(() => release),
      grab: vi.fn(async () => undefined),
      check: vi.fn(async () => true),
    };
    const qbittorrent = {
      listTorrents: vi.fn(async () => []),
      duplicateForRelease: vi.fn(async () => false),
      check: vi.fn(async () => true),
    };
    const app = await createApp({
      config,
      pairing: new PairingService({ pairingCode: config.pairingCode, sessionStore: new SessionStore() }),
      prowlarr,
      qbittorrent,
      nas: readyNas,
      staticRoot: "/definitely-not-a-static-root",
    });
    const baseHeaders = { host: "localhost:4178", origin: "http://localhost:4178" };
    const session = await app.inject({ method: "GET", url: "/api/session", headers: { host: baseHeaders.host }, remoteAddress: "10.0.0.42" });
    expect(session.statusCode).toBe(200);
    expect(session.json().paired).toBe(true);
    expect(session.headers["set-cookie"]).toMatch(/HttpOnly/iu);
    expect(session.headers["set-cookie"]).toMatch(/SameSite=Strict/iu);
    expect(session.headers["content-security-policy"]).toContain("default-src 'self'");
    const cookie = String(session.headers["set-cookie"]).split(";", 1)[0];
    const csrfToken = session.json().csrfToken as string;

    const noCsrf = await app.inject({ method: "POST", url: "/api/search", headers: { ...baseHeaders, cookie }, payload: { query: "The Matrix" } });
    expect(noCsrf.statusCode).toBe(403);
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { host: "evil:4178", origin: "http://localhost:4178", cookie, "x-csrf-token": csrfToken },
      payload: { query: "The Matrix" },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const good = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { ...baseHeaders, cookie, "x-csrf-token": csrfToken },
      payload: { query: "The Matrix" },
    });
    expect(good.statusCode).toBe(200);

    const publicSession = await app.inject({ method: "GET", url: "/api/session", headers: { host: baseHeaders.host }, remoteAddress: "203.0.113.10" });
    expect(publicSession.json()).toEqual({ paired: false });
    expect(publicSession.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("does not invoke Prowlarr grab while the explicit arm is disabled", async () => {
    const release = makeRelease();
    const grab = vi.fn(async () => undefined);
    const app = await createApp({
      config,
      pairing: new PairingService({ pairingCode: config.pairingCode }),
      prowlarr: {
        search: vi.fn(),
        getRelease: vi.fn(() => release),
        grab,
        check: vi.fn(async () => true),
      },
      qbittorrent: {
        listTorrents: vi.fn(async () => []),
        duplicateForRelease: vi.fn(async () => false),
        check: vi.fn(async () => true),
      },
      nas: readyNas,
      staticRoot: "/definitely-not-a-static-root",
    });
    const pair = await app.inject({ method: "POST", url: "/api/auth/pair", headers: { host: "localhost:4178", origin: "http://localhost:4178" }, payload: { code: "123456" } });
    const headers = {
      host: "localhost:4178",
      origin: "http://localhost:4178",
      cookie: String(pair.headers["set-cookie"]).split(";", 1)[0],
      "x-csrf-token": pair.json().csrfToken as string,
    };
    const response = await app.inject({ method: "POST", url: "/api/grab", headers, payload: { releaseId: "abcdefghijklmnopqrst", confirm: true } });
    expect(response.statusCode).toBe(503);
    expect(grab).not.toHaveBeenCalled();
    await app.close();
  });

  it("protects NAS storage capacity with the session and returns a no-store summary", async () => {
    const app = await createApp({
      config,
      pairing: new PairingService({ pairingCode: config.pairingCode }),
      prowlarr: {
        search: vi.fn(),
        getRelease: vi.fn(() => makeRelease()),
        grab: vi.fn(async () => undefined),
        check: vi.fn(async () => true),
      },
      qbittorrent: {
        listTorrents: vi.fn(async () => []),
        duplicateForRelease: vi.fn(async () => false),
        check: vi.fn(async () => true),
      },
      nas: readyNas,
      staticRoot: "/definitely-not-a-static-root",
    });
    const baseHeaders = { host: "localhost:4178", origin: "http://localhost:4178" };

    const unauthenticated = await app.inject({ method: "GET", url: "/api/storage", headers: baseHeaders });
    expect(unauthenticated.statusCode).toBe(401);

    const pair = await app.inject({ method: "POST", url: "/api/auth/pair", headers: baseHeaders, payload: { code: "123456" } });
    const headers = {
      ...baseHeaders,
      cookie: String(pair.headers["set-cookie"]).split(";", 1)[0],
    };
    const response = await app.inject({ method: "GET", url: "/api/storage", headers });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      path: config.nasPath,
      mounted: true,
      ready: true,
      totalBytes: 100 * 1024 ** 3,
      usedBytes: 40 * 1024 ** 3,
      freeBytes: 60 * 1024 ** 3,
    });
    await app.close();
  });
});
