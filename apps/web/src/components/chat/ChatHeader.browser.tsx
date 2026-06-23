import "../../index.css";

import type { ComponentProps } from "react";
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
    activeThreadId: "thread-1" as never,
    activeThreadTitle: "Thread",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    model: "gpt-5.4",
    provider: "codex",
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
    filesOpen: false,
    terminalToggleShortcutLabel: null,
    diffToggleShortcutLabel: null,
    gitCwd: null,
    diffOpen: false,
    onRunProjectScript: () => {},
    onAddProjectScript: async () => {},
    onUpdateProjectScript: async () => {},
    onDeleteProjectScript: async () => {},
    onToggleTerminal: () => {},
    onToggleFiles: () => {},
    onToggleDiff: () => {},
    ...overrides,
  };
}

function renderHeader(overrides: Partial<ChatHeaderProps> = {}) {
  return render(<ChatHeader {...makeProps(overrides)} />);
}

describe("ChatHeader", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not render a context-window badge when token usage is unknown", async () => {
    const screen = await renderHeader();

    try {
      expect(document.querySelector('[aria-label^="Context window occupancy for "]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("does not render the thinking-token pill when there is no live estimate", async () => {
    const screen = await renderHeader({ estimatedThinkingTokens: 0 });

    try {
      expect(document.querySelector('[aria-label="Live thinking-token estimate"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("renders the thinking-token pill with a compact live estimate", async () => {
    const screen = await renderHeader({ estimatedThinkingTokens: 12_500 });

    try {
      const badge = document.querySelector<HTMLButtonElement>(
        '[aria-label="Live thinking-token estimate"]',
      );
      expect(badge?.textContent).toContain("12.5K thinking");

      await page.getByRole("button", { name: "Live thinking-token estimate" }).hover();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Thinking: ~12,500 tokens");
        expect(document.body.textContent).toContain("not billed output tokens");
      });
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

  it("renders the badge with threshold colors and a tooltip describing the model window", async () => {
    const screen = await renderHeader({
      estimatedContextTokens: 38_000,
      modelContextWindowTokens: 200_000,
      model: "claude-sonnet-4-6",
      provider: "claudeAgent",
      tokenUsageSource: "estimated",
    });

    try {
      let badge = document.querySelector<HTMLButtonElement>(
        '[aria-label="Context window occupancy for claude-sonnet-4-6"]',
      );
      expect(badge?.textContent).toContain("38K / 200K (19%)");
      expect(badge?.getAttribute("class")).toContain("text-emerald-700");

      await screen.rerender(
        <ChatHeader
          {...makeProps({
            estimatedContextTokens: 40_000,
            modelContextWindowTokens: 200_000,
            model: "claude-sonnet-4-6",
            provider: "claudeAgent",
            tokenUsageSource: "provider",
          })}
        />,
      );

      badge = document.querySelector<HTMLButtonElement>(
        '[aria-label="Context window occupancy for claude-sonnet-4-6"]',
      );
      expect(badge?.textContent).toContain("40K / 200K (20%)");
      expect(badge?.getAttribute("class")).toContain("text-yellow-700");

      await screen.rerender(
        <ChatHeader
          {...makeProps({
            estimatedContextTokens: 90_000,
            modelContextWindowTokens: 200_000,
            model: "claude-sonnet-4-6",
            provider: "claudeAgent",
            tokenUsageSource: "provider",
          })}
        />,
      );

      badge = document.querySelector<HTMLButtonElement>(
        '[aria-label="Context window occupancy for claude-sonnet-4-6"]',
      );
      expect(badge?.textContent).toContain("90K / 200K (45%)");
      expect(badge?.getAttribute("class")).toContain("text-orange-700");

      await screen.rerender(
        <ChatHeader
          {...makeProps({
            estimatedContextTokens: 735_000,
            modelContextWindowTokens: 1_050_000,
            model: "gpt-5.4",
            provider: "codex",
            tokenUsageSource: "provider",
          })}
        />,
      );

      badge = document.querySelector<HTMLButtonElement>(
        '[aria-label="Context window occupancy for gpt-5.4"]',
      );
      expect(badge?.textContent).toContain("735K / 1.1M (70%)");
      expect(badge?.getAttribute("class")).toContain("text-red-700");

      await page.getByRole("button", { name: "Context window occupancy for gpt-5.4" }).hover();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Window: 1,050,000 tokens");
        expect(document.body.textContent).toContain("Model: gpt-5.4");
        expect(document.body.textContent).toContain("Source: Provider reported");
      });
    } finally {
      await screen.unmount();
    }
  });
});
