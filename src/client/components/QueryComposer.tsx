import { ArrowUp, Paperclip, X } from "lucide-react";
import { FormEvent, KeyboardEvent } from "react";

export function QueryComposer({
  value,
  onChange,
  onSubmit,
  loading,
  disabled = false,
  onCancel,
  placeholder = "输入电影或剧集名称",
  inputLabel = "输入电影或剧集名称"
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  loading: boolean;
  disabled?: boolean;
  onCancel?: () => void;
  placeholder?: string;
  inputLabel?: string;
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
        {inputLabel}
      </label>
      <textarea
        id="query-input"
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled || (loading && !onCancel)}
        aria-label={inputLabel}
      />
      <button
        className="send-button"
        type={loading && onCancel ? "button" : "submit"}
        disabled={disabled || (!loading && !value.trim())}
        onClick={loading && onCancel ? onCancel : undefined}
        aria-label={loading ? (onCancel ? "取消推荐" : "正在搜索") : "发送搜索"}
      >
        {loading && onCancel ? <X size={24} strokeWidth={1.8} aria-hidden="true" /> : <ArrowUp size={25} strokeWidth={1.8} aria-hidden="true" />}
      </button>
    </form>
  );
}
