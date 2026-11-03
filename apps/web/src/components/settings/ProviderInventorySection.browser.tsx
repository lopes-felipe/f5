import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ProviderInventorySection } from "./ProviderInventorySection";

vi.mock("../../store", () => ({
  useStore: (select: (state: unknown) => unknown) => select({ projects: [] }),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    server: {
      getProviderInventory: async () => ({
        instanceId: "codex",
        driver: "codex",
        generatedAt: "2026-11-03T00:00:00Z",
        hooks: [],
        plugins: [],
        connectors: [],
        agents: [],
        warnings: [],
        accountWorkspaces: [{ name: "Engineering", kind: "workspace", active: true }],
        account: { type: "gcp", workspaceName: "Engineering" },
      }),
    },
  }),
}));

afterEach(() => {
  document.body.innerHTML = "";
});
it("shows read-only account workspaces and Vertex AI account labels", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <ProviderInventorySection instanceId={ProviderInstanceId.makeUnsafe("codex")} />
    </QueryClientProvider>,
  );
  try {
    await page.getByText("Hooks, plugins and connectors", { exact: true }).click();
    await expect.element(page.getByText(/Account workspaces/)).toBeVisible();
    await expect.element(page.getByText(/workspace · Active/)).toBeVisible();
    await expect.element(page.getByText(/Google Vertex AI/)).toBeVisible();
  } finally {
    await screen.unmount();
    client.clear();
  }
});
