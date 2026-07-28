import "../../index.css";

import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  defaultInstanceIdForDriver,
  DesktopBridge,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationCreateInvestigationWorkflowInput,
  OrchestrationCreateWorkflowInput,
  ProjectId,
  ProviderDriverKind,
  ResolvedKeybindingsConfig,
  ServerProvider,
  WorkflowPlatformCreateRunInput,
} from "@t3tools/contracts";

import { appendAttachedFilesToPrompt } from "../../lib/attachedFiles";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { isMacPlatform } from "../../lib/utils";
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
  createInvestigationWorkflow: vi.fn<
    (input: OrchestrationCreateInvestigationWorkflowInput) => Promise<{ workflowId: string }>
  >(async () => ({ workflowId: "workflow-3" })),
  getConfig: vi.fn(async () => ({
    keybindings: [],
  })),
}));

vi.mock("../../nativeApi", () => {
  const createRun = async (input: WorkflowPlatformCreateRunInput) => {
    const request = {
      ...input.input,
      ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
    };
    switch (input.templateId) {
      case "builtin.planning.dual": {
        const result = await nativeApiMocks.createWorkflow(
          request as OrchestrationCreateWorkflowInput,
        );
        return { runKind: "planning" as const, workflowId: result.workflowId };
      }
      case "builtin.code-review.dual": {
        const result = await nativeApiMocks.createCodeReviewWorkflow(
          request as OrchestrationCreateCodeReviewWorkflowInput,
        );
        return { runKind: "codeReview" as const, workflowId: result.workflowId };
      }
      case "builtin.investigation.dual": {
        const result = await nativeApiMocks.createInvestigationWorkflow(
          request as OrchestrationCreateInvestigationWorkflowInput,
        );
        return { runKind: "investigation" as const, workflowId: result.workflowId };
      }
    }
  };
  const api = {
    orchestration: {
      createWorkflow: nativeApiMocks.createWorkflow,
      createCodeReviewWorkflow: nativeApiMocks.createCodeReviewWorkflow,
      createInvestigationWorkflow: nativeApiMocks.createInvestigationWorkflow,
    },
    workflowPlatform: {
      createRun,
    },
    server: {
      getConfig: nativeApiMocks.getConfig,
    },
  };
  return {
    ensureNativeApi: () => api,
    readNativeApi: () => api,
  };
});

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => vi.fn(async () => {}),
  };
});

