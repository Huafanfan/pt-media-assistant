import { useCallback, useEffect, useState } from "react";
import type { ServiceHealth, SessionResponse } from "../../shared/contracts";
import { apiClient, type ApiClient } from "../api";

export type ServiceBootstrapState = {
  loading: boolean;
  session: SessionResponse | null;
  health: ServiceHealth | null;
  healthLoading: boolean;
  sessionError: string | null;
  healthError: string | null;
  reload: () => void;
  refreshHealth: () => void;
};

const HEALTH_TIMEOUT_MS = 15_000;

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "服务暂时不可用。";
  return message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "服务暂时不可用。";
}

export function useServiceBootstrap(client: ApiClient = apiClient): ServiceBootstrapState {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [healthAttempt, setHealthAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSessionError(null);

    async function loadSession() {
      try {
        const value = await client.getSession();
        if (active) setSession(value);
      } catch (error) {
        if (!active) return;
        setSession(null);
        setSessionError(readableError(error));
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSession();
    return () => { active = false; };
  }, [client, sessionAttempt]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    setHealthLoading(true);
    setHealthError(null);

    async function loadHealth() {
      try {
        const value = await client.getHealth(controller.signal);
        if (active) setHealth(value);
      } catch (error) {
        if (!active) return;
        setHealthError(controller.signal.aborted ? "状态检查超时，请稍后重试。" : readableError(error));
      } finally {
        clearTimeout(timeout);
        if (active) setHealthLoading(false);
      }
    }

    void loadHealth();
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [client, healthAttempt]);

  const reload = useCallback(() => setSessionAttempt(attempt => attempt + 1), []);
  const refreshHealth = useCallback(() => setHealthAttempt(attempt => attempt + 1), []);

  return { loading, session, health, healthLoading, sessionError, healthError, reload, refreshHealth };
}
