import "../../index.css";

import type {
  GitListBranchesResult,
  OrchestrationStartImplementationInput,
  PlanningWorkflow,
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useStore } from "../../store";

const nativeApiMocks = vi.hoisted(() => ({
  startImplementation: vi.fn<(input: OrchestrationStartImplementationInput) => Promise<void>>(
    async () => undefined,
  ),
  listBranches: vi.fn<() => Promise<GitListBranchesResult>>(async () => ({
    branches: [
      { name: "main", isRemote: false, current: true, isDefault: true, worktreePath: null },
      { name: "develop", isRemote: false, current: false, isDefault: false, worktreePath: null },
      {
        name: "feature/foo",
        isRemote: false,
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ] as unknown as GitListBranchesResult["branches"],
    isRepo: true,
    hasOriginRemote: true,
  })),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      startImplementation: nativeApiMocks.startImplementation,
    },
  }),
  ensureNativeApi: () => ({
    git: {
      listBranches: nativeApiMocks.listBranches,
    },
  }),
}));

vi.mock("../../appSettings", async () => {
  const actual = await vi.importActual<typeof import("../../appSettings")>("../../appSettings");
  const settings = {
    ...actual.parsePersistedAppSettings(null),
    customCodexModels: [],
    customClaudeModels: [],
  };
  return {
    ...actual,
    useAppSettings: () => ({
      settings,
      updateSettings: () => {},
    }),
  };
});

import { WorkflowImplementDialog } from "./WorkflowImplementDialog";

const PROJECT_ID = "project-1" as ProjectId;
const NOW = "2026-04-17T00:00:00.000Z";

function makeWorkflow(): PlanningWorkflow {
  return {
    id: "workflow-1" as PlanningWorkflowId,
    projectId: PROJECT_ID,
    title: "Workflow",
    slug: "workflow",
    requirementPrompt: "Implement the plan",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: {
      branchId: "a",
      authorSlot: { provider: "codex", model: "gpt-5-codex" },
      authorThreadId: "thread-a" as ThreadId,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "revised",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    branchB: {
      branchId: "b",
      authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      authorThreadId: "thread-b" as ThreadId,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "revised",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: "merge-thread" as ThreadId,
      outputFilePath: "plans/workflow-merged.md",
      turnId: "merge-turn",
      approvedPlanId: "approved-plan",
      status: "manual_review",
      error: null,
      updatedAt: NOW,
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

describe("WorkflowImplementDialog", () => {
  beforeEach(() => {
    useStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          name: "Project",
          cwd: "/repo/project",
          model: "gpt-5",
          createdAt: NOW,
          expanded: true,
          scripts: [],
          memories: [],
        },
      ],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threadsHydrated: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    nativeApiMocks.startImplementation.mockClear();
    nativeApiMocks.listBranches.mockClear();
    useStore.setState({
      projects: [],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threadsHydrated: false,
    });
  });

  it("submits with envMode=local by default", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const workflow = makeWorkflow();
    const screen = await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkflowImplementDialog open workflow={workflow} onOpenChange={() => {}} />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: "Start implementation" }).click();

      await vi.waitFor(() => {
        expect(nativeApiMocks.startImplementation).toHaveBeenCalledTimes(1);
      });

      const payload = nativeApiMocks.startImplementation.mock.calls[0]?.[0];
      expect(payload?.envMode).toBe("local");
      expect(payload?.baseBranch).toBeUndefined();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("disables Start implementation in New worktree mode until a branch is chosen", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const workflow = makeWorkflow();
    const screen = await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkflowImplementDialog open workflow={workflow} onOpenChange={() => {}} />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: "New worktree" }).click();

      await vi.waitFor(() => {
        const startButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (element) => element.textContent?.trim() === "Start implementation",
        );
        expect(startButton?.disabled).toBe(true);
      });

      await vi.waitFor(() => {
        // The dialog renders a short hint beneath the worktree picker as long
        // as no branch is chosen ("Select a base branch before sending."). The
        // longer "in New worktree mode." suffix is only shown as an error
        // after a submit attempt; we just need to confirm the gating hint is
        // visible and the submit button is disabled.
        expect(document.body.textContent ?? "").toContain("Select a base branch before sending.");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("submits envMode=worktree with the selected base branch", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const workflow = makeWorkflow();
    const screen = await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkflowImplementDialog open workflow={workflow} onOpenChange={() => {}} />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: "New worktree" }).click();

      await vi.waitFor(() => {
        expect(nativeApiMocks.listBranches).toHaveBeenCalled();
      });

      await vi.waitFor(() => {
        const trigger = document.querySelector<HTMLButtonElement>(
          '[data-testid="workflow-implement-base-branch-trigger"]',
        );
        expect(trigger).not.toBeNull();
        expect(trigger?.disabled).toBe(false);
      });

      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-implement-base-branch-trigger"]',
      );
      trigger?.click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("develop");
      });

      const developOption = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((element) => element.textContent?.trim() === "develop");
      expect(developOption).toBeDefined();
      developOption?.click();

      await vi.waitFor(() => {
        const startButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (element) => element.textContent?.trim() === "Start implementation",
        );
        expect(startButton?.disabled).toBe(false);
      });

      await page.getByRole("button", { name: "Start implementation" }).click();

      await vi.waitFor(() => {
        expect(nativeApiMocks.startImplementation).toHaveBeenCalledTimes(1);
      });

      const payload = nativeApiMocks.startImplementation.mock.calls[0]?.[0];
      expect(payload?.envMode).toBe("worktree");
      expect(payload?.baseBranch).toBe("develop");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
