import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, PullRequestKey, type TrackedPullRequest } from "@t3tools/contracts";
import { PrMarkdown } from "./PrMarkdown";
import { PrSendToAgent } from "./PrSendToAgent";
import { useComposerDraftStore } from "../../composerDraftStore";
import { WsRequestError } from "../../wsTransport";
import { OpenLinkThread } from "../../hooks/useOpenLink";
import { useRightPanelStore } from "../../rightPanelStore";
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
it.each([
  ["github", true],
  ["forgejo", true],
  ["azure-devops", true],
  ["gitlab", false],
  ["bitbucket", false],
] as const)(
  "%s follows the forge's single-newline rendering rule",
  async (provider, hardLineBreaks) => {
    const screen = await render(
      <PrMarkdown host="forge.example" provider={provider} body={"first\nsecond"} />,
    );
    await expect.element(page.getByText(/first/)).toBeVisible();
    expect(document.querySelectorAll("p br").length).toBe(hardLineBreaks ? 1 : 0);
    await screen.unmount();
  },
);
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
  await focusPreview();
  await expect.element(page.getByText("Pinned PR", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Open", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  expect(document.querySelector('[aria-label="CI passed"]')).toBeNull();
  await page.getByRole("button", { name: "Copy link" }).click();
  expect(api.dispatchCommand).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Pinned PR", { exact: true })).not.toBeInTheDocument();
});

it("tabs into the preview actions and back to the surrounding page", async () => {
  await renderPreview();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("link", { name: "Linked PR" })).toHaveFocus();
  await expect.element(page.getByText("Pinned PR", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("button", { name: "Copy link" })).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.element(page.getByRole("link", { name: "Linked PR" })).toHaveFocus();
  await userEvent.keyboard("{Tab}{Tab}");
  await expect.element(page.getByRole("button", { name: "Open on github.com" })).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("button", { name: "After preview" })).toHaveFocus();
});

function renderPreview(url = "https://github.com/team/repo/pull/7") {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PrMarkdown host="github.com" body={"[Linked PR](" + url + ")"} />
      <button type="button">After preview</button>
    </QueryClientProvider>,
  );
}

it("prefetches only when the pointer rests on the link", async () => {
  await renderPreview();
  const link = page.getByRole("link", { name: "Linked PR" });
  const element = link.element();
  element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  element.dispatchEvent(
    new PointerEvent("pointerout", {
      bubbles: true,
      pointerType: "mouse",
      relatedTarget: document.body,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(api.peek).not.toHaveBeenCalled();
  await link.hover();
  await expect.poll(() => api.peek.mock.calls.length).toBe(1);
});

it("does not open instantly on mouse focus", async () => {
  await renderPreview();
  await page.getByRole("link", { name: "Linked PR" }).click();
  expect(document.querySelector('[aria-label="Pull request preview"]')).toBeNull();
});

it("uses a readable fallback and the server's reference for unusual URLs", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const value = await api.peek();
  api.peek.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useRightPanelStore.setState({ byThreadId: {}, closedHistory: [] });
  await render(
    <OpenLinkThread.Provider value={thread}>
      <QueryClientProvider client={new QueryClient()}>
        <PrMarkdown host="github.com" body="[Linked PR](/unusual/pull/7)" />
      </QueryClientProvider>
    </OpenLinkThread.Provider>,
  );
  await focusPreview();
  await expect.element(page.getByText("Pull request preview", { exact: true })).toBeVisible();
  finish?.(value);
  await page.getByRole("button", { name: "Open in F5" }).click();
  expect(useRightPanelStore.getState().byThreadId[thread]).toMatchObject({
    activeSurfaceId: "pr:github:github.com/team/repo#7",
    surfaces: [expect.objectContaining({ url: value.url })],
  });
});

async function focusPreview() {
  await userEvent.keyboard("{ArrowRight}");
  page.getByRole("link", { name: "Linked PR" }).element().focus();
}

it("shows the URL header and usable actions while the preview loads", async () => {
  api.peek.mockImplementation(() => new Promise(() => {}));
  await renderPreview();
  await focusPreview();
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
  await focusPreview();
  await expect.poll(() => document.querySelector('[aria-label="CI passed"]')).not.toBeNull();
  await expect
    .poll(() => document.querySelector('[aria-label="2 unresolved threads"]'))
    .not.toBeNull();
});

it.each([
  [new Error("network"), "Preview unavailable"],
  [
    new WsRequestError("Connect an account before using PR Hub.", "PrHubAccountRequired"),
    "Connect a github.com account in PR Hub to preview this pull request.",
  ],
  [
    new WsRequestError(
      "Pull request provider or host does not match the selected account.",
      "PrHubAccountMismatch",
    ),
    "Select the account for this repository in PR Hub to preview this pull request.",
  ],
  [
    new WsRequestError("Account was not found.", "PrHubAccountChanged"),
    "Refresh PR Hub and select an account to preview this pull request.",
  ],
  [
    new WsRequestError("Forbidden", "PrHubAccessDenied"),
    "Your account does not have access to this pull request.",
  ],
])("keeps actions available on preview failure %s", async (error, message) => {
  api.peek.mockRejectedValue(error);
  await renderPreview();
  await focusPreview();
  await expect.element(page.getByText(message, { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
});

it.each(["merged", "closed"])("hides actionable status chips for %s PRs", async (state) => {
  const value = await api.peek();
  api.peek.mockResolvedValue({
    ...value,
    state,
    status: {
      checkRollup: "failure",
      reviewDecision: "approved",
      mergeable: "conflicting",
      unresolvedThreadCount: 0,
    },
  });
  await renderPreview();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByText("Pinned PR", { exact: true })).toBeVisible();
  expect(document.querySelector('[aria-label="CI failed"]')).toBeNull();
  expect(document.querySelector('[aria-label="Conflicts"]')).toBeNull();
});
