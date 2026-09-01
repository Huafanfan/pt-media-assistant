import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DiscoveryCollectionId,
  DiscoveryCollectionResponse,
  DiscoveryItem,
  DiscoveryItemDetails,
  DiscoveryMedia,
  DiscoveryReleaseResponse
} from "../../shared/contracts";
import { apiClient, type ApiClient } from "../api";

const DEFAULT_COLLECTION: DiscoveryCollectionId = "movie-hot";
export const DISCOVERY_PAGE_SIZE = 10;
const MAX_DISCOVERY_PAGE = 100;

function itemKey(collection: DiscoveryCollectionId, page: number, itemId: string): string {
  return `${collection}:${page}:${itemId}`;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "发现页暂时不可用。";
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "发现页暂时不可用。";
}

export type DiscoveryState = {
  collection: DiscoveryCollectionId;
  page: number;
  pageSize: number;
  response: DiscoveryCollectionResponse | null;
  items: DiscoveryItem[];
  total: number;
  hasNext: boolean;
  loading: boolean;
  error: string | null;
  availabilityById: Readonly<Record<string, DiscoveryReleaseResponse>>;
  checkingIds: ReadonlySet<string>;
  detailsById: Readonly<Record<string, DiscoveryItemDetails>>;
  detailsLoadingIds: ReadonlySet<string>;
  setCollection: (collection: DiscoveryCollectionId) => void;
  setPage: (page: number) => void;
  retryCollection: () => void;
  ensureAvailability: (item: DiscoveryMedia) => Promise<DiscoveryReleaseResponse | null>;
  refreshAvailability: (item: DiscoveryMedia) => Promise<DiscoveryReleaseResponse | null>;
  ensureDetails: (item: DiscoveryMedia) => Promise<DiscoveryItemDetails | null>;
};

