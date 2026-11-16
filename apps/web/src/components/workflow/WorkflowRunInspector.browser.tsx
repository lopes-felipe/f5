import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NativeApi, WorkflowPlatformInspectRunResult } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { WorkflowRunInspector } from "./WorkflowRunInspector";

const inspectRun = vi.fn<(input: unknown) => Promise<WorkflowPlatformInspectRunResult>>();

const result = (totalCostUsd: number) =>
  ({
    inspection: {
      workflowId: "workflow-1",
      projectId: "project-1",
      title: "Plan",
      templateId: "planning",
      templateVersion: 2,
      runKind: "planning",
      status: "running",
      totalCostUsd,
      maxCostUsd: null,
      budgetRemainingUsd: null,
      nodes: [],
      projectMemories: [],
      projectSkills: [],
    },
  }) as unknown as WorkflowPlatformInspectRunResult;

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.body.appendChild(document.createElement("div"));
  const ui = (updatedAt: string) => (
    <QueryClientProvider client={queryClient}>
      <WorkflowRunInspector runKind="planning" workflowId="workflow-1" updatedAt={updatedAt} />
    </QueryClientProvider>
  );
  return { queryClient, host, ui };
}

describe("WorkflowRunInspector", () => {
  beforeEach(() => {
    inspectRun.mockReset();
    (window as typeof window & { nativeApi?: NativeApi }).nativeApi = {
      workflowPlatform: { inspectRun },
    } as unknown as NativeApi;
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("makes no request while collapsed, even as the run updates", async () => {
    const { queryClient, host, ui } = setup();
    const screen = await render(ui("2026-10-01T00:00:00.000Z"), { container: host });
    await screen.rerender(ui("2026-10-01T00:00:01.000Z"));
    await screen.rerender(ui("2026-10-01T00:00:02.000Z"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inspectRun).not.toHaveBeenCalled();
    await expect.element(page.getByText("Template, cost and per-step context")).toBeVisible();
    expect(queryClient.getQueryCache().findAll({ queryKey: ["workflow-platform"] })).toHaveLength(
      1,
    );
  });

  it("fetches on expansion and refetches the same entry on run updates", async () => {
    inspectRun.mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(2.5));
    const { queryClient, host, ui } = setup();
    const screen = await render(ui("2026-10-01T00:00:00.000Z"), { container: host });
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect.element(page.getByText(/planning@2 · \$1\.00/)).toBeVisible();

    await screen.rerender(ui("2026-10-01T00:00:05.000Z"));
    await expect.element(page.getByText(/planning@2 · \$2\.50/)).toBeVisible();
    expect(inspectRun).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["workflow-platform"] })).toHaveLength(
      1,
    );
  });

  it("shows a failure with a working retry", async () => {
    inspectRun.mockRejectedValueOnce(new Error("Run store unavailable"));
    inspectRun.mockResolvedValueOnce(result(3));
    const { host, ui } = setup();
    await render(ui("2026-10-01T00:00:00.000Z"), { container: host });
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Run store unavailable");

    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByText(/planning@2 · \$3\.00/)).toBeVisible();
  });
});
