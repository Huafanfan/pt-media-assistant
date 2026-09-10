import { DEFAULT_AI_MODEL, DEFAULT_AI_PROVIDER_TIMEOUT_MS } from "../config.js";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isStepCount, jsonSchema } from "ai";

export type AssistantRole = "system" | "user" | "assistant" | "tool";

export type AssistantMessage = {
  role: AssistantRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AssistantToolCall[];
};

export type AssistantToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AssistantToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ProviderUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type ProviderResponse = {
  message: AssistantMessage;
  finishReason?: string;
  usage: ProviderUsage;
};

export type CompatibleChatProvider = {
  chat(
    messages: AssistantMessage[],
    tools: AssistantToolDefinition[],
    options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number },
  ): Promise<ProviderResponse>;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CompatibleProviderOptions = {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

function reasoningEffortForModel(model: string): "none" | undefined {
  // This gateway's Luna Chat Completions tool mode supports only "none".
  // Explicit low/medium/high requires Responses; omission caused minute-long
  // requests in live diagnostics. Keep the setting consistent on final turns.
  return model === DEFAULT_AI_MODEL ? "none" : undefined;
}

export type ProviderErrorCode =
  | "AI_UNAVAILABLE"
  | "AI_TIMEOUT"
  | "AI_CANCELLED"
  | "AI_RATE_LIMITED"
  | "AI_INVALID_OUTPUT";

export class ProviderError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly status?: number;
  public readonly retryAfterSeconds?: number;

  public constructor(
    code: ProviderErrorCode,
    message = "AI provider unavailable",
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function positiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function usageFrom(value: unknown): ProviderUsage {
  if (!value || typeof value !== "object") {
    return { promptTokens: null, completionTokens: null, totalTokens: null };
  }
  const usage = value as Record<string, unknown>;
  return {
    promptTokens: positiveInteger(usage.prompt_tokens ?? usage.promptTokens),
    completionTokens: positiveInteger(usage.completion_tokens ?? usage.completionTokens),
    totalTokens: positiveInteger(usage.total_tokens ?? usage.totalTokens),
  };
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error("AI provider URL must use https");
  const path = parsed.pathname.replace(/\/+$/u, "");
  if (path.endsWith("/chat/completions")) return `${parsed.origin}${path}`;
  if (path.endsWith("/v1")) return `${parsed.origin}${path}/chat/completions`;
  if (path.endsWith("/v1/chat")) return `${parsed.origin}${path}/completions`;
  return `${parsed.origin}${path}/chat/completions`;
}

function normalizeSdkBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error("AI provider URL must use https");
  let path = parsed.pathname.replace(/\/+$/u, "");
  if (path.endsWith("/chat/completions")) path = path.slice(0, -"/chat/completions".length);

  return `${parsed.origin}${path}`;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function coerceMessage(value: unknown): AssistantMessage {
  if (!value || typeof value !== "object") throw new ProviderError("AI_INVALID_OUTPUT", "Invalid provider message");
  const candidate = value as Record<string, unknown>;
  const role = candidate.role;
  // A provider response is always an assistant message. Accepting a
  // provider supplied system/user/tool role here could inject a new system
  // message into the next orchestration step.
  if (role !== "assistant") {
    throw new ProviderError("AI_INVALID_OUTPUT", "Invalid provider message role");
  }
  const content = candidate.content === null || typeof candidate.content === "string"
    ? candidate.content
    : candidate.content === undefined
      ? null
      : String(candidate.content);
  const calls = Array.isArray(candidate.tool_calls)
    ? candidate.tool_calls.slice(0, 8).flatMap((raw): AssistantToolCall[] => {
      if (!raw || typeof raw !== "object") return [];
      const call = raw as Record<string, unknown>;
      const fn = call.function;
      if (!fn || typeof fn !== "object") return [];
      const functionValue = fn as Record<string, unknown>;
      if (typeof call.id !== "string" || typeof functionValue.name !== "string") return [];
      return [{
        id: call.id.slice(0, 160),
        type: "function",
        function: {
          name: functionValue.name.slice(0, 80),
          arguments: typeof functionValue.arguments === "string" ? functionValue.arguments.slice(0, 12_000) : "{}",
        },
      }];
    })
    : [];
  return {
    role,
    content: typeof content === "string" ? content.slice(0, 4_000) : content,
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

/**
 * Minimal OpenAI-compatible adapter. It intentionally uses fetch instead of
 * importing an SDK so the configured TRANS_STATION endpoint remains the only
 * network boundary and no provider-specific dependency is required at build
 * time. The request shape is compatible with AI SDK's OpenAI-compatible
 * provider and can be replaced behind this interface later.
 */
export class FetchCompatibleProvider implements CompatibleChatProvider {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly reasoningEffort?: "none";
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  public constructor(options: CompatibleProviderOptions) {
    this.endpoint = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_AI_MODEL;
    this.reasoningEffort = reasoningEffortForModel(this.model);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_AI_PROVIDER_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async chat(
    messages: AssistantMessage[],
    tools: AssistantToolDefinition[],
    options: { signal?: AbortSignal; maxTokens?: number; temperature?: number } = {},
  ): Promise<ProviderResponse> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeoutController.signal, options.signal]) : timeoutController.signal;
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    const body = {
      model: this.model,
      messages,
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      max_tokens: Math.min(1_200, Math.max(1, Math.floor(options.maxTokens ?? 1_200))),
      temperature: Math.min(1, Math.max(0, options.temperature ?? 0.2)),
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      stream: false,
    };
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal });
      } catch (error) {
        if (options.signal?.aborted) throw new ProviderError("AI_CANCELLED", "AI request cancelled");
        if (isAbortError(error) || (error instanceof Error && error.name === "TimeoutError")) throw new ProviderError("AI_TIMEOUT", "AI request timed out");
        throw new ProviderError("AI_UNAVAILABLE");
      }
      if (response.status === 429) {
        throw new ProviderError("AI_RATE_LIMITED", "AI provider rate limited", {
          status: response.status,
          retryAfterSeconds: retryAfter(response),
        });
      }
      if (!response.ok) {
        throw new ProviderError(
          response.status >= 500 ? "AI_UNAVAILABLE" : "AI_INVALID_OUTPUT",
          "AI provider request failed",
          { status: response.status },
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProviderError("AI_INVALID_OUTPUT", "AI provider returned invalid JSON");
      }
      if (!payload || typeof payload !== "object") throw new ProviderError("AI_INVALID_OUTPUT", "AI provider returned invalid output");
      const choices = (payload as Record<string, unknown>).choices;
      if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
        throw new ProviderError("AI_INVALID_OUTPUT", "AI provider returned no choices");
      }
      const first = choices[0] as Record<string, unknown>;
      const message = coerceMessage(first.message);
      return {
        message,
        ...(typeof first.finish_reason === "string" ? { finishReason: first.finish_reason } : {}),
        usage: usageFrom((payload as Record<string, unknown>).usage),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * AI SDK backed adapter used by production configuration. The orchestrator
 * still owns the loop and budgets: the SDK is only responsible for encoding
 * the compatible provider request and decoding one model step. Keeping this
 * boundary small also leaves the fetch adapter available for gateways whose
 * tool dialect differs from the SDK.
 */
export class AiSdkCompatibleProvider implements CompatibleChatProvider {
  private readonly model: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>;
  private readonly reasoningEffort?: "none";
  private readonly timeoutMs: number;

  public constructor(options: CompatibleProviderOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AI_PROVIDER_TIMEOUT_MS;
    const provider = createOpenAICompatible({
      baseURL: normalizeSdkBaseUrl(options.baseUrl),
      name: "trans-station",
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.fetchImpl ? { fetch: options.fetchImpl as never } : {}),
      includeUsage: true,
      supportsStructuredOutputs: false,
      // The configured gateway must receive an explicit non-streaming request.
      transformRequestBody: (body) => ({ ...body, stream: false }),
    });
    const model = options.model?.trim() || DEFAULT_AI_MODEL;
    this.reasoningEffort = reasoningEffortForModel(model);
    this.model = provider.chatModel(model);
  }

  public async chat(
    messages: AssistantMessage[],
    tools: AssistantToolDefinition[],
    options: { signal?: AbortSignal; maxTokens?: number; temperature?: number } = {},
  ): Promise<ProviderResponse> {
    const instructions = messages.filter(message => message.role === "system").map(message => message.content ?? "").join("\n");
    const sdkMessages = messages.filter(message => message.role !== "system").map((message) => {
      if (message.role === "assistant" && message.tool_calls?.length) {
        const content = [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.tool_calls.map((call) => ({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.function.name,
            input: (() => {
              try { return JSON.parse(call.function.arguments) as unknown; } catch { return {}; }
            })(),
          })),
        ];
        return { role: "assistant", content };
      }
      if (message.role === "tool") {
        return {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: message.tool_call_id ?? "unknown",
            toolName: message.name ?? "unknown",
            output: { type: "text", value: message.content ?? "" },
          }],
        };
      }
      return { role: message.role, content: message.content ?? "" };
    });
    const sdkTools = Object.fromEntries(tools.map((definition) => [
      definition.function.name,
      {
        description: definition.function.description,
        inputSchema: jsonSchema(definition.function.parameters),
        outputSchema: jsonSchema({ type: "object" }),
      },
    ]));
    try {
      const result = await generateText({
        model: this.model,
        instructions,
        messages: sdkMessages as never,
        ...(tools.length ? { tools: sdkTools as never } : {}),
        stopWhen: isStepCount(1),
        maxRetries: 0,
        temperature: Math.min(1, Math.max(0, options.temperature ?? 0.2)),
        maxOutputTokens: Math.min(1_200, Math.max(1, Math.floor(options.maxTokens ?? 1_200))),
        ...(this.reasoningEffort ? { reasoning: this.reasoningEffort } : {}),
        abortSignal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      const toolCalls: AssistantToolCall[] = (result.toolCalls ?? []).flatMap((call) => {
        const typed = call as unknown as { toolCallId?: string; toolName?: string; input?: unknown };
        if (!typed.toolCallId || !typed.toolName) return [];
        return [{
          id: typed.toolCallId.slice(0, 160),
          type: "function",
          function: {
            name: typed.toolName.slice(0, 80),
            arguments: JSON.stringify(typed.input ?? {}),
          },
        }];
      });
      const usage = result.usage as unknown as Record<string, unknown> | undefined;
      return {
        message: {
          role: "assistant",
          content: result.text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finishReason: typeof result.finishReason === "string" ? result.finishReason : undefined,
        usage: {
          promptTokens: positiveInteger(usage?.inputTokens ?? usage?.promptTokens),
          completionTokens: positiveInteger(usage?.outputTokens ?? usage?.completionTokens),
          totalTokens: positiveInteger(usage?.totalTokens),
        },
      };
    } catch (error) {
      if (options.signal?.aborted) throw new ProviderError("AI_CANCELLED", "AI request cancelled");
      if (isAbortError(error) || (error instanceof Error && error.name === "TimeoutError")) throw new ProviderError("AI_TIMEOUT", "AI request timed out");
      if (error instanceof ProviderError) throw error;
      const status = typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? Number((error as { statusCode: number }).statusCode)
        : undefined;
      if (status === 429) throw new ProviderError("AI_RATE_LIMITED", "AI provider rate limited", { status });
      const failure = new ProviderError("AI_UNAVAILABLE");
      failure.cause = error;
      throw failure;
    }
  }
}

export function providerFromConfig(config: {
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  aiProviderTimeoutMs?: number;
}): CompatibleChatProvider | undefined {
  if (!config.aiBaseUrl) return undefined;
  return new AiSdkCompatibleProvider({
    baseUrl: config.aiBaseUrl,
    ...(config.aiApiKey ? { apiKey: config.aiApiKey } : {}),
    ...(config.aiModel ? { model: config.aiModel } : {}),
    ...(config.aiProviderTimeoutMs ? { timeoutMs: config.aiProviderTimeoutMs } : {}),
  });
}
