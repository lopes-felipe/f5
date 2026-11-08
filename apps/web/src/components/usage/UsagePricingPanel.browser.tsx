import "../../index.css";

import type { UsageSummary } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { UsagePriceDialog, type UsagePriceDraft } from "./UsagePriceDialog";
import { UsagePricingPanel } from "./UsagePricingPanel";

const settings = vi.hoisted(() => ({
  current: {
    usagePriceOverrides: [] as Array<Record<string, unknown>>,
    usageModelAliases: {} as Record<string, string>,
    usageMonthlyBudget: null as Record<string, unknown> | null,
  },
  updateSettings: vi.fn(async (_patch: Record<string, unknown>) => {}),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (value: typeof settings.current) => unknown) => select(settings.current),
  useUpdateSettings: () => ({ updateSettings: settings.updateSettings }),
}));
vi.mock("../../lib/usageReactQuery", () => ({ refreshUsageSummaries: async () => {} }));

afterEach(() => {
  settings.current = { usagePriceOverrides: [], usageModelAliases: {}, usageMonthlyBudget: null };
  settings.updateSettings.mockClear();
  document.body.innerHTML = "";
});

const metrics = (turnCount: number, unpricedTurnCount: number, cost: number | null) => ({
  turnCount,
  reportedTokenTurnCount: turnCount,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 110,
  providerReportedCostUsd: cost,
  pricedTurnCount: turnCount - unpricedTurnCount,
  unpricedTurnCount,
  reporting: null,
});

const summary = {
  byProvider: [
    { provider: "claudeAgent", model: "claude-opus", metrics: metrics(5, 0, 2) },
    { provider: "codex", model: "gpt-5.6-preview", metrics: metrics(3, 3, null) },
    { provider: "codex", model: null, metrics: metrics(1, 0, 0.1) },
  ],
} as unknown as UsageSummary;

function Harness(props: { readonly initial?: UsagePriceDraft | null }) {
  const [draft, setDraft] = useState<UsagePriceDraft | null>(props.initial ?? null);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <UsagePricingPanel
        summary={summary}
        loading={false}
        onSetPrice={(provider, model) => setDraft({ provider, model, nonce: Math.random() })}
      />
      <UsagePriceDialog draft={draft} onClose={() => setDraft(null)} />
    </QueryClientProvider>
  );
}

