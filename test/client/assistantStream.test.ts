import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/client/api";
import { defaultAssistantPreferences, type AssistantRecommendationCard, type AssistantTurnResponse } from "../../src/shared/assistant";

const card: AssistantRecommendationCard = {
  cardId: "card_12345678",
  mediaId: "1292267",
  mediaType: "movie",
  title: "银河系漫游指南",
  genres: ["科幻"],
  summary: "太空喜剧",
  reason: "适合轻松观看",
  evidenceIds: ["metadata:movie:1292267"],
  constraintResults: [],
  availability: "available",
  rankedReleases: []
};

const baseResponse: AssistantTurnResponse = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  turnId: "22222222-2222-4222-8222-222222222222",
  clientTurnId: "22222222-2222-4222-8222-222222222222",
  text: "推荐作品",
  preferences: defaultAssistantPreferences(),
  recommendations: [card],
  warnings: []
};

const request = {
  clientTurnId: baseResponse.clientTurnId,
  message: "科幻电影"
};

function streamResponse(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

describe("assistant recommendation stream client", () => {
  it("rejects a snapshot for another request and cancels the unread stream", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'snapshot', data: { ...baseResponse, clientTurnId: '33333333-3333-4333-8333-333333333333', phase: 'complete' } })}\n`)); },
      cancel,
    }));
    const client = createApiClient(vi.fn(async () => response) as typeof fetch);
    const callback = vi.fn();
    await expect(client.createAssistantTurnStream!(request, 'csrf', callback)).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
    expect(callback).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("emits snapshots from split UTF-8 chunks and accepts a final line without newline", async () => {
    const verifying = { ...baseResponse, phase: "verifying" as const, text: "正在核实作品…" };
    const complete = { ...baseResponse, phase: "complete" as const, text: "推荐完成" };
    const body = `${JSON.stringify({ type: "snapshot", data: verifying })}\n${JSON.stringify({ type: "snapshot", data: complete })}`;
    const bytes = new TextEncoder().encode(body);
    const splitAt = body.indexOf("核实");
    const byteSplit = new TextEncoder().encode(body.slice(0, splitAt + 1)).length;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("same-origin");
      expect((init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-test");
      expect((init?.headers as Record<string, string>).Accept).toBe("application/x-ndjson");
      return streamResponse([bytes.slice(0, byteSplit), bytes.slice(byteSplit, byteSplit + 3), bytes.slice(byteSplit + 3)]);
    });
    const client = createApiClient(fetchImpl as typeof fetch);
    const snapshots: AssistantTurnResponse[] = [];

    const result = await client.createAssistantTurnStream!(request, "csrf-test", (snapshot) => snapshots.push(snapshot));

    expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(["verifying", "complete"]);
    expect(result.text).toBe("推荐完成");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces a validated in-stream error after earlier snapshots without retrying", async () => {
    const verifying = { ...baseResponse, phase: "verifying" as const };
    const body = [
      JSON.stringify({ type: "snapshot", data: verifying }),
      JSON.stringify({ type: "error", error: "片源检查超时", code: "AI_TIMEOUT" })
    ].join("\n");
    const fetchImpl = vi.fn(async () => streamResponse([new TextEncoder().encode(body)]));
    const client = createApiClient(fetchImpl as typeof fetch);
    const snapshots: AssistantTurnResponse[] = [];

    await expect(client.createAssistantTurnStream!(request, "csrf-test", (snapshot) => snapshots.push(snapshot)))
      .rejects.toMatchObject({ code: "AI_TIMEOUT", message: "片源检查超时" });
    expect(snapshots).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed events and preserves AbortSignal propagation", async () => {
    const malformedFetch = vi.fn(async () => streamResponse([new TextEncoder().encode("{\"type\":\"snapshot\"}")]))
    const malformedClient = createApiClient(malformedFetch as typeof fetch);
    await expect(malformedClient.createAssistantTurnStream!(request, "csrf-test", () => undefined))
      .rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });

    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const abortFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw abortError;
    });
    const abortClient = createApiClient(abortFetch as typeof fetch);
    await expect(abortClient.createAssistantTurnStream!(request, "csrf-test", () => undefined, controller.signal))
      .rejects.toBe(abortError);
    expect(abortFetch).toHaveBeenCalledTimes(1);
  });
});
