import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { PairingService, SessionStore } from "../../src/server/auth.js";
import { QBittorrentClient } from "../../src/server/qbittorrent.js";

const hash = "a".repeat(40);

const config = {
  host: "0.0.0.0",
  port: 4178,
  prowlarrUrl: "http://127.0.0.1:9696",
  prowlarrApiKey: "test-only-key",
  qbittorrentUrl: "http://127.0.0.1:8080",
  nasPath: "/Volumes/YourNAS/pt",
  nasCheckMode: "smbfs" as const,
  nasSentinelName: ".pt-media-assistant-mounted",
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

async function makeApp(torrentAction: (action: string, hashes: string[]) => Promise<void> = vi.fn(async () => undefined)) {
  const prowlarr = {
    search: vi.fn(async () => ({ query: "", intent: { searchTerm: "" }, total: 0, elapsedMs: 0, releases: [] })),
    getRelease: vi.fn(),
    grab: vi.fn(async () => undefined),
    check: vi.fn(async () => true),
  };
  const qbittorrent = {
    listTorrents: vi.fn(async () => []),
    duplicateForRelease: vi.fn(async () => false),
    check: vi.fn(async () => true),
    torrentAction,
  };
  const app = await createApp({
    config,
    pairing: new PairingService({ pairingCode: config.pairingCode, sessionStore: new SessionStore() }),
    prowlarr,
    qbittorrent,
    nas: readyNas,
    staticRoot: "/definitely-not-a-static-root",
  });
  const session = await app.inject({ method: "GET", url: "/api/session", headers: { host: "localhost:4178" }, remoteAddress: "10.0.0.42" });
  const headers = {
    host: "localhost:4178",
    origin: "http://localhost:4178",
    cookie: session.headers["set-cookie"] as string,
    "x-csrf-token": session.json().csrfToken as string,
  };
  return { app, headers, torrentAction };
}

describe("torrent task actions route", () => {
  it("forwards pause, resume, and remove with exactly the requested hashes", async () => {
    const { app, headers, torrentAction } = await makeApp();
    for (const action of ["pause", "resume", "remove"]) {
      const response = await app.inject({ method: "POST", url: "/api/torrents/actions", headers, payload: { action, hashes: [hash] } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(torrentAction).toHaveBeenLastCalledWith(action, [hash]);
    }
    await app.close();
  });

  it("rejects unknown fields, the all keyword, unknown actions, and malformed hashes", async () => {
    const { app, headers, torrentAction } = await makeApp();
    const payloads: Array<Record<string, unknown>> = [
      { action: "pause", hashes: ["all"] },
      { action: "pause", hashes: [hash], deleteFiles: true },
      { action: "delete", hashes: [hash] },
      { action: "remove", hashes: [] },
      { action: "remove", hashes: ["A".repeat(200)] },
      { action: "remove", hashes: [hash, hash], extra: true },
      // Batch control stays out of scope even with valid hashes.
      { action: "pause", hashes: [hash, hash] },
      { action: "remove", hashes: [hash, "b".repeat(40)] },
    ];
    for (const payload of payloads) {
      const response = await app.inject({ method: "POST", url: "/api/torrents/actions", headers, payload });
      expect(response.statusCode).toBe(400);
    }
    expect(torrentAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires a session and a matching CSRF token", async () => {
    const { app, headers, torrentAction } = await makeApp();
    const noSession = await app.inject({
      method: "POST",
      url: "/api/torrents/actions",
      headers: { host: "localhost:4178", origin: "http://localhost:4178", "x-csrf-token": headers["x-csrf-token"] },
      payload: { action: "pause", hashes: [hash] },
    });
    expect(noSession.statusCode).toBe(401);
    const badCsrf = await app.inject({
      method: "POST",
      url: "/api/torrents/actions",
      headers: { ...headers, "x-csrf-token": "not-the-token" },
      payload: { action: "pause", hashes: [hash] },
    });
    expect(badCsrf.statusCode).toBe(403);
    expect(torrentAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a mismatched Origin", async () => {
    const { app, headers, torrentAction } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/torrents/actions",
      headers: { ...headers, origin: "http://evil.example" },
      payload: { action: "pause", hashes: [hash] },
    });
    expect(response.statusCode).toBe(403);
    expect(torrentAction).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps adapter failures to a sanitized upstream error", async () => {
    const { app, headers } = await makeApp(vi.fn(async () => { throw new Error("boom"); }));
    const response = await app.inject({ method: "POST", url: "/api/torrents/actions", headers, payload: { action: "remove", hashes: [hash] } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Upstream service unavailable", code: "UPSTREAM_UNAVAILABLE" });
    await app.close();
  });
});

function qbFetch(version: string) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/api/v2/app/webapiVersion")) return new Response(version, { status: 200 });
    if (url.includes("/api/v2/torrents/")) return new Response("", { status: 200 });
    return new Response("", { status: 404 });
  });
  return { fetchImpl, calls };
}

describe("qBittorrent control endpoint compatibility", () => {
  it("uses stop/start on Web API 2.11+ and pause/resume on 4.6.x", async () => {
    const modern = qbFetch("2.11.2");
    const modernClient = new QBittorrentClient({ baseUrl: "http://127.0.0.1:8080", fetchImpl: modern.fetchImpl });
    await modernClient.torrentAction("pause", [hash]);
    expect(modern.calls.some((call) => call.url.endsWith("/api/v2/torrents/stop"))).toBe(true);

    const legacy = qbFetch("2.9.3");
    const legacyClient = new QBittorrentClient({ baseUrl: "http://127.0.0.1:8080", fetchImpl: legacy.fetchImpl });
    await legacyClient.torrentAction("pause", [hash]);
    expect(legacy.calls.some((call) => call.url.endsWith("/api/v2/torrents/pause"))).toBe(true);
  });

  it("falls back once when the reported version uses the other endpoint family", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/v2/app/webapiVersion")) return new Response("2.9.3", { status: 200 });
      if (url.endsWith("/api/v2/torrents/pause")) return new Response("", { status: 404 });
      if (url.endsWith("/api/v2/torrents/stop")) return new Response("", { status: 200 });
      return new Response("", { status: 404 });
    });
    const client = new QBittorrentClient({ baseUrl: "http://127.0.0.1:8080", fetchImpl });
    await client.torrentAction("pause", [hash]);
    expect(calls.filter((url) => url.endsWith("/api/v2/torrents/stop"))).toHaveLength(1);
  });

  it("removes tasks without deleting files and rejects non-hash input", async () => {
    const { fetchImpl, calls } = qbFetch("2.9.3");
    const client = new QBittorrentClient({ baseUrl: "http://127.0.0.1:8080", fetchImpl });
    await client.torrentAction("remove", [hash]);
    expect(calls.find((call) => call.url.endsWith("/api/v2/torrents/delete"))?.body).toContain("deleteFiles=false");
    await expect(client.torrentAction("remove", ["all"])).rejects.toThrow();
    await expect(client.torrentAction("pause", [])).rejects.toThrow();
    await expect(client.torrentAction("pause", [hash, "b".repeat(40)])).rejects.toThrow();
  });
});
