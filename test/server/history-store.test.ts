import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../../src/server/ai/conversation-store.js";
import { filterCandidateForPreferences } from "../../src/server/ai/recommendation.js";
import { updatePreferences } from "../../src/server/ai/tools.js";
import { HistoryStore } from "../../src/server/history-store.js";
import { defaultAssistantPreferences } from "../../src/shared/assistant.js";

const temporaryDirectories: string[] = [];
const markedAt = "2026-09-12T10:00:00.000Z";
const now = () => Date.parse(markedAt);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pt-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("持久化历史存储", () => {
  it("persists seen entries and preferences across reloads", async () => {
    const path = join(await temporaryDirectory(), "history.json");
    const store = new HistoryStore({ path, now });
    store.markSeen({ mediaId: "1293000", mediaType: "movie", title: "星际穿越", markedAt });
    store.savePreferences({ ...defaultAssistantPreferences(), resolution: "1080p" });

    const reloaded = new HistoryStore({ path, now });
    expect(reloaded.loadError).toBeUndefined();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.snapshot().seen).toEqual([{ mediaId: "1293000", mediaType: "movie", title: "星际穿越", markedAt }]);
    expect(reloaded.preferences().resolution).toBe("1080p");
    expect(reloaded.knownSeenIds().has("movie:1293000")).toBe(true);
    expect(reloaded.knownSeenIds().has("1293000")).toBe(true);
  });

  it("writes through a temporary file and leaves no partial state", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "history.json");
    const store = new HistoryStore({ path, now });
    store.markSeen({ mediaId: "42", mediaType: "tv", title: "某剧", markedAt });

    const parsed = JSON.parse(await readFile(path, "utf8")) as { version: number; seen: unknown[] };
    expect(parsed.version).toBe(2);
    expect(parsed.seen).toHaveLength(1);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("preserves a damaged file instead of silently replacing it with an empty state", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "history.json");
    await writeFile(path, "{not-json", "utf8");

    const store = new HistoryStore({ path, now });
    expect(store.loadError).toMatch(/损坏/u);
    expect(store.snapshot().seen).toEqual([]);
    const entries = await readdir(directory);
    expect(entries).toContain(`history.json.corrupt-${now()}`);
    await expect(readFile(path, "utf8")).rejects.toThrow();

    // A later mutation writes a fresh file; the damaged copy stays available.
    store.markSeen({ mediaId: "7", mediaType: "movie", title: "新记录", markedAt });
    expect(entries).toContain(`history.json.corrupt-${now()}`);
    expect(JSON.parse(await readFile(path, "utf8")).seen).toHaveLength(1);
  });

  it("treats an unknown stored version as damaged state", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "history.json");
    await writeFile(path, JSON.stringify({ version: 99, seen: [], preferences: defaultAssistantPreferences() }), "utf8");
    const store = new HistoryStore({ path, now });
    expect(store.loadError).toMatch(/损坏/u);
  });

  it("keeps unknown-title seen IDs in preferences and removes both forms on unmark", async () => {
    const path = join(await temporaryDirectory(), "history.json");
    const store = new HistoryStore({ path, now });
    store.savePreferences({ ...defaultAssistantPreferences(), seenMediaIds: ["tv:999"] });
    expect(store.snapshot().seen).toEqual([]);
    expect(store.knownSeenIds().has("tv:999")).toBe(true);

    store.markSeen({ mediaId: "999", mediaType: "tv", title: "某剧", markedAt });
    expect(store.unmarkSeen("tv", "999")).toBe(true);
    const reloaded = new HistoryStore({ path, now });
    // `type:id` tombstones must stay schema-valid across reloads.
    expect(reloaded.loadError).toBeUndefined();
    expect(reloaded.knownSeenIds().has("tv:999")).toBe(false);
    expect(reloaded.knownSeenIds().has("999")).toBe(false);
    expect(reloaded.snapshot().seen).toEqual([]);
  });

  it("adds display entries for AI-marked seen IDs only when a title is known", () => {
    const store = new HistoryStore({ now });
    store.savePreferences(
      { ...defaultAssistantPreferences(), seenMediaIds: ["movie:42", "movie:43"] },
      new Map([["movie:42", { mediaId: "42", mediaType: "movie", title: "已知电影" }]])
    );
    expect(store.snapshot().seen).toEqual([{ mediaId: "42", mediaType: "movie", title: "已知电影", markedAt }]);
    expect(store.knownSeenIds().has("movie:43")).toBe(true);
  });

  it("bounds the seen list without dropping the newest entries", () => {
    const store = new HistoryStore({ now });
    for (let index = 0; index < 2_100; index += 1) {
      store.markSeen({ mediaId: String(index), mediaType: "movie", title: `电影 ${index}`, markedAt });
    }
    const seen = store.snapshot().seen;
    expect(seen).toHaveLength(2_000);
    expect(seen[0]?.mediaId).toBe("2099");
  });

  it("stays in memory only when no data directory is configured", () => {
    const store = new HistoryStore({ now });
    expect(store.enabled).toBe(false);
    store.markSeen({ mediaId: "1", mediaType: "movie", title: "临时", markedAt });
    expect(store.snapshot().seen).toHaveLength(1);
  });
});

