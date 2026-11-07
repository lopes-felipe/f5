import "../../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ThreadListItem } from "../../../types";
import { ArchiveSettings } from "./ArchiveSettings";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  deleteThreads: vi.fn(),
  unarchive: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
}));
vi.mock("../../../appSettings", () => ({
  useAppSettings: () => ({ settings: { confirmThreadDelete: true } }),
}));
vi.mock("../../../nativeApi", () => ({
  readNativeApi: () => ({ dialogs: { confirm: mocks.confirm } }),
  ensureNativeApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("../../../archiveActions", () => ({
  deleteThreadsWithCleanup: mocks.deleteThreads,
  setThreadArchived: mocks.unarchive,
  deleteWorkflow: vi.fn(),
  setWorkflowArchived: vi.fn(),
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../../../store", () => {
  const state = {
    projects: [],
    threads: [],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: [],
  };
  return {
    useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), {
      getState: () => state,
    }),
  };
});
vi.mock("../../../threadSelectors", () => ({
  liveThreadActivityAt: () => "2026-01-01T00:00:00Z",
  useThreadSummaries: () => [
    {
      id: "archived-thread",
      projectId: "project",
      title: "Archived release notes",
      archivedAt: "2026-01-01T00:00:00Z",
      worktreePath: null,
    } as ThreadListItem,
  ],
}));

describe("archived thread actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteThreads.mockResolvedValue({ failures: [] });
    mocks.unarchive.mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("names the thread, blocks actions during confirmation, and preserves it on cancel", async () => {
    let confirm!: (value: boolean) => void;
    mocks.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const view = await render(<ArchiveSettings />);
    try {
      const remove = page.getByRole("button", {
        name: "Delete Archived release notes",
        exact: true,
      });
      await remove.click();
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Delete thread "Archived release notes"?'),
      );
      await expect.element(remove).toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: "Unarchive Archived release notes" }))
        .toBeDisabled();
      confirm(false);
      await expect.element(remove).toBeEnabled();
      expect(mocks.deleteThreads).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("deletes the selected thread after confirmation", async () => {
    mocks.confirm.mockResolvedValue(true);
    const view = await render(<ArchiveSettings />);
    try {
      await page
        .getByRole("button", { name: "Delete Archived release notes", exact: true })
        .click();
      await vi.waitFor(() =>
        expect(mocks.deleteThreads).toHaveBeenCalledWith(
          expect.objectContaining({ threadIds: ["archived-thread"] }),
        ),
      );
    } finally {
      await view.unmount();
    }
  });

  it("reports confirmation failures and allows retrying", async () => {
    mocks.confirm.mockRejectedValue(new Error("Dialog unavailable"));
    const view = await render(<ArchiveSettings />);
    try {
      const remove = page.getByRole("button", {
        name: "Delete Archived release notes",
        exact: true,
      });
      await remove.click();
      await vi.waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith(
          expect.objectContaining({ type: "error", description: "Dialog unavailable" }),
        ),
      );
      await expect.element(remove).toBeEnabled();
    } finally {
      await view.unmount();
    }
  });

  it("shows action tooltips and unarchives the thread", async () => {
    const view = await render(<ArchiveSettings />);
    try {
      await page
        .getByRole("button", { name: "Delete Archived release notes", exact: true })
        .hover();
      await expect.element(page.getByText("Delete", { exact: true })).toBeVisible();
      const restore = page.getByRole("button", { name: "Unarchive Archived release notes" });
      await restore.hover();
      await expect.element(page.getByText("Unarchive", { exact: true })).toBeVisible();
      await restore.click();
      expect(mocks.unarchive).toHaveBeenCalledWith({
        threadId: "archived-thread",
        archived: false,
      });
    } finally {
      await view.unmount();
    }
  });
});
