import { Bot, CircleAlert } from "lucide-react";
import type { AssistantConversationMessage } from "../types";

function messageTime(createdAt: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(createdAt));
}

export function AssistantThread({ messages }: { messages: AssistantConversationMessage[] }) {
  return (
    <section className="assistant-thread" aria-label="AI 推荐对话记录">
      {messages.length === 0 ? (
        <div className="assistant-thread-empty">
          <strong>想看什么？</strong>
        </div>
      ) : (
        <ol className="message-list">
          {messages.map((message) => {
            const isUser = message.role === "user";
            const warnings = message.warnings ?? [];
            return (
              <li className={`message-row ${isUser ? "is-user" : "is-assistant"}`} key={message.id}>
                {!isUser ? <div className="assistant-avatar" aria-hidden="true"><Bot size={21} strokeWidth={1.8} /></div> : null}
                <div className="message-stack">
                  <time className="message-time" dateTime={new Date(message.createdAt).toISOString()}>{messageTime(message.createdAt)}</time>
                  <p className={`message-bubble${message.status === "pending" ? " is-pending" : ""}`}>{message.text}</p>
                  {warnings.length ? (
                    <details className="assistant-warning-list">
                      <summary className="assistant-warning-summary">
                        <CircleAlert size={14} aria-hidden="true" />
                        <span>{warnings.length} 条补充说明</span>
                      </summary>
                      <div className="assistant-warning-items" role="status">
                        {warnings.map((warning) => <span className="assistant-warning-item" key={`${warning.code}-${warning.message}`}>{warning.message}</span>)}
                      </div>
                    </details>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export default AssistantThread;
