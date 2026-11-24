import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import "../../index.css";

import {
  CodeReviewWorkflowId,
  ProjectId,
  ThreadId,
  type CodeReviewWorkflow,
  type WorkflowBenchmarkSummary,
} from "@t3tools/contracts";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
const renderView = (view: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {view}
    </QueryClientProvider>,
  );

import { useStore } from "../../store";
import { toastManager } from "../ui/toast";

const nativeApiMocks = vi.hoisted(() => ({
  connected: true,
  getBenchmark: vi.fn(),
  retryCodeReviewWorkflow: vi.fn(),
  deleteCodeReviewWorkflow: vi.fn(),
  postCodeReviewWorkflow: vi.fn(),
}));

vi.mock("../../nativeApi", () => {
  const api = {
    workflowPlatform: { getBenchmark: nativeApiMocks.getBenchmark },
    orchestration: {
      retryCodeReviewWorkflow: nativeApiMocks.retryCodeReviewWorkflow,
      deleteCodeReviewWorkflow: nativeApiMocks.deleteCodeReviewWorkflow,
      postCodeReviewWorkflow: nativeApiMocks.postCodeReviewWorkflow,
    },
  };
  return {
    ensureNativeApi: () => {
      if (!nativeApiMocks.connected) throw new Error("Native API not available in this test");
      return api;
    },
    readNativeApi: () => (nativeApiMocks.connected ? api : null),
  };
});

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    // Step cards link to their threads; no router is mounted here.
    Link: ({
      to: _to,
      params: _params,
      children,
      ...rest
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: unknown; params?: unknown }) => (
      <a href="#" {...rest}>
        {children}
      </a>
    ),
  };
});

vi.mock("./WorkflowRunInspector", () => ({ WorkflowRunInspector: () => null }));

import { CodeReviewWorkflowView } from "./CodeReviewWorkflowView";

const NOW = "2026-08-20T12:00:00.000Z";
const workflowId = CodeReviewWorkflowId.makeUnsafe("code-review-retry");

