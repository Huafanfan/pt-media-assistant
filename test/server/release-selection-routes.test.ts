import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/server/app.js";
import type { CompatibleChatProvider } from "../../src/server/ai/provider.js";
import type { DiscoveryMedia, ReleaseSummary } from "../../src/shared/contracts.js";
import { SearchSnapshotRegistry } from "../../src/server/release-selection/snapshots.js";
import { SelectionService } from "../../src/server/release-selection/service.js";
import { releaseSelectionRequestSchema } from "../../src/shared/release-selection.js";

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

const media: DiscoveryMedia = {
  id: "36808876",
  title: "奥德赛",
  originalTitle: "The Odyssey",
  year: "2026",
  mediaType: "movie",
  genres: ["动作"],
  summary: "漫长归途。",
  sourceUrl: "https://movie.douban.com/subject/36808876/",
};

function release(id: string, title: string): ReleaseSummary {
  return {
    id,
    title,
    indexer: "TJUPT",
    protocol: "torrent",
    size: 5 * 1024 ** 3,
    seeders: 12,
    leechers: 1,
    grabs: 3,
    ageDays: 2,
    categories: ["Movies"],
    freeleech: false,
    freeleechState: "no",
    evidence: {
      resolution: "title_inferred",
      codec: "title_inferred",
      size: "upstream",
      seeders: "upstream",
      season: "unknown",
    },
  };
}

function discoverySnapshot(releases: ReleaseSummary[] = [
  release("rel-aaaaaaaa", "The.Odyssey.2026.1080p.WEB-DL.x264"),
]) {
  return {
    snapshotId: "snap-aaaaaaaa",
    media,
    response: {
      snapshotId: "snap-aaaaaaaa",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      actionableUntil: new Date(Date.now() + 60_000).toISOString(),
      itemId: media.id,
      query: "The Odyssey 2026",
      status: "available" as const,
      checkedAt: new Date().toISOString(),
      total: releases.length,
      releases,
    },
  };
}

type HarnessOptions = {
  snapshot?: ReturnType<typeof discoverySnapshot> | undefined;
};

function harness(options: HarnessOptions = {}) {
  const search = vi.fn(async () => ({
    query: "The Odyssey 2026",
    intent: { searchTerm: "The Odyssey 2026" },
    total: 1,
    elapsedMs: 3,
    releases: [release("rel-bbbbbbbb", "The.Odyssey.2026.1080p.WEB-DL.x264")],
  }));
  const hasRelease = vi.fn(() => true);
  const snapshot =
    "snapshot" in options ? options.snapshot : discoverySnapshot();
  return {
    services: {
      config: config as never,
      prowlarr: {
        search,
        getRelease: vi.fn(),
        grab: vi.fn(),
        check: vi.fn(async () => true),
        hasRelease,
      },
      discovery: {
        list: vi.fn(async () => ({
          collection: "movie-hot" as const,
          updatedAt: new Date().toISOString(),
          stale: false,
          page: 1,
          pageSize: 10,
          total: 1,
          hasNext: false,
          items: [],
        })),
        getReleases: vi.fn(),
        getReleaseSnapshot: vi.fn(() => snapshot),
      },
      qbittorrent: {
        listTorrents: vi.fn(async () => []),
        duplicateForRelease: vi.fn(async () => false),
        check: vi.fn(async () => true),
        torrentAction: vi.fn(async () => undefined),
      },
      nas: {
        preflight: vi.fn(async () => ({
          path: config.nasPath,
          mounted: true,
          directoryExists: true,
          ready: true,
        })),
        storage: vi.fn(async () => ({
          path: config.nasPath,
          mounted: true,
          ready: true,
          totalBytes: 100,
          usedBytes: 40,
          freeBytes: 60,
        })),
      },
    },
    search,
    hasRelease,
  };
}

async function trustedSession(app: Awaited<ReturnType<typeof createApp>>) {
  const response = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { host: "localhost:4178" },
    remoteAddress: "10.0.0.42",
  });
  return {
    cookie: String(response.headers["set-cookie"]).split(";", 1)[0],
    csrfToken: String(response.json().csrfToken),
  };
}

