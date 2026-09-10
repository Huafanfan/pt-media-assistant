import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssistantPreferences,
  AssistantRecommendationCard,
  AssistantTurnRequest,
  AssistantTurnResponse
} from "../../shared/assistant";
import { ApiError, apiClient, type ApiClient } from "../api";
import type { AssistantConversationMessage } from "../types";

function messageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function uuid(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === "function") return randomUuid.call(globalThis.crypto);

  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex = bytes.map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function readableError(error: unknown): { message: string; code?: string } {
  if (error instanceof ApiError) {
    return {
      message: error.message || "推荐暂时不可用，请按片名搜索。",
      ...(error.code ? { code: error.code } : {})
    };
  }
  const message = error instanceof Error ? error.message : "推荐暂时不可用，请按片名搜索。";
  return { message: message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) };
}

function responseMessage(response: AssistantTurnResponse): AssistantConversationMessage {
  return {
    id: response.turnId,
    role: "assistant",
    text: response.text,
    createdAt: Date.now(),
    recommendations: response.recommendations,
    ...(response.phase ? { phase: response.phase } : {}),
    ...(response.pendingRecommendations ? { pendingRecommendations: response.pendingRecommendations } : {}),
    preferences: response.preferences,
    warnings: response.warnings
  };
}

export type AssistantState = {
  conversationId: string | null;
  messages: AssistantConversationMessage[];
  cards: AssistantRecommendationCard[];
  pendingRecommendations: AssistantRecommendationCard[];
  phase: AssistantTurnResponse["phase"];
  preferences: AssistantPreferences | null;
  loading: boolean;
  error: string | null;
  errorCode?: string;
  activeTurnId: string | null;
  submit: (message: string) => Promise<AssistantTurnResponse | null>;
  cancel: () => Promise<void>;
  clear: () => Promise<void>;
};

