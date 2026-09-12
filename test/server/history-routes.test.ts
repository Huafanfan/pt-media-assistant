import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { PairingService, SessionStore } from "../../src/server/auth.js";
import { HistoryStore } from "../../src/server/history-store.js";

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
  preflight: vi.fn(async () => ({ path: config.nasPath, mounted: true, directoryExists: true, ready: true, mountPoint: "/Volumes/YourNAS" })),
  storage: vi.fn(async () => ({ path: config.nasPath, mounted: true, ready: true, totalBytes: 100, usedBytes: 40, freeBytes: 60 })),
};

async function makeApp() {
  const history = new HistoryStore({ now: () => Date.parse("2026-09-12T10:00:00.000Z") });
  const app = await createApp({
    config,
    pairing: new PairingService({ pairingCode: config.pairingCode, sessionStore: new SessionStore() }),
    prowlarr: {
      search: vi.fn(async () => ({ query: "", intent: { searchTerm: "" }, total: 0, elapsedMs: 0, releases: [] })),
      getRelease: vi.fn(),
      grab: vi.fn(async () => undefined),
      check: vi.fn(async () => true),
    },
    qbittorrent: {
      listTorrents: vi.fn(async () => []),
      duplicateForRelease: vi.fn(async () => false),
      check: vi.fn(async () => true),
      torrentAction: vi.fn(async () => undefined),
    },
    nas: readyNas,
    history,
    staticRoot: "/definitely-not-a-static-root",
  });
  const session = await app.inject({ method: "GET", url: "/api/session", headers: { host: "localhost:4178" }, remoteAddress: "10.0.0.42" });
  const headers = {
    host: "localhost:4178",
    origin: "http://localhost:4178",
    cookie: session.headers["set-cookie"] as string,
    "x-csrf-token": session.json().csrfToken as string,
  };
  return { app, headers, history };
}

describe("持久化历史路由", () => {
  it("marks and unmarks seen media and returns the family-shared snapshot", async () => {
    const { app, headers } = await makeApp();
    const empty = await app.inject({ method: "GET", url: "/api/history", headers });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers["cache-control"]).toBe("no-store");
    expect(empty.json()).toMatchObject({ seen: [] });

    const marked = await app.inject({
      method: "POST",
      url: "/api/history/seen",
      headers,
      payload: { mediaId: "1293000", mediaType: "movie", title: "星际穿越" },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toEqual({ ok: true });

    const listed = await app.inject({ method: "GET", url: "/api/history", headers });
    expect(listed.json().seen).toHaveLength(1);
    expect(listed.json().seen[0]).toMatchObject({ mediaId: "1293000", mediaType: "movie", title: "星际穿越" });
    expect(Number.isFinite(Date.parse(listed.json().seen[0].markedAt))).toBe(true);
    expect(listed.json().preferences.seenMediaIds).toContain("movie:1293000");

    const removed = await app.inject({ method: "DELETE", url: "/api/history/seen/movie/1293000", headers });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/history", headers });
    expect(after.json().seen).toEqual([]);
    expect(after.json().preferences.seenMediaIds).not.toContain("movie:1293000");
    await app.close();
  });

  it("requires a session to read and a CSRF token to write", async () => {
    const { app, headers } = await makeApp();
    const readWithoutSession = await app.inject({ method: "GET", url: "/api/history", headers: { host: "localhost:4178" } });
    expect(readWithoutSession.statusCode).toBe(401);

    const writeWithoutCsrf = await app.inject({
      method: "POST",
      url: "/api/history/seen",
      headers: { host: "localhost:4178", origin: "http://localhost:4178", cookie: headers.cookie },
      payload: { mediaId: "1", mediaType: "movie", title: "某电影" },
    });
    expect(writeWithoutCsrf.statusCode).toBe(403);

    const deleteWithoutCsrf = await app.inject({
      method: "DELETE",
      url: "/api/history/seen/movie/1",
      headers: { host: "localhost:4178", origin: "http://localhost:4178", cookie: headers.cookie },
    });
    expect(deleteWithoutCsrf.statusCode).toBe(403);
    await app.close();
  });

  it("rejects malformed media identities and unknown fields", async () => {
    const { app, headers, history } = await makeApp();
    for (const payload of [
      { mediaId: "not a media id", mediaType: "movie", title: "某电影" },
      { mediaId: "1", mediaType: "anime", title: "某电影" },
      { mediaId: "1", mediaType: "movie", title: "" },
      { mediaId: "1", mediaType: "movie", title: "某电影", extra: true },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/history/seen", headers, payload });
      expect(response.statusCode).toBe(400);
    }
    const badDelete = await app.inject({ method: "DELETE", url: "/api/history/seen/movie/not-an-id!", headers });
    expect(badDelete.statusCode).toBe(400);
    expect(history.snapshot().seen).toEqual([]);
    await app.close();
  });
});
