import { useCallback, useEffect, useState } from "react";
import type { ServiceHealth, SessionResponse } from "../../shared/contracts";
import { apiClient, type ApiClient } from "../api";

export type ServiceBootstrapState = {
  loading: boolean;
  session: SessionResponse | null;
  health: ServiceHealth | null;
  sessionError: string | null;
  healthError: string | null;
  reload: () => Promise<void>;
  refreshHealth: () => Promise<void>;
};

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "服务暂时不可用。";
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "服务暂时不可用。";
}

export function useServiceBootstrap(client: ApiClient = apiClient): ServiceBootstrapState {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setSessionError(null);
    setHealthError(null);

    const [sessionResult, healthResult] = await Promise.allSettled([client.getSession(), client.getHealth()]);
    if (sessionResult.status === "fulfilled") {
      setSession(sessionResult.value);
    } else {
      setSession(null);
      setSessionError(readableError(sessionResult.reason));
    }

    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
    } else {
      setHealth(null);
      setHealthError(readableError(healthResult.reason));
    }

    setLoading(false);
  }, [client]);

  const refreshHealth = useCallback(async () => {
    setHealthError(null);
    try {
      setHealth(await client.getHealth());
    } catch (error) {
      setHealth(null);
      setHealthError(readableError(error));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { loading, session, health, sessionError, healthError, reload, refreshHealth };
}
