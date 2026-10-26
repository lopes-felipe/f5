import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_UNIFIED_SETTINGS, ProjectId, type ScheduledTask } from "@t3tools/contracts";
import { CRON_EXPRESSION_MAX_LENGTH } from "@t3tools/shared/cronSchedule";
import { ScheduledTaskDialog } from "./ScheduledTaskDialog";
import { createTestServerProvider } from "../../testServerProvider";
import { useStore } from "../../store";
import { TooltipProvider } from "../ui/tooltip";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    scheduledTasks: { create: mocks.create, update: mocks.update },
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
let active: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
async function setup(task?: ScheduledTask) {
  const id = ProjectId.makeUnsafe("project");
  useStore.setState({
    projects: [
      {
        id,
        name: "Project",
        cwd: "/repo",
        model: "gpt-5.6-sol",
        defaultModel: "gpt-5.6-sol",
        createdAt: "2026-01-01T00:00:00Z",
        expanded: true,
        scripts: [],
        memories: [],
        skills: [],
      },
    ],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData<unknown>(serverConfigQueryOptions().queryKey, {
    providers: [createTestServerProvider("codex")],
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  client.setQueryData<unknown>(
    gitBranchesQueryOptions({ cwd: "/repo", autoRefresh: false }).queryKey,
    {
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
      isRepo: true,
      hasOriginRemote: false,
    },
  );
  client.setQueryData<unknown>(projectSettingsQueryOptions(id).queryKey, {
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  active = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ScheduledTaskDialog
          projectId={id}
          {...(task ? { task } : {})}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("textbox", { name: "Task name" })).toHaveFocus();
}
function paste(expression: string, field = "Minute") {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", expression);
  page
    .getByRole("textbox", { name: field, exact: true })
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
}

it("defaults to project root and presets, and shows the schedule without a preview action", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  await setup();
  await expect
    .element(page.getByRole("combobox", { name: "Workspace" }))
    .toHaveValue("projectRoot");
  const workspace = page
    .getByRole("combobox", { name: "Workspace" })
    .element() as HTMLSelectElement;
  expect(workspace.options[0]?.value).toBe("projectRoot");
  await expect
    .element(page.getByRole("combobox", { name: "Schedule format" }))
    .toHaveValue("preset");
  const format = page
    .getByRole("combobox", { name: "Schedule format" })
    .element() as HTMLSelectElement;
  expect(Array.from(format.options, (option) => option.text)).toEqual(["Preset", "Cron"]);
  const timezone = page.getByRole("textbox", { name: "Timezone" }).element();
  const notify = page.getByRole("combobox", { name: "Notification policy" }).element();
  expect(timezone.compareDocumentPosition(notify) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(notify.compareDocumentPosition(format) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const select of [workspace, notify, format]) {
    const arrow = select.parentElement!.querySelector("svg")!;
    const box = select.getBoundingClientRect();
    const icon = arrow.getBoundingClientRect();
    expect(Math.abs(box.top + box.height / 2 - (icon.top + icon.height / 2))).toBeLessThan(1);
  }

  await expect
    .element(page.getByRole("button", { name: "Preview schedule" }))
    .not.toBeInTheDocument();
  await page.getByText("Next", { exact: true }).click();
  await expect.element(page.getByRole("list", { name: "Next runs" })).toBeVisible();
  expect(
    page.getByRole("list", { name: "Next runs" }).getByRole("listitem").elements(),
  ).toHaveLength(5);
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Timezone" }).fill("Asia/Tokyo");
  await expect.element(page.getByText("At 09:00 AM (Asia/Tokyo)")).toBeVisible();
  await page.getByRole("textbox", { name: "Task name" }).fill("Check page");
  await page.getByTestId("composer-editor").fill("Check for updates");
  await page.getByRole("button", { name: "Save task" }).click();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({
        workspace: { kind: "projectRoot" },
        cron: "0 9 * * *",
        timezone: "Asia/Tokyo",
      }),
    }),
  );
});

it("recovers automatically from invalid timezone input and validates the prompt", async () => {
  await setup();
  await page.getByRole("textbox", { name: "Timezone" }).fill("Mars/Olympus");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  await expect.element(page.getByRole("alert")).toHaveTextContent("valid IANA timezone");
  await page.getByRole("textbox", { name: "Timezone" }).fill("UTC");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("button", { name: "Save task" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Enter a name and prompt");
  expect(mocks.create).not.toHaveBeenCalled();
});

it("uses separate cron fields with Tab and Shift+Tab, retaining empty sections", async () => {
  await setup();
  await page.getByRole("combobox", { name: "Workspace" }).selectOptions("worktree");
  await expect.element(page.getByRole("combobox", { name: "Base branch" })).toHaveValue("main");
  await page.getByRole("combobox", { name: "Schedule format" }).selectOptions("cron");
  const minute = page.getByRole("textbox", { name: "Minute", exact: true });
  const hour = page.getByRole("textbox", { name: "Hour", exact: true });
  await expect.element(minute).toHaveValue("0");
  await expect
    .element(page.getByRole("button", { name: "Every 15 minutes", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("Minute", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Copy cron expression", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await minute.click();
  await userEvent.tab();
  await expect.element(hour).toHaveFocus();
  await expect.element(hour).toHaveValue("9");
  await userEvent.tab({ shift: true });
  await expect.element(minute).toHaveFocus();
  await minute.fill("");
  await expect.element(hour).toHaveValue("9");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  await minute.fill("*/15");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  for (const [field, value] of [
    ["Minute", "60"],
    ["Hour", "24"],
    ["Month", "13"],
    ["Day of week", "8"],
    ["Minute", "*/0"],
  ]) {
    paste("*/15 * * * *");
    const input = page.getByRole("textbox", { name: field!, exact: true });
    await input.fill(value!);
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
    await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  }
  paste("0 9 * * MON#1");
  await expect
    .element(page.getByRole("textbox", { name: "Day of week", exact: true }))
    .toHaveValue("MON#1");
  await expect.element(page.getByText(/first Monday/)).toBeVisible();
});

it.each([
  { width: 1280, height: 1200 },
  { width: 414, height: 896 },
])(
  "keeps the dialog stable while recalculating and describes the cron below its input ($width px)",
  async ({ width, height }) => {
    await page.viewport(width, height);
    try {
      await setup();
      await page.getByRole("textbox", { name: "Timezone" }).fill("UTC");
      await expect.element(page.getByRole("textbox", { name: "Timezone" })).toHaveValue("UTC");
      await page.getByRole("combobox", { name: "Schedule format" }).selectOptions("cron");
      await expect.element(page.getByRole("textbox", { name: "Timezone" })).toHaveValue("UTC");
      await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
      const description = page.getByTestId("schedule-summary").element();
      const input = page.getByRole("group", { name: "Cron expression" }).element();
      expect(description.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        input.getBoundingClientRect().bottom,
      );
      const dialog = page.getByRole("dialog").element();
      const samples: Array<{ height: number; top: number; text: string }> = [];
      const sample = () => {
        const bounds = dialog.getBoundingClientRect();
        samples.push({
          height: bounds.height,
          top: bounds.top,
          text: description.textContent ?? "",
        });
      };
      sample();
      const observer = new MutationObserver(sample);
      observer.observe(dialog, { childList: true, characterData: true, subtree: true });
      try {
        await page.getByRole("textbox", { name: "Minute", exact: true }).fill("*");
        await expect
          .element(page.getByTestId("schedule-summary"))
          .toHaveTextContent("Every minute, between 09:00 AM and 09:59 AM (UTC)");
        expect(samples.length).toBeGreaterThan(1);
        expect(samples.every((entry) => entry.text.trim().length > 0)).toBe(true);
        expect(
          Math.max(...samples.map((entry) => entry.height)) -
            Math.min(...samples.map((entry) => entry.height)),
        ).toBeLessThan(1);
        expect(
          Math.max(...samples.map((entry) => entry.top)) -
            Math.min(...samples.map((entry) => entry.top)),
        ).toBeLessThan(1);
        await expect.element(page.getByText("Updating schedule…")).not.toBeInTheDocument();
        await page.getByText("Next", { exact: true }).click();
        expect(Math.abs(dialog.getBoundingClientRect().height - samples[0]!.height)).toBeLessThan(
          1,
        );
      } finally {
        observer.disconnect();
      }
    } finally {
      await page.viewport(1280, 720);
    }
  },
);

it("distributes complete expressions pasted in any section and rejects oversized or malformed pastes", async () => {
  await setup();
  await page.getByRole("combobox", { name: "Schedule format" }).selectOptions("cron");
  paste("*/15 9-17 * JAN-MAR MON-FRI", "Hour");
  await expect
    .element(page.getByRole("textbox", { name: "Minute", exact: true }))
    .toHaveValue("*/15");
  await expect
    .element(page.getByRole("textbox", { name: "Hour", exact: true }))
    .toHaveValue("9-17");
  await expect
    .element(page.getByRole("textbox", { name: "Month", exact: true }))
    .toHaveValue("JAN-MAR");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Hour", exact: true }).click();
  paste("*/15 9-17 * JAN-MAR MON-FRI", "Hour");
  await userEvent.tab();
  const day = page.getByRole("textbox", { name: "Day of month", exact: true });
  await expect.element(day).toHaveFocus();
  await day.fill("1");
  await expect.element(day).toHaveFocus();
  paste("* * * * * *");
  await expect.element(page.getByRole("alert")).toHaveTextContent("Paste five cron fields");
  await expect
    .element(page.getByRole("textbox", { name: "Minute", exact: true }))
    .toHaveValue("*/15");
  paste("1".repeat(CRON_EXPRESSION_MAX_LENGTH + 1) + " * * * *");
  await expect.element(page.getByRole("alert")).toHaveTextContent("too long");
  paste("60 * * * *");
  await expect
    .element(page.getByRole("textbox", { name: "Minute", exact: true }))
    .toHaveAttribute("aria-invalid", "true");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  paste("@hourly", "Day of week");
  await expect.element(page.getByRole("textbox", { name: "Minute", exact: true })).toHaveValue("0");
  await expect.element(page.getByRole("textbox", { name: "Hour", exact: true })).toHaveValue("*");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await page.getByRole("button", { name: "Copy cron expression", exact: true }).click();
  expect(write).toHaveBeenCalledWith("0 * * * *");
  await expect.element(page.getByRole("button", { name: "Cron expression copied" })).toBeVisible();
});

it("ignores old calculations after rapid input changes and saves the current expression", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  await setup();
  await page.getByRole("combobox", { name: "Schedule format" }).selectOptions("cron");
  paste("0 1 * * *");
  paste("*/15 * * * *");
  await page.getByRole("textbox", { name: "Timezone" }).fill("Mars/Olympus");
  await page.getByRole("textbox", { name: "Timezone" }).fill("UTC");
  await expect.element(page.getByText("Every 15 minutes (UTC)")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("textbox", { name: "Task name" }).fill("Latest");
  await page.getByTestId("composer-editor").fill("Check");
  await page.getByRole("button", { name: "Save task" }).click();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({ cron: "*/15 * * * *", timezone: "UTC" }),
    }),
  );
});

it("saves metadata on an expired one-shot without changing or reconverting its target", async () => {
  const task = {
    id: "expired",
    projectId: "project",
    name: "Expired",
    prompt: "Check",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    workspace: { kind: "projectRoot" },
    cron: "0 0 15 1 1 * 2020",
    timezone: "UTC",
    scheduleSource: "once",
    maxRuns: 1,
    oneShotAt: "2020-01-01T15:00:00.000Z",
    notify: "all",
    enabled: false,
    version: 1,
    createdBy: "user",
    authority: { kind: "user" },
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
    nextRunAt: null,
    lastRunAt: null,
    runsConsumed: 1,
  } as ScheduledTask;
  mocks.update.mockResolvedValue({ task, warnings: [] });
  await setup(task);
  await page.getByRole("textbox", { name: "Task name" }).fill("Renamed");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("button", { name: "Save task" }).click();
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({
        name: "Renamed",
        oneShotAt: task.oneShotAt,
        maxRuns: 1,
        enabled: false,
      }),
    }),
  );
});

it("timestamps create requests when saving rather than when the dialog opens", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  await setup();
  const savedAt = Date.now() + 2 * 86400000;
  vi.spyOn(Date, "now").mockReturnValue(savedAt);
  await page.getByRole("textbox", { name: "Task name" }).fill("Long-open dialog");
  await page.getByTestId("composer-editor").fill("Check for updates");
  // Keep the preview's real wall clock: only the request timestamp uses Date.now.
  await page.getByRole("button", { name: "Save task" }).click();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalled());
  expect(mocks.create.mock.calls[0]![0].requestedAt).toBe(new Date(savedAt).toISOString());
});
