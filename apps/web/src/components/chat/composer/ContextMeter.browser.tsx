import "../../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { TurnId, type UsageThreadTurn } from "@t3tools/contracts";

import type { PromptCacheMeterView } from "../../../lib/useThreadCacheTurns";
import { summarizeThreadCache } from "../cacheIndicator.logic";
import { ContextMeter } from "./ContextMeter";
import type { ComposerTokenUsage } from "./contextMeter.logic";

const minute = (value: number) =>
  new Date(Date.UTC(2026, 10, 13, 10, 0) + value * 60_000).toISOString();

function cacheTurn(id: string, overrides: Partial<UsageThreadTurn> = {}): UsageThreadTurn {
  return {
    turnId: TurnId.makeUnsafe(id),
    provider: "claudeAgent",
    model: "claude-opus-5-5",
    inputTokens: 10,
    outputTokens: 100,
    cacheReadTokens: 900,
    cacheWriteTokens: 90,
    completedAt: minute(Number(id.slice(1))),
    ...overrides,
  };
}

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

  it("shows the thread's prompt cache history and jumps to a turn", async () => {
    const onSelectTurn = vi.fn();
    const turns = [
      cacheTurn("t1", { cacheReadTokens: 0, cacheWriteTokens: 9_000 }),
      cacheTurn("t2"),
      cacheTurn("t3"),
    ];
    const view = (overrides: Partial<PromptCacheMeterView> = {}): PromptCacheMeterView => ({
      summary: summarizeThreadCache(turns, new Map()),
      // t1's reply is older than the loaded history.
      canSelectTurn: (turnId) => turnId !== "t1",
      onSelectTurn,
      ...overrides,
    });
    const tokenUsage = usage({ estimatedContextTokens: 38_000, modelContextWindowTokens: 200_000 });
    const screen = await render(<ContextMeter tokenUsage={tokenUsage} promptCache={view()} />);

    try {
      expect(document.querySelector('[data-slot="prompt-cache-miss-badge"]')).toBeNull();
      await page.getByRole("button", { name: /Context window occupancy/ }).hover();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Prompt cache · this thread");
        expect(document.body.textContent).toContain("Context 38K / 200K (19%)");
      });
      const bars = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-slot="prompt-cache-history"] button',
        ),
      ];
      expect(bars.map((bar) => bar.dataset.cacheState)).toEqual(["cold-start", "warm", "warm"]);
      expect(bars[0]!.disabled).toBe(true);
      expect(bars[0]!.getAttribute("aria-label")).toBe("Turn 1: 0% from cache, first turn");
      expect(document.querySelector('[data-slot="prompt-cache-last-turn"]')?.textContent).toBe(
        "90% from cache",
      );

      await page.getByRole("button", { name: "Turn 2: 90% from cache" }).click();
      expect(onSelectTurn).toHaveBeenCalledWith("t2");

      // A missed last turn puts the badge on the ring and names the gap.
      const missed = [
        ...turns,
        cacheTurn("t4", { cacheReadTokens: 0, cacheWriteTokens: 9_000, completedAt: minute(200) }),
      ];
      await screen.rerender(
        <ContextMeter
          tokenUsage={tokenUsage}
          promptCache={view({
            summary: summarizeThreadCache(
              missed,
              new Map([[TurnId.makeUnsafe("t4"), minute(190)]]),
            ),
          })}
        />,
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="prompt-cache-miss-badge"]')).not.toBeNull();
        expect(document.querySelector('[data-slot="prompt-cache-last-turn"]')?.textContent).toBe(
          "miss · idle 3h",
        );
      });
      expect(
        document.querySelector('[data-slot="context-meter"]')?.getAttribute("aria-label"),
      ).toContain("last turn missed the prompt cache");
    } finally {
      await screen.unmount();
    }
  });

  it("stays visible for cache history when the context size is unknown", async () => {
    const screen = await render(
      <ContextMeter
        tokenUsage={usage()}
        promptCache={{
          summary: summarizeThreadCache([cacheTurn("t1")], new Map()),
          canSelectTurn: () => true,
          onSelectTurn: () => {},
        }}
      />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Prompt cache history" }))
        .toBeVisible();
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
