import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type NativeApi,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationFileChangeId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "../store";
import type { Project, Thread, TurnDiffSummary } from "../types";
import DiffPanel from "./DiffPanel";

const { nativeApiRef, routeSearchRef, navigateSpy, threadIdValue, turnIdValue } = vi.hoisted(
  () => ({
    nativeApiRef: {
      current: undefined as NativeApi | undefined,
    },
    routeSearchRef: {
      current: { diff: "1", diffTurnId: "diff-panel-turn" } as Record<string, unknown>,
    },
    navigateSpy: vi.fn(),
    threadIdValue: "diff-panel-thread",
    turnIdValue: "diff-panel-turn",
  }),
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateSpy,
  useParams: (options: { select?: (params: Record<string, string>) => unknown }) =>
    options.select ? options.select({ threadId: threadIdValue }) : { threadId: threadIdValue },
  useSearch: (options: { select?: (search: Record<string, unknown>) => unknown }) =>
    options.select ? options.select(routeSearchRef.current) : routeSearchRef.current,
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => {
    if (!nativeApiRef.current) {
      throw new Error("Native API not found");
    }
    return nativeApiRef.current;
  },
  readNativeApi: () => nativeApiRef.current,
}));

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [
    {
      files: [
        {
          name: "src/example.ts",
          prevName: "src/example.ts",
          cacheKey: "example",
        },
      ],
    },
  ],
}));

vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children?: ReactNode }) => children ?? null,
  useWorkerPool: () => null,
  Virtualizer: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className} data-testid="diff-virtualizer">
      {children}
    </div>
  ),
  FileDiff: ({
    fileDiff,
    options,
  }: {
    fileDiff: { name?: string; cacheKey?: string };
    options: { collapsed?: boolean; overflow?: string };
  }) => (
    <div
      data-testid={`file-diff-${fileDiff.cacheKey}`}
      data-collapsed={String(options.collapsed ?? false)}
      data-overflow={options.overflow ?? "scroll"}
    >
      <div data-diffs-header data-testid={`diff-header-${fileDiff.cacheKey}`}>
        <span>Header</span>
        <span data-title>{fileDiff.name}</span>
      </div>
    </div>
  ),
}));

const THREAD_ID = ThreadId.makeUnsafe(threadIdValue);
const TURN_ID = TurnId.makeUnsafe(turnIdValue);
const PROJECT_ID = "diff-panel-project" as ProjectId;
const NOW_ISO = "2026-05-20T12:00:00.000Z";
const PATCH = "diff --git a/src/example.ts b/src/example.ts\n";

function createProject(): Project {
  return {
    id: PROJECT_ID,
    name: "Diff Panel Project",
    cwd: "/repo/diff-panel",
    model: "gpt-5",
    createdAt: NOW_ISO,
    expanded: true,
    scripts: [],
    memories: [],
  };
}

function createThread(summaries: TurnDiffSummary[]): Thread {
  return {
    id: THREAD_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Diff panel thread",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: NOW_ISO,
    archivedAt: null,
    lastInteractionAt: NOW_ISO,
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    compaction: null,
    turnDiffSummaries: summaries,
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
  };
}

function seedStore() {
  useStore.setState({
    projects: [createProject()],
    threads: [
      createThread([
        {
          turnId: TURN_ID,
          completedAt: NOW_ISO,
          files: [{ path: "src/example.ts", additions: 1, deletions: 1 }],
          checkpointTurnCount: 2,
        },
      ]),
    ],
    threadsHydrated: true,
    lastAppliedSequence: 1,
    planningWorkflows: [],
    codeReviewWorkflows: [],
    detailEventBufferByThreadId: new Map(),
    changedFilesExpandedByThreadId: {},
  });
}

function renderDiffPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <DiffPanel />
    </QueryClientProvider>,
  );
}