export function useDiscovery(
  client: ApiClient = apiClient,
  csrfToken = "",
  enabled = false
): DiscoveryState {
  const [collection, setCollectionState] = useState<DiscoveryCollectionId>(DEFAULT_COLLECTION);
  const [page, setPageState] = useState(1);
  const [response, setResponse] = useState<DiscoveryCollectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [availabilityByKey, setAvailabilityByKey] = useState<Record<string, DiscoveryReleaseResponse>>({});
  const [checkingKeys, setCheckingKeys] = useState<Set<string>>(() => new Set());
  const [detailsByKey, setDetailsByKey] = useState<Record<string, DiscoveryItemDetails>>({});
  const [detailsLoadingKeys, setDetailsLoadingKeys] = useState<Set<string>>(() => new Set());
  const availabilityRef = useRef(availabilityByKey);
  const inFlightRef = useRef(new Map<string, {
    forceRefresh: boolean;
    promise: Promise<DiscoveryReleaseResponse | null>;
  }>());
  const mountedRef = useRef(true);
  const detailsRef = useRef(detailsByKey);
  const detailsInFlightRef = useRef(new Map<string, Promise<DiscoveryItemDetails | null>>());

  availabilityRef.current = availabilityByKey;
  detailsRef.current = detailsByKey;

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
    void client.getDiscoveryCollection(collection, csrfToken, page, DISCOVERY_PAGE_SIZE)
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
  }, [client, collection, csrfToken, enabled, page, refreshRevision]);

  const requestAvailability = useCallback((
    item: DiscoveryMedia,
    forceRefresh = false
  ): Promise<DiscoveryReleaseResponse | null> => {
    if (!enabled || !csrfToken) return Promise.resolve(null);
    const key = itemKey(collection, page, item.id);
    const existing = inFlightRef.current.get(key);
    if (existing && (!forceRefresh || existing.forceRefresh)) return existing.promise;
    const cached = availabilityRef.current[key];
    if (!forceRefresh && cached) return Promise.resolve(cached);

    setCheckingKeys((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });

    const request = (existing?.promise ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => forceRefresh
        ? client.refreshDiscoveryMediaReleases(item.mediaType, item.id, csrfToken, DISCOVERY_PAGE_SIZE)
        : client.getDiscoveryMediaReleases(item.mediaType, item.id, csrfToken, DISCOVERY_PAGE_SIZE))
      .then((next) => {
        if (mountedRef.current) {
          availabilityRef.current = { ...availabilityRef.current, [key]: next };
          setAvailabilityByKey(availabilityRef.current);
        }
        return next;
      })
      .catch(() => null)
      .finally(() => {
        if (inFlightRef.current.get(key)?.promise === request) {
          inFlightRef.current.delete(key);
          if (mountedRef.current) {
            setCheckingKeys((current) => {
              const next = new Set(current);
              next.delete(key);
              return next;
            });
          }
        }
      });
    inFlightRef.current.set(key, { forceRefresh, promise: request });
    return request;
  }, [client, collection, csrfToken, enabled, page]);

  const refreshAvailability = useCallback(
    (item: DiscoveryMedia) => requestAvailability(item, true),
    [requestAvailability]
  );

  const requestDetails = useCallback((item: DiscoveryMedia): Promise<DiscoveryItemDetails | null> => {
    if (!enabled || !csrfToken) return Promise.resolve(null);
    const key = itemKey(collection, page, item.id);
    const cached = detailsRef.current[key];
    if (cached) return Promise.resolve(cached);
    const existing = detailsInFlightRef.current.get(key);
    if (existing) return existing;

    setDetailsLoadingKeys((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });

    const request = client.getDiscoveryMediaDetails(item.mediaType, item.id, csrfToken)
      .then((next) => {
        if (mountedRef.current) {
          detailsRef.current = { ...detailsRef.current, [key]: next };
          setDetailsByKey(detailsRef.current);
        }
        return next;
      })
      .catch(() => null)
      .finally(() => {
        if (detailsInFlightRef.current.get(key) === request) {
          detailsInFlightRef.current.delete(key);
          if (mountedRef.current) {
            setDetailsLoadingKeys((current) => {
              const next = new Set(current);
              next.delete(key);
              return next;
            });
          }
        }
      });
    detailsInFlightRef.current.set(key, request);
    return request;
  }, [client, collection, csrfToken, enabled, page]);

  const activeResponse = response?.collection === collection && response.page === page ? response : null;
  const items = activeResponse?.items ?? [];

  useEffect(() => {
    if (!enabled || !visible || items.length === 0) return;
    let cancelled = false;
    const run = async () => {
      for (const item of items) {
        if (cancelled || document.visibilityState !== "visible") return;
        const key = itemKey(collection, page, item.id);
        if (availabilityRef.current[key]) continue;
        await requestAvailability(item);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [collection, enabled, items, page, requestAvailability, visible]);

  const availabilityById = useMemo(() => {
    const current: Record<string, DiscoveryReleaseResponse> = {};
    for (const item of items) {
      const value = availabilityByKey[itemKey(collection, page, item.id)];
      if (value) current[item.id] = value;
    }
    return current;
  }, [availabilityByKey, collection, items, page]);

  const checkingIds = useMemo(() => {
    const current = new Set<string>();
    for (const item of items) {
      if (checkingKeys.has(itemKey(collection, page, item.id))) current.add(item.id);
    }
    return current;
  }, [checkingKeys, collection, items, page]);

  const detailsById = useMemo(() => {
    const current: Record<string, DiscoveryItemDetails> = {};
    for (const item of items) {
      const value = detailsByKey[itemKey(collection, page, item.id)];
      if (value) current[item.id] = value;
    }
    return current;
  }, [collection, detailsByKey, items, page]);

  const detailsLoadingIds = useMemo(() => {
    const current = new Set<string>();
    for (const item of items) {
      if (detailsLoadingKeys.has(itemKey(collection, page, item.id))) current.add(item.id);
    }
    return current;
  }, [collection, detailsLoadingKeys, items, page]);

  const setCollection = useCallback((nextCollection: DiscoveryCollectionId) => {
    setCollectionState(nextCollection);
    setPageState(1);
  }, []);

  const setPage = useCallback((nextPage: number) => {
    if (!Number.isFinite(nextPage)) return;
    setPageState(Math.min(MAX_DISCOVERY_PAGE, Math.max(1, Math.floor(nextPage))));
  }, []);

  return {
    collection,
    page,
    pageSize: activeResponse?.pageSize ?? DISCOVERY_PAGE_SIZE,
    response,
    items,
    total: activeResponse?.total ?? 0,
    hasNext: activeResponse?.hasNext ?? false,
    loading,
    error,
    availabilityById,
    checkingIds,
    detailsById,
    detailsLoadingIds,
    setCollection,
    setPage,
    retryCollection: () => setRefreshRevision((current) => current + 1),
    ensureAvailability: requestAvailability,
    refreshAvailability,
    ensureDetails: requestDetails
  };
}
