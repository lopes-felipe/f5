import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PullRequestKey, type TrackedPullRequest } from "@t3tools/contracts";
import { PrDescription } from "./PrDescription";

const api = vi.hoisted(() => ({
  prepareOperation: vi.fn(),
  submitOperation: vi.fn(),
  getOperation: vi.fn(),
  recoverOperation: vi.fn(),
  cancelOperation: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
vi.mock("../../lib/prHubAccount", () => ({
  getPrHubAccountGeneration: () => "account",
  getPrHubSelectedAccountId: () => "account",
  getPrHubDraftIdentity: () => "account",
}));
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  api.getOperation.mockResolvedValue(null);
});
const pr = {
  key: PullRequestKey.makeUnsafe("github:github.com/team/repo#7"),
  provider: "github",
  host: "github.com",
  headRefOid: "head",
} as TrackedPullRequest;

it("shows rapid clicks immediately and saves bodies in click order", async () => {
  let release!: (value: { status: string }) => void;
  api.prepareOperation.mockResolvedValue({ status: "prepared" });
  api.submitOperation
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ status: "succeeded" });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrDescription pr={pr} body={"- [ ] first\n- [ ] second"} canEdit />
    </QueryClientProvider>,
  );
  const tasks = page.getByRole("checkbox");
  await tasks.nth(0).click();
  await tasks.nth(1).click();
  await expect.element(tasks.nth(0)).toBeChecked();
  await expect.element(tasks.nth(1)).toBeChecked();
  expect(api.prepareOperation).toHaveBeenCalledTimes(1);
  expect(api.prepareOperation.mock.calls[0]![0].payload.body).toBe("- [x] first\n- [ ] second");
  release({ status: "succeeded" });
  await vi.waitFor(() => expect(api.prepareOperation).toHaveBeenCalledTimes(2));
  expect(api.prepareOperation.mock.calls[1]![0].payload.body).toBe("- [x] first\n- [x] second");
});

it("leaves task checkboxes disabled without edit permission", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrDescription pr={pr} body="- [ ] first" canEdit={false} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("checkbox")).toBeDisabled();
});

it("shows failed saves and restores the last confirmed description", async () => {
  api.prepareOperation.mockResolvedValue({ status: "prepared" });
  api.submitOperation.mockRejectedValue(new Error("Forge unavailable"));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrDescription pr={pr} body="- [ ] first" canEdit />
    </QueryClientProvider>,
  );
  await page.getByRole("checkbox").click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Forge unavailable");
  await expect.element(page.getByRole("checkbox")).not.toBeChecked();
});

it("keeps the saved operation reachable and recovers an uncertain checkbox save", async () => {
  api.prepareOperation.mockResolvedValue({ status: "prepared" });
  const operation = {
    status: "outcome_unknown",
    operationId: "saved-op",
    accountGeneration: "account",
    key: pr.key,
    expectedHeadOid: "head",
    payload: { kind: "edit", body: "- [x] first" },
  };
  api.submitOperation.mockResolvedValue(operation);
  api.getOperation.mockResolvedValue(operation);
  api.recoverOperation.mockResolvedValue({ ...operation, status: "succeeded" });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrDescription pr={pr} body="- [ ] first" canEdit />
    </QueryClientProvider>,
  );
  await page.getByRole("checkbox").click();
  await expect.element(page.getByText("Saved operation: outcome unknown")).toBeInTheDocument();
  await page.getByRole("button", { name: "Check saved operation" }).click();
  await vi.waitFor(() =>
    expect(api.recoverOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "saved-op" }),
    ),
  );
  await expect.element(page.getByRole("checkbox")).toBeEnabled();
  await expect.element(page.getByRole("checkbox")).toBeChecked();
});

it("allows editing again after a failed preparation is confirmed absent", async () => {
  api.prepareOperation
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue({ status: "prepared" });
  api.submitOperation.mockResolvedValue({ status: "succeeded" });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrDescription pr={pr} body="- [ ] first" canEdit />
    </QueryClientProvider>,
  );
  await page.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Retry description editing" }).click();
  await page.getByRole("checkbox").click();
  await vi.waitFor(() => expect(api.submitOperation).toHaveBeenCalledTimes(1));
  await expect.element(page.getByRole("checkbox")).toBeChecked();
});
it("retries a failed operation lookup without discarding the saved identity", async () => {
  api.prepareOperation.mockRejectedValue(new Error("Offline"));
  api.getOperation.mockRejectedValueOnce(new Error("Lookup offline")).mockResolvedValue(null);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrDescription pr={pr} body="- [ ] first" canEdit />
    </QueryClientProvider>,
  );
  await page.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Retry operation lookup" }).click();
  await page.getByRole("button", { name: "Retry description editing" }).click();
  await expect.element(page.getByRole("checkbox")).toBeEnabled();
});
