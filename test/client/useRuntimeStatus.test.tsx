import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/client/api";
import { useRuntimeStatus } from "../../src/client/hooks/useRuntimeStatus";

const originalVisibilityState = document.visibilityState;

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state
  });
}

function makeClient() {
  const getTorrents = vi.fn().mockResolvedValue([]);
  const getStorage = vi.fn().mockResolvedValue({
    path: "/tmp/pt",
    mounted: true,
    ready: true,
    totalBytes: 1_000,
    usedBytes: 250,
    freeBytes: 750
  });
  const client = { getTorrents, getStorage } as unknown as ApiClient;
  return { client, getTorrents, getStorage };
}

async function flushRefresh(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  setVisibilityState(originalVisibilityState);
});

describe("useRuntimeStatus", () => {
  it("refreshes immediately when visible and then every 15 seconds", async () => {
    vi.useFakeTimers();
    setVisibilityState("visible");
    const { client, getTorrents, getStorage } = makeClient();
    const hook = renderHook(() => useRuntimeStatus(client, "csrf-test", true));

    await flushRefresh();
    expect(getTorrents).toHaveBeenCalledTimes(1);
    expect(getStorage).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(14_999));
    expect(getTorrents).toHaveBeenCalledTimes(1);
    expect(getStorage).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1));
    await flushRefresh();
    expect(getTorrents).toHaveBeenCalledTimes(2);
    expect(getStorage).toHaveBeenCalledTimes(2);

    hook.unmount();
  });

  it("pauses hidden polling, refreshes on visible, and cleans one subscription", async () => {
    vi.useFakeTimers();
    setVisibilityState("hidden");
    const { client, getTorrents, getStorage } = makeClient();
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");
    const hook = renderHook(() => useRuntimeStatus(client, "csrf-test", true));

    await flushRefresh();
    expect(getTorrents).not.toHaveBeenCalled();
    expect(getStorage).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(30_000));
    expect(getTorrents).not.toHaveBeenCalled();
    expect(getStorage).not.toHaveBeenCalled();

    hook.rerender();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(addEventListenerSpy.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(1);

    setVisibilityState("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flushRefresh();
    expect(getTorrents).toHaveBeenCalledTimes(1);
    expect(getStorage).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(14_999));
    expect(getTorrents).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    await flushRefresh();
    expect(getTorrents).toHaveBeenCalledTimes(2);

    hook.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(removeEventListenerSpy.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(1);

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(getTorrents).toHaveBeenCalledTimes(2);
  });
});
