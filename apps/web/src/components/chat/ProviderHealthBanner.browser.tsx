import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ServerProvider } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { act } from "react";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { ProviderHealthBanner } from "./ProviderHealthBanner";

const { refreshProviders, notify } = vi.hoisted(() => ({
  refreshProviders: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ server: { refreshProviders } }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: notify } }));

afterEach(() => {
  vi.resetAllMocks();
});

it.each(["warning", "error"] as const)(
  "refreshes only the banner instance and blocks repeat clicks for %s",
  async (status) => {
    const provider = {
      instanceId: "codex-work",
      driver: "codex",
      displayName: "Work Codex",
      status,
    } as ServerProvider;
    const refreshed = { ...provider, status: "ready", models: [{ id: "new-model" }] };
    let resolve!: (value: unknown) => void;
    refreshProviders.mockImplementation(() => new Promise((done) => (resolve = done)));
    const client = new QueryClient();
    client.setQueryData(serverQueryKeys.config(), { providers: [provider], marker: "preserved" });
    const screen = await render(
      <QueryClientProvider client={client}>
        <ProviderHealthBanner status={provider} />
      </QueryClientProvider>,
    );
    const button = page.getByRole("button", { name: "Refresh Work Codex provider status" });
    const nativeButton = screen.container.querySelector("button")!;
    await act(() => {
      nativeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // Both clicks reach React before it commits the disabled state.
      expect(nativeButton.disabled).toBe(false);
      nativeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect.element(button).toBeDisabled();
    await expect.element(button).toHaveTextContent("Refreshing...");
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(refreshProviders).toHaveBeenCalledWith({ instanceId: "codex-work" });
    resolve({ providers: [refreshed] });
    await expect.element(button).toBeEnabled();
    expect(client.getQueryData(serverQueryKeys.config())).toEqual({
      providers: [refreshed],
      marker: "preserved",
    });
    await screen.unmount();
  },
);

it("keeps disabled provider notices without offering Refresh", async () => {
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <ProviderHealthBanner
        status={
          {
            instanceId: "codex",
            driver: "codex",
            status: "disabled",
            message: "Provider disabled",
          } as ServerProvider
        }
      />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("Provider disabled")).toBeVisible();
  expect(screen.container.querySelector("button")).toBeNull();
  expect(refreshProviders).not.toHaveBeenCalled();
  await screen.unmount();
});

it("reports refresh errors and allows retrying", async () => {
  refreshProviders
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValue({ providers: [] });
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <ProviderHealthBanner
        status={{ instanceId: "claude", driver: "claudeAgent", status: "error" } as ServerProvider}
      />
    </QueryClientProvider>,
  );
  const button = page.getByRole("button", { name: /Refresh .* provider status/ });
  await button.click();
  await expect.poll(() => notify.mock.calls.length).toBe(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ description: "Disconnected" }));
  await expect.element(button).toBeEnabled();
  await button.click();
  await expect.poll(() => refreshProviders.mock.calls.length).toBe(2);
  await screen.unmount();
});
