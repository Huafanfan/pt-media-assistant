import { useEffect, useState } from "react";
import type { DiscoveryItemDetails, DiscoveryMedia, DiscoveryReleaseResponse } from "../../shared/contracts";
import { apiClient, type ApiClient } from "../api";

function readableError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || fallback;
}

export type MediaInspectorState = {
  details: DiscoveryItemDetails | null;
  detailsLoading: boolean;
  detailsError: string | null;
  releaseResponse: DiscoveryReleaseResponse | null;
  releaseLoading: boolean;
  releaseError: string | null;
  retryAvailability: () => void;
  retryDetails: () => void;
};

export function useMediaInspector(
  client: ApiClient = apiClient,
  csrfToken = "",
  item: DiscoveryMedia | null = null,
  enabled = false,
): MediaInspectorState {
  const itemKey = item ? `${item.mediaType}:${item.id}` : "";
  const [details, setDetails] = useState<DiscoveryItemDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [releaseResponse, setReleaseResponse] = useState<DiscoveryReleaseResponse | null>(null);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releaseRevision, setReleaseRevision] = useState(0);
  const [detailsRevision, setDetailsRevision] = useState(0);

  useEffect(() => {
    setDetails(null);
    setDetailsError(null);
    setReleaseResponse(null);
    setReleaseError(null);
    setReleaseRevision(0);
    setDetailsRevision(0);
  }, [itemKey]);

  useEffect(() => {
    if (!enabled || !csrfToken || !item) {
      setReleaseLoading(false);
      setReleaseResponse(null);
      setReleaseError(null);
      return;
    }
    let current = true;
    setReleaseLoading(true);
    setReleaseError(null);
    void client.getDiscoveryMediaReleases(item.mediaType, item.id, csrfToken, 10)
      .then((next) => {
        if (current) setReleaseResponse(next);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setReleaseResponse(null);
        setReleaseError(readableError(reason, "片源检查暂时不可用。"));
      })
      .finally(() => {
        if (current) setReleaseLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, csrfToken, enabled, item, itemKey, releaseRevision]);

  useEffect(() => {
    if (!enabled || !csrfToken || !item) {
      setDetailsLoading(false);
      setDetails(null);
      setDetailsError(null);
      return;
    }
    let current = true;
    setDetailsLoading(true);
    setDetailsError(null);
    void client.getDiscoveryMediaDetails(item.mediaType, item.id, csrfToken)
      .then((next) => {
        if (current) setDetails(next);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setDetails(null);
        setDetailsError(readableError(reason, "演职员信息暂时不可用。"));
      })
      .finally(() => {
        if (current) setDetailsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, csrfToken, detailsRevision, enabled, item, itemKey]);

  return {
    details,
    detailsLoading,
    detailsError,
    releaseResponse,
    releaseLoading,
    releaseError,
    retryAvailability: () => setReleaseRevision((current) => current + 1),
    retryDetails: () => setDetailsRevision((current) => current + 1),
  };
}

export default useMediaInspector;
