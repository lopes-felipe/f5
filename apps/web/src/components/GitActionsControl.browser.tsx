import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => {
  const suggestedMessage =
    "Review this generated subject\n\nKeep the entire generated body for inspection.";
  return {
    hasWorkingTreeChanges: true,
    // Replaces the thread's resolved PRs when set.
    pullRequests: null as ReadonlyArray<ThreadPullRequestItem> | null,
    openEditor: vi.fn(async () => {}),
    suggestedMessage,
    run: vi.fn(async () => ({
      action: "commit",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "context_changed",
        subject: "Review this generated subject",
        suggestedMessage,
      },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
    })),
  };
});
vi.mock("../appSettings", () => ({
  useAppSettings: () => ({
    settings: {
      gitStatusAutoRefreshIntervalSeconds: 0,
      textGenerationModel: null,
    },
  }),
}));
vi.mock("../hooks/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("../lib/threadPullRequests", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/threadPullRequests")>();
  return {
    ...original,
    resolveThreadPullRequests: (input: Parameters<typeof original.resolveThreadPullRequests>[0]) =>
      fixture.pullRequests ? [...fixture.pullRequests] : original.resolveThreadPullRequests(input),
  };
});
vi.mock("../editorPreferences", () => ({ openInPreferredEditor: fixture.openEditor }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
}));
vi.mock("../nativeApi", () => {
  const api = {
    git: {
      status: async () => ({
        branch: "feature/test",
        hasWorkingTreeChanges: fixture.hasWorkingTreeChanges,
        workingTree: {
          rootPath: "/repo",
          files: [{ path: "README.md", insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
      listBranches: async () => ({
        isRepo: true,
        hasOriginRemote: false,
        branches: [
          {
            name: "feature/test",
            current: true,
            isRemote: false,
            isDefault: false,
            worktreePath: null,
          },
        ],
      }),
      runStackedAction: fixture.run,
      onActionProgress: () => () => {},
    },
  };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});

import type { ThreadPullRequestItem } from "../lib/threadPullRequests";
import GitActionsControl from "./GitActionsControl";
import { ToastProvider } from "./ui/toast";

function linkedPullRequest(number: number): ThreadPullRequestItem {
  return {
    key: `github:github.com/acme/repo#${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/repo/pull/${number}`,
    repository: "acme/repo",
    state: "open",
    source: "link",
    linked: true,
    ref: null,
  };
}

async function renderControl(children?: (control: ReactNode) => ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const control = <GitActionsControl gitCwd="/repo/nested" activeThreadId={null} isServerThread />;
  const screen = await render(
    <QueryClientProvider client={client}>
      <ToastProvider>{children ? children(control) : control}</ToastProvider>
    </QueryClientProvider>,
  );
  return {
    async cleanup() {
      await screen.unmount();
      client.clear();
    },
  };
}

describe("commit context changed", () => {
  it("offers the entire suggestion for review without dispatching another action", async () => {
    fixture.run.mockClear();
    const screen = await renderControl();
    try {
      const commit = page.getByRole("button", { name: "Commit", exact: true });
      await expect.element(commit).toBeEnabled();
      await commit.click();
      await expect
        .element(page.getByText("Files or staging changed", { exact: true }))
        .toBeVisible();
      expect(fixture.run).toHaveBeenCalledTimes(1);
      await page.getByRole("button", { name: "Review suggestion", exact: true }).click();
      await expect.element(page.getByRole("dialog", { name: "Commit changes" })).toBeVisible();
      await expect.element(page.getByRole("textbox")).toHaveValue(fixture.suggestedMessage);
      await page.getByRole("button", { name: /README.md/ }).click();
      expect(fixture.openEditor).toHaveBeenCalledWith(expect.anything(), "/repo/README.md");
      expect(fixture.run).toHaveBeenCalledTimes(1);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(fixture.run).toHaveBeenCalledTimes(1);
    } finally {
      await screen.cleanup();
    }
  });
});

describe("View PR with several linked PRs", () => {
  it("keeps the options chevron inside the track at its min-content width", async () => {
    fixture.hasWorkingTreeChanges = false;
    fixture.pullRequests = [linkedPullRequest(1), linkedPullRequest(2)];
    // Force the track to its min-content width (the suspected Electron sizing), where a label
    // that can wrap would push the chevron out.
    const screen = await renderControl((control) => (
      <div style={{ containerType: "inline-size", containerName: "header-actions", width: 768 }}>
        <div style={{ width: "min-content" }}>{control}</div>
      </div>
    ));
    try {
      await expect.element(page.getByRole("button", { name: "View PR (2)" })).toBeVisible();
      const track = page.getByRole("group", { name: "Git actions" }).element();
      const chevron = page.getByRole("button", { name: "Git action options" }).element();
      const label = page.getByText("View PR", { exact: true }).element();
      expect(label.getClientRects()).toHaveLength(1);
      expect(track.getBoundingClientRect().right).toBeGreaterThanOrEqual(
        chevron.getBoundingClientRect().right - 0.5,
      );
    } finally {
      await screen.cleanup();
      fixture.hasWorkingTreeChanges = true;
      fixture.pullRequests = null;
    }
  });
});
