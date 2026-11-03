import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ProviderInstanceCard } from "../ProviderInstanceCard";
import type { ComponentProps } from "react";
import { ProvidersSettings } from "./ProvidersSettings";

const mocks = vi.hoisted(() => ({ update: vi.fn(), confirm: vi.fn() }));
vi.mock("../../../hooks/useSettings", () => ({
  useSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      codex: { driver: "codex", config: { binaryPath: "/opt/codex" } },
      grok: { driver: "grok", enabled: true },
      custom: { driver: "codex", displayName: "Custom" },
    },
  }),
  useUpdateSettings: () => ({ updateSettings: mocks.update }),
}));
vi.mock("../SettingsRouteContext", () => ({
  useSettingsRouteContext: () => ({ settings: {}, defaults: {}, updateSettings: vi.fn() }),
}));
vi.mock("../../../nativeApi", () => ({
  ensureNativeApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("../ProviderInstanceCard", () => ({
  ProviderInstanceCard: (props: ComponentProps<typeof ProviderInstanceCard>) => (
    <div>
      {props.headerAction}
      {props.onDelete && <button onClick={props.onDelete}>Delete {props.instanceId}</button>}
    </div>
  ),
}));
vi.mock("../AddProviderInstanceDialog", () => ({ AddProviderInstanceDialog: () => null }));

beforeEach(() => {
  mocks.update.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(false);
});

it.each(["Reset Codex provider settings", "Delete custom"])(
  "requires confirmation for %s",
  async (name) => {
    const screen = await render(
      <QueryClientProvider client={new QueryClient()}>
        <ProvidersSettings />
      </QueryClientProvider>,
    );
    const button = screen.getByRole("button", { name, exact: true });
    await button.click();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("custom binary path"));
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValue(true);
    await button.click();
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(mocks.update.mock.calls[0]![0].providerInstances).not.toHaveProperty(
      name.startsWith("Reset") ? "codex" : "custom",
    );
  },
);

it("fails closed on dialog errors", async () => {
  mocks.confirm.mockRejectedValue(new Error("Dialog unavailable"));
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <ProvidersSettings />
    </QueryClientProvider>,
  );
  await screen.getByRole("button", { name: "Reset Grok provider settings", exact: true }).click();
  expect(mocks.update).not.toHaveBeenCalled();
});
