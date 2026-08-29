import { useCallback, useEffect, useRef, useState } from "react";
import type { NasStorageSummary, TorrentSummary } from "../../shared/contracts";
import { apiClient, type ApiClient } from "../api";

const POLL_INTERVAL_MS = 15_000;

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "状态暂时不可用。";
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "状态暂时不可用。";
}

export type RuntimeStatus = {
  torrents: TorrentSummary[];
  torrentsLoading: boolean;
  torrentsError: string | null;
  storage: NasStorageSummary | null;
  storageLoading: boolean;
  storageError: string | null;
  refresh: (showLoading?: boolean) => Promise<void>;
};

export function useRuntimeStatus(
  client: ApiClient = apiClient,
  csrfToken = "",
  enabled = false
): RuntimeStatus {
  const [torrents, setTorrents] = useState<TorrentSummary[]>([]);
  const [torrentsLoading, setTorrentsLoading] = useState(false);
  const [torrentsError, setTorrentsError] = useState<string | null>(null);
  const [storage, setStorage] = useState<NasStorageSummary | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async (showLoading = true) => {
    if (!enabled || !csrfToken || inFlight.current) return;
    inFlight.current = true;
    if (showLoading) {
      setTorrentsLoading(true);
      setStorageLoading(true);
    }

    const [torrentResult, storageResult] = await Promise.allSettled([
      client.getTorrents(csrfToken),
      client.getStorage(csrfToken)
    ]);

    if (torrentResult.status === "fulfilled") {
      setTorrents(torrentResult.value);
      setTorrentsError(null);
    } else {
      setTorrentsError(readableError(torrentResult.reason));
    }

    if (storageResult.status === "fulfilled") {
      setStorage(storageResult.value);
      setStorageError(null);
    } else {
      setStorageError(readableError(storageResult.reason));
    }

    setTorrentsLoading(false);
    setStorageLoading(false);
    inFlight.current = false;
  }, [client, csrfToken, enabled]);

  // Keep the subscription stable while always calling the latest refresh
  // implementation. This prevents render-driven listener/timer churn.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled || !csrfToken) return;

    const refreshIfVisible = (showLoading: boolean) => {
      if (document.visibilityState !== "visible") return;
      void refreshRef.current(showLoading);
    };

    refreshIfVisible(true);
    const timer = window.setInterval(() => refreshIfVisible(false), POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshRef.current(false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [csrfToken, enabled]);

  return {
    torrents,
    torrentsLoading,
    torrentsError,
    storage,
    storageLoading,
    storageError,
    refresh
  };
}
