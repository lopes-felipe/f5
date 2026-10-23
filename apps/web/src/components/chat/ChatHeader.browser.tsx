import "../../index.css";

import type { ComponentProps, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("../GitActionsControl", () => ({
  default: () => null,
}));

vi.mock("../ProjectScriptsControl", () => ({
  default: () => null,
}));

vi.mock("./OpenInPicker", () => ({
  OpenInPicker: () => null,
}));

vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: (props: Record<string, unknown>) => <button type="button" {...props} />,
}));

import { ChatHeader } from "./ChatHeader";

type ChatHeaderProps = ComponentProps<typeof ChatHeader>;

function makeProps(overrides: Partial<ChatHeaderProps> = {}): ChatHeaderProps {
  return {
    isServerThread: true,
    activeThreadId: "thread-1" as never,
    activeThreadTitle: "Thread",
    activeProjectName: undefined,
    workflowTitle: undefined,
    onOpenWorkflow: undefined,
    isGitRepo: true,
    openInCwd: null,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    terminalAvailable: false,
    terminalOpen: false,
    workspaceFilesAvailable: false,
    filesState: "closed",
    agentsState: "closed",
    previewState: "closed",
    previewAvailable: false,
    liveAgentCount: 0,
    terminalToggleShortcutLabel: null,
    diffToggleShortcutLabel: null,
    gitCwd: null,
    diffState: "closed",
    threadActionItems: [],
    onThreadAction: () => {},
    onRenameThread: () => {},
    onRunProjectScript: () => {},
    onAddProjectScript: async () => {},
    onUpdateProjectScript: async () => {},
    onDeleteProjectScript: async () => {},
    onToggleTerminal: () => {},
    onToggleFiles: () => {},
    onToggleAgents: () => {},
    onTogglePreview: () => {},
    onToggleDiff: () => {},
    ...overrides,
  };
}

const queryClients: QueryClient[] = [];
/** The default width fits the inline panel toggles (they collapse into a menu below 36rem). */
function renderHeader(overrides: Partial<ChatHeaderProps> = {}, width = 900) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(client);
  return render(
    <div style={{ width }}>
      <ChatHeader {...makeProps(overrides)} />
    </div>,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}

