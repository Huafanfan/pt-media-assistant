import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { assistantPreferencesSchema, defaultAssistantPreferences, type AssistantPreferences } from "../shared/assistant.js";
import type { Conversation } from "./ai/conversation-store.js";

export const HISTORY_STORE_VERSION = 1;
export const MAX_SEEN_ENTRIES = 2_000;
const MAX_PREFERENCE_SEEN_IDS = 100;

export const seenEntrySchema = z.object({
  mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  mediaType: z.enum(["movie", "tv"]),
  title: z.string().trim().min(1).max(240),
  markedAt: z.iso.datetime(),
}).strict();
export type SeenEntry = z.infer<typeof seenEntrySchema>;

const stateSchema = z.object({
  version: z.literal(HISTORY_STORE_VERSION),
  seen: z.array(seenEntrySchema).max(MAX_SEEN_ENTRIES),
  preferences: assistantPreferencesSchema,
}).strict();

export type SeenTitleRecord = { mediaId: string; mediaType: "movie" | "tv"; title: string };
export type SeenTitleIndex = ReadonlyMap<string, SeenTitleRecord>;

/**
 * Build a lookup of the titles this conversation knows for seen IDs. The AI
 * can only mark IDs it has already resolved, so a missing title simply means
 * the ID stays in preferences instead of gaining a display entry.
 */
export function buildSeenTitleIndex(conversation: Conversation): SeenTitleIndex {
  const index = new Map<string, SeenTitleRecord>();
  const add = (mediaId: string, mediaType: "movie" | "tv", title: string): void => {
    if (!mediaId) return;
    const record: SeenTitleRecord = { mediaId, mediaType, title: title.trim().slice(0, 240) || mediaId };
    index.set(mediaId, record);
    index.set(`${mediaType}:${mediaId}`, record);
  };
  for (const candidate of conversation.candidates.values()) {
    add(candidate.media.id, candidate.media.mediaType, candidate.media.title);
  }
  for (const entry of conversation.history) {
    for (const card of [...entry.response.recommendations, ...(entry.response.pendingRecommendations ?? [])]) {
      add(card.mediaId, card.mediaType, card.title);
    }
  }
  return index;
}

/**
 * Family-shared seen records and AI preferences persisted as one JSON file.
 * Writes go through a temporary file and rename so a crash or concurrent
 * reader never observes a half-written state. A damaged file is renamed and
 * kept; it is never silently replaced by an empty one.
 */
export class HistoryStore {
  private state: { seen: SeenEntry[]; preferences: AssistantPreferences };
  private readonly path?: string;
  private readonly now: () => number;
  private writeBlocked = false;
  private error?: string;

