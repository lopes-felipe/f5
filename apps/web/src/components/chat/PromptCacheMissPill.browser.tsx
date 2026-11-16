import "../../index.css";

import { TurnId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { PromptCacheMissPill } from "./PromptCacheMissPill";
import type { TurnCacheSummary } from "./cacheIndicator.logic";
import { summarizeThreadCache } from "./cacheIndicator.logic";

const turn: TurnCacheSummary = {
  turnId: TurnId.makeUnsafe("t2"),
  turnNumber: 2,
  state: "miss",
  ratio: 0.03,
  cacheReadTokens: 3_000,
  cacheWriteTokens: 118_218,
  uncachedInputTokens: 77,
  outputTokens: 25_071,
  rewrittenTokens: 118_218,
  idleMs: 3 * 3_600_000 + 60_000,
  completedAt: "2026-11-13T13:41:00.000Z",
};

describe("PromptCacheMissPill", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names the rewrite and the gap, and breaks the turn's tokens down", async () => {
    const screen = await render(<PromptCacheMissPill turn={turn} />);
    try {
      const pill = page.getByRole("button", {
        name: "Cache miss · rewrote 118.2K tokens · idle 3h",
      });
      await expect.element(pill).toBeVisible();
      await pill.click();
      await vi.waitFor(() => {
        const breakdown = document.querySelector('[data-slot="prompt-cache-breakdown"]');
        expect(breakdown?.textContent).toContain("this turn · 3% from cache");
        expect(breakdown?.textContent).toContain("Read from cache3,000");
        expect(breakdown?.textContent).toContain("Written to cache118,218");
        expect(breakdown?.textContent).toContain("Uncached input77");
        expect(breakdown?.textContent).toContain("Output25,071");
        expect(breakdown?.textContent).toContain("Totals for the whole turn");
        expect(breakdown?.textContent).toContain("ended 3h before this one started");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("leaves out what it does not know", async () => {
    const screen = await render(
      <PromptCacheMissPill turn={{ ...turn, idleMs: null, rewrittenTokens: null }} />,
    );
    try {
      await expect.element(page.getByRole("button", { name: "Cache miss" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("renders a loaded Codex miss with uncached input and no reported cache writes", async () => {
    const summary = summarizeThreadCache(
      {
        firstTurnId: TurnId.makeUnsafe("earlier"),
        earlierTurnCount: 1,
        turns: [
          {
            turnId: TurnId.makeUnsafe("codex-miss"),
            provider: "codex",
            model: "gpt-6.1-sol",
            inputTokens: 100,
            cacheReadTokens: 20,
            cacheWriteTokens: null,
            outputTokens: 10,
            completedAt: turn.completedAt,
          },
        ],
      },
      new Map(),
    );
    const screen = await render(<PromptCacheMissPill turn={summary.last!} />);
    try {
      const pill = page.getByRole("button", { name: "Cache miss · rewrote 80 tokens" });
      await expect.element(pill).toBeVisible();
      await pill.click();
      await vi.waitFor(() => {
        const breakdown = document.querySelector('[data-slot="prompt-cache-breakdown"]');
        expect(breakdown?.textContent).toContain("20% from cache");
        expect(breakdown?.textContent).toContain("Uncached input80");
      });
    } finally {
      await screen.unmount();
    }
  });
});
