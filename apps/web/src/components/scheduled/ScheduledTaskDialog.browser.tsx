import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_UNIFIED_SETTINGS,
  ProjectId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
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
const project = (id: string, cwd: string) => ({
  id: ProjectId.makeUnsafe(id),
  name: id === "project" ? "Project" : "Other",
  cwd,
  model: "gpt-5.6-sol",
  defaultModel: "gpt-5.6-sol",
  createdAt: "2026-01-01T00:00:00Z",
  expanded: true,
  scripts: [],
  memories: [],
  skills: [],
});
const conversation = ThreadId.makeUnsafe("conversation");
function seedConversation(overrides: Record<string, unknown> = {}) {
  useStore.setState({
    threads: [
      {
        id: conversation,
        projectId: ProjectId.makeUnsafe("project"),
        title: "Release notes",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "plan",
        ...overrides,
      },
    ] as never,
  });
}
async function setup(
  task?: ScheduledTask,
  options: {
    boundThreadId?: ThreadId;
    allowProjectChange?: boolean;
    configure?: (client: QueryClient) => void;
  } = {},
) {
  const id = ProjectId.makeUnsafe("project");
  useStore.setState({ projects: [project("project", "/repo"), project("other", "/other")] });
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
  options.configure?.(client);
  active = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ScheduledTaskDialog
          projectId={id}
          {...(task ? { task } : {})}
          {...(options.boundThreadId ? { boundThreadId: options.boundThreadId } : {})}
          {...(options.allowProjectChange ? { allowProjectChange: true } : {})}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("textbox", { name: "Task name" })).toHaveFocus();
}
function storedTask(overrides: Partial<Record<keyof ScheduledTask, unknown>> = {}) {
  return {
    id: "stored",
    projectId: "project",
    name: "Stored",
    prompt: "Check",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspace: { kind: "projectRoot" },
    cron: "0 9 * * *",
    timezone: "UTC",
    scheduleSource: "0 9 * * *",
    maxRuns: null,
    oneShotAt: null,
    notify: "all",
    enabled: true,
    version: 3,
    createdBy: "user",
    authority: { kind: "user" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    nextRunAt: null,
    lastRunAt: null,
    runsConsumed: 0,
    ...overrides,
  } as ScheduledTask;
}
const format = () => page.getByRole("combobox", { name: "Schedule format" });
const time = () => page.getByLabelText(/^Time \(/);
const day = (name: string) => page.getByRole("button", { name, exact: true });
async function saveNamed(name = "Task") {
  await page.getByRole("textbox", { name: "Task name" }).fill(name);
  await page.getByTestId("composer-editor").fill("Check");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("button", { name: "Save task" }).click();
}
function paste(expression: string, field = "Minute") {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", expression);
  page
    .getByRole("textbox", { name: field, exact: true })
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
}

it("defaults to project root and a fixed time, and shows the schedule without a preview action", async () => {
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
    .toHaveValue("fixed");
  const format = page
    .getByRole("combobox", { name: "Schedule format" })
    .element() as HTMLSelectElement;
  expect(Array.from(format.options, (option) => option.text)).toEqual(["Fixed time", "Cron"]);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await expect.element(page.getByLabelText(`Time (${browserZone})`)).toHaveValue("09:00");
  for (const name of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
    await expect
      .element(page.getByRole("button", { name, exact: true }))
      .toHaveAttribute("aria-pressed", "true");
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
    interactionMode: "default",
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

it("edits a fixed time with day toggles and the task's timezone", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  await setup();
  await page.getByRole("textbox", { name: "Timezone" }).fill("Asia/Tokyo");
  await expect.element(page.getByLabelText("Time (Asia/Tokyo)")).toHaveValue("09:00");
  await day("Saturday").click();
  await day("Sunday").click();
  await expect.element(day("Sunday")).toHaveAttribute("aria-pressed", "false");
  await day("Monday").click();
  await expect.element(day("Monday")).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(day("Tuesday")).toHaveFocus();
  // Clearing the time keeps the rest of the draft.
  await page.getByRole("textbox", { name: "Task name" }).fill("Weekdays");
  await time().fill("");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Enter a time as HH:MM.");
  await expect.element(page.getByRole("textbox", { name: "Task name" })).toHaveValue("Weekdays");
  await time().fill("07:30");
  await day("Monday").click();
  await page.getByTestId("composer-editor").fill("Check");
  await expect
    .element(page.getByText("07:30 AM, Monday through Friday", { exact: false }))
    .toBeVisible();
  await page.getByRole("button", { name: "Save task" }).click();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({
        name: "Weekdays",
        cron: "30 7 * * MON-FRI",
        scheduleSource: "30 7 * * MON-FRI",
        timezone: "Asia/Tokyo",
      }),
    }),
  );
});

it("keeps the last selected day and rejects times with seconds", async () => {
  await setup();
  for (const name of ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
    await day(name).click();
  await day("Monday").click();
  await expect.element(day("Monday")).toHaveAttribute("aria-pressed", "true");
  await time().fill("09:00:30");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
});

it("converts between fixed time and cron in both directions", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  await setup();
  await time().fill("07:30");
  await format().selectOptions("cron");
  await expect
    .element(page.getByRole("textbox", { name: "Minute", exact: true }))
    .toHaveValue("30");
  await expect.element(page.getByRole("textbox", { name: "Hour", exact: true })).toHaveValue("7");
  paste("15 18 * * SAT,SUN");
  await format().selectOptions("fixed");
  await expect.element(time()).toHaveValue("18:15");
  await expect.element(day("Saturday")).toHaveAttribute("aria-pressed", "true");
  await expect.element(day("Monday")).toHaveAttribute("aria-pressed", "false");
  await saveNamed();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({ cron: "15 18 * * SUN,SAT" }),
    }),
  );
});