function makeWorkflow(): CodeReviewWorkflow {
  return {
    id: workflowId,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Review Pedregal",
    slug: "review-pedregal",
    reviewPrompt: "Review the pull request",
    branch: null,
    reviewerA: {
      label: "Reviewer A",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      status: "error",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: "Reviewer A provider disconnected",
      updatedAt: NOW,
    },
    reviewerB: {
      label: "Reviewer B",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      status: "completed",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    consolidation: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
  };
}

beforeEach(() => {
  nativeApiMocks.connected = true;
  nativeApiMocks.getBenchmark.mockReset();
  nativeApiMocks.getBenchmark.mockResolvedValue({
    kind: "summary",
    models: [],
    phases: [],
    modelTotals: [],
    total: {
      tokens: 0,
      costUsd: 0,
      estimated: false,
      missingTokens: 0,
      missingCost: 0,
      pending: 0,
    },
    findings: 0,
    historicalPartial: false,
    ambiguous: 0,
    evaluationsIncomplete: 0,
    coverage: [],
  } satisfies WorkflowBenchmarkSummary);
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  useStore.setState({ threads: [], codeReviewWorkflows: [] });
});

describe("CodeReviewWorkflowView recovery", () => {
  beforeEach(() => {
    nativeApiMocks.retryCodeReviewWorkflow.mockReset();
    nativeApiMocks.deleteCodeReviewWorkflow.mockReset();
    useStore.setState({ threads: [], codeReviewWorkflows: [makeWorkflow()] });
  });

  it("shows the exact failed stage and reports retry failures", async () => {
    nativeApiMocks.retryCodeReviewWorkflow.mockRejectedValue(new Error("Provider is unavailable"));
    const toastSpy = vi.spyOn(toastManager, "add");
    const screen = await renderView(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await expect.element(page.getByText("Reviewer A provider disconnected")).toBeVisible();
      await vi.waitFor(() =>
        expect(nativeApiMocks.getBenchmark).toHaveBeenCalledWith({
          runKind: "codeReview",
          workflowId,
          select: { kind: "summary" },
        }),
      );
      await page.getByRole("button", { name: "Retry failed" }).click();
      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith({
          type: "error",
          title: "Provider is unavailable",
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("confirms ambiguous delivery risk with the same retry scope", async () => {
    nativeApiMocks.retryCodeReviewWorkflow
      .mockResolvedValueOnce({ status: "confirmation_required", threadIds: ["reviewer-a"] })
      .mockResolvedValueOnce({ status: "started" });
    const screen = await renderView(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await page.getByRole("button", { name: "Retry failed" }).click();
      await page.getByRole("button", { name: "Retry anyway" }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.retryCodeReviewWorkflow).toHaveBeenLastCalledWith({
          workflowId,
          scope: "failed",
          allowPossibleDuplicate: true,
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("reports that retry is unavailable while disconnected", async () => {
    nativeApiMocks.connected = false;
    const toastSpy = vi.spyOn(toastManager, "add");
    const screen = await renderView(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await page.getByRole("button", { name: "Retry failed" }).click();
      expect(toastSpy).toHaveBeenCalledWith({
        type: "error",
        title: "Code-review retry is unavailable while disconnected.",
      });
      expect(nativeApiMocks.retryCodeReviewWorkflow).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

const PULL_REQUEST = {
  url: "https://github.com/acme/app/pull/42",
  key: "github:github.com/acme/app#42",
};

function makePostableWorkflow(post: CodeReviewWorkflow["post"] = null): CodeReviewWorkflow {
  const base = makeWorkflow();
  return {
    ...base,
    reviewerA: { ...base.reviewerA, status: "completed", error: null },
    consolidation: {
      ...base.consolidation,
      status: "completed",
      pinnedTurnId: "turn-merge",
      pinnedAssistantMessageId: "assistant-merge",
    },
    pullRequest: PULL_REQUEST,
    autoPost: false,
    post,
  };
}

function makePost(
  overrides: Partial<NonNullable<CodeReviewWorkflow["post"]>>,
): NonNullable<CodeReviewWorkflow["post"]> {
  return {
    trigger: "auto",
    status: "posted",
    operationId: "f5-code-review:code-review-retry:op",
    consolidationTurnId: "turn-merge",
    commentUrl: `${PULL_REQUEST.url}#issuecomment-9`,
    error: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("CodeReviewWorkflowView pull request posting", () => {
  beforeEach(() => {
    nativeApiMocks.postCodeReviewWorkflow.mockReset();
    nativeApiMocks.postCodeReviewWorkflow.mockResolvedValue({ status: "started" });
  });

  it("links the pull request and posts the merged review", async () => {
    useStore.setState({ threads: [], codeReviewWorkflows: [makePostableWorkflow()] });
    const screen = await renderView(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await expect
        .element(page.getByRole("link", { name: "acme/app#42" }))
        .toHaveAttribute("href", PULL_REQUEST.url);
      await page.getByRole("button", { name: "Post to PR" }).click();
      await expect.element(page.getByText("Post the merged review to acme/app#42?")).toBeVisible();
      expect(nativeApiMocks.postCodeReviewWorkflow).not.toHaveBeenCalled();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Post", exact: true })
        .click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.postCodeReviewWorkflow).toHaveBeenCalledWith({
          workflowId,
          allowPossibleDuplicate: false,
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("links a posted comment", async () => {
    useStore.setState({ threads: [], codeReviewWorkflows: [makePostableWorkflow(makePost({}))] });
    const screen = await renderView(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await expect
        .element(page.getByRole("link", { name: "Posted" }))
        .toHaveAttribute("href", `${PULL_REQUEST.url}#issuecomment-9`);
      expect(page.getByRole("button", { name: "Post to PR" }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("shows failed and unknown post outcomes with their recovery actions", async () => {
    useStore.setState({
      threads: [],
      codeReviewWorkflows: [
        makePostableWorkflow(makePost({ status: "failed", error: "Resource not accessible" })),
      ],
    });
    const screen = await renderView(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await expect.element(page.getByText("Resource not accessible")).toBeVisible();
      await page.getByRole("button", { name: "Retry post" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Post", exact: true })
        .click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.postCodeReviewWorkflow).toHaveBeenCalledTimes(1);
      });

      useStore.setState({
        codeReviewWorkflows: [
          makePostableWorkflow(
            makePost({ status: "needs_recovery", error: "GitHub may have received the comment." }),
          ),
        ],
      });
      await page.getByRole("button", { name: "Check again" }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.postCodeReviewWorkflow).toHaveBeenLastCalledWith({
          workflowId,
          allowPossibleDuplicate: false,
        });
      });
      await page.getByRole("button", { name: "Post anyway" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Post anyway" }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.postCodeReviewWorkflow).toHaveBeenLastCalledWith({
          workflowId,
          allowPossibleDuplicate: true,
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("confirms before posting a newer merged review again", async () => {
    useStore.setState({
      threads: [],
      codeReviewWorkflows: [makePostableWorkflow(makePost({ consolidationTurnId: "turn-old" }))],
    });
    const screen = await renderView(<CodeReviewWorkflowView workflowId={workflowId} />);

    try {
      await page.getByRole("button", { name: "Post again" }).click();
      await expect.element(page.getByText("Post the new merged review?")).toBeVisible();
      expect(nativeApiMocks.postCodeReviewWorkflow).not.toHaveBeenCalled();
      await page.getByRole("alertdialog").getByRole("button", { name: "Post again" }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.postCodeReviewWorkflow).toHaveBeenCalledWith({
          workflowId,
          allowPossibleDuplicate: false,
        });
      });
    } finally {
      await screen.unmount();
    }
  });
});