const selectionBody = {
  snapshot: {
    kind: "discovery",
    mediaType: "movie",
    itemId: media.id,
    snapshotId: "snap-aaaaaaaa",
  },
  target: { kind: "movie", mode: "browse" },
  preferences: {},
};

describe("POST /api/releases/selection", () => {
  it("ranks an existing discovery snapshot without a new PT query", async () => {
    const { services, search } = harness();
    const app = await createApp(services as never);
    const session = await trustedSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/releases/selection",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: selectionBody,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.snapshot.id).toBe("snap-aaaaaaaa");
    expect(body.recommendations).toHaveLength(1);
    expect(body.recommendations[0].releaseId).toBe("rel-aaaaaaaa");
    expect(body.revision.algorithmVersion).toBe("selection-1");
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects a stale snapshot id with 409", async () => {
    const { services } = harness();
    const app = await createApp(services as never);
    const session = await trustedSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/releases/selection",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: {
        ...selectionBody,
        snapshot: { ...selectionBody.snapshot, snapshotId: "snap-stale00" },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("SNAPSHOT_EXPIRED");
  });

  it("rejects a missing snapshot with 409", async () => {
    const { services } = harness({ snapshot: undefined });
    const app = await createApp(services as never);
    const session = await trustedSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/releases/selection",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: selectionBody,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("SNAPSHOT_NOT_FOUND");
  });

  it("validates an explicit target", async () => {
    const { services } = harness();
    const app = await createApp(services as never);
    const session = await trustedSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/releases/selection",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: {
        ...selectionBody,
        target: { kind: "series", mode: "explicit", season: 2 },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires a session", async () => {
    const { services } = harness();
    const app = await createApp(services as never);
    const response = await app.inject({
      method: "POST",
      url: "/api/releases/selection",
      headers: { host: "localhost:4178" },
      remoteAddress: "10.0.0.42",
      payload: selectionBody,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("POST /api/search snapshot reference", () => {
  it("returns a snapshot id that selection can use", async () => {
    const { services, hasRelease } = harness();
    const app = await createApp(services as never);
    const session = await trustedSession(app);
    const searchResponse = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: { query: "The Odyssey 2026" },
    });
    expect(searchResponse.statusCode).toBe(200);
    const snapshotId = searchResponse.json().snapshotId as string;
    expect(snapshotId).toBeTruthy();

    const selectionResponse = await app.inject({
      method: "POST",
      url: "/api/releases/selection",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: {
        snapshot: { kind: "search", snapshotId },
        target: { kind: "movie", mode: "browse" },
        preferences: {},
      },
    });
    expect(selectionResponse.statusCode).toBe(200);
    const body = selectionResponse.json();
    // Direct search has no confirmed work identity.
    expect(body.recommendations).toHaveLength(0);
    expect(body.snapshot.media).toBeNull();

    hasRelease.mockReturnValue(false);
    const revoked = await app.inject({
      method: "POST",
      url: "/api/releases/selection",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: {
        snapshot: { kind: "search", snapshotId },
        target: { kind: "movie", mode: "browse" },
        preferences: {},
      },
    });
    expect(revoked.statusCode).toBe(409);
  });
});

describe("POST /api/releases/selection/assist", () => {
  it("returns the rules result with an AI-disabled warning", async () => {
    const { services } = harness();
    const app = await createApp(services as never);
    const session = await trustedSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/releases/selection/assist",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: { ...selectionBody, mode: "compare" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.analysis).toBe("rule_fallback");
    expect(body.warnings[0].code).toBe("AI_DISABLED");
    expect(body.selection.snapshot.id).toBe("snap-aaaaaaaa");
  });

  it("returns verified AI suggestions without changing the rules selection", async () => {
    const { services } = harness();
    const chat = vi.fn(
      async (_messages: Parameters<CompatibleChatProvider["chat"]>[0]) => ({
        message: {
          role: "assistant" as const,
          content: JSON.stringify({
            text: "候选 1 标注了 1080p。",
            parseSuggestions: [
              {
                candidate: "c1",
                field: "resolution",
                value: "1080p",
                raw: "1080p",
              },
              { candidate: "c9", field: "resolution", value: "1080p", raw: "1080p" },
            ],
          }),
        },
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      }),
    );
    const app = await createApp({
      ...services,
      config: { ...config, aiEnabled: true } as never,
      aiProvider: { chat },
    } as never);
    const session = await trustedSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/releases/selection/assist",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: { ...selectionBody, mode: "compare" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.analysis).toBe("complete");
    expect(body.parseSuggestions).toHaveLength(1);
    expect(body.parseSuggestions[0].releaseId).toBe("rel-aaaaaaaa");
    expect(body.selection.recommendations[0].releaseId).toBe("rel-aaaaaaaa");
    expect(chat).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(vi.mocked(chat).mock.calls[0]?.[0] ?? []);
    expect(sent).not.toMatch(/downloadUrl|guid|passkey|cookie/iu);
  });

  it("validates the assist body", async () => {
    const { services } = harness();
    const app = await createApp(services as never);
    const session = await trustedSession(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/releases/selection/assist",
      headers: {
        host: "localhost:4178",
        cookie: session.cookie,
        origin: "http://localhost:4178",
        "x-csrf-token": session.csrfToken,
      },
      remoteAddress: "10.0.0.42",
      payload: { ...selectionBody, mode: "preferences" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("SearchSnapshotRegistry", () => {
  const releases = [release("rel-cccccccc", "Example.2026.1080p.WEB-DL.x264")];

  it("expires snapshots by TTL", () => {
    let now = 0;
    const registry = new SearchSnapshotRegistry({
      now: () => now,
      ttlMs: 1000,
      idFactory: () => "snap-cccccccc",
    });
    registry.register("Example 2026", releases);
    expect(registry.resolve("snap-cccccccc")).toBeDefined();
    now = 2000;
    expect(registry.resolve("snap-cccccccc")).toBeUndefined();
  });

  it("drops a snapshot when a release reference is revoked", () => {
    const alive = new Set(["rel-cccccccc"]);
    const registry = new SearchSnapshotRegistry({
      idFactory: () => "snap-dddddddd",
      isReleaseAlive: (id) => alive.has(id),
    });
    registry.register("Example 2026", releases);
    alive.clear();
    expect(registry.resolve("snap-dddddddd")).toBeUndefined();
  });

  it("caps retained entries", () => {
    let counter = 0;
    const registry = new SearchSnapshotRegistry({
      maxEntries: 2,
      idFactory: () => `snap-${String(counter++).padStart(8, "0")}`,
    });
    registry.register("one", releases);
    registry.register("two", releases);
    registry.register("three", releases);
    expect(registry.size).toBe(2);
    expect(registry.resolve("snap-00000000")).toBeUndefined();
    expect(registry.resolve("snap-00000002")).toBeDefined();
  });
});

describe("SelectionService", () => {
  it("hashes target and preference revisions deterministically", () => {
    const service = new SelectionService({
      searchSnapshots: new SearchSnapshotRegistry({
        idFactory: () => "snap-eeeeeeee",
      }),
    });
    const { snapshotId } = service.registerSearchSnapshot("query", [
      release("rel-eeeeeeee", "Example.2026.1080p.WEB-DL.x264"),
    ]);
    const base = releaseSelectionRequestSchema.parse({
      snapshot: { kind: "search", snapshotId },
      target: { kind: "movie", mode: "browse" },
      preferences: {},
    });
    const first = service.preview(base);
    const second = service.preview(base);
    expect(first.revision.targetRevision).toBe(second.revision.targetRevision);
    expect(first.revision.preferencesRevision).toBe(
      second.revision.preferencesRevision,
    );
    const changed = service.preview(
      releaseSelectionRequestSchema.parse({
        snapshot: { kind: "search", snapshotId },
        target: { kind: "movie", mode: "browse" },
        preferences: { maxSizeBytes: 1024 ** 3 },
      }),
    );
    expect(changed.revision.preferencesRevision).not.toBe(
      first.revision.preferencesRevision,
    );
  });
});
