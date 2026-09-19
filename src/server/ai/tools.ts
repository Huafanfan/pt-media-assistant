import { z } from "zod";
import type { DiscoveryService } from "../discovery.js";
import {
  assistantPreferencesSchema,
  assistantPreferencesPatchSchema,
  type AssistantPreferences,
  type AssistantWarning,
} from "../../shared/assistant.js";
import type { Conversation } from "./conversation-store.js";
import { AssistantError } from "./conversation-store.js";
import { buildRecommendationCard, rankReleases } from "./recommendation.js";
import type { AssistantToolDefinition } from "./provider.js";

export type AssistantDiscovery = Pick<
  DiscoveryService,
  "searchMedia" | "getMedia" | "getMediaDetails" | "getMediaReleases"
>;
// Use shape rather than partial() on a refined object; no schema defaults may erase a prior preference.
export const preferencePatch = assistantPreferencesPatchSchema;
const identity = {
  mediaId: z.string().regex(/^\d{1,16}$/),
  mediaType: z.enum(["movie", "tv"]),
};
const schemas = {
  resolve_media: z
    .object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe(
          "一个确切的电影或剧集片名，例如夏洛特烦恼；不能填写类型、情绪或用户整句需求。",
        ),
      limit: z.number().int().min(1).max(5).default(3),
      preferences: preferencePatch.optional(),
    })
    .strict(),
  get_media_details: z.object(identity).strict(),
  check_pt_availability: z
    .object({ ...identity, preferences: preferencePatch.optional() })
    .strict(),
  rank_releases: z
    .object({ ...identity, preferences: preferencePatch.optional() })
    .strict(),
};
export const toolDefinitions: AssistantToolDefinition[] = Object.entries(
  schemas,
).map(([name, schema]) => ({
  type: "function",
  function: {
    name,
    description:
      name === "resolve_media"
        ? "按具体片名核实公开作品，返回类型/简介。首次调用同时提交本轮偏好变更，最多5个片名。"
        : name === "get_media_details"
          ? "取得已知作品的演员和导演。"
          : name === "check_pt_availability"
            ? "对已知作品缓存优先只读检查PT（每轮最多3部）。允许偏好更新。"
            : "用服务端规则对已有片源快照排序，允许更新偏好，不增加PT请求。",
    parameters: z.toJSONSchema(schema, { io: "input" }) as Record<
      string,
      unknown
    >,
  },
}));
export function updatePreferences(c: Conversation, patch: unknown) {
  if (!patch) return;
  const parsed = preferencePatch.parse(patch);
  const clean = Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined),
  );
  const merged = assistantPreferencesSchema.parse({
    ...c.preferences,
    ...clean,
  });
  // A model may only mark a canonical entity already present in this session
  // or one already recorded in the persisted seen store as seen.
  if (
    merged.seenMediaIds.some(
      (id) =>
        !c.knownSeen?.has(id) &&
        ![...c.candidates.values()].some(
          (x) =>
            x.media.id === id || `${x.media.mediaType}:${x.media.id}` === id,
        ),
    )
  )
    throw new Error("Unknown seen media");
  c.preferences = merged;
}
export class ToolRunner {
  executions = 0;
  searches = 0;
  ptRequests = 0;
  checked = new Set<string>();
  touched = new Set<string>();
  warnings: AssistantWarning[] = [];
  constructor(
    readonly discovery: AssistantDiscovery,
    readonly conversation: Conversation,
    readonly signal: AbortSignal,
  ) {}
  async execute(name: string, raw: unknown): Promise<unknown> {
    this.signal.throwIfAborted();
    if (this.executions >= 8) throw new AssistantError("AI_BUDGET_EXCEEDED");
    this.executions += 1;
    if (!(name in schemas)) throw new Error("Unknown tool");
    const args = schemas[name as keyof typeof schemas].parse(raw);
    if ("preferences" in args)
      updatePreferences(this.conversation, args.preferences);
    if ("query" in args) {
      if (++this.searches > 5) throw new AssistantError("AI_BUDGET_EXCEEDED");
      const response = await this.discovery.searchMedia(args.query, args.limit);
      this.signal.throwIfAborted();
      const items = [];
      // Independent metadata requests overlap; publish in search-result order.
      const enriched = await Promise.all(
        response.items.slice(0, 2).map(async (found) => {
          this.signal.throwIfAborted();
          try {
            return await this.discovery.getMedia(found.mediaType, found.id);
          } catch {
            this.warnings.push({
              code: "METADATA_PARTIAL",
              message: "部分作品详情未能核实。",
              mediaId: found.id,
            });
            return found;
          }
        }),
      );
      for (const media of enriched) {
        this.signal.throwIfAborted();
        const key = `${media.mediaType}:${media.id}`;
        const previous = this.conversation.candidates.get(key);
        this.conversation.candidates.set(key, { ...previous, media });
        this.touched.add(key);
        items.push({
          mediaId: media.id,
          mediaType: media.mediaType,
          title: media.title,
          originalTitle: media.originalTitle,
          year: media.year,
          genres: media.genres.slice(0, 20),
          summary: media.summary.slice(0, 240),
          evidenceId: `metadata:${key}`,
        });
      }
      while (this.conversation.candidates.size > 100)
        this.conversation.candidates.delete(
          this.conversation.candidates.keys().next().value!,
        );
      return { items };
    }
    const key = `${args.mediaType}:${args.mediaId}`;
    const candidate = this.conversation.candidates.get(key);
    if (!candidate) throw new Error("Unknown media ID");
    this.touched.add(key);
    if (name === "get_media_details") {
      const details = await this.discovery.getMediaDetails(
        args.mediaType,
        args.mediaId,
      );
      return {
        mediaId: args.mediaId,
        actors: details.actors.slice(0, 12).map((x) => x.name),
        directors: details.directors.slice(0, 12),
      };
    }
    if (name === "check_pt_availability") {
      // A failed attempt is still an attempt. Replaying the same work item in
      // one turn must return the existing bounded result rather than spending
      // another PT query and bypassing the three-work-item budget.
      if (this.checked.has(key)) {
        const cachedCard = buildRecommendationCard(
          this.conversation.id,
          "tool_result_0000",
          0,
          candidate,
          this.conversation.preferences,
        );
        return {
          mediaId: args.mediaId,
          availability: cachedCard.availability,
          checkedAt: cachedCard.checkedAt,
          evidenceIds: cachedCard.evidenceIds,
          constraintResults: cachedCard.constraintResults,
          releases: cachedCard.rankedReleases.map((r, index) => ({
            id: r.id,
            title: r.title,
            size: r.evidence?.size === "unknown" ? null : r.size,
            seeders: r.evidence?.seeders === "unknown" ? null : r.seeders,
            resolution: r.resolution,
            freeleechState: r.freeleechState,
            rank: index + 1,
            reasonCodes: r.reasonCodes,
          })),
        };
      }
      if (this.checked.size >= 3)
        throw new AssistantError("AI_BUDGET_EXCEEDED");
      this.checked.add(key);
      try {
        const snapshot = await this.discovery.getMediaReleases(
          args.mediaType,
          args.mediaId,
          10,
          {
            signal: this.signal,
            beforeSearch: () => {
              this.signal.throwIfAborted();
              if (++this.ptRequests > 6)
                throw new AssistantError("AI_BUDGET_EXCEEDED");
            },
          },
        );
        // An abort can happen while a shared discovery request is completing.
        // Do not publish that late result into the conversation after cancel.
        this.signal.throwIfAborted();
        candidate.snapshot = snapshot;
        candidate.releaseError = undefined;
      } catch (e) {
        this.signal.throwIfAborted();
        if (e instanceof AssistantError) throw e;
        candidate.releaseError = "PT 查询失败";
        this.warnings.push({
          code: "PT_UNAVAILABLE",
          message: "PT 查询失败，不代表没有资源。",
          mediaId: args.mediaId,
        });
      }
    }
    const card = buildRecommendationCard(
      this.conversation.id,
      "tool_result_0000",
      0,
      candidate,
      this.conversation.preferences,
    );
    return {
      mediaId: args.mediaId,
      availability: card.availability,
      checkedAt: card.checkedAt,
      evidenceIds: card.evidenceIds,
      constraintResults: card.constraintResults,
      // Never send raw indexer labels, URLs or raw Prowlarr objects to the model.
      releases: card.rankedReleases.map((r, index) => ({
        id: r.id,
        title: r.title,
        size: r.evidence?.size === "unknown" ? null : r.size,
        seeders: r.evidence?.seeders === "unknown" ? null : r.seeders,
        resolution: r.resolution,
        freeleechState: r.freeleechState,
        rank: index + 1,
        reasonCodes: r.reasonCodes,
      })),
    };
  }
}
