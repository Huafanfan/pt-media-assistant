import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { ServiceHealth } from "../../shared/contracts";

function serviceHealthText(
  health: ServiceHealth | null,
  paired: boolean,
): string {
  if (!paired) {
    return "等待设备配对";
  }
  if (!health) {
    return "服务状态未知";
  }

  const services = health.services;
  if (!services) {
    return health.status === "ok"
      ? "TJUPT · qBittorrent · NAS 已连接"
      : "服务检查中";
  }

  const indexer = services.prowlarr ? "TJUPT" : "TJUPT 未连接";
  const client = services.qbittorrent ? "qBittorrent" : "qBittorrent 未连接";
  const nas = services.nasMounted ? "NAS 已连接" : "NAS 未连接";
  return `${indexer} · ${client} · ${nas}`;
}

export function AppHeader({
  health,
  paired,
  healthError,
  onRefresh,
  onShowStatus,
  runtimeStatus,
}: {
  health: ServiceHealth | null;
  paired: boolean;
  healthError?: string | null;
  onRefresh?: () => void;
  onShowStatus?: () => void;
  runtimeStatus?: ReactNode;
}) {
  const isHealthy = paired && health?.status === "ok";
  const statusText = serviceHealthText(health, paired);

  return (
    <header className="app-header">
      <div className="brand-lockup">
        <h1>片源助手</h1>
        <div className="header-status">
          <p
            className={`service-status ${isHealthy ? "is-healthy" : "is-degraded"}`}
          >
            <span className="status-dot" aria-hidden="true" />
            <span>{statusText}</span>
            {onRefresh ? (
              <button
                className="service-status-refresh"
                type="button"
                onClick={onRefresh}
                aria-label="刷新状态"
              >
                <RefreshCw size={14} aria-hidden="true" />
              </button>
            ) : null}
            {onShowStatus ? (
              <button
                className="service-status-detail"
                type="button"
                onClick={onShowStatus}
              >
                服务状态
              </button>
            ) : null}
          </p>
          <div className="header-status-runtime">{runtimeStatus}</div>
        </div>
        {healthError ? <span className="sr-only">{healthError}</span> : null}
      </div>
    </header>
  );
}

export { serviceHealthText };