it("asks before replacing a cron that a fixed time cannot show", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  await setup();
  await format().selectOptions("cron");
  paste("*/15 * * * *");
  await format().selectOptions("fixed");
  const replace = page.getByRole("group", { name: "Replace schedule" });
  await expect.element(replace).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  await replace.getByRole("button", { name: "Cancel" }).click();
  await expect.element(format()).toHaveValue("cron");
  await expect
    .element(page.getByRole("textbox", { name: "Minute", exact: true }))
    .toHaveValue("*/15");
  await format().selectOptions("fixed");
  await page.getByRole("button", { name: "Replace with daily at 09:00" }).click();
  await expect.element(time()).toHaveValue("09:00");
  await saveNamed();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ configuration: expect.objectContaining({ cron: "0 9 * * *" }) }),
  );
});

it("turns a one-time task recurring only after the replacement is accepted", async () => {
  const task = storedTask({
    cron: "0 0 15 1 1 * 2099",
    scheduleSource: "once",
    maxRuns: 1,
    oneShotAt: "2099-01-01T15:00:00.000Z",
  });
  mocks.update.mockResolvedValue({ task, warnings: [] });
  await setup(task);
  await expect.element(format()).toHaveValue("cron");
  await format().selectOptions("fixed");
  await expect
    .element(page.getByRole("group", { name: "Replace schedule" }))
    .toHaveTextContent("one-time schedule");
  await page.getByRole("button", { name: "Replace with daily at 09:00" }).click();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("button", { name: "Save task" }).click();
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({ cron: "0 9 * * *", oneShotAt: null, maxRuns: null }),
    }),
  );
});

