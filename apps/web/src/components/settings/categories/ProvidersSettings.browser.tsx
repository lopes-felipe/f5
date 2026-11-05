import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { ProviderDriverKind, ProviderInstanceId, type UnifiedSettings } from "@t3tools/contracts";
import type { ProviderInstanceCard } from "../ProviderInstanceCard";
import type { ComponentProps } from "react";
import { ProvidersSettings } from "./ProvidersSettings";

const mocks = vi.hoisted(() => ({ update: vi.fn(), confirm: vi.fn() }));
const initialSettings = (): UnifiedSettings => ({
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: {
    [ProviderInstanceId.make("codex")]: {
      driver: ProviderDriverKind.make("codex"),
      config: { binaryPath: "/opt/codex" },
    },
    [ProviderInstanceId.make("grok")]: { driver: ProviderDriverKind.make("grok"), enabled: true },
    [ProviderInstanceId.make("custom")]: {
      driver: ProviderDriverKind.make("codex"),
      displayName: "Custom",
    },
  },
});
let settings = initialSettings();
vi.mock("../../../hooks/useSettings", () => ({
  useSettings: () => settings,
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
      <output data-favorites={props.instanceId}>{props.favoriteModels.join(",")}</output>
      <button
        onClick={() =>
          props.onFavoriteModelsChange(
            props.favoriteModels.includes("gpt-5.4")
              ? props.favoriteModels.filter((model) => model !== "gpt-5.4")
              : [...props.favoriteModels, "gpt-5.4"],
          )
        }
      >
        Toggle gpt-5.4 on {props.instanceId}
      </button>
    </div>
  ),
}));
vi.mock("../AddProviderInstanceDialog", () => ({ AddProviderInstanceDialog: () => null }));

beforeEach(() => {
  settings = initialSettings();
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
    await act(async () => {});
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
  await act(async () => {});
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.update).not.toHaveBeenCalled();
});

it.each(["Reset Codex provider settings", "Delete custom"])(
  "preserves changes made while confirming %s",
  async (name) => {
    let confirm!: (value: boolean) => void;
    mocks.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const queryClient = new QueryClient();
    const panel = () => (
      <QueryClientProvider client={queryClient}>
        <ProvidersSettings />
      </QueryClientProvider>
    );
    const screen = await render(panel());
    await screen.getByRole("button", { name, exact: true }).click();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    const added = {
      providerInstances: {
        ...settings.providerInstances,
        added: { driver: ProviderDriverKind.make("codex") },
      },
      providerModelPreferences: { added: { hiddenModels: [], modelOrder: ["new-model"] } },
      dismissedProviderUpdateAdvisories: { added: "1.2.3" },
      favorites: [{ provider: ProviderInstanceId.make("added"), model: "new-model" }],
      providers: {
        ...settings.providers,
        grok: { ...settings.providers.grok, binaryPath: "/new/grok" },
      },
    };
    settings = { ...settings, ...added };
    await screen.rerender(panel());
    await act(async () => confirm(true));
    const patch = mocks.update.mock.calls[0]![0];
    expect(patch.providerInstances.added).toEqual(added.providerInstances.added);
    expect(patch.providerModelPreferences).toEqual(added.providerModelPreferences);
    expect(patch.favorites).toEqual(added.favorites);
    if (name.startsWith("Reset")) expect(patch.providers.grok).toEqual(added.providers.grok);
    else
      expect(patch.dismissedProviderUpdateAdvisories).toEqual(
        added.dismissedProviderUpdateAdvisories,
      );
  },
);

it("keeps pinned-effort presets and their order when another model is toggled", async () => {
  const codex = ProviderInstanceId.make("codex");
  const custom = ProviderInstanceId.make("custom");
  const presets = [
    { provider: codex, model: "gpt-5.5", effort: "high" },
    { provider: custom, model: "gpt-5.2" },
    { provider: codex, model: "gpt-5.5", effort: "xhigh" },
  ];
  settings = { ...settings, favorites: presets };
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <ProvidersSettings />
    </QueryClientProvider>,
  );
  // A model with two presets is a single favorite in Settings.
  expect(document.querySelector('[data-favorites="codex"]')?.textContent).toBe("gpt-5.5");

  await screen.getByRole("button", { name: "Toggle gpt-5.4 on codex", exact: true }).click();
  expect(mocks.update).toHaveBeenLastCalledWith({
    favorites: [...presets, { provider: codex, model: "gpt-5.4" }],
  });

  settings = { ...settings, favorites: [...presets, { provider: codex, model: "gpt-5.4" }] };
  await screen.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ProvidersSettings />
    </QueryClientProvider>,
  );
  await screen.getByRole("button", { name: "Toggle gpt-5.4 on codex", exact: true }).click();
  expect(mocks.update).toHaveBeenLastCalledWith({ favorites: presets });
});