describe("ChatHeader", () => {
  afterEach(() => {
    for (const client of queryClients.splice(0)) client.clear();
    document.body.innerHTML = "";
  });

  it("renders provider-native goal status in the header", async () => {
    const screen = await renderHeader({ nativeGoalSummary: "Goal: All tests pass · active" });
    try {
      await expect
        .element(page.getByText("Goal: All tests pass · active", { exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("collapses the panel toggles into a Panels menu when the header is narrow", async () => {
    const onToggleDiff = vi.fn();
    const screen = await renderHeader({ diffToggleShortcutLabel: "Mod+D", onToggleDiff }, 320);

    try {
      expect(document.querySelector('[aria-label="Toggle diff panel"]')).not.toBeNull();
      await expect
        .element(page.getByRole("button", { name: "Toggle diff panel" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Panels" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Toggle diff panel" }).click();
      expect(onToggleDiff).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("renders a workspace files toggle when file browsing is available", async () => {
    const onToggleFiles = vi.fn();
    const screen = await renderHeader({
      activeProjectName: "Project",
      workspaceFilesAvailable: true,
      onToggleFiles,
    });

    try {
      const filesToggle = page.getByRole("button", { name: "Toggle workspace files" });
      await expect.element(filesToggle).toBeEnabled();
      await filesToggle.click();
      expect(onToggleFiles).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("shows the live agent count and toggles the Agents panel", async () => {
    const onToggleAgents = vi.fn();
    const screen = await renderHeader({ liveAgentCount: 3, onToggleAgents });

    try {
      const agentsToggle = page.getByRole("button", {
        name: "Toggle Agents panel, 3 agents working",
      });
      await expect.element(agentsToggle).toBeEnabled();
      expect(agentsToggle.element().textContent).toContain("3");
      await agentsToggle.click();
      expect(onToggleAgents).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("groups side-panel toggles, including Preview, apart from the terminal", async () => {
    const onTogglePreview = vi.fn();
    const screen = await renderHeader({
      previewAvailable: true,
      previewState: "active",
      agentsState: "background",
      onTogglePreview,
    });

    try {
      const sideGroup = page.getByRole("group", { name: "Side panel" });
      const previewToggle = sideGroup.getByRole("button", { name: "Toggle preview" });
      await expect.element(previewToggle).toHaveAttribute("aria-pressed", "true");
      await previewToggle.click();
      expect(onTogglePreview).toHaveBeenCalledTimes(1);

      const agentsToggle = sideGroup.getByRole("button", {
        name: "Toggle Agents panel, open in background",
        exact: true,
      });
      await expect.element(agentsToggle).toHaveAttribute("aria-pressed", "false");
      await expect.element(agentsToggle).toHaveAttribute("data-in-background", "");
      await agentsToggle.hover();
      await expect.element(page.getByText("Agents · open in background")).toBeVisible();

      await expect
        .element(sideGroup.getByRole("button", { name: "Toggle terminal drawer" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Toggle terminal drawer" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("hides the Preview toggle when the preview host is unavailable", async () => {
    const screen = await renderHeader({ previewAvailable: false }, 320);

    try {
      expect(document.querySelector('[aria-label="Toggle preview"]')).toBeNull();
      await page.getByRole("button", { name: "Panels" }).click();
      await expect
        .element(page.getByRole("menuitemcheckbox", { name: "Toggle diff panel" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("menuitemcheckbox", { name: "Toggle preview" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("groups the narrow Panels menu by side panel and bottom drawer", async () => {
    const screen = await renderHeader(
      { previewAvailable: true, previewState: "active", agentsState: "background" },
      320,
    );

    try {
      await page.getByRole("button", { name: "Panels" }).click();
      await expect.element(page.getByText("Side panel", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Bottom", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("menuitemcheckbox", { name: "Toggle preview" }))
        .toHaveAttribute("aria-checked", "true");
      const agentsItem = page.getByRole("menuitemcheckbox", {
        name: "Toggle Agents panel, open in background",
        exact: true,
      });
      await expect.element(agentsItem).toHaveAttribute("aria-checked", "false");
      expect(agentsItem.element().textContent).toContain("in background");
    } finally {
      await screen.unmount();
    }
  });

  it("offers thread actions and commits an IME-safe inline rename", async () => {
    const onThreadAction = vi.fn();
    const onRenameThread = vi.fn();
    const screen = await renderHeader({
      threadActionItems: [
        { id: "rename", label: "Rename thread" },
        { id: "regenerate-title", label: "Regenerate title" },
      ],
      onThreadAction,
      onRenameThread,
    });

    try {
      await page.getByRole("button", { name: "Thread actions" }).click();
      await page.getByRole("menuitem", { name: "Regenerate title" }).click();
      expect(onThreadAction).toHaveBeenCalledWith("regenerate-title");

      await page.getByRole("button", { name: "Thread actions" }).click();
      await page.getByRole("menuitem", { name: "Rename thread" }).click();
      const input = document.querySelector<HTMLInputElement>('[aria-label="Rename thread"]');
      expect(input).not.toBeNull();
      if (!input) return;
      await page.getByRole("textbox", { name: "Rename thread" }).fill("Renamed thread");

      const composingEnter = new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
      });
      Object.defineProperty(composingEnter, "isComposing", { value: true });
      input.dispatchEvent(composingEnter);
      expect(onRenameThread).not.toHaveBeenCalled();

      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      expect(onRenameThread).toHaveBeenCalledWith("Renamed thread");
    } finally {
      await screen.unmount();
    }
  });

  it("offers project-scoped actions from the project badge", async () => {
    const onNewThreadInProject = vi.fn();
    const onOpenProjectSettings = vi.fn();
    const screen = await renderHeader({
      activeProjectName: "Project Alpha",
      onNewThreadInProject,
      onOpenProjectSettings,
    });

    try {
      await page.getByRole("button", { name: "Project actions for Project Alpha" }).click();
      await page.getByRole("menuitem", { name: "New thread in Project Alpha" }).click();
      expect(onNewThreadInProject).toHaveBeenCalledTimes(1);

      await page.getByRole("button", { name: "Project actions for Project Alpha" }).click();
      await page.getByRole("menuitem", { name: "Project settings" }).click();
      expect(onOpenProjectSettings).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
