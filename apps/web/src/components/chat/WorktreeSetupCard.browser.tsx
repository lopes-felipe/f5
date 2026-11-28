import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { makeWorktreeSetupSnapshot } from "./worktreeSetupFixtures";

describe("WorktreeSetupCard", () => {
  it("shows checkout progress, the script tail and Cancel while running", async () => {
    const onCancel = vi.fn();
    const base = makeWorktreeSetupSnapshot();
    const snapshot = {
      ...base,
      setupScript: { name: "Install", command: "bun install", async: false },
      stages: base.stages.map((stage) =>
        stage.id === "fetch"
          ? { ...stage, status: "done" as const, detail: "origin/main at abc1234" }
          : stage.id === "checkout"
            ? { ...stage, status: "done" as const, percent: 100, detail: "1,200 files" }
            : stage.id === "setup-script"
              ? {
                  ...stage,
                  status: "running" as const,
                  startedAt: "2026-10-01T10:00:01.000Z",
                  tail: ["resolving", "linking", "done 12 packages"],
                }
              : stage,
      ),
    };
    const screen = await render(
      <WorktreeSetupCard
        snapshot={snapshot}
        busy={false}
        onCancel={onCancel}
        onRetry={null}
        onWorkLocally={null}
      />,
    );
    try {
      await expect.element(page.getByText("Setting up worktree")).toBeVisible();
      await expect.element(page.getByText("Install (agent waits)")).toBeVisible();
      await expect.element(page.getByText("done 12 packages")).toBeVisible();
      await expect.element(page.getByText("1,200 files")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(page.getByRole("button").elements()).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("offers to rerun a setup script that a restart cut off, without holding anything", async () => {
    const onRerunScript = vi.fn();
    const base = makeWorktreeSetupSnapshot({
      phase: "done",
      endedAt: "2026-10-01T10:00:02.000Z",
      agentStarted: true,
    });
    const screen = await render(
      <WorktreeSetupCard
        snapshot={{
          ...base,
          setupScript: { name: "Install", command: "bun install", async: true },
          stages: base.stages.map((stage) =>
            stage.id === "setup-script"
              ? { ...stage, status: "warning" as const, detail: "interrupted by a restart" }
              : { ...stage, status: "done" as const },
          ),
        }}
        busy={false}
        defaultExpanded
        onCancel={null}
        onRetry={null}
        onWorkLocally={null}
        onRerunScript={onRerunScript}
      />,
    );
    try {
      await expect.element(page.getByText("Worktree ready")).toBeVisible();
      await expect.element(page.getByText("interrupted by a restart")).toBeVisible();
      await page.getByRole("button", { name: "Rerun setup script" }).click();
      expect(onRerunScript).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("collapses a finished setup with warnings to its header until expanded", async () => {
    const base = makeWorktreeSetupSnapshot({
      phase: "done",
      endedAt: "2026-10-01T10:00:02.000Z",
      agentStarted: true,
    });
    const fetchWarning = "Couldn't reach the remote; using local main";
    const screen = await render(
      <WorktreeSetupCard
        snapshot={{
          ...base,
          stages: base.stages.map((stage) =>
            stage.id === "fetch"
              ? { ...stage, status: "warning" as const, detail: fetchWarning }
              : { ...stage, status: "done" as const },
          ),
        }}
        busy={false}
        onCancel={null}
        onRetry={null}
        onWorkLocally={null}
      />,
    );
    try {
      await expect.element(page.getByText("Worktree ready")).toBeVisible();
      await expect.element(page.getByText("1 warning")).toBeVisible();
      await expect.element(page.getByText(fetchWarning)).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Show setup details" }).click();
      await expect.element(page.getByText(fetchWarning)).toBeVisible();
      await expect.element(page.getByText(fetchWarning)).toHaveAttribute("title", fetchWarning);
      await page.getByRole("button", { name: "Hide setup details" }).click();
      await expect.element(page.getByText(fetchWarning)).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("offers Retry first, then the other ways out, after a setup stopped", async () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    const onWorkLocally = vi.fn();
    const screen = await render(
      <WorktreeSetupCard
        snapshot={makeWorktreeSetupSnapshot({
          phase: "cancelled_kept",
          endedAt: "2026-10-01T10:01:00.000Z",
          error: "Setup cancelled; worktree kept because it may contain changes.",
        })}
        busy={false}
        onCancel={onCancel}
        onRetry={onRetry}
        onWorkLocally={onWorkLocally}
      />,
    );
    try {
      await expect
        .element(page.getByText("Setup cancelled; worktree kept because it may contain changes."))
        .toBeVisible();
      expect(
        page
          .getByRole("button")
          .elements()
          .map((button) => button.textContent?.trim()),
      ).toEqual(["Retry", "Continue in Local", "Discard message"]);
      await page.getByRole("button", { name: "Discard message" }).click();
      await page.getByRole("button", { name: "Continue in Local" }).click();
      await page.getByRole("button", { name: "Retry" }).click();
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onWorkLocally).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