describe("DiffPanel", () => {
  const listBranches = vi.fn();
  const getTurnDiff = vi.fn();
  const getFullThreadDiff = vi.fn();
  const getThreadFileChange = vi.fn();

  afterEach(() => {
    nativeApiRef.current = undefined;
    routeSearchRef.current = { diff: "1", diffTurnId: turnIdValue };
    navigateSpy.mockReset();
    listBranches.mockReset();
    getTurnDiff.mockReset();
    getFullThreadDiff.mockReset();
    getThreadFileChange.mockReset();
    window.localStorage.clear();
    document.body.innerHTML = "";
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
      lastAppliedSequence: 0,
      planningWorkflows: [],
      codeReviewWorkflows: [],
      detailEventBufferByThreadId: new Map(),
      changedFilesExpandedByThreadId: {},
    });
  });

  function installNativeApi() {
    listBranches.mockResolvedValue({ isRepo: true });
    getTurnDiff.mockResolvedValue({ diff: PATCH });
    getFullThreadDiff.mockResolvedValue({ diff: PATCH });
    getThreadFileChange.mockResolvedValue({
      fileChange: {
        id: "file-change-1" as OrchestrationFileChangeId,
        title: "src/example.ts",
        patch: PATCH,
      },
    });
    nativeApiRef.current = {
      git: { listBranches },
      orchestration: {
        getTurnDiff,
        getFullThreadDiff,
        getThreadFileChange,
      },
    } as unknown as NativeApi;
  }

  it("passes ignore-whitespace only after the checkpoint-mode toggle is enabled", async () => {
    installNativeApi();
    seedStore();
    const screen = await renderDiffPanel();
    try {
      await expect.element(page.getByTestId("file-diff-example")).toBeInTheDocument();
      await vi.waitFor(() => {
        expect(getTurnDiff).toHaveBeenCalledWith(
          expect.objectContaining({
            fromTurnCount: 1,
            toTurnCount: 2,
          }),
        );
      });
      expect(getTurnDiff).not.toHaveBeenCalledWith(
        expect.objectContaining({ options: { ignoreWhitespace: true } }),
      );

      await page.getByLabelText("Ignore whitespace").click();
      await vi.waitFor(() => {
        expect(getTurnDiff).toHaveBeenCalledWith(
          expect.objectContaining({ options: { ignoreWhitespace: true } }),
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("applies wrap and collapse state through FileDiff options", async () => {
    installNativeApi();
    seedStore();
    const screen = await renderDiffPanel();
    try {
      await expect
        .element(page.getByTestId("file-diff-example"))
        .toHaveAttribute("data-overflow", "scroll");
      await page.getByLabelText("Wrap long lines").click();
      await expect
        .element(page.getByTestId("file-diff-example"))
        .toHaveAttribute("data-overflow", "wrap");

      await expect
        .element(page.getByTestId("file-diff-example"))
        .toHaveAttribute("data-collapsed", "false");
      const collapseButton = page.getByRole("button", { name: "Collapse src/example.ts" });
      await expect.element(collapseButton).toHaveAttribute("aria-expanded", "true");
      await collapseButton.click();
      await expect
        .element(page.getByTestId("file-diff-example"))
        .toHaveAttribute("data-collapsed", "true");
      const expandButton = page.getByRole("button", { name: "Expand src/example.ts" });
      await expect.element(expandButton).toHaveAttribute("aria-expanded", "false");
      await expandButton.click();
      await expect
        .element(page.getByTestId("file-diff-example"))
        .toHaveAttribute("data-collapsed", "false");
    } finally {
      await screen.unmount();
    }
  });

  it("does not render the ignore-whitespace toggle in exact-file mode", async () => {
    installNativeApi();
    seedStore();
    routeSearchRef.current = { diff: "1", diffFileChangeId: "file-change-1" };
    const screen = await renderDiffPanel();
    try {
      await expect.element(page.getByLabelText("Wrap long lines")).toBeInTheDocument();
      await expect.element(page.getByLabelText("Ignore whitespace")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
