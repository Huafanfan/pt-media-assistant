import { Bot } from "lucide-react";
import type { ChatMessage } from "../types";
import { EmptyState } from "./States";

function messageTime(createdAt?: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(createdAt ?? Date.now())
  );
}
export function ChatThread({ messages }: { messages: ChatMessage[] }) {
  return (
    <section className="chat-thread" aria-label="对话记录">
      {messages.length === 0 ? (
        <EmptyState title="准备好了" detail="输入片名、年份或豆瓣链接，开始查找片源。" />
      ) : (
        <ol className="message-list">
          {messages.map((message) => {
            const isUser = message.role === "user";
            return (
              <li className={`message-row ${isUser ? "is-user" : "is-assistant"}`} key={message.id}>
                {!isUser ? (
                  <div className="assistant-avatar" aria-hidden="true">
                    <Bot size={21} strokeWidth={1.8} />
                  </div>
                ) : null}
                <div className="message-stack">
                  <time className="message-time" dateTime={new Date(message.createdAt ?? Date.now()).toISOString()}>
                    {messageTime(message.createdAt)}
                  </time>
                  <p className="message-bubble">{message.text}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
