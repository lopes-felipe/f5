import { useState } from "react";
import type { ProviderModelOptions } from "@t3tools/contracts";
import { READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE } from "@t3tools/shared/workflowProviders";
import {
  createClaudeModelCapabilities,
  createModelCapabilities,
  createReportedClaudeModelCapabilities,
  createReportedCodexModelCapabilities,
} from "@t3tools/shared/model";
import "../../index.css";

import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  DesktopBridge,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationCreateInvestigationWorkflowInput,
  OrchestrationCreateWorkflowInput,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ServerProvider,
  WorkflowPlatformCreateRunInput,
} from "@t3tools/contracts";

import { appendAttachedFilesToPrompt } from "../../lib/attachedFiles";
import { toastManager } from "../ui/toast";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { isMacPlatform } from "../../lib/utils";
import {
  MODEL_PREFERENCES_STORAGE_KEY,
  useModelPreferencesStore,
} from "../../modelPreferencesStore";
import { useStore } from "../../store";
import { workspaceIdentityForRoot, writeFileTreeDragMention } from "../fileTreeDragMention";

const nativeApiMocks = vi.hoisted(() => ({
  createRun: vi.fn<(input: WorkflowPlatformCreateRunInput) => void>(),
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
  authorizeEntry: vi.fn(async (input: { relativePath: string }) => ({
    relativePath: input.relativePath,
    kind: "file" as const,
  })),
  uploadAttachment: vi.fn(async (_baseUrl: string, threadId: string, file: File) => ({
    uploadId: "00000000-0000-4000-8000-000000000001",
    draftThreadId: threadId,
    kind: "image" as const,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    contentHash: "hash",
    expiresAt: "2099-01-01T00:00:00.000Z",
  })),
  materializeUploads: vi.fn(async (input: { threadId: string; uploadIds: string[] }) => ({
    files: input.uploadIds.map((uploadId) => ({
      uploadId,
      path: `/state/workflow-attachments/${uploadId}/image.png`,
    })),
  })),
  releaseUploads: vi.fn(async () => ({})),
  discardMaterialized: vi.fn(async () => ({})),
}));

vi.mock("../../lib/attachmentUploadQueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/attachmentUploadQueue")>()),
  uploadAttachment: nativeApiMocks.uploadAttachment,
}));