vi.mock("../../appSettings", async () => {
  const actual = await vi.importActual<typeof import("../../appSettings")>("../../appSettings");
  const settings = {
    ...actual.parsePersistedAppSettings(null),
    customCodexModels: [],
    customClaudeModels: [],
    customGrokModels: [],
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

function createTestQueryClient(
  keybindings: ResolvedKeybindingsConfig = DEFAULT_RESOLVED_KEYBINDINGS,
  providers?: ReadonlyArray<ServerProvider>,
): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
  queryClient.setQueryData(serverQueryKeys.config(), { keybindings, providers });
  return queryClient;
}

async function renderWithQueryClient(
  element: ReactElement,
  options: {
    container?: HTMLElement;
    keybindings?: ResolvedKeybindingsConfig;
    providers?: ReadonlyArray<ServerProvider>;
  } = {},
) {
  const queryClient = createTestQueryClient(options.keybindings, options.providers);
  const renderOptions = options.container ? { container: options.container } : undefined;
  const screen = await render(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
    renderOptions,
  );
  return {
    ...screen,
    unmount: async () => {
      await screen.unmount();
      queryClient.clear();
    },
  };
}

function claudeProvider(version: string, models: ReadonlyArray<string>): ServerProvider {
  const driver = ProviderDriverKind.make("claudeAgent");
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    driver,
    enabled: true,
    installed: true,
    version,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-28T00:00:00.000Z",
    models: models.map((slug) => ({
      slug,
      name:
        slug === "claude-opus-5"
          ? "Claude Opus 5"
          : slug === "claude-fable-5"
            ? "Claude Fable 5"
            : slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

function createDialogPrimaryKeybinding(
  key: string,
  options: { shiftKey?: boolean } = {},
): ResolvedKeybindingsConfig[number] {
  return {
    command: "dialog.primaryAction",
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: options.shiftKey ?? false,
      altKey: false,
      modKey: true,
    },
    whenAst: { type: "identifier", name: "dialogFocus" },
  };
}

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
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"], [role="option"], [data-slot="combobox-item"]',
      ),
    ).find(
      (element) =>
        element.getAttribute("aria-label") === text || element.textContent?.trim() === text,
    ) ?? null
  );
}

function findMenuItem(text: string): HTMLElement | null {
  if (text === "Claude") {
    const providerButton = document.querySelector<HTMLElement>(
      '[data-model-picker-provider="claudeAgent"]',
    );
    if (providerButton) {
      return providerButton;
    }
  }
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
  const button = Array.from(document.querySelectorAll("button")).find((element) =>
    element.textContent?.trim().startsWith("Start workflow"),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Start workflow button not found.");
  }
  return button;
}

function createModifiedEnterEvent(options: KeyboardEventInit = {}): KeyboardEvent {
  const useMetaForMod = isMacPlatform(navigator.platform);
  return new KeyboardEvent("keydown", {
    key: "Enter",
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

function dispatchModifiedEnter(
  target: EventTarget,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = createModifiedEnterEvent(options);
  target.dispatchEvent(event);
  return event;
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
      investigationWorkflows: [],
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
    nativeApiMocks.createInvestigationWorkflow.mockClear();
    nativeApiMocks.getConfig.mockClear();
    useStore.setState({
      projects: [],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      investigationWorkflows: [],
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
          cursor: [{ slug: "auto", name: "Auto" }],
          opencode: [{ slug: "openai/gpt-5", name: "OpenAI GPT-5" }],
          grok: [{ slug: "grok-build", name: "Grok Build" }],
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
          cursor: [{ slug: "auto", name: "Auto" }],
          opencode: [{ slug: "openai/gpt-5", name: "OpenAI GPT-5" }],
          grok: [{ slug: "grok-build", name: "Grok Build" }],
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
    const screen = await renderWithQueryClient(
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
        const rememberedOption = findMenuItemRadio("Claude Opus 4.7");
        expect(rememberedOption).not.toBeNull();
        expect(rememberedOption?.textContent ?? "").not.toContain("Active");
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

  it("falls back from remembered Opus 5 when the live Claude snapshot gates it out", async () => {
    await seedModelPreferences({
      lastProvider: "claudeAgent",
      lastModelByProvider: { claudeAgent: "opus-5[1m]" },
      lastModelOptions: { claudeAgent: { fastMode: true } },
      lastWorkflowProviderBySlot: { branchB: "claudeAgent" },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      {
        container: host,
        providers: [claudeProvider("2.1.219", ["claude-fable-5"])],
      },
    );

    try {
      await vi.waitFor(() => {
        expect(findProviderFieldButton("Author B").textContent ?? "").toContain("Fable 5");
      });
      await page
        .getByPlaceholder("Describe the feature or requirement to plan.")
        .fill("Plan the gated workflow");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1);
      });
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0].branchB).toEqual({
        provider: "claudeAgent",
        model: "claude-fable-5",
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("selects and submits canonical Opus 5 with Fast Mode when supported", async () => {
    await seedModelPreferences({
      lastProvider: "claudeAgent",
      lastModelByProvider: { claudeAgent: "opus-5[1m]" },
      lastModelOptions: { claudeAgent: { fastMode: true } },
      lastWorkflowProviderBySlot: { branchB: "claudeAgent" },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      {
        container: host,
        providers: [claudeProvider("2.1.220", ["claude-opus-5", "claude-fable-5"])],
      },
    );

    try {
      await vi.waitFor(() => {
        expect(findProviderFieldButton("Author B").textContent ?? "").toContain("Opus 5");
      });
      await page
        .getByPlaceholder("Describe the feature or requirement to plan.")
        .fill("Plan the Opus workflow");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1);
      });
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0].branchB).toEqual({
        provider: "claudeAgent",
        model: "claude-opus-5",
        modelOptions: { claudeAgent: { fastMode: true } },
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("remembers the merge provider when reopening the workflow dialog", async () => {
    const firstHost = document.createElement("div");
    document.body.append(firstHost);
    const firstScreen = await renderWithQueryClient(
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
    const secondScreen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: secondHost },
    );

    try {
      await vi.waitFor(() => {
        expect(findProviderFieldButton("Merge").textContent ?? "").toContain("Sonnet 4.6");
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
    const screen = await renderWithQueryClient(
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

  it("renders keyboard-navigable workflow type toggles with distinct hue classes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      const feature = page.getByRole("button", { name: "Feature" }).element();
      const codeReview = page.getByRole("button", { name: "Code Review" }).element();
      const investigation = page.getByRole("button", { name: "Investigation" }).element();

      expect(feature.getAttribute("aria-pressed")).toBe("true");
      expect(feature.className).toContain("data-pressed:bg-sky-500/15");
      expect(codeReview.className).toContain("data-pressed:bg-emerald-500/15");
      expect(investigation.className).toContain("data-pressed:bg-amber-500/15");

      await page.getByRole("button", { name: "Feature" }).click();
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => {
        expect(
          page.getByRole("button", { name: "Code Review" }).element().getAttribute("aria-pressed"),
        ).toBe("true");
        expect(document.activeElement).toBe(codeReview);
      });
      expect(document.body.textContent ?? "").toContain("Reviewer A");

      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => {
        expect(
          page
            .getByRole("button", { name: "Investigation" })
            .element()
            .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(document.activeElement).toBe(investigation);
      });
      expect(document.body.textContent ?? "").toContain("Investigator A");

      await userEvent.keyboard("{Home}");
      await vi.waitFor(() => {
        expect(
          page.getByRole("button", { name: "Feature" }).element().getAttribute("aria-pressed"),
        ).toBe("true");
        expect(document.activeElement).toBe(feature);
      });

      await userEvent.keyboard("{End}");
      await vi.waitFor(() => {
        expect(
          page
            .getByRole("button", { name: "Investigation" })
            .element()
            .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(document.activeElement).toBe(investigation);
      });

      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        expect(
          page.getByRole("button", { name: "Feature" }).element().getAttribute("aria-pressed"),
        ).toBe("true");
        expect(document.activeElement).toBe(feature);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows the configured dialog primary shortcut hint inside the start button", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      {
        container: host,
        keybindings: [createDialogPrimaryKeybinding("r", { shiftKey: true })],
      },
    );

    try {
      const startButton = page.getByRole("button", { name: "Start workflow" }).element();
      expect(startButton.querySelector('[data-slot="kbd"]')?.textContent ?? "").toBe(
        isMacPlatform(navigator.platform) ? "⇧⌘R" : "Ctrl+Shift+R",
      );
      expect(
        document.querySelector('[data-slot="dialog-footer"]')?.textContent ?? "",
      ).not.toContain("to start");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("starts a planning workflow from the dialog primary shortcut", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onWorkflowCreated = vi.fn();
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog
        open
        projectId={"project-1" as ProjectId}
        onOpenChange={() => {}}
        onWorkflowCreated={onWorkflowCreated}
      />,
      { container: host },
    );

    try {
      const prompt = page.getByPlaceholder("Describe the feature or requirement to plan.");
      await prompt.fill("Plan the new workflow behavior");

      dispatchModifiedEnter(prompt.element());

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
      await vi.waitFor(() => {
        expect(onWorkflowCreated).toHaveBeenCalledWith("workflow-1");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("does not start from the dialog primary shortcut when submit is disabled", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      const prompt = page.getByPlaceholder("Describe the feature or requirement to plan.");
      dispatchModifiedEnter(prompt.element());
      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(0);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("ignores IME composition and repeated primary-action keydowns", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      const prompt = page.getByPlaceholder("Describe the feature or requirement to plan.");
      await prompt.fill("Plan the new workflow behavior");

      const composingEvent = createModifiedEnterEvent();
      Object.defineProperty(composingEvent, "isComposing", { value: true });
      prompt.element().dispatchEvent(composingEvent);

      dispatchModifiedEnter(prompt.element(), { repeat: true });

      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(0);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps plain Enter in the prompt as a newline", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      const prompt = page.getByPlaceholder("Describe the feature or requirement to plan.");
      await prompt.click();
      await userEvent.keyboard("First line{Enter}Second line");

      const textarea = prompt.element();
      expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
      expect((textarea as HTMLTextAreaElement).value).toBe("First line\nSecond line");
      expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(0);
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
    const screen = await renderWithQueryClient(
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
      await vi.waitFor(() => {
        expect(onWorkflowCreated).toHaveBeenCalledWith("workflow-1");
      });
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
    const screen = await renderWithQueryClient(
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
      await vi.waitFor(() => {
        expect(onWorkflowCreated).toHaveBeenCalledWith("workflow-2");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("sends investigation workflow own-model review preference", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onWorkflowCreated = vi.fn();
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog
        open
        projectId={"project-1" as ProjectId}
        onOpenChange={() => {}}
        onWorkflowCreated={onWorkflowCreated}
      />,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: "Investigation" }).click();
      await page
        .getByPlaceholder(
          "Describe the problem, symptoms, suspected regression, or evidence to investigate.",
        )
        .fill("Investigate checkout timeouts");
      await page.getByText("Own-model review").click();

      await vi.waitFor(() => {
        expect(createWorkflowButton().disabled).toBe(false);
      });
      createWorkflowButton().click();

      await vi.waitFor(() => {
        expect(nativeApiMocks.createInvestigationWorkflow).toHaveBeenCalledTimes(1);
      });

      const firstCall = nativeApiMocks.createInvestigationWorkflow.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) {
        throw new Error("Expected investigation workflow request payload.");
      }
      const [payload] = firstCall;
      expect(payload).toMatchObject({
        projectId: "project-1",
        problemPrompt: "Investigate checkout timeouts",
        titleGenerationModel: "custom/thread-title-model",
        selfReviewEnabled: true,
      });
      await vi.waitFor(() => {
        expect(onWorkflowCreated).toHaveBeenCalledWith("workflow-3");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows removable file chips in the requirement editor", async () => {
    desktopBridgePathByFileName.set("AGENTS.md", "/repo/project/docs/AGENTS.md");

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
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
    const screen = await renderWithQueryClient(
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
