import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DiscoveryCollectionId,
  DiscoveryCollectionResponse,
  DiscoveryItem,
  DiscoveryReleaseResponse
} from "../../src/shared/contracts";
import type { ApiClient } from "../../src/client/api";
import { useDiscovery } from "../../src/client/hooks/useDiscovery";

const originalVisibilityState = document.visibilityState;

const items: DiscoveryItem[] = [
  {
    id: "1001",
    title: "奥德赛",
    originalTitle: "The Odyssey",
    year: "2026",
    rating: 8.5,
    rank: 1,
    mediaType: "movie",
    genres: ["动作", "冒险"],
    summary: "一段漫长归途。",
    sourceUrl: "https://movie.douban.com/subject/1001/"
  },
  {
    id: "1002",
    title: "空枪",
    year: "2026",
    rank: 2,
    mediaType: "movie",
    genres: ["剧情"],
    summary: "命运开始转动。",
    sourceUrl: "https://movie.douban.com/subject/1002/"
  }
];

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

function collectionResponse(collection: DiscoveryCollectionId): DiscoveryCollectionResponse {
  return { collection, updatedAt: "2026-08-29T00:00:00.000Z", stale: false, items };
}

function releaseResponse(itemId: string): DiscoveryReleaseResponse {
  return {
    itemId,
    query: itemId === "1001" ? "The Odyssey 2026" : "空枪 2026",
    status: itemId === "1001" ? "available" : "unavailable",
    checkedAt: "2026-08-29T00:00:01.000Z",
    total: itemId === "1001" ? 1 : 0,
    releases: []
  };
}

function makeClient() {
  const getDiscoveryCollection = vi.fn(async (collection: DiscoveryCollectionId) => collectionResponse(collection));
  const getDiscoveryReleases = vi.fn(async (_collection: DiscoveryCollectionId, itemId: string) => releaseResponse(itemId));
  const refreshDiscoveryReleases = vi.fn(async (_collection: DiscoveryCollectionId, itemId: string) => ({
    ...releaseResponse(itemId),
    checkedAt: "2026-08-29T00:00:02.000Z"
  }));
  const client = { getDiscoveryCollection, getDiscoveryReleases, refreshDiscoveryReleases } as unknown as ApiClient;
  return { client, getDiscoveryCollection, getDiscoveryReleases, refreshDiscoveryReleases };
}

afterEach(() => {
  setVisibilityState(originalVisibilityState);
});

describe("useDiscovery", () => {
  it("loads a collection and progressively checks each visible item once", async () => {
    setVisibilityState("visible");
    const { client, getDiscoveryCollection, getDiscoveryReleases } = makeClient();
    const hook = renderHook(() => useDiscovery(client, "csrf-test", true));

    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    await waitFor(() => expect(getDiscoveryReleases).toHaveBeenCalledTimes(2));

    expect(getDiscoveryCollection).toHaveBeenCalledWith("movie-hot", "csrf-test");
    expect(hook.result.current.availabilityById["1001"]?.status).toBe("available");
    expect(hook.result.current.availabilityById["1002"]?.status).toBe("unavailable");

    await act(async () => {
      await hook.result.current.ensureAvailability(items[0]);
    });
    expect(getDiscoveryReleases).toHaveBeenCalledTimes(2);
  });

  it("loads discovery content while hidden but pauses PT checks until visible", async () => {
    setVisibilityState("hidden");
    const { client, getDiscoveryReleases } = makeClient();
    const hook = renderHook(() => useDiscovery(client, "csrf-test", true));

    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(getDiscoveryReleases).not.toHaveBeenCalled();

    setVisibilityState("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(getDiscoveryReleases).toHaveBeenCalledTimes(2));
  });

  it("uses the cached ordinary check but forces a refresh through the refresh API", async () => {
    setVisibilityState("visible");
    const { client, getDiscoveryReleases, refreshDiscoveryReleases } = makeClient();
    const hook = renderHook(() => useDiscovery(client, "csrf-test", true));

    await waitFor(() => expect(getDiscoveryReleases).toHaveBeenCalledTimes(2));
    await act(async () => {
      await hook.result.current.ensureAvailability(items[0]);
    });
    expect(getDiscoveryReleases).toHaveBeenCalledTimes(2);

    await act(async () => {
      await hook.result.current.refreshAvailability(items[0]);
    });
    expect(refreshDiscoveryReleases).toHaveBeenCalledWith("movie-hot", items[0].id, "csrf-test");
    expect(refreshDiscoveryReleases).toHaveBeenCalledTimes(1);
    expect(hook.result.current.availabilityById[items[0].id]?.checkedAt).toBe("2026-08-29T00:00:02.000Z");
  });

  it("reuses an in-flight refresh for concurrent checks instead of falling back to GET", async () => {
    setVisibilityState("hidden");
    const { client, getDiscoveryReleases, refreshDiscoveryReleases } = makeClient();
    let resolveRefresh: (response: DiscoveryReleaseResponse) => void = () => undefined;
    const pendingRefresh = new Promise<DiscoveryReleaseResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    refreshDiscoveryReleases.mockReturnValue(pendingRefresh);
    const hook = renderHook(() => useDiscovery(client, "csrf-test", true));

    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    let first = Promise.resolve(null) as Promise<DiscoveryReleaseResponse | null>;
    let second = Promise.resolve(null) as Promise<DiscoveryReleaseResponse | null>;
    let ordinary = Promise.resolve(null) as Promise<DiscoveryReleaseResponse | null>;
    act(() => {
      first = hook.result.current.refreshAvailability(items[0]);
      second = hook.result.current.refreshAvailability(items[0]);
      ordinary = hook.result.current.ensureAvailability(items[0]);
    });

    await waitFor(() => expect(refreshDiscoveryReleases).toHaveBeenCalledTimes(1));
    expect(second).toBe(first);
    expect(ordinary).toBe(first);
    expect(getDiscoveryReleases).not.toHaveBeenCalled();

    await act(async () => {
      resolveRefresh({ ...releaseResponse(items[0].id), checkedAt: "2026-08-29T00:00:03.000Z" });
      await first;
    });
    expect(hook.result.current.availabilityById[items[0].id]?.checkedAt).toBe("2026-08-29T00:00:03.000Z");
    expect(hook.result.current.checkingIds.has(items[0].id)).toBe(false);
  });
});
