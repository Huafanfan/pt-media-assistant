import { Compass, Search } from "lucide-react";

export type AppMode = "discover" | "search";

export function ModeSwitch({ mode, onChange }: { mode: AppMode; onChange: (mode: AppMode) => void }) {
  return (
    <div className="mode-switch" role="tablist" aria-label="浏览方式">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "discover"}
        className={mode === "discover" ? "is-active" : undefined}
        onClick={() => onChange("discover")}
      >
        <Compass size={17} aria-hidden="true" />
        发现
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "search"}
        className={mode === "search" ? "is-active" : undefined}
        onClick={() => onChange("search")}
      >
        <Search size={17} aria-hidden="true" />
        搜索
      </button>
    </div>
  );
}
