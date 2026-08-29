import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DiscoveryCollectionId,
  DiscoveryCollectionResponse,
  DiscoveryItem,
  DiscoveryReleaseResponse
} from "../../shared/contracts";
import { apiClient, type ApiClient } from "../api";

const DEFAULT_COLLECTION: DiscoveryCollectionId = "movie-hot";

function itemKey(collection: DiscoveryCollectionId, itemId: string): string {
  return `${collection}:${itemId}`;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "发现页暂时不可用。";
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "发现页暂时不可用。";
}

export type DiscoveryState = {
  collection: DiscoveryCollectionId;
  response: DiscoveryCollectionResponse | null;
  items: DiscoveryItem[];
  loading: boolean;
  error: string | null;
  availabilityById: Readonly<Record<string, DiscoveryReleaseResponse>>;
  checkingIds: ReadonlySet<string>;
  setCollection: (collection: DiscoveryCollectionId) => void;
  retryCollection: () => void;
  ensureAvailability: (item: DiscoveryItem) => Promise<DiscoveryReleaseResponse | null>;
};

export function useDiscovery(
  client: ApiClient = apiClient,
  csrfToken = "",
  enabled = false
): DiscoveryState {
  const [collection, setCollection] = useState<DiscoveryCollectionId>(DEFAULT_COLLECTION);
  const [response, setResponse] = useState<DiscoveryCollectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [availabilityByKey, setAvailabilityByKey] = useState<Record<string, DiscoveryReleaseResponse>>({});
  const [checkingKeys, setCheckingKeys] = useState<Set<string>>(() => new Set());
  const availabilityRef = useRef(availabilityByKey);
  const inFlightRef = useRef(new Map<string, Promise<DiscoveryReleaseResponse | null>>());
  const mountedRef = useRef(true);

  availabilityRef.current = availabilityByKey;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!enabled || !csrfToken) {
      setResponse(null);
      setLoading(false);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    void client.getDiscoveryCollection(collection, csrfToken)
      .then((next) => {
        if (!current) return;
        setResponse(next);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setResponse(null);
        setError(readableError(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, collection, csrfToken, enabled, refreshRevision]);

  const requestAvailability = useCallback((item: DiscoveryItem): Promise<DiscoveryReleaseResponse | null> => {
    if (!enabled || !csrfToken) return Promise.resolve(null);
    const key = itemKey(collection, item.id);
    const cached = availabilityRef.current[key];
    if (cached) return Promise.resolve(cached);
    const existing = inFlightRef.current.get(key);
    if (existing) return existing;

    setCheckingKeys((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });

    const request = client.getDiscoveryReleases(collection, item.id, csrfToken)
      .then((next) => {
        if (mountedRef.current) {
          availabilityRef.current = { ...availabilityRef.current, [key]: next };
          setAvailabilityByKey(availabilityRef.current);
        }
        return next;
      })
      .catch(() => null)
      .finally(() => {
        inFlightRef.current.delete(key);
        if (mountedRef.current) {
          setCheckingKeys((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      });
    inFlightRef.current.set(key, request);
    return request;
  }, [client, collection, csrfToken, enabled]);

  const items = response?.collection === collection ? response.items : [];

  useEffect(() => {
    if (!enabled || !visible || items.length === 0) return;
    let cancelled = false;
    const run = async () => {
      for (const item of items) {
        if (cancelled || document.visibilityState !== "visible") return;
        const key = itemKey(collection, item.id);
        if (availabilityRef.current[key]) continue;
        await requestAvailability(item);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [collection, enabled, items, requestAvailability, visible]);

  const availabilityById = useMemo(() => {
    const current: Record<string, DiscoveryReleaseResponse> = {};
    for (const item of items) {
      const value = availabilityByKey[itemKey(collection, item.id)];
      if (value) current[item.id] = value;
    }
    return current;
  }, [availabilityByKey, collection, items]);

  const checkingIds = useMemo(() => {
    const current = new Set<string>();
    for (const item of items) {
      if (checkingKeys.has(itemKey(collection, item.id))) current.add(item.id);
    }
    return current;
  }, [checkingKeys, collection, items]);

  return {
    collection,
    response,
    items,
    loading,
    error,
    availabilityById,
    checkingIds,
    setCollection,
    retryCollection: () => setRefreshRevision((current) => current + 1),
    ensureAvailability: requestAvailability
  };
}
