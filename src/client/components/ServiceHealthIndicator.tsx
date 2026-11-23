import { useEffect, useId, useRef, useState } from "react";
import type { ServiceHealth } from "../../shared/contracts";

const dependencies = [
  { key: "prowlarr", label: "Prowlarr", unavailable: "不可用" },
  { key: "qbittorrent", label: "qBittorrent", unavailable: "不可用" },
  { key: "nasMounted", label: "NAS", unavailable: "未就绪" },
] as const;

type Props = {
  health: ServiceHealth | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
};

export function ServiceHealthIndicator({ health, loading, error, onRefresh }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [disclosure, setDisclosure] = useState<"preview" | "pinned" | null>(null);
  const open = disclosure !== null;
  const tone = loading ? "pending" : error || !health ? "unknown" : health.status;
  const statusText = {
    pending: "检查中", unknown: "暂不可用", degraded: "部分服务异常", ok: "正常",
  }[tone];

  useEffect(() => {
    if (!open) return;
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (root.current?.contains(document.activeElement)) trigger.current?.focus();
      setDisclosure(null);
    }
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setDisclosure(null);
    }
    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener("pointerdown", dismissOutside);
    return () => {
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("pointerdown", dismissOutside);
    };
  }, [open]);

  return (
    <div
      className="service-health"
      ref={root}
      onPointerEnter={event => {
        if (event.pointerType === "mouse") setDisclosure(current => current ?? "preview");
      }}
      onPointerLeave={event => {
        if (event.pointerType === "mouse" && !root.current?.contains(document.activeElement)) {
          setDisclosure(current => current === "preview" ? null : current);
        }
      }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDisclosure(null);
      }}
    >
      <button
        className="health-trigger"
        type="button"
        ref={trigger}
        aria-label={`服务状态：${statusText}`}
        aria-expanded={open}
        aria-controls={id}
        onFocus={event => {
          if (event.currentTarget.matches(":focus-visible")) setDisclosure(current => current ?? "preview");
        }}
        onClick={() => setDisclosure(current => current === "pinned" ? null : "pinned")}
      >
        <span className="health-dot" data-tone={tone} aria-hidden="true" />
      </button>
      <section id={id} className="health-panel" aria-label="服务状态详情" hidden={!open}>
        <header className="health-panel-heading">
          <strong>服务状态</strong>
          <span className="health-summary" role="status" data-tone={tone}>{statusText}</span>
        </header>
        <dl>
          {dependencies.map(({ key, label, unavailable }) => {
            const ready = !loading && !error ? health?.services?.[key] : undefined;
            return <div key={key} className="health-row">
              <dt>{label}</dt>
              <dd data-tone={ready === undefined ? "pending" : ready ? "ok" : "degraded"}>
                {ready === undefined ? "未确认" : ready ? "正常" : unavailable}
              </dd>
            </div>;
          })}
        </dl>
        {error && <p className="health-error">{error}</p>}
        <button className="text-button health-refresh" type="button" aria-disabled={loading}
          onClick={() => { if (!loading) onRefresh(); }}>
          {loading ? "检查中…" : "重新检查"}
        </button>
      </section>
    </div>
  );
}
