import { useCallback, useEffect, useState } from "react";
import type { DiscoveryActorProfile } from "../../shared/contracts";
import { apiClient, type ApiClient } from "../api";

const ACTOR_PAGE_SIZE = 10;
const MAX_ACTOR_PAGE = 100;

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "演员资料暂时不可用。";
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "演员资料暂时不可用。";
}

export type DiscoveryActorState = {
  page: number;
  profile: DiscoveryActorProfile | null;
  loading: boolean;
  error: string | null;
  setPage: (page: number) => void;
  retry: () => void;
};

export function useDiscoveryActor(
  client: ApiClient = apiClient,
  csrfToken = "",
  name: string | null = null,
  enabled = false,
): DiscoveryActorState {
  const [page, setPageState] = useState(1);
  const [profile, setProfile] = useState<DiscoveryActorProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);

  useEffect(() => {
    setPageState(1);
    setProfile(null);
    setError(null);
  }, [name]);

  useEffect(() => {
    if (!enabled || !csrfToken || !name) {
      setProfile(null);
      setLoading(false);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    void client.getDiscoveryActor(name, csrfToken, page, ACTOR_PAGE_SIZE)
      .then((next) => {
        if (current) setProfile(next);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setProfile(null);
        setError(readableError(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, csrfToken, enabled, name, page, refreshRevision]);

  const setPage = useCallback((nextPage: number) => {
    if (!Number.isFinite(nextPage)) return;
    setPageState(Math.min(MAX_ACTOR_PAGE, Math.max(1, Math.floor(nextPage))));
  }, []);

  return {
    page,
    profile,
    loading,
    error,
    setPage,
    retry: () => setRefreshRevision((current) => current + 1),
  };
}

export default useDiscoveryActor;
