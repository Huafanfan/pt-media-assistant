import { Bot, CircleAlert, Sparkles } from "lucide-react";
import type { AssistantConversationMessage } from "../types";

function messageTime(createdAt: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(createdAt));
}

export function AssistantThread({ messages }: { messages: AssistantConversationMessage[] }) {
  return (
    <section className="assistant-thread" aria-label="AI 推荐对话记录">
      {messages.length === 0 ? (
        <div className="assistant-thread-empty">
          <div className="assistant-thread-mark" aria-hidden="true"><Sparkles size={22} /></div>
          <strong>想看什么？</strong>
          <p>说说你现在的口味，我会把作品偏好和 PT 片源一起核对。</p>
        </div>
      ) : (
        <ol className="message-list">
          {messages.map((message) => {
            const isUser = message.role === "user";
            return (
              <li className={`message-row ${isUser ? "is-user" : "is-assistant"}`} key={message.id}>
                {!isUser ? <div className="assistant-avatar" aria-hidden="true"><Bot size={21} strokeWidth={1.8} /></div> : null}
                <div className="message-stack">
                  <time className="message-time" dateTime={new Date(message.createdAt).toISOString()}>{messageTime(message.createdAt)}</time>
                  <p className={`message-bubble${message.status === "pending" ? " is-pending" : ""}`}>{message.text}</p>
                  {message.warnings?.length ? (
                    <div className="assistant-warning-list" role="status">
                      {message.warnings.map((warning) => <span key={`${warning.code}-${warning.message}`}><CircleAlert size={14} aria-hidden="true" />{warning.message}</span>)}
                    </div>
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
