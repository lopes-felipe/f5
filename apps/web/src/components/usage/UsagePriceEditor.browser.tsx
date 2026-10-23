import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { UsagePriceEditor } from "./UsagePriceEditor";

const settings = vi.hoisted(() => ({
  current: {
    usagePriceOverrides: [] as Array<Record<string, unknown>>,
    usageModelAliases: {} as Record<string, string>,
  },
  updateSettings: vi.fn(async (_patch: Record<string, unknown>) => {}),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (value: typeof settings.current) => unknown) => select(settings.current),
  useUpdateSettings: () => ({ updateSettings: settings.updateSettings }),
}));
vi.mock("../../lib/usageReactQuery", () => ({ refreshUsageSummaries: async () => {} }));

afterEach(() => {
  settings.current = { usagePriceOverrides: [], usageModelAliases: {} };
  settings.updateSettings.mockClear();
  document.body.innerHTML = "";
});

const view = () => (
  <QueryClientProvider client={new QueryClient()}>
    <UsagePriceEditor draft={null} />
  </QueryClientProvider>
);

it("adds and removes a model mapping without touching prices", async () => {
  settings.current.usageModelAliases = { "claude-preview": "claude-opus" };
  const screen = await render(view());
  try {
    await page.getByText("Usage prices").click();
    await expect.element(page.getByText("claude-preview → claude-opus")).toBeVisible();

    await page.getByRole("button", { name: "Save mapping" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("two different model IDs");
    expect(settings.updateSettings).not.toHaveBeenCalled();

    await page.getByLabelText("Mapped model").fill(" gpt-5.6-preview ");
    await page.getByLabelText("Map to").fill("gpt-5.6");
    await page.getByRole("button", { name: "Save mapping" }).click();
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
