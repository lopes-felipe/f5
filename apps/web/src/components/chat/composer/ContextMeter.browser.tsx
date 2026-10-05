import "../../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ContextMeter } from "./ContextMeter";
import type { ComposerTokenUsage } from "./contextMeter.logic";

function usage(overrides: Partial<ComposerTokenUsage> = {}): ComposerTokenUsage {
  return {
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    model: "gpt-5.4",
    provider: "codex",
    ...overrides,
  };
}

describe("ContextMeter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders nothing when neither context nor thinking usage is known", async () => {
    const screen = await render(
      <ContextMeter tokenUsage={usage({ estimatedThinkingTokens: 0 })} />,
    );
    try {
      expect(document.querySelector('[data-slot="context-meter"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("tones the ring by occupancy and explains the model window in the tooltip", async () => {
    const screen = await render(
      <ContextMeter
        tokenUsage={usage({
          estimatedContextTokens: 38_000,
          modelContextWindowTokens: 200_000,
          model: "claude-sonnet-4-6",
          provider: "claudeAgent",
          tokenUsageSource: "estimated",
        })}
      />,
    );

    try {
      const meter = () => document.querySelector<HTMLButtonElement>('[data-slot="context-meter"]');
      expect(meter()?.getAttribute("aria-label")).toBe(
        "Context window occupancy for claude-sonnet-4-6: 38K / 200K (19%)",
      );
      expect(meter()?.dataset.tone).toBe("muted");

      await screen.rerender(
        <ContextMeter
          tokenUsage={usage({ estimatedContextTokens: 160_000, modelContextWindowTokens: 200_000 })}
        />,
      );
      expect(meter()?.dataset.tone).toBe("warning");

      await screen.rerender(
        <ContextMeter
          tokenUsage={usage({
            estimatedContextTokens: 1_000_000,
            modelContextWindowTokens: 1_050_000,
            tokenUsageSource: "provider",
          })}
        />,
      );
      expect(meter()?.dataset.tone).toBe("destructive");

      await page.getByRole("button", { name: "Context window occupancy for gpt-5.4" }).hover();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Context 1M / 1.1M (95%)");
        expect(document.body.textContent).toContain("Window: 1,050,000 tokens");
        expect(document.body.textContent).toContain("Model: gpt-5.4");
        expect(document.body.textContent).toContain("Source: Provider reported");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows the live thinking estimate with its own tooltip", async () => {
    const screen = await render(
      <ContextMeter tokenUsage={usage({ estimatedThinkingTokens: 12_500 })} />,
    );

    try {
      const meter = page.getByRole("button", { name: "Live thinking-token estimate" });
      await expect.element(meter).toHaveTextContent("12.5K thinking");
      await meter.hover();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Thinking: ~12,500 tokens");
        expect(document.body.textContent).toContain("not billed output tokens");
      });
    } finally {
      await screen.unmount();
    }
  });
});
