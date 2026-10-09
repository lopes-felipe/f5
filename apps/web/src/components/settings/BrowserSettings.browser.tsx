import "../../index.css";
import { it, expect, vi, beforeEach } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BrowserSettings } from "./BrowserSettings";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  select: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  sources: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({
    linkOpenTarget: "system",
    enableAgentBrowserAccess: true,
    previewDefaults: { zoomFactor: 1, muted: false, colorScheme: "system" },
    snapShotEnabled: false,
    snapShotShortcut: "Alt+Shift+Command+S",
  }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  api.select.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue(undefined);
  api.list.mockResolvedValue([
    { id: "default", name: "Default", persistent: true },
    { id: "private", name: "Private", persistent: false },
  ]);
  api.sources.mockResolvedValue([
    {
      id: "fixture",
      name: "Synthetic Firefox",
      available: true,
      profiles: [{ id: "one", name: "Fixture profile" }],
      remediation: "Close the source browser.",
    },
  ]);
  api.start.mockResolvedValue("job");
  api.status.mockResolvedValue({
    id: "job",
    status: "writing",
    imported: 3,
    skipped: 2,
    failed: 0,
  });
  window.desktopBridge = { preview: { profiles: api, browserImport: api } } as never;
});
it("selects profiles for new tabs and exposes incognito without changing existing tabs", async () => {
  render(<BrowserSettings />);
  await expect.element(page.getByText("Private")).toBeVisible();
  await expect.element(page.getByText("Incognito", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use for new tabs" }).nth(1).click();
  expect(api.select).toHaveBeenCalledWith("private");
  expect(api.create).not.toHaveBeenCalled();
});
it("shows staged import progress and permits cancellation without touching the target profiles", async () => {
  render(<BrowserSettings />);
  await page.getByRole("combobox", { name: "Import source" }).click();
  await page.getByRole("option", { name: "Synthetic Firefox" }).click();
  await page.getByRole("combobox", { name: "Source profile" }).click();
  await page.getByRole("option", { name: "Fixture profile" }).click();
  await page.getByRole("button", { name: "Import into new profile" }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("3 imported, 2 skipped, 0 failed");
  await page.getByRole("button", { name: "Cancel import" }).click();
  expect(api.cancel).toHaveBeenCalledWith("job");
  expect(api.delete).not.toHaveBeenCalled();
});