  public constructor(options: { path?: string; now?: () => number } = {}) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.state = { seen: [], preferences: defaultAssistantPreferences() };
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = stateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      this.state = { seen: parsed.seen, preferences: parsed.preferences };
    } catch {
      // Preserve the damaged file instead of silently replacing it with an
      // empty state. The status view surfaces the load error.
      try {
        renameSync(this.path, `${this.path}.corrupt-${this.now()}`);
        this.error = "历史数据文件损坏，已保留原文件并以默认状态启动。";
      } catch {
        this.writeBlocked = true;
        this.error = "历史数据文件损坏且无法备份，持久化写入已停用。";
      }
      return;
    }
    this.mergeSeenIntoPreferences();
  }

  public get loadError(): string | undefined {
    return this.error;
  }

  public get enabled(): boolean {
    return Boolean(this.path) && !this.writeBlocked;
  }

  public snapshot(): { seen: SeenEntry[]; preferences: AssistantPreferences } {
    return {
      seen: this.state.seen.map((entry) => ({ ...entry })),
      preferences: this.preferences(),
    };
  }

  public preferences(): AssistantPreferences {
    return assistantPreferencesSchema.parse({
      ...this.state.preferences,
      includeGenres: [...this.state.preferences.includeGenres],
      excludeGenres: [...this.state.preferences.excludeGenres],
      seenMediaIds: [...this.state.preferences.seenMediaIds],
    });
  }

  /** Both raw and `type:id` forms, so model patches can reference either. */
  public knownSeenIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.state.seen) {
      ids.add(entry.mediaId);
      ids.add(`${entry.mediaType}:${entry.mediaId}`);
    }
    for (const id of this.state.preferences.seenMediaIds) ids.add(id);
    return ids;
  }

  public markSeen(entry: SeenEntry): SeenEntry {
    const parsed = seenEntrySchema.parse(entry);
    const key = `${parsed.mediaType}:${parsed.mediaId}`;
    this.state.seen = [parsed, ...this.state.seen.filter((existing) => `${existing.mediaType}:${existing.mediaId}` !== key)];
    this.trimSeen();
    this.state.preferences = assistantPreferencesSchema.parse({
      ...this.state.preferences,
      seenMediaIds: uniqueTail([...this.state.preferences.seenMediaIds, parsed.mediaId, key], MAX_PREFERENCE_SEEN_IDS),
    });
    this.persist();
    return parsed;
  }

  public unmarkSeen(mediaType: "movie" | "tv", mediaId: string): boolean {
    const key = `${mediaType}:${mediaId}`;
    const before = this.state.seen.length;
    this.state.seen = this.state.seen.filter((entry) => `${entry.mediaType}:${entry.mediaId}` !== key);
    this.state.preferences = assistantPreferencesSchema.parse({
      ...this.state.preferences,
      seenMediaIds: this.state.preferences.seenMediaIds.filter((id) => id !== key && id !== mediaId),
    });
    const changed = this.state.seen.length !== before || this.state.preferences.seenMediaIds.length !== 0;
    if (this.state.seen.length !== before) this.persist();
    return changed;
  }

  /**
   * Persist AI preferences after a turn. Seen IDs that already have a known
   * title become display entries as well; IDs without one stay in
   * preferences only, so the list never shows a placeholder title.
   */
  public savePreferences(preferences: AssistantPreferences, titles?: SeenTitleIndex): void {
    this.state.preferences = assistantPreferencesSchema.parse(preferences);
    let changed = false;
    const known = new Set(this.state.seen.map((entry) => `${entry.mediaType}:${entry.mediaId}`));
    const markedAt = new Date(this.now()).toISOString();
    for (const id of this.state.preferences.seenMediaIds) {
      if (known.has(id)) continue;
      const info = titles?.get(id);
      if (!info) continue;
      const key = `${info.mediaType}:${info.mediaId}`;
      if (known.has(key)) continue;
      this.state.seen.unshift({ mediaId: info.mediaId, mediaType: info.mediaType, title: info.title, markedAt });
      known.add(key);
      changed = true;
    }
    if (changed) this.trimSeen();
    this.persist();
  }

  private mergeSeenIntoPreferences(): void {
    const ids = this.state.seen.slice(0, MAX_PREFERENCE_SEEN_IDS).map((entry) => `${entry.mediaType}:${entry.mediaId}`);
    if (ids.length === 0) return;
    this.state.preferences = assistantPreferencesSchema.parse({
      ...this.state.preferences,
      seenMediaIds: uniqueTail([...this.state.preferences.seenMediaIds, ...ids], MAX_PREFERENCE_SEEN_IDS),
    });
  }

  private trimSeen(): void {
    if (this.state.seen.length > MAX_SEEN_ENTRIES) {
      this.state.seen = this.state.seen.slice(0, MAX_SEEN_ENTRIES);
    }
  }

  private persist(): void {
    if (!this.path || this.writeBlocked) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.tmp-${process.pid}`;
      writeFileSync(temporary, serializeState(this.state), { mode: 0o600 });
      renameSync(temporary, this.path);
      this.error = undefined;
    } catch {
      this.error = "历史数据写入失败，最新改动未持久化。";
    }
  }
}

/** Single serialization seam so the atomic write stays easy to audit. */
function serializeState(state: { seen: SeenEntry[]; preferences: AssistantPreferences }): string {
  return JSON.stringify({
    version: HISTORY_STORE_VERSION,
    seen: state.seen,
    preferences: state.preferences,
  });
}

function uniqueTail(values: string[], limit: number): string[] {
  return [...new Set(values)].slice(-limit);
}
