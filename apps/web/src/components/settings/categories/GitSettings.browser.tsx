import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { AppSettingsSchema } from "../../../appSettings";
import { serverQueryKeys } from "../../../lib/serverReactQuery";
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
      prHub: { pollIntervalSeconds: 180, excludeRepos: [] },
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
  expect(mocks.update).toHaveBeenCalledWith({
    prHub: { pollIntervalSeconds: 300, excludeRepos: [] },
  });
  await expect.element(prHub).toHaveValue(180);
  await prHub.fill("300");
  await userEvent.tab();
  await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
});
