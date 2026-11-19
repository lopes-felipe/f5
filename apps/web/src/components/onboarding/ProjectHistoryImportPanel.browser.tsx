import "../../index.css";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProjectHistoryImportPanel } from "./ProjectHistoryImportPanel";

const fixtures = vi.hoisted(() => ({
  scan: vi.fn(),
  import: vi.fn(),
  update: vi.fn(),
  status: "eligible",
  toast: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    projects: { scanAgentSessions: fixtures.scan, importAgentSessions: fixtures.import },
  }),
}));
vi.mock("../../appSettings", () => ({
  readAppSettingsSnapshot: () => ({ onboardingLiteStatus: fixtures.status }),
  updateAppSettings: fixtures.update,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: fixtures.toast } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/settings?category=providers">{children}</a>
  ),
}));
beforeEach(() => {
  vi.resetAllMocks();
  fixtures.status = "eligible";
  fixtures.update.mockImplementation((settings: { onboardingLiteStatus: string }) => {
    fixtures.status = settings.onboardingLiteStatus;
  });
  fixtures.scan.mockResolvedValue({
    candidates: ["First", "Second"].map((title) => ({
      id: title,
      title,
      path: "/projects/" + title,
      sources: ["codex"],
      threadCount: 2,
      lastActiveAt: "2026-11-19T10:00:00.000Z",
      alreadyImported: false,
    })),
    scannedAt: "2026-11-19T10:00:00.000Z",
    truncated: false,
  });
  fixtures.import.mockResolvedValue({
    projectId: "project",
    threadIds: [],
    skippedCount: 0,
    truncated: false,
  });
});
afterEach(() => {
  document.body.innerHTML = "";
});
it("waits for explicit scanning, selection, and history opt-in", async () => {
  const view = await render(<ProjectHistoryImportPanel />);
  expect(fixtures.scan).not.toHaveBeenCalled();
  expect(fixtures.import).not.toHaveBeenCalled();
  expect(
    view.getByRole("link", { name: "Set up agents" }).element().getAttribute("href"),
  ).toContain("providers");
  await view.getByRole("button", { name: "Discover projects from agent history" }).click();
  const history = view.getByRole("checkbox", { name: "Also import recent thread history" });
  await expect.element(history).not.toBeChecked();
  const submit = view.getByRole("button", { name: "Import selected projects" });
  await expect.element(submit).toBeDisabled();
  await view.getByRole("checkbox", { name: /First/ }).click();
  await submit.click();
  await vi.waitFor(() =>
    expect(fixtures.import).toHaveBeenCalledExactlyOnceWith({
      candidateId: "First",
      expectedWorkspaceRoot: "/projects/First",
      includeHistory: false,
    }),
  );
  await vi.waitFor(() =>
    expect(fixtures.update).toHaveBeenLastCalledWith({ onboardingLiteStatus: "eligible" }),
  );
});
it("keeps onboarding open through a batch failure and preserves completed imports", async () => {
  fixtures.import
    .mockResolvedValueOnce({
      projectId: "first",
      threadIds: ["history"],
      skippedCount: 0,
      truncated: false,
    })
    .mockRejectedValueOnce(new Error("unavailable"));
  const view = await render(<ProjectHistoryImportPanel />);
  await view.getByRole("button", { name: "Discover projects from agent history" }).click();
  await view.getByRole("checkbox", { name: /First/ }).click();
  await view.getByRole("checkbox", { name: /Second/ }).click();
  await view.getByRole("checkbox", { name: "Also import recent thread history" }).click();
  await view.getByRole("button", { name: "Import selected projects" }).click();
  await expect
    .element(view.getByRole("alert"))
    .toHaveTextContent("Completed imports are preserved");
  expect(fixtures.update).toHaveBeenLastCalledWith({ onboardingLiteStatus: "reopened" });
  expect(fixtures.import.mock.calls.map(([input]) => input.includeHistory)).toEqual([true, true]);
  await expect.element(view.getByRole("checkbox", { name: /First/ })).not.toBeChecked();
  await expect.element(view.getByRole("checkbox", { name: /Second/ })).toBeChecked();
  await view.getByRole("button", { name: "Import selected projects" }).click();
  await vi.waitFor(() => expect(fixtures.import).toHaveBeenCalledTimes(3));
  expect(fixtures.import.mock.lastCall?.[0].candidateId).toBe("Second");
  await vi.waitFor(() => expect(fixtures.status).toBe("eligible"));
});

it.each(["eligible", "dismissed", "completed", "reopened"])(
  "restores %s when leaving the panel after an import fails",
  async (previous) => {
    fixtures.status = previous;
    fixtures.import.mockRejectedValueOnce(new Error("unavailable"));
    const view = await render(<ProjectHistoryImportPanel />);
    await view.getByRole("button", { name: "Discover projects from agent history" }).click();
    await view.getByRole("checkbox", { name: /First/ }).click();
    await view.getByRole("button", { name: "Import selected projects" }).click();
    await expect.element(view.getByRole("alert")).toBeVisible();
    expect(fixtures.status).toBe("reopened");
    await view.unmount();
    expect(fixtures.status).toBe(previous);
  },
);