describe("会话从持久化状态初始化", () => {
  it("seeds preferences and accepts persisted seen IDs in model patches", () => {
    const store = new ConversationStore(now, {
      preferences: () => ({ ...defaultAssistantPreferences(), resolution: "1080p", seenMediaIds: ["movie:7"] }),
      seenIds: () => new Set(["movie:7", "7"]),
    });
    const { turn } = store.start("owner", "client-turn-1");
    expect(turn.conversation.preferences.resolution).toBe("1080p");
    expect(turn.conversation.knownSeen?.has("7")).toBe(true);
    // A persisted seen ID is valid even though no candidate is in memory yet.
    expect(() => updatePreferences(turn.conversation, { seenMediaIds: ["movie:7"] })).not.toThrow();
    expect(() => updatePreferences(turn.conversation, { seenMediaIds: ["movie:404"] })).toThrow();
  });

  it("rebases a resumed conversation on the durable shared preferences", () => {
    let shared = defaultAssistantPreferences();
    const store = new ConversationStore(now, {
      preferences: () => shared,
      seenIds: () => new Set(["movie:7"]),
    });
    const first = store.start("owner", "turn-1").turn;
    const conversationId = first.conversation.id;
    first.conversation.active = undefined;
    // Another device changed the shared preferences after this conversation started.
    shared = { ...shared, resolution: "2160p" };
    const second = store.start("owner", "turn-2", conversationId).turn;
    expect(second.conversation.preferences.resolution).toBe("2160p");
  });
});

describe("持久化正确性回归", () => {
  it("persists a preference-only unmark across reloads", async () => {
    const path = join(await temporaryDirectory(), "history.json");
    const store = new HistoryStore({ path, now });
    store.savePreferences({ ...defaultAssistantPreferences(), seenMediaIds: ["tv:999"] });
    expect(store.knownSeenIds().has("tv:999")).toBe(true);
    expect(store.unmarkSeen("tv", "999")).toBe(true);

    const reloaded = new HistoryStore({ path, now });
    expect(reloaded.knownSeenIds().has("tv:999")).toBe(false);
    expect(reloaded.preferences().seenMediaIds).not.toContain("tv:999");
  });

  it("keeps the full durable seen set authoritative beyond the preference cap", () => {
    const store = new HistoryStore({ now });
    for (let index = 0; index < 130; index += 1) {
      store.markSeen({ mediaId: String(index), mediaType: "movie", title: `电影 ${index}`, markedAt });
    }
    const known = store.knownSeenIds();
    expect(known.size).toBe(260);
    // The oldest entry fell out of the bounded preference array but is still excluded.
    expect(store.preferences().seenMediaIds).not.toContain("movie:0");
    const oldest = { id: "0", title: "电影 0", mediaType: "movie" as const, genres: [], summary: "", sourceUrl: "" };
    expect(filterCandidateForPreferences(oldest, store.preferences(), known)).toBe(false);
  });

  it("does not let a stale conversation resurrect a manually unmarked entry", () => {
    const store = new HistoryStore({ now });
    store.markSeen({ mediaId: "7", mediaType: "movie", title: "某电影", markedAt });
    expect(store.unmarkSeen("movie", "7")).toBe(true);
    // A conversation that still carries the ID in its working set saves later.
    expect(store.savePreferences({ ...defaultAssistantPreferences(), seenMediaIds: ["movie:7", "7"] })).toBe(true);
    expect(store.knownSeenIds().has("movie:7")).toBe(false);
    expect(store.snapshot().seen).toEqual([]);
  });

  it("reports a failed write and keeps the previous valid state", async () => {
    const directory = await temporaryDirectory();
    const blocker = join(directory, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const store = new HistoryStore({ path: join(blocker, "history.json"), now });

    expect(store.markSeen({ mediaId: "1", mediaType: "movie", title: "某电影", markedAt })).toBe(false);
    expect(store.loadError).toMatch(/写入失败/u);
    expect(store.snapshot().seen).toEqual([]);
    expect(store.knownSeenIds().size).toBe(0);
  });

  it("loads a version 1 file and upgrades it on the next write", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "history.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      seen: [{ mediaId: "5", mediaType: "movie", title: "旧记录", markedAt }],
      preferences: defaultAssistantPreferences(),
    }), "utf8");

    const store = new HistoryStore({ path, now });
    expect(store.loadError).toBeUndefined();
    expect(store.snapshot().seen).toHaveLength(1);
    expect(store.unmarkSeen("movie", "5")).toBe(true);
    const raw = JSON.parse(await readFile(path, "utf8")) as { version: number; removed: string[] };
    expect(raw.version).toBe(2);
    expect(raw.removed).toContain("movie:5");
    // The upgraded file must load cleanly, including the `type:id` tombstone.
    const reloaded = new HistoryStore({ path, now });
    expect(reloaded.loadError).toBeUndefined();
    expect(reloaded.knownSeenIds().has("movie:5")).toBe(false);
  });
});
