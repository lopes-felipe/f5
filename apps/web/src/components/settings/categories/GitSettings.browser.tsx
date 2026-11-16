import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { AppSettingsSchema } from "../../../appSettings";
import { serverQueryKeys } from "../../../lib/serverReactQuery";
import { toastManager } from "../../ui/toast";
import { GitSettings } from "./GitSettings";

const mocks = vi.hoisted(() => ({ update: vi.fn(), updateLocal: vi.fn() }));
vi.mock("../../../nativeApi", () => ({
  ensureNativeApi: () => ({ server: { updateSettings: mocks.update } }),
}));
vi.mock("../../../hooks/useSettings", () => ({
  useSettings: (select?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    select ? select(DEFAULT_UNIFIED_SETTINGS) : DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: mocks.updateLocal }),
}));
vi.mock("../SettingsRouteContext", () => ({
  useSettingsRouteContext: () => ({
    settings: AppSettingsSchema.makeUnsafe({ enableGitStatusAutoRefresh: true }),
    defaults: AppSettingsSchema.makeUnsafe({}),
    updateSettings: mocks.updateLocal,
    gitTextGenerationModelOptions: [],
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: () => null,
}));
vi.mock("../ReviewGuideSettings", () => ({ ReviewGuideSettings: () => null }));
vi.mock("../ThreadSettlementSettings", () => ({ ThreadSettlementSettings: () => null }));
vi.mock("../WorktreeDisposablePathsEditor", () => ({ WorktreeDisposablePathsEditor: () => null }));

it("defers real Git and PR Hub interval writes and restores a rejected PR Hub save", async () => {
  mocks.update.mockRejectedValue(new Error("Offline"));
  mocks.updateLocal.mockResolvedValue(undefined);
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(serverQueryKeys.config(), {
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS,
      prHub: { ...DEFAULT_UNIFIED_SETTINGS.prHub, pollIntervalSeconds: 180 },
    },
    providers: [],
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <GitSettings />
    </QueryClientProvider>,
  );
  const git = screen.getByRole("spinbutton", { name: "Git auto-refresh interval in seconds" });
  await git.fill("120");
  expect(mocks.updateLocal).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(mocks.updateLocal).toHaveBeenCalledWith({ gitStatusAutoRefreshIntervalSeconds: 120 });
  const prHub = screen.getByRole("spinbutton", { name: "PR Hub refresh interval in seconds" });
  await prHub.fill("300");
  expect(mocks.update).not.toHaveBeenCalled();
  await userEvent.tab();
  await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
  // Only the changed field is sent, so a second save in flight cannot write old values back.
  expect(mocks.update).toHaveBeenCalledWith({ prHub: { pollIntervalSeconds: 300 } });
  await expect.element(prHub).toHaveValue(180);
  await prHub.fill("300");
  await userEvent.tab();
  await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
});

it("keeps team text typed while a save is in flight and reports a failed save", async () => {
  mocks.update.mockReset();
  mocks.updateLocal.mockResolvedValue(undefined);
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const config = (directReviewTeams: string[]) => ({
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS,
      prHub: { ...DEFAULT_UNIFIED_SETTINGS.prHub, directReviewTeams },
    },
    providers: [],
  });
  queryClient.setQueryData(serverQueryKeys.config(), config([]));
  let land: (settings: unknown) => void = () => {};
  mocks.update.mockImplementationOnce(
    () => new Promise((resolve) => (land = resolve as typeof land)),
  );
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <GitSettings />
    </QueryClientProvider>,
  );
  const teams = screen.getByRole("textbox", { name: "Teams whose review requests are mine" });
  await teams.fill("@octo/platform");
  await userEvent.tab();
  await vi.waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({
      prHub: { directReviewTeams: ["octo/platform"] },
    }),
  );
  // The user goes on typing before the first save answers.
  await teams.fill("octo/platform\nocto/data");
  land(config(["octo/platform"]).settings);
  await expect.element(teams).toHaveValue("octo/platform\nocto/data");

  mocks.update.mockRejectedValue(new Error("Offline"));
  const toast = vi.spyOn(toastManager, "add");
  await teams.click();
  await userEvent.tab();
  await vi.waitFor(() =>
    expect(mocks.update).toHaveBeenLastCalledWith({
      prHub: { directReviewTeams: ["octo/platform", "octo/data"] },
    }),
  );
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not save pull request settings",
      description: "Offline",
    }),
  );
  // The draft is still there to retry.
  await expect.element(teams).toHaveValue("octo/platform\nocto/data");
});