vi.mock("../../nativeApi", () => {
  const createRun = async (input: WorkflowPlatformCreateRunInput) => {
    nativeApiMocks.createRun(input);
    const request = {
      ...input.input,
      ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
    };
    switch (input.templateId) {
      case "builtin.document.dual":
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
    projects: {
      authorizeEntry: nativeApiMocks.authorizeEntry,
    },
    attachments: {
      materializeUploads: nativeApiMocks.materializeUploads,
      releaseUploads: nativeApiMocks.releaseUploads,
      discardMaterialized: nativeApiMocks.discardMaterialized,
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

import { SlotRow } from "./SlotRow";
import { WorkflowCreateDialog } from "./WorkflowCreateDialog";
import { normalizeWorkflowSlotModelOptions } from "./workflowSlots";

const desktopBridgePathByFileName = new Map<string, string>();

/** The default `uploadAttachment` mock's id, and the path `materializeUploads` returns for it. */
const FIRST_UPLOAD_ID = "00000000-0000-4000-8000-000000000001";
const FIRST_UPLOAD_PATH = `/state/workflow-attachments/${FIRST_UPLOAD_ID}/image.png`;

function uploadRecord(threadId: string, file: File, uploadId: string) {
  return {
    uploadId,
    draftThreadId: threadId,
    kind: "image" as const,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    contentHash: "hash",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

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
  const desktopBridge: Pick<
    DesktopBridge,
    "getPathForFile" | "getWsUrl" | "resolveRealPath" | "setTheme"
  > = {
    getPathForFile: (file: File) => desktopBridgePathByFileName.get(file.name) ?? null,
    // The project picker's icons resolve asset URLs against the server origin.
    getWsUrl: () => "ws://localhost:3773",
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

/** The select button of a model picker row whose display name is `name`. */
function findModelRow(name: string): HTMLButtonElement | null {
  for (const row of document.querySelectorAll<HTMLElement>("[data-model-picker-row]")) {
    const select = row.querySelectorAll<HTMLButtonElement>("button")[1];
    if (select?.querySelector(".truncate")?.textContent?.trim() === name) return select;
  }
  return null;
}

/** The model picker rail entry for a provider's default instance. */
function findRailInstance(provider: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-model-picker-provider="instance:${defaultInstanceIdForDriver(ProviderDriverKind.make(provider))}"]`,
  );
}

function providerSnapshot(
  provider: string,
  models: ReadonlyArray<{
    slug: string;
    name: string;
    capabilities?: ServerProvider["models"][number]["capabilities"];
  }>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  const driver = ProviderDriverKind.make(provider);
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-28T00:00:00.000Z",
    models: models.map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      capabilities: model.capabilities ?? null,
    })),
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const EMPTY_MODEL_OPTIONS_BY_INSTANCE = new Map<ProviderInstanceId, never[]>();

/** An Antigravity snapshot whose Gemini row has a thinking level, as the live runtime reports. */
function antigravityProvider(readOnlyWorkflowTurns: boolean): ServerProvider {
  return providerSnapshot(
    "antigravity",
    [
      {
        slug: "gemini-4-neon",
        name: "Gemini 4 Neon",
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
          ],
        }),
      },
    ],
    {
      displayName: "Antigravity",
      runtimeCapabilities: {
        nativeReview: false,
        nativeCompaction: false,
        nativeFork: false,
        nativeGoals: false,
        nativeAttachments: false,
        childTaskInspection: false,
        childTaskStop: false,
        fileCheckpointing: false,
        turnSteering: true,
        conversationRollback: false,
        rollbackAffectsFiles: false,
        rollbackReadback: false,
        asyncQuestions: false,
        maxImagesPerTurn: 20,
        reportedModels: true,
        sessionCommandCatalog: true,
        instanceInventory: false,
        nativeSessionCleanup: false,
        readOnlyWorkflowTurns,
      },
    },
  );
}

const CODEX_EFFORT_BY_LABEL: Record<string, string> = {
  Low: "low",
  Medium: "medium",
  High: "high",
  "Extra High": "xhigh",
  Max: "max",
  Ultra: "ultra",
};

/** Codex and Claude snapshots with the models the dialog tests pick from. */
function defaultTestProviders(): ServerProvider[] {
  return [
    providerSnapshot("codex", [
      { slug: "gpt-5-codex", name: "GPT-5 Codex" },
      { slug: "gpt-5.4", name: "GPT-5.4" },
    ]),
    providerSnapshot("claudeAgent", [
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { slug: "claude-opus-4-7", name: "Claude Opus 4.7" },
    ]),
  ];
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

async function typeRequirementPrompt(text: string): Promise<void> {
  // Exercise Lexical's input events instead of racing its controlled draft with fill().
  await page.getByTestId("composer-editor").click();
  await userEvent.keyboard(text);
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
  const editor = document.querySelector('[data-testid="composer-editor"]');
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Workflow requirement editor not found.");
  }
  const surface = editor.closest(".composer-editor-surface")?.parentElement;
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

function pasteFilesOnRequirement(files: File[]) {
  const dataTransfer = new DataTransfer();
  for (const file of files) {
    dataTransfer.items.add(file);
  }
  getRequirementEditorSurface().dispatchEvent(
    new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer }),
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
    nativeApiMocks.createRun.mockClear();
    nativeApiMocks.createCodeReviewWorkflow.mockClear();
    nativeApiMocks.createInvestigationWorkflow.mockClear();
    nativeApiMocks.getConfig.mockClear();
    nativeApiMocks.authorizeEntry.mockClear();
    nativeApiMocks.uploadAttachment.mockClear();
    nativeApiMocks.materializeUploads.mockClear();
    nativeApiMocks.releaseUploads.mockClear();
    nativeApiMocks.discardMaterialized.mockClear();
    vi.restoreAllMocks();
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
    const screen = await renderWithQueryClient(
      <SlotRow
        label="Branch A"
        provider="codex"
        model="gpt-5-codex"
        modelOptions={{ codex: { reasoningEffort: "high" } }}
        modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
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

      await page.getByRole("menuitemradio", { name: /^Medium/ }).click();

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

  it("lines up the model field of a row without reasoning when the effort column is reserved", async () => {
    const host = document.createElement("div");
    host.style.width = "480px";
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <>
        <SlotRow
          label="With reasoning"
          provider="codex"
          model="gpt-5-codex"
          modelOptions={{ codex: { reasoningEffort: "high" } }}
          modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
          reserveTraitsColumn
          reserveTrailing
          onProviderModelChange={() => {}}
          onModelOptionsChange={() => {}}
        />
        <SlotRow
          label="Without reasoning"
          provider="cursor"
          model="auto"
          modelOptions={undefined}
          modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
          reserveTraitsColumn
          reserveTrailing
          trailing={<button type="button" aria-label="Remove" className="size-7" />}
          onProviderModelChange={() => {}}
          onModelOptionsChange={() => {}}
        />
      </>,
      { container: host },
    );

    try {
      const modelRight = (name: string) =>
        page
          .getByRole("group", { name })
          .element()
          .querySelector('[data-slot="workflow-slot-model"]')!
          .getBoundingClientRect().right;
      expect(modelRight("Without reasoning")).toBe(modelRight("With reasoning"));
      // The effort trigger is neutral in a slot: no effort-level tint.
      const effortTrigger = page
        .getByRole("group", { name: "With reasoning" })
        .element()
        .querySelector<HTMLElement>("[data-slot='workflow-slot-traits'] button")!;
      expect(effortTrigger.className).not.toMatch(/bg-effort-/);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders the effort field only when reasoning controls render", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <>
        <SlotRow
          label="With reasoning"
          provider="codex"
          model="gpt-5-codex"
          modelOptions={{ codex: { reasoningEffort: "high" } }}
          modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
          onProviderModelChange={() => {}}
          onModelOptionsChange={() => {}}
        />
        <SlotRow
          label="Without reasoning"
          provider="cursor"
          model="auto"
          modelOptions={undefined}
          modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
          onProviderModelChange={() => {}}
          onModelOptionsChange={() => {}}
        />
      </>,
      { container: host },
    );

    try {
      const withReasoning = page.getByRole("group", { name: "With reasoning" }).element();
      const withoutReasoning = page.getByRole("group", { name: "Without reasoning" }).element();
      expect(withReasoning.querySelector('[data-slot="workflow-slot-traits"]')).not.toBeNull();
      expect(withReasoning.querySelector("button[aria-haspopup='menu']")?.textContent).toBe("High");
      expect(withoutReasoning.querySelector('[data-slot="workflow-slot-traits"]')).toBeNull();
      expect(withoutReasoning.querySelector("button[aria-haspopup='menu']")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("offers Cursor's reported reasoning levels and stores the pick for dispatch", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const cursor = providerSnapshot("cursor", [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "reasoning",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        }),
      },
    ]);
    const onModelOptionsChange = vi.fn();
    const screen = await renderWithQueryClient(
      <SlotRow
        label="Cursor slot"
        provider="cursor"
        model="gpt-5.6-sol"
        modelOptions={undefined}
        providers={[cursor]}
        modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
        onProviderModelChange={() => {}}
        onModelOptionsChange={onModelOptionsChange}
      />,
      { container: host },
    );

    try {
      const row = page.getByRole("group", { name: "Cursor slot" }).element();
      expect(row.querySelector('[data-slot="workflow-slot-traits"]')).not.toBeNull();
      const trigger = row.querySelector<HTMLElement>("button[aria-haspopup='menu']")!;
      expect(trigger.textContent).toContain("Medium");
      trigger.click();
      await page.getByRole("menuitemradio", { name: /^High/ }).click();
      expect(onModelOptionsChange).toHaveBeenCalledWith({ cursor: { reasoning: "high" } });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows no traits for OpenCode slots, whose traits workflow turns never apply", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const opencode = providerSnapshot("opencode", [
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "variant",
              label: "Variant",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
          ],
        }),
      },
    ]);
    const screen = await renderWithQueryClient(
      <SlotRow
        label="OpenCode slot"
        provider="opencode"
        model="openai/gpt-5"
        modelOptions={{ opencode: { variant: "low" } }}
        providers={[opencode]}
        modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
        onProviderModelChange={() => {}}
        onModelOptionsChange={() => {}}
      />,
      { container: host },
    );

    try {
      const row = page.getByRole("group", { name: "OpenCode slot" }).element();
      expect(row.querySelector('[data-slot="workflow-slot-traits"]')).toBeNull();
      expect(row.querySelector("button[aria-haspopup='menu']")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("omits Ultra for Astra and normalizes persisted Ultra to Max", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onModelOptionsChange = vi.fn();
    const screen = await renderWithQueryClient(
      <SlotRow
        label="Branch A"
        provider="codex"
        model="gpt-6-astra"
        modelOptions={{ codex: { reasoningEffort: "ultra" } }}
        modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
        onProviderModelChange={() => {}}
        onModelOptionsChange={onModelOptionsChange}
      />,
      { container: host },
    );

    try {
      await page.getByRole("button", { name: /Max/ }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Ultra");
      });
      await page.getByRole("menuitemradio", { name: /^Max/ }).click();
      expect(onModelOptionsChange).toHaveBeenCalledWith({
        codex: { reasoningEffort: "max" },
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
    const screen = await renderWithQueryClient(
      <SlotRow
        label="Branch A"
        provider="claudeAgent"
        model="claude-opus-4-7"
        modelOptions={undefined}
        providers={[
          providerSnapshot("claudeAgent", [
            {
              slug: "claude-opus-4-7",
              name: "Claude Opus 4.7",
              capabilities: createClaudeModelCapabilities("claude-opus-4-7"),
            },
          ]),
        ]}
        modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
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

      await page.getByRole("menuitemradio", { name: /^Max/ }).click();

      await vi.waitFor(() => {
        // Like a thread, the Claude control saves its shown traits, including the default
        // context window.
        expect(onModelOptionsChange).toHaveBeenCalledWith({
          claudeAgent: { effort: "max", contextWindow: "200k" },
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
      { container: host, providers: defaultTestProviders() },
    );

    try {
      findProviderFieldButton("Author A").click();

      await vi.waitFor(() => {
        expect(findRailInstance("claudeAgent")).not.toBeNull();
      });

      findRailInstance("claudeAgent")?.click();

      await vi.waitFor(() => {
        const rememberedOption = findModelRow("Claude Opus 4.7");
        expect(rememberedOption).not.toBeNull();
        expect(rememberedOption?.textContent ?? "").not.toContain("Active");
      });

      findModelRow("Claude Sonnet 4.6")?.click();

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
      await typeRequirementPrompt("Plan the gated workflow");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1);
      });
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0].branchB).toEqual({
        provider: "claudeAgent",
        model: "claude-fable-5",
        providerOptions: {
          claudeAgent: {
            subagentsEnabled: true,
            subagentModel: "inherit",
          },
        },
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
      await typeRequirementPrompt("Plan the Opus workflow");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1);
      });
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0].branchB).toEqual({
        provider: "claudeAgent",
        model: "claude-opus-5",
        modelOptions: { claudeAgent: { fastMode: true } },
        providerOptions: {
          claudeAgent: { subagentsEnabled: true, subagentModel: "inherit" },
        },
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("submits persisted Fable 5.2 aliases with supported effort only", async () => {
    await seedModelPreferences({
      lastProvider: "claudeAgent",
      lastModelByProvider: { claudeAgent: "fable[200k]" },
      lastModelOptions: {
        claudeAgent: { effort: "xhigh", fastMode: true, contextWindow: "200k", thinking: false },
      },
      lastWorkflowProviderBySlot: { branchB: "claudeAgent" },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      {
        container: host,
        providers: [
          claudeProvider("2.1.290", ["claude-opus-5", "claude-fable-5-2", "claude-fable-5"]),
        ],
      },
    );
    try {
      await typeRequirementPrompt("Plan Fable support");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1));
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0].branchB).toEqual({
        provider: "claudeAgent",
        model: "claude-fable-5-2",
        modelOptions: { claudeAgent: { effort: "xhigh" } },
        providerOptions: { claudeAgent: { subagentsEnabled: true, subagentModel: "inherit" } },
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
      { container: firstHost, providers: defaultTestProviders() },
    );

    try {
      findProviderFieldButton("Merge").click();

      await vi.waitFor(() => {
        expect(findRailInstance("claudeAgent")).not.toBeNull();
      });

      findRailInstance("claudeAgent")?.click();

      await vi.waitFor(() => {
        expect(findModelRow("Claude Sonnet 4.6")).not.toBeNull();
      });

      findModelRow("Claude Sonnet 4.6")?.click();

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
      { container: secondHost, providers: defaultTestProviders() },
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

  it("lists uncertified Antigravity models disabled with the read-only reason", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host, providers: [...defaultTestProviders(), antigravityProvider(false)] },
    );

    try {
      findProviderFieldButton("Author A").click();
      await vi.waitFor(() => expect(findRailInstance("antigravity")).not.toBeNull());
      findRailInstance("antigravity")!.click();

      await vi.waitFor(() => expect(findModelRow("Gemini 4 Neon")).not.toBeNull());
      const row = findModelRow("Gemini 4 Neon")!;
      expect(row.disabled).toBe(true);
      expect(row.textContent).toContain(READ_ONLY_WORKFLOW_UNCERTIFIED_ANTIGRAVITY_MESSAGE);
      expect(document.body.textContent).not.toContain("No models found");

      row.click();
      expect(findProviderFieldButton("Author A").textContent).not.toContain("Gemini");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("picks a certified Antigravity model and submits its thinking level", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host, providers: [...defaultTestProviders(), antigravityProvider(true)] },
    );

    try {
      findProviderFieldButton("Author A").click();
      await vi.waitFor(() => expect(findRailInstance("antigravity")).not.toBeNull());
      findRailInstance("antigravity")!.click();
      await vi.waitFor(() => expect(findModelRow("Gemini 4 Neon")?.disabled).toBe(false));
      findModelRow("Gemini 4 Neon")!.click();
      await vi.waitFor(() =>
        expect(findProviderFieldButton("Author A").textContent).toContain("Gemini 4 Neon"),
      );

      const authorA = page.getByRole("group", { name: "Author A" }).element();
      authorA.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!.click();
      await page.getByRole("menuitemradio", { name: /^Low/ }).click();

      await typeRequirementPrompt("Plan with Gemini");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1));
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0].branchA).toMatchObject({
        provider: "antigravity",
        model: "gemini-4-neon",
        modelOptions: { antigravity: { thinking: "low" } },
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("lists only the instance each workflow slot runs on", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      {
        container: host,
        providers: [
          ...defaultTestProviders(),
          providerSnapshot("codex", [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }], {
            instanceId: "codex_work" as ProviderInstanceId,
            displayName: "Codex Work",
          }),
        ],
      },
    );

    try {
      findProviderFieldButton("Author A").click();
      await vi.waitFor(() => expect(findRailInstance("codex")).not.toBeNull());
      expect(
        document.querySelector('[data-model-picker-provider="instance:codex_work"]'),
      ).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("submits the Codex effort the traits control shows when none was picked", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host, providers: defaultTestProviders() },
    );

    try {
      const authorA = page.getByRole("group", { name: "Author A" }).element();
      await vi.waitFor(() =>
        expect(authorA.querySelector("button[aria-haspopup='menu']")).not.toBeNull(),
      );
      const shown = authorA.querySelector("button[aria-haspopup='menu']")!.textContent!.trim();
      await typeRequirementPrompt("Plan the default effort");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1));
      const branchA = nativeApiMocks.createWorkflow.mock.calls[0]?.[0].branchA;
      expect(branchA?.provider).toBe("codex");
      expect(branchA?.modelOptions?.codex?.reasoningEffort).toBe(CODEX_EFFORT_BY_LABEL[shown]);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps workflow codex effort explicit when it equals the default", () => {
    // Codex may report a different default than the client knows, so the
    // shown effort is saved instead of being left for the server to fill.
    expect(
      normalizeWorkflowSlotModelOptions("codex", "gpt-5-codex", {
        codex: { reasoningEffort: "high" },
      }),
    ).toEqual({ codex: { reasoningEffort: "high" } });
  });

  it("saves the effort the Codex picker showed when none was picked", () => {
    const reported = createReportedCodexModelCapabilities({
      model: "gpt-6.1-sol",
      supportedReasoningEfforts: [
        { reasoningEffort: "max" },
        { reasoningEffort: "high" },
        { reasoningEffort: "low" },
      ],
      defaultReasoningEffort: "low",
      serviceTiers: [],
    });
    expect(normalizeWorkflowSlotModelOptions("codex", "gpt-6.1-sol", undefined, reported)).toEqual({
      codex: { reasoningEffort: "low" },
    });
    expect(normalizeWorkflowSlotModelOptions("codex", "gpt-6.1-sol", undefined)).toEqual({
      codex: { reasoningEffort: "high" },
    });
    expect(
      normalizeWorkflowSlotModelOptions(
        "codex",
        "gpt-6.1-sol",
        { codex: { reasoningEffort: "ultra" } },
        reported,
      ),
    ).toEqual({ codex: { reasoningEffort: "max" } });
  });

  it("clamps unsupported Astra workflow reasoning before submission", () => {
    expect(
      normalizeWorkflowSlotModelOptions("codex", "gpt-6-astra", {
        codex: { reasoningEffort: "ultra" },
      }),
    ).toEqual({
      codex: { reasoningEffort: "max" },
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

      await typeRequirementPrompt("Plan the new workflow behavior");

      await vi.waitFor(() => {
        expect(createWorkflowButton().disabled).toBe(false);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("follows the merge model until the reader is selected and blocks identical authors", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host, providers: defaultTestProviders() },
    );
    const chooseClaude = async (field: string, model: string) => {
      findProviderFieldButton(field).click();
      await vi.waitFor(() => expect(findRailInstance("claudeAgent")).not.toBeNull());
      findRailInstance("claudeAgent")!.click();
      await vi.waitFor(() => expect(findModelRow(model)).not.toBeNull());
      findModelRow(model)!.click();
      await vi.waitFor(() =>
        expect(findProviderFieldButton(field).textContent, field).toContain(
          model.replace("Claude ", ""),
        ),
      );
      await vi.waitFor(() => expect(findRailInstance("claudeAgent")).toBeNull());
    };
    try {
      await page.getByRole("button", { name: "Document", exact: true }).click();
      await typeRequirementPrompt("Describe the migration");
      await chooseClaude("Author B", "Claude Sonnet 4.6");
      expect(findProviderFieldButton("Reader model").textContent).toContain("Sonnet 4.6");
      const authorA = findProviderFieldButton("Author A").textContent;
      await chooseClaude("Merge model", "Claude Sonnet 4.6");
      expect(findProviderFieldButton("Reader model").textContent).toBe(authorA);
      await chooseClaude("Reader model", "Claude Sonnet 4.6");
      expect(document.body.textContent).toContain(
        "The reader is the model that writes the final document",
      );
      await chooseClaude("Merge model", "Claude Opus 4.7");
      expect(findProviderFieldButton("Reader model").textContent).toContain("Sonnet 4.6");
      await chooseClaude("Author A", "Claude Sonnet 4.6");
      expect(document.body.textContent).toContain(
        "Document workflows need two different author models.",
      );
      expect(createWorkflowButton().disabled).toBe(true);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("creates an ADR with reader review and no implementation fields", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );
    try {
      await page.getByRole("button", { name: "Document", exact: true }).click();
      await page.getByRole("combobox", { name: "Document type" }).click();
      await page.getByRole("option", { name: "ADR", exact: true }).click();
      await typeRequirementPrompt("Record why we chose queues");
      expect(document.body.textContent).toContain("/ 24,000");
      expect(document.body.textContent).not.toContain("Plans directory");
      expect(document.body.textContent).not.toContain("Compare against branch");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => expect(nativeApiMocks.createRun).toHaveBeenCalledTimes(1));
      const request = nativeApiMocks.createRun.mock.calls[0]![0];
      expect(request.templateId).toBe("builtin.document.dual");
      expect(request.input).toMatchObject({
        documentType: "adr",
        selfReviewEnabled: true,
        readerReviewEnabled: true,
      });
      expect(request.input).not.toHaveProperty("plansDirectory");
      expect(request.input).not.toHaveProperty("readerPersona");
      if (request.templateId === "builtin.document.dual") {
        const expected =
          request.input.branchA.provider !== request.input.merge.provider ||
          request.input.branchA.model !== request.input.merge.model
            ? request.input.branchA
            : request.input.branchB;
        expect(request.input.reader).toEqual(expected);
      }
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
  it("preserves a custom reader persona across categories and omits the reader when disabled", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );
    try {
      await page.getByRole("button", { name: "Document", exact: true }).click();
      await page.getByRole("textbox", { name: "Reader persona (optional)" }).fill("The CFO");
      await page.getByRole("combobox", { name: "Document type" }).click();
      await page.getByRole("option", { name: "One-pager", exact: true }).click();
      expect(
        (
          page
            .getByRole("textbox", { name: "Reader persona (optional)" })
            .element() as HTMLTextAreaElement
        ).value,
      ).toBe("The CFO");
      await page.getByRole("checkbox", { name: /Reader review of the final document/ }).click();
      await expect
        .element(page.getByRole("textbox", { name: "Reader persona (optional)" }))
        .not.toBeInTheDocument();
      await typeRequirementPrompt("Fund the migration");
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => expect(nativeApiMocks.createRun).toHaveBeenCalledTimes(1));
      expect(nativeApiMocks.createRun.mock.calls[0]![0].input).toMatchObject({
        readerReviewEnabled: false,
      });
      expect(nativeApiMocks.createRun.mock.calls[0]![0].input).not.toHaveProperty("reader");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
  it("shows workflow types as described cards and keeps secondary settings in Options", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      const feature = page.getByRole("button", { name: "Feature", exact: true }).element();
      const descriptionId = feature.getAttribute("aria-describedby");
      expect(descriptionId).toBe("workflow-type-description-planning");
      expect(document.getElementById(descriptionId!)?.textContent).toContain(
        "Two models draft competing plans",
      );
      expect(
        document.querySelectorAll('[data-slot="workflow-slot-row"]').length,
      ).toBeGreaterThanOrEqual(3);

      // Collapsed by default, with a summary of the current choices.
      expect(document.body.textContent).not.toContain("Plans directory");
      const options = page.getByRole("button", { name: /^Options/ });
      expect(options.element().textContent).toContain("Own-model review");
      expect(options.element().textContent).toContain("plans/");
      await options.click();
      await expect.element(page.getByText("Plans directory", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Run cost limit in USD (optional)", { exact: true }))
        .toBeVisible();
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
      const documentToggle = page.getByRole("button", { name: "Document" }).element();

      expect(feature.getAttribute("aria-pressed")).toBe("true");
      expect(feature.className).toContain("data-pressed:bg-info/10");
      expect(codeReview.className).toContain("data-pressed:bg-success/10");
      expect(investigation.className).toContain("data-pressed:bg-warning/10");

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
          page.getByRole("button", { name: "Document" }).element().getAttribute("aria-pressed"),
        ).toBe("true");
        expect(document.activeElement).toBe(documentToggle);
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
      const prompt = page.getByTestId("composer-editor");
      await typeRequirementPrompt("Plan the new workflow behavior");

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
        branchA: { provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex },
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
      const prompt = page.getByTestId("composer-editor");
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
      const prompt = page.getByTestId("composer-editor");
      await typeRequirementPrompt("Plan the new workflow behavior");

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
      const prompt = page.getByTestId("composer-editor");
      await prompt.click();
      await userEvent.keyboard("First line{Enter}Second line");

      const textarea = prompt.element();
      expect(textarea).toBeInstanceOf(HTMLElement);
      expect((textarea as HTMLElement).innerText).toBe("First line\nSecond line");
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
      await typeRequirementPrompt("Plan the new workflow behavior");

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
      expect(nativeApiMocks.createRun.mock.calls[0]?.[0]).not.toHaveProperty("templateVersion");
      await vi.waitFor(() => {
        expect(onWorkflowCreated).toHaveBeenCalledWith("workflow-1");
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("adds, removes and relabels author rows up to the maximum", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog
        open
        projectId={"project-1" as ProjectId}
        onOpenChange={vi.fn()}
        onWorkflowCreated={vi.fn()}
      />,
      { container: host },
    );
    const addAuthorButton = () => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (element) => element.textContent?.trim() === "Add author",
      );
      if (!(button instanceof HTMLButtonElement)) throw new Error("Add author button not found.");
      return button;
    };
    const rowLabels = () =>
      Array.from(document.querySelectorAll("label"))
        .map((element) => element.textContent?.trim() ?? "")
        .filter((text) => /^Author [A-F]$/.test(text));

    try {
      await typeRequirementPrompt("Plan with more authors");
      expect(rowLabels()).toEqual(["Author A", "Author B"]);

      addAuthorButton().click();
      addAuthorButton().click();
      await vi.waitFor(() => {
        expect(rowLabels()).toEqual(["Author A", "Author B", "Author C", "Author D"]);
      });
      expect(addAuthorButton().disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "4 authors: 12 cross-reviews, 4 own-model reviews, 4 revisions, 1 merge",
      );
      // Removable and fixed rows share one column grid, and the estimate closes the
      // section after the merge row.
      const slotRow = (label: string) => {
        const row = document.querySelector(
          `[data-slot="workflow-slot-row"][aria-label="${label}"]`,
        );
        if (!row) throw new Error(`${label} row not found.`);
        return row;
      };
      const rightEdge = (row: Element, slot: string) =>
        row.querySelector(`[data-slot="${slot}"]`)?.getBoundingClientRect().right;
      const alignedRows = [slotRow("Author A"), slotRow("Author C"), slotRow("Merge")];
      const modelEdges = alignedRows.map((row) => rightEdge(row, "workflow-slot-model"));
      expect(modelEdges[0]).toBeDefined();
      expect(new Set(modelEdges).size).toBe(1);
      const effortEdges = alignedRows
        .map((row) => rightEdge(row, "workflow-slot-traits"))
        .filter((edge) => edge !== undefined);
      expect(new Set(effortEdges).size).toBeLessThanOrEqual(1);
      const estimate = document.querySelector('[data-slot="workflow-turn-estimate"]');
      if (!estimate) throw new Error("Turn estimate not found.");
      expect(
        slotRow("Merge").compareDocumentPosition(estimate) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      const rowText = (label: string) =>
        document.querySelector(`[data-slot="workflow-slot-row"][aria-label="${label}"]`)
          ?.textContent ?? "";
      const authorCBefore = rowText("Author C");
      const authorDBefore = rowText("Author D");
      expect(authorDBefore).not.toBe(authorCBefore);
      const removeC = document.querySelector('button[aria-label="Remove Author C"]');
      if (!(removeC instanceof HTMLButtonElement)) throw new Error("Remove Author C not found.");
      removeC.click();
      await vi.waitFor(() => {
        expect(rowLabels()).toEqual(["Author A", "Author B", "Author C"]);
      });
      expect(addAuthorButton().disabled).toBe(false);
      // The former Author D keeps its model under its new label.
      expect(rowText("Author C").replace("Author C", "")).toBe(
        authorDBefore.replace("Author D", ""),
      );

      await vi.waitFor(() => {
        expect(createWorkflowButton().disabled).toBe(false);
      });
      createWorkflowButton().click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1);
      });
      const [payload] = nativeApiMocks.createWorkflow.mock.calls[0]!;
      expect(payload.additionalBranches).toHaveLength(1);
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

      await typeRequirementPrompt("Review the workflow changes");

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
      expect(nativeApiMocks.createRun.mock.calls[0]?.[0]).not.toHaveProperty("templateVersion");
      await vi.waitFor(() => {
        expect(onWorkflowCreated).toHaveBeenCalledWith("workflow-2");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("enables auto-post only for a detected GitHub pull request", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );
    const autoPost = () =>
      page.getByRole("checkbox", { name: /Post merged review to the PR when it finishes/ });

    try {
      await page.getByRole("button", { name: "Code Review" }).click();
      await typeRequirementPrompt("Review the workflow changes");
      await expect.element(autoPost()).toBeDisabled();
      await expect
        .element(page.getByText("Add a GitHub PR link or PR #number to the review instructions."))
        .toBeVisible();

      await typeRequirementPrompt(" for issue #42");
      await expect.element(autoPost()).toBeDisabled();

      await typeRequirementPrompt(" in PR #42");
      await expect
        .element(page.getByText(/^PR #42 in this project's GitHub repo\. It posts from your/))
        .toBeVisible();

      await typeRequirementPrompt(" https://github.com/acme/app/pull/42");
      await expect.element(page.getByText(/^Will post to acme\/app#42\./)).toBeVisible();
      await expect.element(autoPost()).toBeEnabled();
      await autoPost().click();

      await vi.waitFor(() => {
        expect(createWorkflowButton().disabled).toBe(false);
      });
      createWorkflowButton().click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.createCodeReviewWorkflow).toHaveBeenCalledTimes(1);
      });
      expect(nativeApiMocks.createCodeReviewWorkflow.mock.calls[0]?.[0]).toMatchObject({
        autoPost: true,
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
      await typeRequirementPrompt("Investigate checkout timeouts");
      // Own-model review lives in the collapsed Options section.
      await page.getByRole("button", { name: /^Options/ }).click();
      await page.getByText("Own-model review", { exact: true }).click();

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
      expect(nativeApiMocks.createRun.mock.calls[0]?.[0]).not.toHaveProperty("templateVersion");
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

  it("attaches a pasted path-less screenshot through a durable server copy", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);

      await vi.waitFor(() =>
        expect(
          page
            .getByTitle(
              "/state/workflow-attachments/00000000-0000-4000-8000-000000000001/image.png",
            )
            .elements(),
        ).toHaveLength(1),
      );
      expect(nativeApiMocks.uploadAttachment).toHaveBeenCalledTimes(1);
      const draftThreadId = nativeApiMocks.uploadAttachment.mock.calls[0]![1];
      expect(draftThreadId).toMatch(/^workflow-draft-/);
      expect(nativeApiMocks.materializeUploads).toHaveBeenCalledWith({
        threadId: draftThreadId,
        uploadIds: ["00000000-0000-4000-8000-000000000001"],
      });
      expect(addToast).not.toHaveBeenCalled();

      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1));
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0].requirementPrompt).toContain(
        "/state/workflow-attachments/00000000-0000-4000-8000-000000000001/image.png",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("reports a failed pasted-file upload without adding a chip", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    nativeApiMocks.uploadAttachment.mockRejectedValueOnce(new Error("Upload capacity is busy."));
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);

      await vi.waitFor(() =>
        expect(addToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Couldn't attach the file.",
            description: "Upload capacity is busy.",
          }),
        ),
      );
      // The toast fires in `catch`; the pending count clears in `finally`.
      await vi.waitFor(() => expect(document.body.textContent ?? "").not.toContain("Attaching"));
      expect(nativeApiMocks.materializeUploads).not.toHaveBeenCalled();
      expect(document.querySelector('[data-slot="file-chip"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("releases the uploads that succeeded when another file in the paste fails", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    nativeApiMocks.uploadAttachment
      .mockImplementationOnce(async (_baseUrl: string, threadId: string, file: File) =>
        uploadRecord(threadId, file, FIRST_UPLOAD_ID),
      )
      .mockRejectedValueOnce(new Error("Upload timed out. Retry the file."));
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      pasteFilesOnRequirement([
        new File(["png"], "one.png", { type: "image/png" }),
        new File(["png"], "two.png", { type: "image/png" }),
      ]);

      await vi.waitFor(() =>
        expect(addToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Couldn't attach the files.",
            description: "Upload timed out. Retry the file.",
          }),
        ),
      );
      expect(nativeApiMocks.materializeUploads).not.toHaveBeenCalled();
      expect(nativeApiMocks.releaseUploads).toHaveBeenCalledWith({
        threadId: expect.stringMatching(/^workflow-draft-/),
        uploadIds: [FIRST_UPLOAD_ID],
      });
      expect(document.querySelector('[data-slot="file-chip"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("releases the uploads and reports the error when saving them fails", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    nativeApiMocks.materializeUploads.mockRejectedValueOnce(
      new Error("Saved workflow attachments are using their full quota. Retry later."),
    );
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);

      await vi.waitFor(() =>
        expect(addToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Couldn't attach the file.",
            description: "Saved workflow attachments are using their full quota. Retry later.",
          }),
        ),
      );
      expect(nativeApiMocks.releaseUploads).toHaveBeenCalledWith({
        threadId: expect.stringMatching(/^workflow-draft-/),
        uploadIds: [FIRST_UPLOAD_ID],
      });
      expect(document.querySelector('[data-slot="file-chip"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("skips empty files and folders instead of uploading them", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      await dropFilesOnRequirement([new File([], "folder", { type: "" })]);

      await vi.waitFor(() =>
        expect(addToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "warning",
            title: "Empty files and folders can't be attached.",
          }),
        ),
      );
      expect(nativeApiMocks.uploadAttachment).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("discards the saved copy when its chip is removed", async () => {
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="file-chip"]')).not.toBeNull(),
      );

      await page.getByRole("button", { name: `Remove ${FIRST_UPLOAD_PATH}` }).click();

      await vi.waitFor(() =>
        expect(nativeApiMocks.discardMaterialized).toHaveBeenCalledWith({
          uploadIds: [FIRST_UPLOAD_ID],
        }),
      );
      expect(document.querySelector('[data-slot="file-chip"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("discards saved copies when the dialog closes without starting a workflow", async () => {
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="file-chip"]')).not.toBeNull(),
    );

    await screen.unmount();

    expect(nativeApiMocks.discardMaterialized).toHaveBeenCalledWith({
      uploadIds: [FIRST_UPLOAD_ID],
    });
  });

  it("keeps saved copies that a started workflow references", async () => {
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="file-chip"]')).not.toBeNull(),
      );
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1));
    } finally {
      await screen.unmount();
    }
    expect(nativeApiMocks.discardMaterialized).not.toHaveBeenCalled();
  });

  it("discards a copy that finishes saving after the dialog closed", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    let finishUpload: (() => void) | undefined;
    nativeApiMocks.uploadAttachment.mockImplementationOnce(
      async (_baseUrl: string, threadId: string, file: File) => {
        await new Promise<void>((resolve) => {
          finishUpload = resolve;
        });
        return uploadRecord(threadId, file, FIRST_UPLOAD_ID);
      },
    );
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(finishUpload).toBeDefined());

    await screen.unmount();
    finishUpload?.();

    await vi.waitFor(() =>
      expect(nativeApiMocks.discardMaterialized).toHaveBeenCalledWith({
        uploadIds: [FIRST_UPLOAD_ID],
      }),
    );
    expect(addToast).not.toHaveBeenCalled();
  });

  it("blocks starting the workflow while a pasted file is still attaching", async () => {
    let finishUpload: (() => void) | undefined;
    nativeApiMocks.uploadAttachment.mockImplementationOnce(
      async (_baseUrl: string, threadId: string, file: File) => {
        await new Promise<void>((resolve) => {
          finishUpload = resolve;
        });
        return uploadRecord(threadId, file, FIRST_UPLOAD_ID);
      },
    );
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      await typeRequirementPrompt("Look at this screenshot");
      expect(createWorkflowButton().disabled).toBe(false);
      pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);

      await vi.waitFor(() => expect(document.body.textContent ?? "").toContain("Attaching…"));
      expect(createWorkflowButton().disabled).toBe(true);

      finishUpload?.();
      await vi.waitFor(() => expect(createWorkflowButton().disabled).toBe(false));
      expect(document.body.textContent ?? "").not.toContain("Attaching…");
    } finally {
      await screen.unmount();
    }
  });

  it("submits literal handles and quoted paths without authorizing them", async () => {
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      await typeRequirementPrompt('Use @creditornot/wolt-auth and @"src/main.ts" please');
      await page.getByRole("button", { name: /Start workflow/ }).click();
      await vi.waitFor(() => expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1));
      expect(nativeApiMocks.authorizeEntry).not.toHaveBeenCalled();
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0].requirementPrompt).toBe(
        'Use @creditornot/wolt-auth and @"src/main.ts" please',
      );
    } finally {
      await screen.unmount();
    }
  });

  it("accepts an authorized internal file drag and rechecks it on submit", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
      { container: host },
    );

    try {
      // Allow the controlled editor to finish mounting before the synthetic drop.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const transfer = new DataTransfer();
      writeFileTreeDragMention(transfer, {
        projectId: "project-1",
        workspaceIdentity: workspaceIdentityForRoot("project-1", "/repo/project"),
        relativePath: "docs/AGENTS.md",
      });
      getRequirementEditorSurface().dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );

      await vi.waitFor(
        () => {
          expect(document.querySelectorAll("[data-composer-mention-chip]")).toHaveLength(1);
        },
        { timeout: 5_000 },
      );
      expect(nativeApiMocks.authorizeEntry).toHaveBeenCalledWith({
        cwd: "/repo/project",
        relativePath: "docs/AGENTS.md",
        kind: "file",
      });

      nativeApiMocks.authorizeEntry.mockRejectedValueOnce(
        new Error("File not found: docs/AGENTS.md"),
      );
      createWorkflowButton().click();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("File not found: docs/AGENTS.md"),
      );
      expect(nativeApiMocks.createWorkflow).not.toHaveBeenCalled();
      expect(document.querySelectorAll("[data-composer-mention-chip]")).toHaveLength(1);

      createWorkflowButton().click();
      await vi.waitFor(() => expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1));
      expect(nativeApiMocks.authorizeEntry).toHaveBeenCalledWith({
        cwd: "/repo/project",
        relativePath: "docs/AGENTS.md",
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("preserves a dropped mention when the focus frame precedes the queued React render", async () => {
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.all(
        page
          .getByRole("dialog")
          .element()
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
      const editor = page.getByTestId("composer-editor");
      await editor.fill("@docs/AGENTS.md ");
      await vi.waitFor(() => expect(createWorkflowButton().disabled).toBe(false));
      let authorize!: (entry: { relativePath: string; kind: "file" }) => void;
      nativeApiMocks.authorizeEntry.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            authorize = resolve;
          }),
      );
      const transfer = new DataTransfer();
      writeFileTreeDragMention(transfer, {
        projectId: "project-1",
        workspaceIdentity: workspaceIdentityForRoot("project-1", "/repo/project"),
        relativePath: "docs/AGENTS.md",
      });
      getRequirementEditorSurface().dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      await vi.waitFor(() => expect(nativeApiMocks.authorizeEntry).toHaveBeenCalledOnce());
      // React can defer a default-priority render beyond the next frame.
      // Deliver that frame before React's scheduled task, after pending microtasks.
      const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementationOnce((callback) => {
        queueMicrotask(() => callback(performance.now()));
        return 0;
      });
      try {
        authorize({ relativePath: "docs/AGENTS.md", kind: "file" });
        await vi.waitFor(() =>
          expect(document.querySelectorAll("[data-composer-mention-chip]")).toHaveLength(1),
        );
        expect(editor.element().textContent).toContain("@docs/AGENTS.md");
      } finally {
        frame.mockRestore();
      }
    } finally {
      await screen.unmount();
    }
  });

  it("keeps workflow mention identity through deletion, undo and redo beside identical literal text", async () => {
    const screen = await renderWithQueryClient(
      <WorkflowCreateDialog open projectId={"project-1" as ProjectId} onOpenChange={() => {}} />,
    );
    try {
      const editor = page.getByTestId("composer-editor");
      await editor.fill("@docs/AGENTS.md ");
      // The enabled action observes the controlled parent draft, rather than
      // relying on a fixed number of frames after the editor's DOM update.
      await vi.waitFor(() => expect(createWorkflowButton().disabled).toBe(false));
      const transfer = new DataTransfer();
      writeFileTreeDragMention(transfer, {
        projectId: "project-1",
        workspaceIdentity: workspaceIdentityForRoot("project-1", "/repo/project"),
        relativePath: "docs/AGENTS.md",
      });
      getRequirementEditorSurface().dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      const chipCount = () => document.querySelectorAll("[data-composer-mention-chip]").length;
      await vi.waitFor(() => expect(chipCount()).toBe(1), { timeout: 5000 });
      // Drop schedules focusAtEnd on a frame after committing the mention.
      // Deletion must start from that caret, not the selection left by fill().
      await vi.waitFor(() => {
        const surface = editor.element();
        const selection = window.getSelection();
        expect(document.activeElement).toBe(surface);
        expect(selection?.isCollapsed).toBe(true);
        const range = document.createRange();
        range.selectNodeContents(surface);
        range.setEnd(selection!.anchorNode!, selection!.anchorOffset);
        expect(range.toString()).toBe(surface.textContent);
      });
      await userEvent.keyboard("{Backspace}{Backspace}");
      await vi.waitFor(() => expect(chipCount()).toBe(0));
      expect(editor.element().textContent).toContain("@docs/AGENTS.md");
      const modifier = /Mac/.test(navigator.platform) ? "Meta" : "Control";
      const undo = "{" + modifier + ">}z{/" + modifier + "}";
      await userEvent.keyboard(undo);
      await vi.waitFor(() => expect(chipCount()).toBe(1), { timeout: 5000 });
      await userEvent.keyboard("{" + modifier + ">}{Shift>}z{/Shift}{/" + modifier + "}");
      await vi.waitFor(() => expect(chipCount()).toBe(0));
      await userEvent.keyboard(undo);
      await vi.waitFor(() => expect(chipCount()).toBe(1), { timeout: 5000 });
      nativeApiMocks.authorizeEntry.mockClear();
      createWorkflowButton().click();
      await vi.waitFor(() => expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1));
      expect(nativeApiMocks.authorizeEntry).toHaveBeenCalledExactlyOnceWith({
        cwd: "/repo/project",
        relativePath: "docs/AGENTS.md",
      });
    } finally {
      await screen.unmount();
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

  it("switches project in place, keeping the brief and clearing file references", async () => {
    const baseProject = useStore.getState().projects[0]!;
    useStore.setState({
      projects: [
        baseProject,
        { ...baseProject, id: "project-2" as ProjectId, name: "Second", cwd: "/repo/second" },
        {
          ...baseProject,
          id: "scratch" as ProjectId,
          name: "Scratch home",
          cwd: "/scratch",
          kind: "scratch",
        },
      ],
    });
    desktopBridgePathByFileName.set("package.json", "/repo/project/packages/shared/package.json");
    function Host() {
      const [projectId, setProjectId] = useState("project-1" as ProjectId);
      return (
        <WorkflowCreateDialog
          open
          projectId={projectId}
          onOpenChange={() => {}}
          onProjectChange={setProjectId}
        />
      );
    }

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(<Host />, { container: host });

    try {
      await dropFilesOnRequirement([
        new File(['{"name":"shared"}'], "package.json", { type: "application/json" }),
      ]);
      await typeRequirementPrompt("Plan the import flow");
      await vi.waitFor(() => {
        expect(document.querySelector('[title="packages/shared/package.json"]')).not.toBeNull();
      });

      await page.getByRole("combobox", { name: "Project: Project" }).click();
      expect(page.getByTestId("project-picker-no-project").elements()).toHaveLength(0);
      expect(page.getByRole("option", { name: "Scratch home" }).elements()).toHaveLength(0);
      await page.getByRole("option", { name: "Second" }).click();

      await expect
        .element(page.getByText("File references were cleared for the new project."))
        .toBeVisible();
      expect(document.querySelector('[title="packages/shared/package.json"]')).toBeNull();
      await expect.element(page.getByRole("combobox", { name: "Project: Second" })).toBeVisible();

      createWorkflowButton().click();
      await vi.waitFor(() => {
        expect(nativeApiMocks.createWorkflow).toHaveBeenCalledTimes(1);
      });
      expect(nativeApiMocks.createWorkflow.mock.calls[0]?.[0]).toMatchObject({
        projectId: "project-2",
        requirementPrompt: "Plan the import flow",
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("clears the review branch on a project change and drops the note once files are added", async () => {
    const baseProject = useStore.getState().projects[0]!;
    useStore.setState({
      projects: [
        baseProject,
        { ...baseProject, id: "project-2" as ProjectId, name: "Second", cwd: "/repo/second" },
      ],
    });
    desktopBridgePathByFileName.set("AGENTS.md", "/repo/second/AGENTS.md");
    function Host() {
      const [projectId, setProjectId] = useState("project-1" as ProjectId);
      return (
        <WorkflowCreateDialog
          open
          projectId={projectId}
          onOpenChange={() => {}}
          onProjectChange={setProjectId}
        />
      );
    }

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(<Host />, { container: host });

    try {
      await page.getByRole("button", { name: "Code Review" }).click();
      await page.getByRole("button", { name: /^Options/ }).click();
      await page.getByPlaceholder("main").fill("release/old-repo");

      await page.getByRole("combobox", { name: "Project: Project" }).click();
      await page.getByRole("option", { name: "Second" }).click();

      await expect
        .element(page.getByText("The review branch was cleared for the new project."))
        .toBeVisible();
      await expect.element(page.getByPlaceholder("main")).toHaveValue("");

      await dropFilesOnRequirement([new File(["agents"], "AGENTS.md", { type: "text/markdown" })]);
      await vi.waitFor(() => {
        expect(document.querySelector('[title="AGENTS.md"]')).not.toBeNull();
      });
      expect(document.body.textContent).not.toContain("cleared for the new project");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("notes a file that was still attaching when the project changed and discards its copy", async () => {
    const baseProject = useStore.getState().projects[0]!;
    useStore.setState({
      projects: [
        baseProject,
        { ...baseProject, id: "project-2" as ProjectId, name: "Second", cwd: "/repo/second" },
      ],
    });
    let finishUpload: (() => void) | undefined;
    nativeApiMocks.uploadAttachment.mockImplementationOnce(
      async (_baseUrl: string, threadId: string, file: File) => {
        await new Promise<void>((resolve) => {
          finishUpload = resolve;
        });
        return uploadRecord(threadId, file, FIRST_UPLOAD_ID);
      },
    );
    function Host() {
      const [projectId, setProjectId] = useState("project-1" as ProjectId);
      return (
        <WorkflowCreateDialog
          open
          projectId={projectId}
          onOpenChange={() => {}}
          onProjectChange={setProjectId}
        />
      );
    }

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await renderWithQueryClient(<Host />, { container: host });

    try {
      pasteFilesOnRequirement([new File(["png"], "image.png", { type: "image/png" })]);
      await vi.waitFor(() => expect(document.body.textContent ?? "").toContain("Attaching…"));

      await page.getByRole("combobox", { name: "Project: Project" }).click();
      await page.getByRole("option", { name: "Second" }).click();

      await expect
        .element(page.getByText("File references were cleared for the new project."))
        .toBeVisible();
      expect(document.body.textContent ?? "").not.toContain("Attaching…");

      finishUpload?.();
      await vi.waitFor(() =>
        expect(nativeApiMocks.discardMaterialized).toHaveBeenCalledWith({
          uploadIds: [FIRST_UPLOAD_ID],
        }),
      );
      expect(document.querySelector('[data-slot="file-chip"]')).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

describe("reported workflow capabilities", () => {
  it.each(["codex", "claudeAgent"] as const)(
    "keeps unfamiliar %s model controls in the submitted options",
    async (provider) => {
      const capabilities =
        provider === "codex"
          ? createReportedCodexModelCapabilities({
              model: "gpt-future-agent",
              supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
              defaultReasoningEffort: "low",
              serviceTiers: [{ id: "priority" }],
            })
          : createReportedClaudeModelCapabilities({
              value: "claude-opus-6",
              supportedEffortLevels: ["low", "high"],
              supportsFastMode: true,
            });
      const model = provider === "codex" ? "gpt-future-agent" : "claude-opus-6";
      const changes = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      const providers = [providerSnapshot(provider, [{ slug: model, name: model, capabilities }])];
      const Harness = () => {
        const [options, setOptions] = useState<ProviderModelOptions>();
        return (
          <SlotRow
            label="Branch A"
            provider={provider}
            model={model}
            providers={providers}
            modelOptions={options}
            modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
            onProviderModelChange={() => {}}
            onModelOptionsChange={(next) => {
              setOptions(next);
              changes(next);
            }}
          />
        );
      };
      const screen = await renderWithQueryClient(<Harness />, { container: host });
      try {
        const defaultEffort = provider === "codex" ? "Low" : "High";
        await page.getByRole("button", { name: defaultEffort, exact: true }).click();
        const nondefaultEffort = provider === "codex" ? "High" : "Low";
        await page.getByRole("menuitemradio", { name: nondefaultEffort, exact: true }).click();
        // Like the composer, the Codex menu closes after an effort pick and Claude's stays open.
        if (provider === "codex") {
          await page.getByRole("button", { name: nondefaultEffort, exact: true }).click();
        }
        await page.getByRole("menuitemcheckbox", { name: /Fast Mode/ }).click();
        expect(changes.mock.lastCall?.[0]).toEqual(
          provider === "codex"
            ? { codex: { reasoningEffort: "high", fastMode: true } }
            : { claudeAgent: { effort: "low", fastMode: true } },
        );
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );
});

it("saves a Codex pick of the built-in default when no capabilities were reported", async () => {
  // The client's probe returned nothing, but the session will report Low as
  // Sol's default; dropping "high" here would run the slot at Low.
  const changes = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await renderWithQueryClient(
    <SlotRow
      label="Branch A"
      provider="codex"
      model="gpt-6.1-sol"
      modelOptions={{ codex: { reasoningEffort: "medium" } }}
      modelOptionsByInstance={EMPTY_MODEL_OPTIONS_BY_INSTANCE}
      onProviderModelChange={() => {}}
      onModelOptionsChange={changes}
    />,
    { container: host },
  );
  try {
    await page.getByRole("button", { name: "Medium", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /^High/ }).click();
    expect(changes).toHaveBeenLastCalledWith({ codex: { reasoningEffort: "high" } });
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("walks an unsupported stored effort down, not to the default, and shows fast-only controls", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const model = "gpt-future";
  const props = {
    label: "Branch A",
    provider: "codex" as const,
    model,
    modelOptions: { codex: { reasoningEffort: "ultra" as const } },
    modelOptionsByInstance: EMPTY_MODEL_OPTIONS_BY_INSTANCE,
    onProviderModelChange: () => {},
    onModelOptionsChange: () => {},
  };
  const queryClient = createTestQueryClient();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <SlotRow
        {...props}
        providers={[
          providerSnapshot("codex", [
            {
              slug: model,
              name: model,
              capabilities: createReportedCodexModelCapabilities({
                model,
                supportedReasoningEfforts: [
                  { reasoningEffort: "max" },
                  { reasoningEffort: "high" },
                  { reasoningEffort: "low" },
                ],
                defaultReasoningEffort: "low",
              }),
            },
          ]),
        ]}
      />
    </QueryClientProvider>,
    { container: host },
  );
  try {
    // turn/start lowers Ultra to Max; Low (the default) would misstate the run.
    await expect.element(page.getByRole("button", { name: "Max", exact: true })).toBeVisible();
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <SlotRow
          {...props}
          providers={[
            providerSnapshot("codex", [
              {
                slug: model,
                name: model,
                capabilities: createReportedCodexModelCapabilities({
                  model,
                  supportedReasoningEfforts: [],
                  serviceTiers: [{ id: "priority" }],
                }),
              },
            ]),
          ]}
        />
      </QueryClientProvider>,
    );
    // A model whose only control is Fast Mode still gets the traits control.
    const row = page.getByRole("group", { name: "Branch A" }).element();
    await vi.waitFor(() => {
      expect(row.querySelector('[data-slot="workflow-slot-traits"]')).not.toBeNull();
    });
    row.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")?.click();
    await expect.element(page.getByRole("menuitemcheckbox", { name: /Fast Mode/ })).toBeVisible();
  } finally {
    await screen.unmount();
    host.remove();
  }
});
