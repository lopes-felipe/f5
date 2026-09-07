import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PullRequestKey, type PrHubReviewOperation } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PrReviewSubmit } from "./PrReviewSubmit";
import { PrCommentSubmit } from "./PrCommentSubmit";
const api = vi.hoisted(() => ({
  getReviewOperation: vi.fn(),
  getFiles: vi.fn(),
  prepareQuickReview: vi.fn(),
  submitReview: vi.fn(),
  cancelReviewPreparation: vi.fn(),
  getCommentOperation: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
vi.mock("../../lib/prHubAccount", () => ({ getPrHubAccountGeneration: () => "account" }));
const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#1");
const comparison = {
  baseRepository: "org/repo",
  baseRef: "main",
  baseOid: "base",
  headRepository: "org/repo",
  headRef: "topic",
  headOid: "head",
  mergeBaseOid: "base",
  mode: "current_pr" as const,
};
const operation = (body: string): PrHubReviewOperation => ({
  id: "prepared",
  payloadHash: "immutable",
  status: "prepared",
  remoteId: null,
  correlationNonce: "nonce",
  payload: {
    version: 2,
    source: "quick_review",
    event: "APPROVE",
    body: `${body}\n\n<!-- F5 review nonce -->`,
    draft: {
      version: 0,
      frozen: false,
      updatedAt: "2026-01-01T00:00:00Z",
      comparison,
      content: { body, comments: [], viewedFiles: [] },
    },
  },
});
it("does not submit a saved request-changes operation from an Approve dialog", async () => {
  api.getReviewOperation.mockResolvedValue({
    ...operation("Please fix"),
    payload: { ...operation("Please fix").payload, event: "REQUEST_CHANGES" },
  });
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <PrReviewSubmit
        prKey={key}
        prUrl="https://github.com/org/repo/pull/1"
        draft={null}
        disabled={false}
        onBusyChange={() => {}}
        quickEvent="APPROVE"
      />
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("another editor or review outcome");
  await expect
    .element(page.getByRole("button", { name: "Submit review to GitHub" }))
    .not.toBeInTheDocument();
});

it("retains an unsubmitted timeline comment when the dialog is reopened", async () => {
  api.getCommentOperation.mockResolvedValue(null);
  const client = new QueryClient();
  const editor = () => (
    <QueryClientProvider client={client}>
      <PrCommentSubmit prKey={key} />
    </QueryClientProvider>
  );
  const first = await render(editor());
  await page.getByRole("textbox", { name: "PR timeline comment" }).fill("Keep this unsent text");
  await first.unmount();
  await render(editor());
  await expect
    .element(page.getByRole("textbox", { name: "PR timeline comment" }))
    .toHaveValue("Keep this unsent text");
});
it("requires an immutable preview and cancellation before editing a quick review", async () => {
  api.getReviewOperation.mockResolvedValue(null);
  api.getFiles.mockResolvedValue({ comparison });
  api.prepareQuickReview.mockImplementation(async (input: { body: string }) =>
    operation(input.body),
  );
  api.cancelReviewPreparation.mockResolvedValue({
    ...operation("Looks good"),
    status: "failed_before_send",
  });
  api.submitReview.mockResolvedValue({ ...operation("Updated note"), status: "succeeded" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <PrReviewSubmit
        prKey={key}
        prUrl="https://github.com/org/repo/pull/1"
        draft={null}
        disabled={false}
        onBusyChange={() => {}}
        quickEvent="APPROVE"
      />
    </QueryClientProvider>,
  );
  await page.getByRole("textbox", { name: "Quick review note" }).fill("Looks good");
  await page.getByRole("button", { name: "Preview review", exact: true }).click();
  await expect
    .element(page.getByLabelText("Review submission preview"))
    .toHaveTextContent("<!-- F5 review nonce -->");
  expect(api.submitReview).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Back to draft" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Quick review note" }))
    .toHaveValue("Looks good");
  expect(api.cancelReviewPreparation).toHaveBeenCalledWith({
    key,
    accountGeneration: "account",
    id: "prepared",
  });
  await page.getByRole("textbox", { name: "Quick review note" }).fill("Updated note");
  await page.getByRole("button", { name: "Preview review", exact: true }).click();
  await page.getByRole("button", { name: "Submit review to GitHub" }).click();
  expect(api.submitReview).toHaveBeenCalledWith({
    key,
    accountGeneration: "account",
    id: "prepared",
    payloadHash: "immutable",
  });
  expect(api.prepareQuickReview.mock.calls[1]?.[0]).toMatchObject({
    body: "Updated note",
    event: "APPROVE",
    expectedComparison: comparison,
  });
});
