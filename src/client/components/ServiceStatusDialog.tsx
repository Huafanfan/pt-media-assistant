import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { ServiceCapabilities, ServiceHealth } from "../../shared/contracts";

function upstreamLabel(ok: boolean | undefined): string {
  return ok ? "正常" : "异常";
}

/** Distinguish "configured but off" from "on but incomplete" honestly. */
function capabilityLabel(enabled: boolean, configured: boolean): string {
  if (!enabled) return configured ? "已配置 · 未启用" : "未启用";
  return configured ? "已启用" : "已启用 · 配置不完整";
}

function CapabilityRows({ capabilities }: { capabilities: ServiceCapabilities | undefined }) {
  const ai = capabilities?.ai;
  const webSearch = capabilities?.webSearch;
  const persistence = capabilities?.persistence;
  return (
    <ul className="status-list">
      <li>
        <span>AI 推荐</span>
        <strong>{capabilityLabel(ai?.enabled ?? false, ai?.configured ?? false)}</strong>
      </li>
      {ai?.model ? (
        <li>
          <span>模型</span>
          <strong>{ai.model}</strong>
        </li>
      ) : null}
      <li>
        <span>联网搜索</span>
        <strong>{capabilityLabel(webSearch?.enabled ?? false, webSearch?.configured ?? false)}</strong>
      </li>
      <li>
        <span>下载开关</span>
        <strong>{capabilities?.grab.enabled ? "已开启" : "已关闭"}</strong>
      </li>
      <li>
        <span>已看与偏好持久化</span>
        <strong>{persistence?.enabled ? "已启用" : "未启用（仅内存）"}</strong>
      </li>
      {persistence?.error ? (
        <li>
          <span>持久化问题</span>
          <strong className="is-error">{persistence.error}</strong>
        </li>
      ) : null}
    </ul>
  );
}

export function ServiceStatusDialog({
  health,
  onClose
}: {
  health: ServiceHealth | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // Keep keyboard focus inside the dialog while it is open.
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Return focus to the control that opened the dialog.
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="status-dialog-backdrop" onClick={onClose}>
      <div
        className="status-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="status-dialog-heading">
          <h2 id="status-dialog-title">服务与能力状态</h2>
          <button ref={closeRef} className="icon-button small-icon-button" type="button" onClick={onClose} aria-label="关闭状态窗口">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <section aria-label="上游服务">
          <h3>上游服务</h3>
          <ul className="status-list">
            <li>
              <span>Prowlarr / 索引器</span>
              <strong className={health?.services?.prowlarr ? "is-ok" : "is-error"}>{upstreamLabel(health?.services?.prowlarr)}</strong>
            </li>
            <li>
              <span>qBittorrent</span>
              <strong className={health?.services?.qbittorrent ? "is-ok" : "is-error"}>{upstreamLabel(health?.services?.qbittorrent)}</strong>
            </li>
            <li>
              <span>NAS 挂载</span>
              <strong className={health?.services?.nasMounted ? "is-ok" : "is-error"}>{upstreamLabel(health?.services?.nasMounted)}</strong>
            </li>
          </ul>
        </section>

        <section aria-label="可选能力">
          <h3>可选能力</h3>
          <CapabilityRows capabilities={health?.capabilities} />
        </section>

        <p className="status-dialog-note">
          这里只报告配置与就绪状态，不发起模型或搜索调用；“已配置”不代表上游当下一定可用。版本 {health?.version ?? "未知"}。
        </p>
      </div>
    </div>
  );
}

export default ServiceStatusDialog;
