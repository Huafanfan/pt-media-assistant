import { CircleUserRound, Menu, MonitorSmartphone, X } from "lucide-react";
import { useState } from "react";
import type { ServiceHealth } from "../../shared/contracts";

function serviceHealthText(health: ServiceHealth | null, paired: boolean): string {
  if (!paired) {
    return "等待设备配对";
  }
  if (!health) {
    return "服务状态未知";
  }

  const services = health.services;
  if (!services) {
    return health.status === "ok" ? "TJUPT · qBittorrent · NAS 已连接" : "服务检查中";
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
  onRefresh
}: {
  health: ServiceHealth | null;
  paired: boolean;
  healthError?: string | null;
  onRefresh?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isHealthy = paired && health?.status === "ok";
  const statusText = serviceHealthText(health, paired);

  return (
    <header className="app-header">
      <button
        className="icon-button menu-button"
        type="button"
        aria-label={menuOpen ? "关闭导航" : "打开导航"}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {menuOpen ? <X size={25} aria-hidden="true" /> : <Menu size={25} aria-hidden="true" />}
      </button>

      <div className="brand-lockup">
        <h1>片源助手</h1>
        <p className={`service-status ${isHealthy ? "is-healthy" : "is-degraded"}`}>
          <span className="status-dot" aria-hidden="true" />
          <span>{statusText}</span>
        </p>
        {healthError ? <span className="sr-only">{healthError}</span> : null}
      </div>

      <button
        className="device-button"
        type="button"
        aria-label="查看设备连接状态"
        aria-pressed={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="device-icon-wrap">
          {paired ? <MonitorSmartphone size={25} aria-hidden="true" /> : <CircleUserRound size={25} aria-hidden="true" />}
          <span className={`device-dot ${isHealthy ? "is-healthy" : ""}`} aria-hidden="true" />
        </span>
      </button>

      {menuOpen ? (
        <div className="header-menu" role="dialog" aria-label="设备状态">
          <p className="eyebrow">当前连接</p>
          <p className="header-menu-status">{statusText}</p>
          {health?.version ? <p className="header-menu-meta">服务版本 {health.version}</p> : null}
          {onRefresh ? (
            <button className="text-button" type="button" onClick={onRefresh}>
              刷新状态
            </button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

export { serviceHealthText };
