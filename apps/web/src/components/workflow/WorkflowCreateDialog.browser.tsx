import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type {
  DesktopBridge,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationCreateWorkflowInput,
  ProjectId,
} from "@t3tools/contracts";

import { appendAttachedFilesToPrompt } from "../../lib/attachedFiles";
import {
  MODEL_PREFERENCES_STORAGE_KEY,
  useModelPreferencesStore,
} from "../../modelPreferencesStore";
import { useStore } from "../../store";

const nativeApiMocks = vi.hoisted(() => ({
  createWorkflow: vi.fn<
    (input: OrchestrationCreateWorkflowInput) => Promise<{ workflowId: string }>
  >(async () => ({ workflowId: "workflow-1" })),
  createCodeReviewWorkflow: vi.fn<
    (input: OrchestrationCreateCodeReviewWorkflowInput) => Promise<{ workflowId: string }>
  >(async () => ({ workflowId: "workflow-2" })),
}));

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      createWorkflow: nativeApiMocks.createWorkflow,
      createCodeReviewWorkflow: nativeApiMocks.createCodeReviewWorkflow,
    },
  }),
}));

vi.mock("../../appSettings", async () => {
  const actual = await vi.importActual<typeof import("../../appSettings")>("../../appSettings");
  const settings = {
    ...actual.parsePersistedAppSettings(null),
    customCodexModels: [],
    customClaudeModels: [],
    codexThreadTitleModel: "custom/thread-title-model",
  };
  return {
    ...actual,
    useAppSettings: () => ({
      settings,
      updateSettings: () => {},
    }),
    resolveThreadTitleModel: () => "custom/thread-title-model",
  };
});

vi.mock("../../env", () => ({
  isElectron: true,
}));

import {
  ProviderFields,
  WorkflowCreateDialog,
  normalizeWorkflowSlotModelOptions,
} from "./WorkflowCreateDialog";

const desktopBridgePathByFileName = new Map<string, string>();

function installDesktopBridgeMock() {
  const desktopBridge: Pick<DesktopBridge, "getPathForFile" | "resolveRealPath" | "setTheme"> = {
    getPathForFile: (file: File) => desktopBridgePathByFileName.get(file.name) ?? null,
    resolveRealPath: (pathValue: string) => pathValue,
    setTheme: async () => {},
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: desktopBridge as DesktopBridge,
  });
}

function findProviderFieldButton(labelText: string): HTMLButtonElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (element) => element.textContent?.trim() === labelText,
  );
  const button = label?.parentElement?.querySelector("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Provider button not found for ${labelText}.`);
  }
  return button;
}

function findMenuItemRadio(text: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).find(
      (element) => element.textContent?.trim() === text,
    ) ?? null
  );
}

function findMenuItem(text: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (element) => element.textContent?.trim() === text,
    ) ?? null
  );
}

async function seedModelPreferences(state: {
  lastProvider: "codex" | "claudeAgent" | null;
  lastModelByProvider: Record<string, string>;
  lastModelOptions: Record<string, unknown> | null;
  lastWorkflowProviderBySlot?: Record<string, string>;
}) {
  localStorage.setItem(
    MODEL_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      state,
      version: 1,
    }),
  );
  await useModelPreferencesStore.persist.rehydrate();
}

function createWorkflowButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === "Start workflow",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Start workflow button not found.");
  }
  return button;
}

function getRequirementEditorSurface(): HTMLDivElement {
  const textarea = document.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("Workflow requirement textarea not found.");
  }
  const surface = textarea.parentElement;
  if (!(surface instanceof HTMLDivElement)) {
    throw new Error("Workflow requirement surface not found.");
  }
  return surface;
}

async function dropFilesOnRequirement(files: File[]) {
  const surface = getRequirementEditorSurface();
  const dataTransfer = new DataTransfer();
  for (const file of files) {
    dataTransfer.items.add(file);
  }
  surface.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }),
  );
}