it("lists unpriced models first and saves a price from the dialog", async () => {
  const screen = await render(<Harness />);
  try {
    const rows = page.getByRole("table", { name: "Model prices" }).getByRole("row");
    await expect.element(rows.nth(1)).toHaveTextContent(/gpt-5\.6-preview.*Unpriced · 3/);
    await expect.element(rows.nth(2)).toHaveTextContent(/claude-opus.*Reported/);
    // Rows without a model name can't be priced and stay out of the table.
    expect(rows.all()).toHaveLength(3);

    await page.getByRole("button", { name: "Set price for gpt-5.6-preview" }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "Set price" })).toBeVisible();
    await expect.element(dialog.getByLabelText("Model")).toHaveValue("gpt-5.6-preview");
    await expect.element(dialog.getByLabelText("Input price")).toHaveFocus();

    await dialog.getByRole("button", { name: "Save price" }).click();
    await expect.element(dialog.getByRole("alert")).toHaveTextContent("non-negative input");
    expect(settings.updateSettings).not.toHaveBeenCalled();

    await dialog.getByLabelText("Input price").fill("1.25");
    await dialog.getByLabelText("Output price").fill("10");
    await dialog.getByRole("button", { name: "Save price" }).click();
    await vi.waitFor(() =>
      expect(settings.updateSettings).toHaveBeenLastCalledWith({
        usagePriceOverrides: [
          {
            provider: "codex",
            model: "gpt-5.6-preview",
            inputUsdPerMillion: 1.25,
            outputUsdPerMillion: 10,
            cacheReadUsdPerMillion: null,
            cacheWriteUsdPerMillion: null,
          },
        ],
      }),
    );
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("replaces an override when editing renames its model, and removes one", async () => {
  const existing = {
    provider: "codex",
    model: "gpt-old",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cacheReadUsdPerMillion: null,
    cacheWriteUsdPerMillion: null,
  };
  const other = { ...existing, model: "gpt-other" };
  settings.current.usagePriceOverrides = [existing, other];
  const screen = await render(<Harness />);
  try {
    // Saved overrides for models outside the range still get rows.
    await expect.element(page.getByText("Override", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Edit price for gpt-old" }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("heading", { name: "Edit price" })).toBeVisible();
    await expect.element(dialog.getByLabelText("Input price")).toHaveValue(1);
    // Initial focus lands on Input price after opening; typing before then can be redirected.
    await expect.element(dialog.getByLabelText("Input price")).toHaveFocus();
    await dialog.getByLabelText("Model").fill("gpt-new");
    await expect.element(dialog.getByLabelText("Model")).toHaveValue("gpt-new");
    await dialog.getByRole("button", { name: "Save price" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(settings.updateSettings).toHaveBeenLastCalledWith({
        usagePriceOverrides: [other, { ...existing, model: "gpt-new" }],
      }),
    );

    await page.getByRole("button", { name: "Remove price for gpt-other" }).click();
    await vi.waitFor(() =>
      expect(settings.updateSettings).toHaveBeenLastCalledWith({
        usagePriceOverrides: [existing],
      }),
    );
  } finally {
    await screen.unmount();
  }
});

it("adds and removes a model mapping without touching prices", async () => {
  settings.current.usageModelAliases = { "claude-preview": "claude-opus" };
  const screen = await render(<Harness />);
  try {
    const mappings = page.getByRole("region", { name: "Model mappings" });
    await expect.element(mappings.getByText("claude-preview")).toBeVisible();

    await mappings.getByRole("button", { name: "Add mapping" }).click();
    await expect.element(mappings.getByRole("alert")).toHaveTextContent("two different model IDs");
    expect(settings.updateSettings).not.toHaveBeenCalled();

    await page.getByLabelText("Mapped model").fill(" gpt-5.6-preview ");
    await page.getByLabelText("Map to").fill("gpt-5.6");
    await mappings.getByRole("button", { name: "Add mapping" }).click();
    await vi.waitFor(() =>
      expect(settings.updateSettings).toHaveBeenLastCalledWith({
        usageModelAliases: { "claude-preview": "claude-opus", "gpt-5.6-preview": "gpt-5.6" },
      }),
    );
    await expect.element(page.getByLabelText("Map to")).toHaveValue("");

    await page.getByRole("button", { name: "Remove mapping for claude-preview" }).click();
    await vi.waitFor(() =>
      expect(settings.updateSettings).toHaveBeenLastCalledWith({ usageModelAliases: {} }),
    );
  } finally {
    await screen.unmount();
  }
});

it("validates, saves and clears the monthly budget", async () => {
  const screen = await render(<Harness />);
  try {
    const budget = page.getByRole("region", { name: "Monthly budget" });
    await budget.getByLabelText("Token budget").fill("1.5");
    await budget.getByRole("button", { name: "Save budget" }).click();
    await expect.element(budget.getByRole("alert")).toHaveTextContent("whole token budget");
    await budget.getByLabelText("Token budget").fill("");
    await budget.getByLabelText("Cost budget").fill("0");
    await budget.getByRole("button", { name: "Save budget" }).click();
    await expect.element(budget.getByRole("alert")).toHaveTextContent("above $0");
    expect(settings.updateSettings).not.toHaveBeenCalled();

    await budget.getByLabelText("Token budget").fill("250,000,000");
    await budget.getByLabelText("Cost budget").fill("100");
    await budget.getByRole("button", { name: "Save budget" }).click();
    await vi.waitFor(() =>
      expect(settings.updateSettings).toHaveBeenLastCalledWith({
        usageMonthlyBudget: { costUsd: 100, tokens: 250_000_000 },
      }),
    );
  } finally {
    await screen.unmount();
  }
});
