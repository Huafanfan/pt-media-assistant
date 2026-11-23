import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppHeader } from "../../src/client/components/AppHeader";
import type { ServiceHealth } from "../../src/shared/contracts";

const health: ServiceHealth = {
  status: "ok",
  version: "0.1.0",
  pairingRequired: false,
  services: { prowlarr: true, qbittorrent: true, nasMounted: true },
  capabilities: {
    ai: { enabled: true, configured: true, model: "deepseek-flash" },
    webSearch: { enabled: true, configured: true },
    grab: { enabled: true },
    persistence: { enabled: true },
  },
};

describe("AppHeader AI status", () => {
  it("renders the AI chip with a detail tooltip", () => {
    render(
      <AppHeader
        health={health}
        paired
        aiStatus={{
          state: "ok",
          label: "AI 已启用",
          detail: "模型 deepseek-flash",
        }}
      />,
    );
    const chip = screen.getByText("AI 已启用");
    expect(chip).toBeInTheDocument();
    expect(chip.closest("p")?.getAttribute("title")).toBe(
      "模型 deepseek-flash",
    );
    expect(screen.getByText("TJUPT · qBittorrent · NAS 已连接")).toBeInTheDocument();
  });

  it("renders a warning chip for an unavailable AI", () => {
    render(
      <AppHeader
        health={health}
        paired
        aiStatus={{ state: "warning", label: "AI 异常" }}
      />,
    );
    const chip = screen.getByText("AI 异常");
    expect(chip.closest("p")?.className).toContain("is-warning");
  });

  it("omits the chip when no AI status is provided", () => {
    render(<AppHeader health={health} paired />);
    expect(screen.queryByText(/^AI /u)).toBeNull();
  });
});