export function useAssistant(
  client: ApiClient = apiClient,
  csrfToken = "",
  enabled = false
): AssistantState {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantConversationMessage[]>([]);
  const [preferences, setPreferences] = useState<AssistantPreferences | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const conversationRef = useRef<string | null>(null);
  const activeTurnRef = useRef<string | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);
  const requestRevision = useRef(0);

  conversationRef.current = conversationId;
  activeTurnRef.current = activeTurnId;

  useEffect(() => () => {
    requestRevision.current += 1;
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
  }, []);

  const latestRecommendationMessage = useMemo(
    () => [...messages].reverse().find(message => message.role === "assistant" && message.recommendations),
    [messages]
  );
  const cards = latestRecommendationMessage?.recommendations ?? [];
  const pendingRecommendations = latestRecommendationMessage?.pendingRecommendations ?? [];
  const phase = latestRecommendationMessage?.phase;

  const submit = useCallback(async (message: string): Promise<AssistantTurnResponse | null> => {
    const trimmed = message.trim();
    if (!trimmed || loading) return null;
    const streamTurn = client.createAssistantTurnStream;
    const legacyTurn = client.createAssistantTurn;
    if (!enabled || !csrfToken || (!streamTurn && !legacyTurn)) {
      setError("AI 推荐暂时不可用，请按片名搜索。" );
      setErrorCode("AI_UNAVAILABLE");
      return null;
    }

    const clientTurnId = uuid();
    const pendingMessageId = messageId("assistant-pending");
    const revision = requestRevision.current + 1;
    const controller = new AbortController();
    requestRevision.current = revision;
    activeAbortRef.current = controller;
    setLoading(true);
    setError(null);
    setErrorCode(undefined);
    setActiveTurnId(clientTurnId);
    activeTurnRef.current = clientTurnId;
    setMessages((current) => [
      ...current,
      { id: messageId("assistant-user"), role: "user", text: trimmed, createdAt: Date.now() },
      { id: pendingMessageId, role: "assistant", text: "正在查找推荐…", createdAt: Date.now(), status: "pending" }
    ]);

    const request: AssistantTurnRequest = {
      ...(conversationRef.current ? { conversationId: conversationRef.current } : {}),
      clientTurnId,
      message: trimmed
    };

    const applySnapshot = (snapshot: AssistantTurnResponse, streaming: boolean): void => {
      if (requestRevision.current !== revision) return;
      setConversationId(snapshot.conversationId);
      conversationRef.current = snapshot.conversationId;
      setActiveTurnId(snapshot.turnId);
      activeTurnRef.current = snapshot.turnId;
      setPreferences(snapshot.preferences);
      const nextMessage = responseMessage(snapshot);
      setMessages((current) => {
        if (!streaming) {
          return [...current.filter((item) => item.id !== pendingMessageId), nextMessage];
        }
        return current.map((item) => item.id === pendingMessageId
          ? {
              ...nextMessage,
              id: pendingMessageId,
              ...(snapshot.phase === "complete" ? {} : { status: "pending" as const })
            }
          : item);
      });
    };

    try {
      const response = streamTurn
        ? await streamTurn(
            request,
            csrfToken,
            (snapshot) => applySnapshot(snapshot, true),
            controller.signal
          )
        : await legacyTurn!(request, csrfToken, controller.signal);
      if (requestRevision.current !== revision) return null;
      applySnapshot(response, Boolean(streamTurn));
      setActiveTurnId(null);
      activeTurnRef.current = null;
      activeAbortRef.current = null;
      return response;
    } catch (reason: unknown) {
      if (requestRevision.current !== revision) return null;
      const failure = readableError(reason);
      setActiveTurnId(null);
      activeAbortRef.current = null;
      setError(failure.message);
      setErrorCode(failure.code);
      if (failure.code === "CONVERSATION_EXPIRED") {
        // The server explicitly invalidated this conversation. Drop its
        // cards and preference context so a later turn starts cleanly and
        // cannot act on stale references from the expired session.
        conversationRef.current = null;
        setConversationId(null);
        setPreferences(null);
        setMessages([{
          id: messageId("assistant-error"),
          role: "assistant",
          text: failure.message,
          createdAt: Date.now()
        }]);
      } else {
        setMessages((current) => {
          const pending = current.find((item) => item.id === pendingMessageId);
          if (!pending) {
            return [...current, {
              id: messageId("assistant-error"),
              role: "assistant",
              text: failure.message,
              createdAt: Date.now()
            }];
          }
          return current.map((item) => item.id === pendingMessageId
            ? { ...item, text: failure.message, status: undefined, phase: undefined }
            : item);
        });
      }
      return null;
    } finally {
      if (requestRevision.current === revision) {
        activeAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [client, csrfToken, enabled, loading]);

  const cancel = useCallback(async () => {
    if (!loading) return;
    const turnId = activeTurnRef.current;
    const revision = requestRevision.current + 1;
    requestRevision.current = revision;
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    activeTurnRef.current = null;
    setLoading(false);
    setActiveTurnId(null);
    setMessages((current) => {
      const hasPending = current.some((item) => item.status === "pending");
      if (!hasPending) {
        return [...current, {
          id: messageId("assistant-cancelled"),
          role: "assistant",
          text: "已取消本轮推荐。",
          createdAt: Date.now(),
          status: "cancelled" as const
        }];
      }
      return current.map((item) => item.status === "pending"
        ? { ...item, text: "已取消本轮推荐。", status: "cancelled" as const, phase: undefined }
        : item);
    });
    if (!turnId || !csrfToken || !client.cancelAssistantTurn) return;
    try {
      await client.cancelAssistantTurn(turnId, csrfToken);
    } catch (reason: unknown) {
      if (requestRevision.current !== revision) return;
      const failure = readableError(reason);
      if (failure.code === "TURN_NOT_FOUND") return;
      setError(failure.message);
      setErrorCode(failure.code);
    }
  }, [client, csrfToken, loading]);

  const clear = useCallback(async () => {
    const conversation = conversationRef.current;
    const turn = activeTurnRef.current;
    const revision = requestRevision.current + 1;
    requestRevision.current = revision;
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    activeTurnRef.current = null;
    setLoading(false);
    setActiveTurnId(null);
    conversationRef.current = null;
    setConversationId(null);
    setPreferences(null);
    setMessages([]);
    setError(null);
    setErrorCode(undefined);
    if (turn && client.cancelAssistantTurn) {
      try {
        await client.cancelAssistantTurn(turn, csrfToken);
      } catch (reason: unknown) {
        const failure = readableError(reason);
        if (failure.code !== "TURN_NOT_FOUND" && requestRevision.current === revision) {
          setError(failure.message);
          setErrorCode(failure.code);
        }
      }
    }
    if (!conversation || !csrfToken || !client.clearAssistantConversation) return;
    try {
      await client.clearAssistantConversation(conversation, csrfToken);
    } catch (reason: unknown) {
      if (requestRevision.current !== revision) return;
      const failure = readableError(reason);
      setError(failure.message);
      setErrorCode(failure.code);
    }
  }, [client, csrfToken]);

  return {
    conversationId,
    messages,
    cards,
    pendingRecommendations,
    phase,
    preferences,
    loading,
    error,
    errorCode,
    activeTurnId,
    submit,
    cancel,
    clear
  };
}

export default useAssistant;