describe("WorkflowCreateDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    desktopBridgePathByFileName.clear();
    installDesktopBridgeMock();
    useStore.setState({
      projects: [
        {
          id: "project-1" as ProjectId,
          name: "Project",
          cwd: "/repo/project",
          model: "gpt-5",
          createdAt: "2026-04-10T00:00:00.000Z",
          expanded: true,
          scripts: [],
          memories: [],
        },
      ],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threadsHydrated: true,
    });
    useModelPreferencesStore.setState({
      lastProvider: null,
      lastModelByProvider: {},
      lastModelOptions: null,
      lastWorkflowProviderBySlot: {},
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    Reflect.deleteProperty(window, "desktopBridge");
    nativeApiMocks.createWorkflow.mockClear();
    nativeApiMocks.createCodeReviewWorkflow.mockClear();
    useStore.setState({
      projects: [],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threadsHydrated: false,
    });
  });

  it("closes the reasoning menu after selecting a codex effort", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onModelOptionsChange = vi.fn();
    const screen = await render(
      <ProviderFields
        label="Branch A"
        provider="codex"
        model="gpt-5-codex"
        modelOptions={{ codex: { reasoningEffort: "high" } }}
        modelOptionsByProvider={{
          codex: [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }],
          claudeAgent: [{ slug: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
        }}
        onProviderModelChange={() => {}}
        onModelOptionsChange={onModelOptionsChange}
      />,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: /High/ }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Extra High");
      });

      await page.getByRole("menuitemradio", { name: "Medium" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Extra High");
      });

      expect(onModelOptionsChange).toHaveBeenCalledWith({
        codex: { reasoningEffort: "medium" },
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows separate Extra High and Max options for Claude Opus 4.7", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onModelOptionsChange = vi.fn();
    const screen = await render(
      <ProviderFields
        label="Branch A"
        provider="claudeAgent"
        model="claude-opus-4-7"
        modelOptions={undefined}
        modelOptionsByProvider={{
          codex: [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }],
          claudeAgent: [{ slug: "claude-opus-4-7", name: "Claude Opus 4.7" }],
        }}
        onProviderModelChange={() => {}}
        onModelOptionsChange={onModelOptionsChange}
      />,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: /Extra High/ }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Extra High");
        expect(text).toContain("Max");
        expect(text).not.toContain("Ultrathink");
      });

      await page.getByRole("menuitemradio", { name: "Max" }).click();

      await vi.waitFor(() => {
        expect(onModelOptionsChange).toHaveBeenCalledWith({
          claudeAgent: { effort: "max" },
        });
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("does not show remembered inactive-provider models as selected", async () => {
    await seedModelPreferences({
      lastProvider: null,
      lastModelByProvider: {
        claudeAgent: "claude-opus-4-7",
      },
      lastModelOptions: null,
    });

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      findProviderFieldButton("Author A").click();

      await vi.waitFor(() => {
        expect(findMenuItem("Claude")).not.toBeNull();
      });

      findMenuItem("Claude")?.click();

      await vi.waitFor(() => {
        expect(findMenuItemRadio("Claude Opus 4.7")?.getAttribute("aria-checked")).toBe("false");
      });

      findMenuItemRadio("Claude Sonnet 4.6")?.click();

      await vi.waitFor(() => {
        expect(useModelPreferencesStore.getState().lastProvider).toBe("claudeAgent");
        expect(useModelPreferencesStore.getState().lastModelByProvider.claudeAgent).toBe(
          "claude-sonnet-4-6",
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("remembers the merge provider when reopening the workflow dialog", async () => {
    const firstHost = document.createElement("div");
    document.body.append(firstHost);
    const firstScreen = await render(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: firstHost },
    );

    try {
      findProviderFieldButton("Merge").click();

      await vi.waitFor(() => {
        expect(findMenuItem("Claude")).not.toBeNull();
      });

      findMenuItem("Claude")?.click();

      await vi.waitFor(() => {
        expect(findMenuItemRadio("Claude Sonnet 4.6")).not.toBeNull();
      });

      findMenuItemRadio("Claude Sonnet 4.6")?.click();

      await vi.waitFor(() => {
        expect(useModelPreferencesStore.getState().lastWorkflowProviderBySlot.merge).toBe(
          "claudeAgent",
        );
      });
    } finally {
      await firstScreen.unmount();
      firstHost.remove();
    }

    const secondHost = document.createElement("div");
    document.body.append(secondHost);
    const secondScreen = await render(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: secondHost },
    );

    try {
      await vi.waitFor(() => {
        expect(findProviderFieldButton("Merge").textContent ?? "").toContain("Claude Sonnet 4.6");
      });
    } finally {
      await secondScreen.unmount();
      secondHost.remove();
    }
  });

  it("preserves explicit workflow codex high reasoning", () => {
    expect(
      normalizeWorkflowSlotModelOptions("codex", "gpt-5-codex", {
        codex: { reasoningEffort: "high" },
      }),
    ).toEqual({
      codex: { reasoningEffort: "high" },
    });
  });

  it("preserves explicit workflow claude medium effort", () => {
    expect(
      normalizeWorkflowSlotModelOptions("claudeAgent", "claude-opus-4-6", {
        claudeAgent: { effort: "medium" },
      }),
    ).toEqual({
      claudeAgent: { effort: "medium" },
    });
  });

  it("removes the manual title field and enables submit from the prompt alone", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      expect(document.body.textContent ?? "").toContain("title will be generated from your prompt");
      expect(
        Array.from(document.querySelectorAll("label")).some(
          (label) => label.textContent?.trim() === "Workflow title",
        ),
      ).toBe(false);
      expect(createWorkflowButton().disabled).toBe(true);

      await page
        .getByPlaceholder("Describe the feature or requirement to plan.")
        .fill("Plan the new workflow behavior");

      await vi.waitFor(() => {
        expect(createWorkflowButton().disabled).toBe(false);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("sends a planning workflow request without title and with titleGenerationModel", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onOpenChange = vi.fn();
    const onWorkflowCreated = vi.fn();
    const screen = await render(
      <WorkflowCreateDialog
        open
        projectId={"project-1" as ProjectId}
        onOpenChange={onOpenChange}
        onWorkflowCreated={onWorkflowCreated}
      />,
      { container: host },
    );

    try {
      await page
        .getByPlaceholder("Describe the feature or requirement to plan.")
        .fill("Plan the new workflow behavior");

      await vi.waitFor(() => {
        expect(createWorkflowButton().disabled).toBe(false);
      });
      createWorkflowButton().click();

      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1);
      });

      const firstCall = nativeApiMocks.createWorkflow.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) {
        throw new Error("Expected planning workflow request payload.");
      }
      const [payload] = firstCall;
      expect(payload).toMatchObject({
        projectId: "project-1",
        requirementPrompt: "Plan the new workflow behavior",
        titleGenerationModel: "custom/thread-title-model",
      });
      expect("title" in payload).toBe(false);
      expect(onWorkflowCreated).toHaveBeenCalledWith("workflow-1");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("sends a code review workflow request without title and with titleGenerationModel", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onWorkflowCreated = vi.fn();
    const screen = await render(
      <WorkflowCreateDialog
        open
        projectId={"project-1" as ProjectId}
        onOpenChange={() => {}}
        onWorkflowCreated={onWorkflowCreated}
      />,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: "Code Review" }).click();

      await page
        .getByPlaceholder(
          "Describe what the reviewers should inspect and how they should review it.",
        )
        .fill("Review the workflow changes");

      await vi.waitFor(() => {
        expect(createWorkflowButton().disabled).toBe(false);
      });
      createWorkflowButton().click();

      await vi.waitFor(() => {
        expect(nativeApiMocks.createCodeReviewWorkflow).toHaveBeenCalledTimes(1);
      });

      const firstCall = nativeApiMocks.createCodeReviewWorkflow.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) {
        throw new Error("Expected code review workflow request payload.");
      }
      const [payload] = firstCall;
      expect(payload).toMatchObject({
        projectId: "project-1",
        reviewPrompt: "Review the workflow changes",
        titleGenerationModel: "custom/thread-title-model",
      });
      expect("title" in payload).toBe(false);
      expect(onWorkflowCreated).toHaveBeenCalledWith("workflow-2");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows removable file chips in the requirement editor", async () => {
    desktopBridgePathByFileName.set("AGENTS.md", "/repo/project/docs/AGENTS.md");

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      await dropFilesOnRequirement([new File(["agents"], "AGENTS.md", { type: "text/markdown" })]);

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("AGENTS.md");
      });
      expect(createWorkflowButton().disabled).toBe(false);

      await page.getByRole("button", { name: "Remove docs/AGENTS.md" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("AGENTS.md");
      });
      expect(createWorkflowButton().disabled).toBe(true);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("submits file-only workflow prompts with an attached-files block", async () => {
    desktopBridgePathByFileName.set("package.json", "/repo/project/packages/shared/package.json");

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      await dropFilesOnRequirement([
        new File(['{"name":"shared"}'], "package.json", { type: "application/json" }),
      ]);

      await vi.waitFor(() => {
        expect(createWorkflowButton().disabled).toBe(false);
      });

      createWorkflowButton().click();

      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1);
      });

      const firstCall = nativeApiMocks.createWorkflow.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) {
        throw new Error("Expected planning workflow request payload.");
      }
      const [payload] = firstCall;
      expect(payload).toMatchObject({
        projectId: "project-1",
        requirementPrompt: appendAttachedFilesToPrompt("", ["packages/shared/package.json"]),
        titleGenerationModel: "custom/thread-title-model",
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
