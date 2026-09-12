import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../../src/server/ai/conversation-store.js";
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
    expect(parsed.version).toBe(1);
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
});
