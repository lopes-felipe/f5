import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ProviderInstanceId,
  PullRequestKey,
  type PullRequestReviewGuideResult,
  type PrHubFilesPage,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PrReviewGuideTab } from "./PrReviewGuideTab";

const api = vi.hoisted(() => ({
  getReviewGuide: vi.fn(),
  generateReviewGuide: vi.fn(),
  getFiles: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#7");
const timestamp = "2026-10-19T12:00:00.000Z";
const saved: PullRequestReviewGuideResult = {
  currentHeadSha: "head",
  run: null,
  guide: {
    headSha: "head",
    generatedAt: timestamp,
    modelSelection: { instanceId: ProviderInstanceId.makeUnsafe("codex"), model: "guide-model" },
    stops: [
      {
        title: "Contract",
        summary: "Check the changed boundary",
        attention: { kind: "contract", note: "Keep compatibility" },
        excerpts: [{ path: "a.ts", side: "new", start: 1, end: 1, caption: "Changed contract" }],
        files: [],
        notes: [],
        questions: ["Is the boundary preserved?"],
      },
      {
        title: "Other files",
        summary: "Skim remaining files",
        attention: null,
        excerpts: [],
        files: [{ path: "docs.md" }],
        notes: [],
        questions: [],
      },
    ],
  },
};
const files: PrHubFilesPage = {
  files: [
    {
      path: "a.ts",
      additions: 1,
      deletions: 1,
      changeType: "changed",
      patch: "@@ -1 +1 @@\n-old\n+new-contract\n",
    },
  ],
  comparison: {
    mode: "current_pr",
    baseRepository: "org/repo",
    headRepository: "org/repo",
    baseRef: "main",
    headRef: "topic",
    baseOid: "base",
    headOid: "head",
    mergeBaseOid: "base",
  },
  pageInfo: { hasNextPage: false, endCursor: null, truncated: false },
  stale: false,
  refreshedAt: timestamp,
};
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  api.getReviewGuide.mockReset().mockResolvedValue(saved);
  api.generateReviewGuide.mockReset();
  api.getFiles.mockReset().mockResolvedValue(files);
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
      <PrReviewGuideTab pr={{ key, headRefOid: "head" }} />
    </QueryClientProvider>,
  );
}
it("renders validated excerpts and moves through the review stops", async () => {
  await mount();
  await expect.element(page.getByText("1  new-contract", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next stop", exact: true }).click();
  await expect
    .element(page.getByRole("article", { name: "Other files", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Next stop", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous stop", exact: true }).click();
  await expect.element(page.getByRole("article", { name: "Contract", exact: true })).toBeVisible();
});
it("hides excerpts when either the PR head or loaded diff changes", async () => {
  api.getFiles.mockResolvedValue({
    ...files,
    comparison: { ...files.comparison, headOid: "new-head" },
  });
  await mount();
  await expect
    .element(page.getByText("Excerpt hidden because the PR head changed.", { exact: true }))
    .toBeVisible();
  expect(page.getByText("1  new-contract", { exact: true }).query()).toBeNull();
});
it("polls a server-owned running job until the guide is ready", async () => {
  api.getReviewGuide
    .mockResolvedValueOnce({ guide: null, run: null, currentHeadSha: "head" })
    .mockResolvedValue(saved);
  api.generateReviewGuide.mockResolvedValue({
    guide: null,
    run: { _tag: "Running", headSha: "head", startedAt: timestamp },
    currentHeadSha: "head",
  });
  await mount();
  await page.getByRole("button", { name: "Generate guide", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Generating guide…", exact: true }))
    .toBeDisabled();
  await expect.element(page.getByText("1  new-contract", { exact: true })).toBeVisible();
});
it("retries failed loads and preserves an existing tour when regeneration fails", async () => {
  api.getReviewGuide.mockRejectedValueOnce(new Error("private detail")).mockResolvedValue(saved);
  api.generateReviewGuide.mockRejectedValue(new Error("private token"));
  await mount();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Regenerate guide", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not start guide generation. Try again.");
  await expect.element(page.getByText("1  new-contract", { exact: true })).toBeVisible();
  expect(page.getByText("private token", { exact: true }).query()).toBeNull();
});
