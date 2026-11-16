import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_UNIFIED_SETTINGS, type ModelSelection } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { TooltipProvider } from "../ui/tooltip";
import { ReviewGuideSettings } from "./ReviewGuideSettings";

const state = vi.hoisted(() => ({ selection: null as ModelSelection | null, update: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ ...DEFAULT_UNIFIED_SETTINGS, reviewGuideModelSelection: state.selection }),
  useUpdateSettings: () => ({ updateSettings: state.update }),
}));
vi.mock("./SettingsRouteContext", () => ({
  useSettingsRouteContext: () => ({ selectedProject: null }),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ server: { getConfig: async () => ({ providers: [] }) } }),
}));
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  state.selection = null;
  state.update.mockReset().mockImplementation(async (patch) => {
    state.selection = patch.reviewGuideModelSelection;
  });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
async function mount() {
  active = await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <ReviewGuideSettings />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
it("uses the git model by default and persists a nullable custom override", async () => {
  await mount();
  const toggle = page.getByRole("switch", {
    name: "Use git text generation model for review guides",
  });
  await expect.element(toggle).toBeChecked();
  await toggle.click();
  await expect
    .poll(() => state.selection)
    .toEqual(DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection);
  await expect.element(toggle).not.toBeChecked();
  await toggle.click();
  await expect.poll(() => state.selection).toBeNull();
  await expect.element(toggle).toBeChecked();
});
it("preserves the stored model after a failed save and allows retry", async () => {
  state.update.mockRejectedValueOnce(new Error("private storage details"));
  await mount();
  const toggle = page.getByRole("switch", {
    name: "Use git text generation model for review guides",
  });
  await toggle.click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not save review guide settings. Try again.");
  await expect.element(toggle).toBeChecked();
  await toggle.click();
  await expect
    .poll(() => state.selection)
    .toEqual(DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection);
  expect(page.getByText("private storage details", { exact: true }).query()).toBeNull();
});
