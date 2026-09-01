import { ArrowUp, Paperclip } from "lucide-react";
import { FormEvent, KeyboardEvent } from "react";

export function QueryComposer({
  value,
  onChange,
  onSubmit,
  loading,
  disabled = false
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  loading: boolean;
  disabled?: boolean;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!loading && !disabled && value.trim()) {
        event.currentTarget.form?.requestSubmit();
      }
    }
  };

  return (
    <form className="query-composer" onSubmit={onSubmit} aria-busy={loading}>
      <span className="composer-attachment" aria-hidden="true">
        <Paperclip size={24} strokeWidth={1.6} />
      </span>
      <label className="sr-only" htmlFor="query-input">
        搜索作品
      </label>
      <textarea
        id="query-input"
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入电影或剧集名称"
        disabled={disabled || loading}
        aria-label="输入电影或剧集名称"
      />
      <button
        className="send-button"
        type="submit"
        disabled={disabled || loading || !value.trim()}
        aria-label={loading ? "正在搜索" : "发送搜索"}
      >
        <ArrowUp size={25} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </form>
  );
}
