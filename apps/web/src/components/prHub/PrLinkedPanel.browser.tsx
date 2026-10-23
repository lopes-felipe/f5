import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, type TrackedPullRequest } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import PrLinkedPanel from "./PrLinkedPanel";
import { getPrHubAccountGeneration, setPrHubAccount } from "../../lib/prHubAccount";
const api = vi.hoisted(() => ({ getOverview: vi.fn(), track: vi.fn(), openExternal: vi.fn() }));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
// The shared detail form has separate native action/browser coverage. Observe admission here.
vi.mock("./PrDetailPanel", () => ({
  PrDetailPanel: ({
    pr,
    confirmationMode,
  }: {
    pr: TrackedPullRequest;
    confirmationMode: string;
  }) => (
    <p>
      {pr.title} · {confirmationMode}
    </p>
  ),
}));
const url = "https://github.com/org/repo/pull/7";
let active: Awaited<ReturnType<typeof render>> | undefined;
let client: QueryClient;
const account = (generation: string) => ({ host: "github.com", viewerId: "42", generation });
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPrHubAccount(account("gen-1"));
  api.getOverview.mockImplementation(async () => ({
    account: account(getPrHubAccountGeneration()!),
  }));
  api.track.mockResolvedValue({ key: "github:github.com/org/repo#7", title: "Verified PR" });
  window.desktopBridge = { openExternal: api.openExternal } as never;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  client.clear();
  localStorage.clear();
  setPrHubAccount(undefined);
  delete window.desktopBridge;
});
async function mount() {
  active = await render(
    <QueryClientProvider client={client}>
      <PrLinkedPanel url={url} threadId={ThreadId.makeUnsafe("owner")} />
    </QueryClientProvider>,
  );
}
it("loads a verified PR for inline review and keeps the system-browser escape available", async () => {
  await mount();
  await expect.element(page.getByText("Verified PR · inline")).toBeVisible();
  expect(api.track).toHaveBeenCalledExactlyOnceWith({ url, accountGeneration: "gen-1" });
  await page.getByRole("button", { name: "Open on forge", exact: true }).click();
  expect(api.openExternal).toHaveBeenCalledExactlyOnceWith(url);
});
it("offers retry for a failed read without submitting a remote action", async () => {
  api.track.mockRejectedValueOnce(new Error("Forge read unavailable"));
  await mount();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Forge read unavailable");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.element(page.getByText("Verified PR · inline")).toBeVisible();
  expect(api.track).toHaveBeenCalledTimes(2);
});
it("discards a tracked response if the account changes during its read", async () => {
  let resolveOld!: (value: unknown) => void;
  api.track
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue({ key: "github:github.com/org/repo#7", title: "Current account PR" });
  await mount();
  await expect.poll(() => api.track.mock.calls.length).toBe(1);
  setPrHubAccount(account("gen-2"));
  resolveOld({ key: "github:github.com/org/repo#7", title: "Old account PR" });
  await expect.element(page.getByText("Current account PR · inline")).toBeVisible();
  expect(page.getByText("Old account PR · inline").query()).toBeNull();
  expect(api.track).toHaveBeenLastCalledWith({ url, accountGeneration: "gen-2" });
});
