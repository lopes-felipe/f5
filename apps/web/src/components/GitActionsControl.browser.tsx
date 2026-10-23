import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => {
  const suggestedMessage =
    "Review this generated subject\n\nKeep the entire generated body for inspection.";
  return {
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
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
}));
vi.mock("../nativeApi", () => {
  const api = {
    git: {
      status: async () => ({
        branch: "feature/test",
        hasWorkingTreeChanges: true,
        workingTree: {
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

import GitActionsControl from "./GitActionsControl";
import { ToastProvider } from "./ui/toast";

describe("commit context changed", () => {
  it("offers the entire suggestion for review without dispatching another action", async () => {
    fixture.run.mockClear();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <GitActionsControl gitCwd="/project" activeThreadId={null} isServerThread />
        </ToastProvider>
      </QueryClientProvider>,
    );
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
      expect(fixture.run).toHaveBeenCalledTimes(1);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(fixture.run).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      client.clear();
    }
  });
});
