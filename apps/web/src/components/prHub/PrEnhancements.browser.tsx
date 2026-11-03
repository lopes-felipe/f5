import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, PullRequestKey, type TrackedPullRequest } from "@t3tools/contracts";
import { PrMarkdown } from "./PrMarkdown";
import { PrSendToAgent } from "./PrSendToAgent";
import { useComposerDraftStore } from "../../composerDraftStore";
const api = vi.hoisted(() => ({
  peek: vi.fn(),
  getThreadsForPr: vi.fn(),
  dispatchCommand: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ prHub: api, orchestration: { dispatchCommand: api.dispatchCommand } }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: api.navigate }),
}));
const thread = ThreadId.makeUnsafe("phase12-thread");
const pr = {
  key: PullRequestKey.makeUnsafe("github:github.com/team/repo#7"),
  provider: "github",
  host: "github.com",
  repository: { nameWithOwner: "team/repo" },
  number: 7,
  title: "Pinned PR",
  url: "https://github.com/team/repo/pull/7",
  headRefOid: "pinned-head",
} as TrackedPullRequest;
beforeEach(() => {
  vi.clearAllMocks();
  useComposerDraftStore.getState().clearDraftThread(thread);
  api.getThreadsForPr.mockResolvedValue([{ threadId: thread, title: "Linked thread" }]);
  api.navigate.mockResolvedValue(undefined);
  api.peek.mockResolvedValue({
    ...pr,
    repository: "team/repo",
    state: "open",
    author: "alice",
    isDraft: false,
    additions: 12,
    deletions: 3,
    createdAt: null,
    updatedAt: null,
    mergedAt: null,
  });
});
it("places a diff request in the existing composer once and preserves the draft without sending a turn", async () => {
  useComposerDraftStore.getState().setPrompt(thread, "Existing draft");
  render(<PrSendToAgent pr={pr} body="Handle the null case" path="src/file.ts" line={12} />);
  await page.getByRole("button", { name: "Send to agent", exact: true }).click();
  await expect.poll(() => api.navigate.mock.calls.length).toBe(1);
  const prompt = useComposerDraftStore.getState().draftsByThreadId[thread]?.prompt;
  expect(prompt).toContain("Existing draft");
  expect(prompt).toContain("Handle the null case");
  expect(prompt).toContain("src/file.ts");
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Send to agent", exact: true }).click();
  await expect.poll(() => api.navigate.mock.calls.length).toBe(2);
  expect(useComposerDraftStore.getState().draftsByThreadId[thread]?.prompt).toBe(prompt);
});
it("proxies authenticated UUID video HTML and images without enabling arbitrary raw HTML", async () => {
  render(
    <PrMarkdown
      host="github.com"
      body={
        '<video src="https://github.com/user-attachments/assets/uuid" controls></video>\n\n![Private](https://github.com/user-attachments/assets/image)\n\n<script>bad()</script>'
      }
    />,
  );
  await expect.poll(() => document.querySelector("video")).not.toBeNull();
  const video = document.querySelector("video");
  expect(video?.getAttribute("src")).toContain("/api/prhub/media?");
  expect(video?.getAttribute("src")).toContain("uuid");
  await expect
    .element(page.getByRole("img", { name: "Private" }))
    .toHaveAttribute("src", expect.stringContaining("/api/prhub/media?"));
  expect(
    [...document.querySelectorAll("script")].some((script) =>
      script.textContent?.includes("bad()"),
    ),
  ).toBe(false);
});
it("loads link previews on focus and exposes copy without submitting a write", async () => {
  await renderPreview();
  const link = page.getByRole("link", { name: "Linked PR" });
  await link.element().focus();
  await expect.element(page.getByText("Pinned PR", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Open", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  expect(document.querySelector('[aria-label="CI passed"]')).toBeNull();
  await page.getByRole("button", { name: "Copy link" }).click();
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Pinned PR", { exact: true })).not.toBeInTheDocument();
});

function renderPreview() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PrMarkdown host="github.com" body="[Linked PR](https://github.com/team/repo/pull/7)" />
    </QueryClientProvider>,
  );
}

it("shows the URL header and usable actions while the preview loads", async () => {
  api.peek.mockImplementation(() => new Promise(() => {}));
  await renderPreview();
  page.getByRole("link", { name: "Linked PR" }).element().focus();
  await expect.element(page.getByText("team/repo #7", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Open on github.com" })).toBeEnabled();
});

it("shows tracked status chips", async () => {
  const value = await api.peek();
  api.peek.mockResolvedValue({
    ...value,
    status: {
      checkRollup: "success",
      reviewDecision: "approved",
      mergeable: "mergeable",
      unresolvedThreadCount: 2,
    },
  });
  await renderPreview();
  page.getByRole("link", { name: "Linked PR" }).element().focus();
  await expect.poll(() => document.querySelector('[aria-label="CI passed"]')).not.toBeNull();
  await expect
    .poll(() => document.querySelector('[aria-label="2 unresolved threads"]'))
    .not.toBeNull();
});

it.each([
  [new Error("network"), "Preview unavailable"],
  [
    new Error("Link preview account mismatch."),
    "Connect a github.com account in PR Hub to preview this pull request.",
  ],
])("keeps actions available on preview failure %s", async (error, message) => {
  api.peek.mockRejectedValue(error);
  await renderPreview();
  page.getByRole("link", { name: "Linked PR" }).element().focus();
  await expect.element(page.getByText(message, { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
});
