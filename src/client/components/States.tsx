import { AlertCircle, LoaderCircle, SearchX, WifiOff } from "lucide-react";

export function LoadingState({ label = "正在连接服务…" }: { label?: string }) {
  return (
    <div className="state-block state-loading" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={20} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
export function EmptyState({
  title = "还没有搜索结果",
  detail = "输入电影或剧集名称，选择作品后查看详情和片源。"
}: {
  title?: string;
  detail?: string;
}) {
  return (
    <div className="state-block state-empty">
      <SearchX size={22} strokeWidth={1.5} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

export function ErrorMessage({
  message,
  onRetry,
  retryLabel = "重试"
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="state-block state-error" role="alert">
      <AlertCircle size={20} strokeWidth={1.8} aria-hidden="true" />
      <div>
        <strong>{message}</strong>
        {onRetry ? (
          <button className="text-button" type="button" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function OfflineState({ detail = "请确认片源服务正在运行。" }: { detail?: string }) {
  return (
    <div className="state-block state-offline" role="alert">
      <WifiOff size={20} strokeWidth={1.8} aria-hidden="true" />
      <div>
        <strong>服务暂时不可用</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}