it("renames an agent-authored task without rewriting its schedule or execution", async () => {
  const task = storedTask({
    cron: "0 9 * * 1-5",
    scheduleSource: "Agent Bridge cron",
    runtimeMode: "approval-required",
    interactionMode: "plan",
    createdBy: "agent",
    authority: { kind: "agent", clientId: "client", grantGeneration: 2 },
  });
  mocks.update.mockResolvedValue({ task, warnings: [] });
  await setup(task);
  await expect.element(format()).toHaveValue("fixed");
  await expect.element(day("Saturday")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("textbox", { name: "Task name" }).fill("Renamed");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
  await page.getByRole("button", { name: "Save task" }).click();
  const { name, ...rest } = mocks.update.mock.calls[0]![0].configuration;
  expect(name).toBe("Renamed");
  const { name: _name, ...expected } = {
    name: task.name,
    prompt: task.prompt,
    modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    workspace: task.workspace,
    cron: task.cron,
    timezone: task.timezone,
    scheduleSource: task.scheduleSource,
    maxRuns: task.maxRuns,
    oneShotAt: task.oneShotAt,
    notify: task.notify,
    enabled: task.enabled,
  };
  expect(JSON.stringify(rest, Object.keys(expected).toSorted())).toBe(
    JSON.stringify(expected, Object.keys(expected).toSorted()),
  );
});

it("saves the interaction mode and shows a stored one", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  await setup();
  await expect
    .element(page.getByRole("combobox", { name: "Interaction mode" }))
    .toHaveValue("default");
  await page.getByRole("combobox", { name: "Interaction mode" }).selectOptions("plan");
  await saveNamed();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({ interactionMode: "plan" }),
    }),
  );
  await active?.unmount();
  await setup(storedTask({ interactionMode: "plan" }));
  await expect
    .element(page.getByRole("combobox", { name: "Interaction mode" }))
    .toHaveValue("plan");
});

it("uses the conversation's settings in thread mode and the project's after leaving it", async () => {
  mocks.create.mockResolvedValue({ warnings: [] });
  seedConversation();
  await setup(undefined, { boundThreadId: conversation });
  await expect.element(page.getByRole("combobox", { name: "Workspace" })).toHaveValue("thread");
  await expect
    .element(page.getByRole("option", { name: "Conversation: Release notes" }))
    .toBeInTheDocument();
  await expect.element(page.getByText("use its current model, mode and access")).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Interaction mode" }))
    .not.toBeInTheDocument();
  await page.getByRole("combobox", { name: "Workspace" }).selectOptions("projectRoot");
  // Leaving the conversation re-seeds from project defaults, not the conversation.
  await expect
    .element(page.getByRole("combobox", { name: "Interaction mode" }))
    .toHaveValue("default");
  await page.getByRole("combobox", { name: "Workspace" }).selectOptions("thread");
  await saveNamed();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      configuration: expect.objectContaining({
        workspace: { kind: "thread", threadId: conversation },
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    }),
  );
});

it("blocks thread mode until the conversation has a model", async () => {
  seedConversation({ modelSelection: null });
  await setup(undefined, { boundThreadId: conversation });
  await page.getByRole("textbox", { name: "Task name" }).fill("Task");
  await page.getByTestId("composer-editor").fill("Check");
  await expect
    .element(page.getByText("Send a message in this conversation before scheduling into it."))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
});

it("keeps the draft across project changes and blocks Save while settings fail to load", async () => {
  await setup(undefined, {
    allowProjectChange: true,
    configure: (client) =>
      client.setQueryData<unknown>(
        gitBranchesQueryOptions({ cwd: "/other", autoRefresh: false }).queryKey,
        { branches: [], isRepo: true, hasOriginRemote: false },
      ),
  });
  await page.getByRole("textbox", { name: "Task name" }).fill("Moving");
  await page.getByTestId("composer-editor").fill("Check");
  await time().fill("07:30");
  await page.getByRole("combobox", { name: "Project" }).selectOptions("other");
  await expect
    .element(page.getByText("Unable to load this project's settings.", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeDisabled();
  await expect.element(page.getByRole("textbox", { name: "Task name" })).toHaveValue("Moving");
  await expect.element(time()).toHaveValue("07:30");
  await page.getByRole("combobox", { name: "Project" }).selectOptions("project");
  await expect.element(page.getByRole("button", { name: "Save task" })).toBeEnabled();
});
