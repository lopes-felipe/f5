import "../../index.css";

import {
  defaultInstanceIdForDriver,
  type GitListBranchesResult,
  type OrchestrationStartImplementationInput,
  type PlanningWorkflow,
  type PlanningWorkflowId,
  type ProjectId,
  ProviderDriverKind,
  type ServerProvider,
  type ThreadId,
  type WorkflowModelSlot,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { serverQueryKeys } from "../../lib/serverReactQuery";
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
    customGrokModels: [],
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

function makeWorkflow(
  mergeSlot: WorkflowModelSlot = { provider: "codex", model: "gpt-5-codex" },
): PlanningWorkflow {
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
      errorStage: null,
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
      errorStage: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    merge: {
      mergeSlot,
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

function makeQueryClient(providers?: ReadonlyArray<ServerProvider>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(serverQueryKeys.config(), { providers });
  return queryClient;
}

function claudeProvider(version: string, models: ReadonlyArray<string>): ServerProvider {
  const driver = ProviderDriverKind.make("claudeAgent");
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    driver,
    enabled: true,
    installed: true,
    version,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-28T00:00:00.000Z",
    models: models.map((slug) => ({
      slug,
      name:
        slug === "claude-opus-5"
          ? "Claude Opus 5"
          : slug === "claude-fable-5"
            ? "Claude Fable 5"
            : slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
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
      investigationWorkflows: [],
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
      investigationWorkflows: [],
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

  it("does not reset selections when the open workflow prop identity changes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const workflow = makeWorkflow();
    const queryClient = makeQueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkflowImplementDialog open workflow={workflow} onOpenChange={() => {}} />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: "New worktree" }).click();

      await vi.waitFor(() => {
        const newWorktreeButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>("button"),
        ).find((element) => element.textContent?.trim() === "New worktree");
        expect(newWorktreeButton?.getAttribute("aria-pressed")).toBe("true");
      });

      await screen.rerender(
        <QueryClientProvider client={queryClient}>
          <WorkflowImplementDialog
            open
            workflow={{
              ...workflow,
              totalCostUsd: 0.25,
              updatedAt: "2026-04-17T00:01:00.000Z",
            }}
            onOpenChange={() => {}}
          />
        </QueryClientProvider>,
      );

      await vi.waitFor(() => {
        const newWorktreeButton = Array.from(
          document.querySelectorAll<HTMLButtonElement>("button"),
        ).find((element) => element.textContent?.trim() === "New worktree");
        expect(newWorktreeButton?.getAttribute("aria-pressed")).toBe("true");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("falls back from gated Opus 5 before submitting an implementation", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const workflow = makeWorkflow({
      provider: "claudeAgent",
      model: "opus-5[1m]",
      modelOptions: { claudeAgent: { fastMode: true } },
    });
    const screen = await render(
      <QueryClientProvider
        client={makeQueryClient([claudeProvider("2.1.219", ["claude-fable-5"])])}
      >
        <WorkflowImplementDialog open workflow={workflow} onOpenChange={() => {}} />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Fable 5");
      });
      await page.getByRole("button", { name: "Start implementation" }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.startImplementation).toHaveBeenCalledTimes(1);
      });
      expect(nativeApiMocks.startImplementation.mock.calls[0]?.[0]).toMatchObject({
        provider: "claudeAgent",
        model: "claude-fable-5",
      });
      expect(nativeApiMocks.startImplementation.mock.calls[0]?.[0].modelOptions).toBeUndefined();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("submits canonical Opus 5 options once the live snapshot supports it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const workflow = makeWorkflow({
      provider: "claudeAgent",
      model: "opus-5[1m]",
      modelOptions: { claudeAgent: { fastMode: true } },
    });
    const screen = await render(
      <QueryClientProvider
        client={makeQueryClient([claudeProvider("2.1.220", ["claude-opus-5", "claude-fable-5"])])}
      >
        <WorkflowImplementDialog open workflow={workflow} onOpenChange={() => {}} />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Opus 5");
      });
      await page.getByRole("button", { name: "Start implementation" }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.startImplementation).toHaveBeenCalledTimes(1);
      });
      expect(nativeApiMocks.startImplementation.mock.calls[0]?.[0]).toMatchObject({
        provider: "claudeAgent",
        model: "claude-opus-5",
        modelOptions: { claudeAgent: { fastMode: true } },
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
