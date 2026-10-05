import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import {
  DOCUMENT_WORKFLOW_TEMPLATE_ID,
  DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS,
  type WorkflowDocumentType,
} from "@t3tools/contracts";
import {
  WORKFLOW_DOCUMENT_PROFILES,
  DEFAULT_WORKFLOW_DOCUMENT_TYPE,
  WORKFLOW_DOCUMENT_TYPE_ORDER,
  defaultDocumentReaderSlot,
} from "@t3tools/shared/documentWorkflow";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ModelSlug,
  ProjectId,
  ProviderKind,
  ProviderModelOptions,
  WorkflowModelSlot,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  getDefaultModel,
  getReasoningEffortOptions,
  normalizeModelSlug,
  resolveCodexReasoningEffortForModel,
  resolveReasoningEffortForProvider,
  supportsClaudeFastMode,
  supportsClaudeThinkingToggle,
} from "@t3tools/shared/model";

import { resolveThreadTitleModel, useAppSettings } from "../../appSettings";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  useServerKeybindings,
} from "../../keybindings";
import {
  appendAttachedFilesToPrompt,
  normalizeAttachedFilePaths,
  relativePathForDisplay,
  sanitizeAttachedFileReferencePaths,
} from "../../lib/attachedFiles";
import {
  collectComposerMentionPaths,
  createComposerMention,
  type ComposerMention,
} from "../../composer-editor-mentions";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import {
  WORKFLOW_TYPE_DESCRIPTION,
  WORKFLOW_TYPE_DIALOG_LABEL,
  WORKFLOW_TYPE_ICON,
  WORKFLOW_TYPE_ORDER,
  WORKFLOW_TYPE_TOGGLE_CLASS,
  type WorkflowTypeValue,
} from "../../lib/workflowType";
import {
  getModelPreferences,
  recordModelSelection,
  type WorkflowCreatePreferenceSlot,
  useModelPreferencesStore,
} from "../../modelPreferencesStore";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { resolveProviderOptionsForDispatch } from "../../providerOptionsForDispatch";
import { basenameOfPath } from "../../vscode-icons";
import {
  createCachedAbsolutePathComparisonNormalizer,
  getCustomModelOptionsByProvider,
  getProviderDispatchModelsByProvider,
  identityAbsolutePathNormalizer,
  resolveComposerPickerModel,
  resolveAttachedFileReferencePaths,
} from "../ChatView.logic";
import { FileChip } from "../chat/FileChip";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  authorizeComposerMentionPaths,
  authorizeFileTreeMention,
  composerFileMention,
  dataTransferHasFileTreeMention,
  readFileTreeDragMention,
  workspaceIdentityForRoot,
} from "../fileTreeDragMention";
import { SectionLabel } from "../ui/section-label";
import { SlotRow } from "./SlotRow";
import {
  WORKFLOW_OPTION_INPUT_CLASS_NAME,
  WorkflowOptionCheckbox,
  WorkflowOptionField,
  WorkflowOptions,
} from "./WorkflowOptions";

const WORKFLOW_TYPE_CARD_PRESSED_BORDER_CLASS: Record<WorkflowTypeValue, string> = {
  planning: "data-pressed:border-info/50",
  codeReview: "data-pressed:border-success/50",
  investigation: "data-pressed:border-warning/50",
  document: "data-pressed:border-attention/50",
};

export function normalizeWorkflowSlotModelOptions(
  provider: ProviderKind,
  model: string,
  modelOptions: ProviderModelOptions | undefined,
): ProviderModelOptions | undefined {
  if (provider === "codex") {
    const effort = modelOptions?.codex?.reasoningEffort
      ? resolveCodexReasoningEffortForModel(model, modelOptions.codex.reasoningEffort)
      : undefined;
    const codex = {
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(modelOptions?.codex?.fastMode === true ? { fastMode: true } : {}),
    };
    return Object.keys(codex).length > 0 ? { codex } : undefined;
  }
  if (provider !== "claudeAgent") {
    return getSingleProviderModelOptions(provider, modelOptions);
  }
  const reasoningOptions = getReasoningEffortOptions("claudeAgent", model);
  const effort = resolveReasoningEffortForProvider(
    "claudeAgent",
    modelOptions?.claudeAgent?.effort,
  );
  const claudeAgent = {
    ...(supportsClaudeThinkingToggle(model) && modelOptions?.claudeAgent?.thinking === false
      ? { thinking: false }
      : {}),
    ...(effort && effort !== "ultrathink" && reasoningOptions.includes(effort) ? { effort } : {}),
    ...(supportsClaudeFastMode(model) && modelOptions?.claudeAgent?.fastMode === true
      ? { fastMode: true }
      : {}),
  };
  if (Object.keys(claudeAgent).length === 0) {
    return undefined;
  }
  return claudeAgent ? { claudeAgent } : undefined;
}

function getSingleProviderModelOptions(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | undefined {
  switch (provider) {
    case "codex":
      return modelOptions?.codex ? { codex: modelOptions.codex } : undefined;
    case "claudeAgent":
      return modelOptions?.claudeAgent ? { claudeAgent: modelOptions.claudeAgent } : undefined;
    case "cursor":
      return modelOptions?.cursor ? { cursor: modelOptions.cursor } : undefined;
    case "opencode":
      return modelOptions?.opencode ? { opencode: modelOptions.opencode } : undefined;
    case "grok":
      return undefined;
  }
}

function getWorkflowSlotDefaults(
  slot: WorkflowCreatePreferenceSlot,
  fallbackProvider: ProviderKind,
  modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<{ readonly slug: string; readonly name: string }>
  >,
  providers: Parameters<typeof resolveComposerPickerModel>[0]["providers"],
): {
  provider: ProviderKind;
  model: string;
  modelOptions: ProviderModelOptions | undefined;
} {
  const preferences = getModelPreferences();
  const provider = preferences.lastWorkflowProviderBySlot[slot] ?? fallbackProvider;
  const preferredModel = preferences.lastModelByProvider[provider] ?? getDefaultModel(provider);
  const model = resolveComposerPickerModel({
    provider,
    rawModel: preferredModel,
    pickerOptions: modelOptionsByProvider[provider],
    providers: providers ?? null,
  });
  return {
    provider,
    model,
    modelOptions:
      normalizeModelSlug(preferredModel, provider) === model
        ? getSingleProviderModelOptions(provider, preferences.lastModelOptions)
        : undefined,
  };
}

interface WorkflowCreateDialogProps {
  open: boolean;
  projectId: ProjectId;
  onOpenChange: (open: boolean) => void;
  onWorkflowCreated?: (workflowId: string) => void;
}

export function WorkflowCreateDialog(props: WorkflowCreateDialogProps) {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const { resolvedTheme } = useTheme();
  const keybindings = useServerKeybindings();
  const project = useStore(
    (store) => store.projects.find((entry) => entry.id === props.projectId) ?? null,
  );
  const modelOptionsByProvider = useMemo(
    () =>
      getCustomModelOptionsByProvider(
        settings,
        serverConfigQuery.data?.providers,
        serverConfigQuery.data?.settings,
      ),
    [settings, serverConfigQuery.data?.providers, serverConfigQuery.data?.settings],
  );
  const dispatchModelsByProvider = useMemo(
    () =>
      getProviderDispatchModelsByProvider(
        settings,
        serverConfigQuery.data?.providers,
        serverConfigQuery.data?.settings,
      ),
    [settings, serverConfigQuery.data?.providers, serverConfigQuery.data?.settings],
  );
  const initialBranchADefaults = getWorkflowSlotDefaults(
    "branchA",
    "codex",
    modelOptionsByProvider,
    serverConfigQuery.data?.providers,
  );
  const initialBranchBDefaults = getWorkflowSlotDefaults(
    "branchB",
    "claudeAgent",
    modelOptionsByProvider,
    serverConfigQuery.data?.providers,
  );
  const initialMergeDefaults = getWorkflowSlotDefaults(
    "merge",
    "codex",
    modelOptionsByProvider,
    serverConfigQuery.data?.providers,
  );
  const [workflowType, setWorkflowType] = useState<WorkflowTypeValue>("planning");
  const [requirementDraft, setRequirementDraft] = useState<{
    text: string;
    mentions: readonly ComposerMention[];
    cursor: number;
  }>({ text: "", mentions: [], cursor: 0 });
  const requirementPrompt = requirementDraft.text;
  const [documentType, setDocumentType] = useState<WorkflowDocumentType>(
    DEFAULT_WORKFLOW_DOCUMENT_TYPE,
  );
  const [readerReviewEnabled, setReaderReviewEnabled] = useState(true);
  const [readerPersona, setReaderPersona] = useState("");
  const [readerSlot, setReaderSlot] = useState<WorkflowModelSlot | null>(null);
  const documentProfile = WORKFLOW_DOCUMENT_PROFILES[documentType];

  const [attachedFilePaths, setAttachedFilePaths] = useState<string[]>([]);
  const [reviewBranch, setReviewBranch] = useState("");
  const [plansDirectory, setPlansDirectory] = useState("plans");
  const [branchAProvider, setBranchAProvider] = useState<ProviderKind>(
    initialBranchADefaults.provider,
  );
  const [branchAModel, setBranchAModel] = useState(initialBranchADefaults.model);
  const [branchAModelOptions, setBranchAModelOptions] = useState<ProviderModelOptions | undefined>(
    initialBranchADefaults.modelOptions,
  );
  const [branchBProvider, setBranchBProvider] = useState<ProviderKind>(
    initialBranchBDefaults.provider,
  );
  const [branchBModel, setBranchBModel] = useState(initialBranchBDefaults.model);
  const [branchBModelOptions, setBranchBModelOptions] = useState<ProviderModelOptions | undefined>(
    initialBranchBDefaults.modelOptions,
  );
  const [mergeProvider, setMergeProvider] = useState<ProviderKind>(initialMergeDefaults.provider);
  const [mergeModel, setMergeModel] = useState(initialMergeDefaults.model);
  const [mergeModelOptions, setMergeModelOptions] = useState<ProviderModelOptions | undefined>(
    initialMergeDefaults.modelOptions,
  );
  const [selfReviewEnabled, setSelfReviewEnabled] = useState(true);
  const [investigationSelfReviewEnabled, setInvestigationSelfReviewEnabled] = useState(false);
  const [maxCostUsd, setMaxCostUsd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOverPrompt, setIsDragOverPrompt] = useState(false);
  const promptEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const submittingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const resolveWorkflowModelSelection = (provider: ProviderKind, model: string): ModelSlug =>
    resolveComposerPickerModel({
      provider,
      rawModel: model,
      pickerOptions: modelOptionsByProvider[provider],
      providers: serverConfigQuery.data?.providers ?? null,
    }) as ModelSlug;

  const branchASelection = resolveWorkflowModelSelection(branchAProvider, branchAModel);
  const branchBSelection = resolveWorkflowModelSelection(branchBProvider, branchBModel);
  const mergeSelection = resolveWorkflowModelSelection(mergeProvider, mergeModel);
  useEffect(() => {
    if (!serverConfigQuery.data) return;

    if (branchAModel !== branchASelection) {
      const preservesOptions =
        normalizeModelSlug(branchAModel, branchAProvider) === branchASelection;
      setBranchAModel(branchASelection);
      if (!preservesOptions) setBranchAModelOptions(undefined);
    }
    if (branchBModel !== branchBSelection) {
      const preservesOptions =
        normalizeModelSlug(branchBModel, branchBProvider) === branchBSelection;
      setBranchBModel(branchBSelection);
      if (!preservesOptions) setBranchBModelOptions(undefined);
    }
    if (mergeModel !== mergeSelection) {
      const preservesOptions = normalizeModelSlug(mergeModel, mergeProvider) === mergeSelection;
      setMergeModel(mergeSelection);
      if (!preservesOptions) setMergeModelOptions(undefined);
    }
  }, [
    branchAModel,
    branchAProvider,
    branchASelection,
    branchBModel,
    branchBProvider,
    branchBSelection,
    mergeModel,
    mergeProvider,
    mergeSelection,
    serverConfigQuery.data,
  ]);
  const effectiveReaderSlot =
    readerSlot ??
    defaultDocumentReaderSlot({
      branchA: {
        provider: branchAProvider,
        model: branchASelection,
        ...(branchAModelOptions ? { modelOptions: branchAModelOptions } : {}),
      },
      branchB: {
        provider: branchBProvider,
        model: branchBSelection,
        ...(branchBModelOptions ? { modelOptions: branchBModelOptions } : {}),
      },
      merge: { provider: mergeProvider, model: mergeSelection },
    });
  // Resolved like the other slots so the picker shows what gets submitted.
  const readerSelection = resolveWorkflowModelSelection(
    effectiveReaderSlot.provider,
    effectiveReaderSlot.model,
  );
  const sameDocumentAuthors =
    workflowType === "document" &&
    branchAProvider === branchBProvider &&
    branchASelection === branchBSelection;
  const titleGenerationModel = resolveThreadTitleModel(settings);
  const workspaceRoots = [project?.cwd];
  const sameInvestigationInvestigatorModel =
    workflowType === "investigation" &&
    branchAProvider === branchBProvider &&
    branchASelection === branchBSelection;
  const parsedMaxCostUsd = maxCostUsd.trim().length > 0 ? Number(maxCostUsd) : null;
  const validMaxCostUsd =
    parsedMaxCostUsd === null || (Number.isFinite(parsedMaxCostUsd) && parsedMaxCostUsd > 0);
  const submittedBriefLength = appendAttachedFilesToPrompt(
    requirementPrompt,
    attachedFilePaths,
  ).length;
  const canSubmit =
    serverConfigQuery.data !== undefined &&
    (requirementPrompt.trim().length > 0 || attachedFilePaths.length > 0) &&
    !sameInvestigationInvestigatorModel &&
    !sameDocumentAuthors &&
    (workflowType !== "document" || submittedBriefLength <= DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS) &&
    validMaxCostUsd;
  const primaryActionShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "dialog.primaryAction"),
    [keybindings],
  );

  const focusPromptEditor = () => {
    promptEditorRef.current?.focusAtEnd();
  };

  const onWorkflowTypeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    const currentIndex = WORKFLOW_TYPE_ORDER.indexOf(workflowType);
    const lastIndex = WORKFLOW_TYPE_ORDER.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? lastIndex
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? currentIndex === lastIndex
              ? 0
              : currentIndex + 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? currentIndex === 0
                ? lastIndex
                : currentIndex - 1
              : null;
    if (nextIndex === null) return;
    const nextType = WORKFLOW_TYPE_ORDER[nextIndex];
    if (!nextType) return;
    event.preventDefault();

    // Base UI moves roving focus for this group, but toggles are only pressed by click/Space/Enter.
    // Keep the selected workflow type in sync with the keyboard-focused segment.
    if (nextType && nextType !== workflowType) {
      setWorkflowType(nextType);
    }
    const toggles = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-slot="toggle"]'),
    );
    queueMicrotask(() => {
      toggles[nextIndex]?.focus();
    });
  };

  const reset = () => {
    const branchADefaults = getWorkflowSlotDefaults(
      "branchA",
      "codex",
      modelOptionsByProvider,
      serverConfigQuery.data?.providers,
    );
    const branchBDefaults = getWorkflowSlotDefaults(
      "branchB",
      "claudeAgent",
      modelOptionsByProvider,
      serverConfigQuery.data?.providers,
    );
    const mergeDefaults = getWorkflowSlotDefaults(
      "merge",
      "codex",
      modelOptionsByProvider,
      serverConfigQuery.data?.providers,
    );

    setWorkflowType("planning");
    setDocumentType(DEFAULT_WORKFLOW_DOCUMENT_TYPE);
    setReaderReviewEnabled(true);
    setReaderPersona("");
    setReaderSlot(null);
    setRequirementDraft({ text: "", mentions: [], cursor: 0 });
    setAttachedFilePaths([]);
    setReviewBranch("");
    setPlansDirectory("plans");
    setBranchAProvider(branchADefaults.provider);
    setBranchAModel(branchADefaults.model);
    setBranchAModelOptions(branchADefaults.modelOptions);
    setBranchBProvider(branchBDefaults.provider);
    setBranchBModel(branchBDefaults.model);
    setBranchBModelOptions(branchBDefaults.modelOptions);
    setMergeProvider(mergeDefaults.provider);
    setMergeModel(mergeDefaults.model);
    setMergeModelOptions(mergeDefaults.modelOptions);
    setSelfReviewEnabled(true);
    setInvestigationSelfReviewEnabled(false);
    setMaxCostUsd("");
    setError(null);
    setIsDragOverPrompt(false);
    dragDepthRef.current = 0;
    submittingRef.current = false;
    setSubmitting(false);
  };

  const addAttachedFiles = (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    const normalizeAbsolutePathForComparison = createCachedAbsolutePathComparisonNormalizer(
      window.desktopBridge?.resolveRealPath ?? identityAbsolutePathNormalizer,
    );
    const { filePaths, missingPathCount, invalidPathCount } = resolveAttachedFileReferencePaths({
      files,
      isElectron,
      desktopBridge: window.desktopBridge,
      workspaceRoots,
      normalizeAbsolutePathForComparison,
    });

    if (filePaths.length > 0) {
      setAttachedFilePaths((current) => normalizeAttachedFilePaths([...current, ...filePaths]));
      setError(null);
    }

    if (missingPathCount > 0) {
      toastManager.add({
        type: "warning",
        title: "File attachments require the desktop app to resolve filesystem paths.",
      });
    }
    if (invalidPathCount > 0) {
      toastManager.add({
        type: "warning",
        title: "Some file attachments could not be added.",
      });
    }
  };

  const removeAttachedFilePath = (filePath: string) => {
    setAttachedFilePaths((current) => current.filter((entry) => entry !== filePath));
  };

  const onPromptPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0 || !isElectron) {
      return;
    }
    event.preventDefault();
    addAttachedFiles(files);
  };

  const onPromptDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverPrompt(true);
  };

  const onPromptDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverPrompt(true);
  };

  const onPromptDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverPrompt(false);
    }
  };

  const claimFileTreeMentionDrag = (event: ReactDragEvent<HTMLDivElement>): boolean => {
    if (!dataTransferHasFileTreeMention(event.dataTransfer.types)) return false;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
    return true;
  };

  const onPromptFileMentionDragEnterCapture = (event: ReactDragEvent<HTMLDivElement>) => {
    if (claimFileTreeMentionDrag(event)) setIsDragOverPrompt(true);
  };

  const onPromptFileMentionDragOverCapture = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!claimFileTreeMentionDrag(event)) return;
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverPrompt(true);
  };

  const onPromptFileMentionDragLeaveCapture = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFileTreeMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverPrompt(false);
  };

  const onPromptFileMentionDropCapture = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFileTreeMention(event.dataTransfer.types)) return;
    const payload = readFileTreeDragMention(event.dataTransfer);
    claimFileTreeMentionDrag(event);
    dragDepthRef.current = 0;
    setIsDragOverPrompt(false);
    const api = readNativeApi();
    if (!payload || !api || !project) {
      toastManager.add({ type: "error", title: "Unable to add the dragged file." });
      return;
    }
    void authorizeFileTreeMention({
      api,
      payload,
      expectedProjectId: project.id,
      expectedWorkspaceIdentity: workspaceIdentityForRoot(project.id, project.cwd),
      workspaceRoot: project.cwd,
    })
      .then((relativePath) => {
        const mention = composerFileMention(relativePath);
        if (mention === null) throw new Error("The file path is invalid.");
        setRequirementDraft((current) => {
          const prefix =
            current.text + (current.text.length > 0 && !/\s$/.test(current.text) ? " " : "");
          const text = prefix + mention + " ";
          const mentions = [
            ...current.mentions,
            createComposerMention(relativePath, prefix.length),
          ];
          return {
            text,
            mentions,
            cursor: collapseExpandedComposerCursor(text, text.length, mentions),
          };
        });
        window.requestAnimationFrame(focusPromptEditor);
      })
      .catch((cause) => {
        toastManager.add({
          type: "error",
          title: "Unable to add the dragged file.",
          description: cause instanceof Error ? cause.message : "The file could not be authorized.",
        });
      });
  };

  const onPromptDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverPrompt(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) {
      return;
    }
    addAttachedFiles(files);
    focusPromptEditor();
  };

  const onSubmit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const api = readNativeApi();
    if (!api) {
      setError("Native API is unavailable.");
      submittingRef.current = false;
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const normalizeAbsolutePathForComparison = createCachedAbsolutePathComparisonNormalizer(
        window.desktopBridge?.resolveRealPath ?? identityAbsolutePathNormalizer,
      );
      const {
        filePaths: attachedFilePathsSnapshot,
        invalidPathCount: invalidAttachedFilePathCount,
      } = sanitizeAttachedFileReferencePaths({
        filePaths: attachedFilePaths,
        workspaceRoots,
        normalizeAbsolutePathForComparison,
      });
      if (invalidAttachedFilePathCount > 0) {
        setError("Remove or reattach invalid file attachments before creating the workflow.");
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }
      const mentionedPaths = collectComposerMentionPaths(
        requirementPrompt,
        requirementDraft.mentions,
      );
      if (mentionedPaths.length > 0 && project) {
        try {
          await authorizeComposerMentionPaths({
            api,
            workspaceRoot: project.cwd,
            relativePaths: mentionedPaths,
          });
        } catch (cause) {
          setError(
            cause instanceof Error
              ? `A mentioned workspace path is unavailable: ${cause.message}`
              : "A mentioned workspace path is unavailable.",
          );
          submittingRef.current = false;
          setSubmitting(false);
          return;
        }
      }
      const promptForSubmission = appendAttachedFilesToPrompt(
        requirementPrompt,
        attachedFilePathsSnapshot,
      );
      const providerOptionsCache = new Map<ProviderKind, WorkflowModelSlot["providerOptions"]>();
      const buildSlot = (
        provider: ProviderKind,
        model: ModelSlug,
        rawModelOptions: ProviderModelOptions | undefined,
      ): WorkflowModelSlot => {
        const modelOptions = normalizeWorkflowSlotModelOptions(provider, model, rawModelOptions);
        let providerOptions = providerOptionsCache.get(provider);
        if (!providerOptionsCache.has(provider)) {
          providerOptions = resolveProviderOptionsForDispatch({
            settings,
            provider,
            projectId: props.projectId,
            availableModels: dispatchModelsByProvider[provider],
          });
          providerOptionsCache.set(provider, providerOptions);
        }
        return {
          provider,
          model,
          ...(modelOptions ? { modelOptions } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        };
      };
      const branchASlot = buildSlot(branchAProvider, branchASelection, branchAModelOptions);
      const branchBSlot = buildSlot(branchBProvider, branchBSelection, branchBModelOptions);
      const mergeSlot = buildSlot(mergeProvider, mergeSelection, mergeModelOptions);
      if (workflowType === "planning") {
        const result = await api.workflowPlatform.createRun({
          templateId: "builtin.planning.dual",
          ...(parsedMaxCostUsd !== null ? { maxCostUsd: parsedMaxCostUsd } : {}),
          input: {
            projectId: props.projectId,
            requirementPrompt: promptForSubmission,
            titleGenerationModel,
            plansDirectory: plansDirectory.trim() || "plans",
            selfReviewEnabled,
            branchA: branchASlot,
            branchB: branchBSlot,
            merge: mergeSlot,
          },
        });
        props.onWorkflowCreated?.(result.workflowId);
      } else if (workflowType === "document") {
        const result = await api.workflowPlatform.createRun({
          templateId: DOCUMENT_WORKFLOW_TEMPLATE_ID,
          ...(parsedMaxCostUsd !== null ? { maxCostUsd: parsedMaxCostUsd } : {}),
          input: {
            projectId: props.projectId,
            requirementPrompt: promptForSubmission,
            titleGenerationModel,
            documentType,
            selfReviewEnabled,
            readerReviewEnabled,
            ...(readerPersona.trim() && readerReviewEnabled
              ? { readerPersona: readerPersona.trim() }
              : {}),
            ...(readerReviewEnabled
              ? {
                  reader: buildSlot(
                    effectiveReaderSlot.provider,
                    readerSelection,
                    effectiveReaderSlot.modelOptions,
                  ),
                }
              : {}),
            branchA: branchASlot,
            branchB: branchBSlot,
            merge: mergeSlot,
          },
        });
        props.onWorkflowCreated?.(result.workflowId);
        await navigate({ to: "/workflow/$workflowId", params: { workflowId: result.workflowId } });
      } else if (workflowType === "codeReview") {
        const result = await api.workflowPlatform.createRun({
          templateId: "builtin.code-review.dual",
          ...(parsedMaxCostUsd !== null ? { maxCostUsd: parsedMaxCostUsd } : {}),
          input: {
            projectId: props.projectId,
            reviewPrompt: promptForSubmission,
            titleGenerationModel,
            ...(reviewBranch.trim() ? { branch: reviewBranch.trim() } : {}),
            reviewerA: branchASlot,
            reviewerB: branchBSlot,
            consolidation: mergeSlot,
          },
        });
        props.onWorkflowCreated?.(result.workflowId);
      } else if (workflowType === "investigation") {
        if (sameInvestigationInvestigatorModel) {
          setError("Choose two different investigator models for Investigation workflows.");
          submittingRef.current = false;
          setSubmitting(false);
          return;
        }
        const result = await api.workflowPlatform.createRun({
          templateId: "builtin.investigation.dual",
          ...(parsedMaxCostUsd !== null ? { maxCostUsd: parsedMaxCostUsd } : {}),
          input: {
            projectId: props.projectId,
            problemPrompt: promptForSubmission,
            titleGenerationModel,
            ...(reviewBranch.trim() ? { branch: reviewBranch.trim() } : {}),
            selfReviewEnabled: investigationSelfReviewEnabled,
            investigatorA: branchASlot,
            investigatorB: branchBSlot,
            synthesis: mergeSlot,
          },
        });
        props.onWorkflowCreated?.(result.workflowId);
        await navigate({
          to: "/investigation/$workflowId",
          params: { workflowId: result.workflowId },
        });
      }
      reset();
      props.onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const command = resolveShortcutCommand(event, keybindings, {
      context: { dialogFocus: true, terminalFocus: false, terminalOpen: false },
    });
    if (command !== "dialog.primaryAction") return;

    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.repeat) return;
    if (submittingRef.current) return;
    if (!canSubmit) return;
    void onSubmit();
  };

  // What the collapsed Options row is currently set to.
  const optionsSummary = [
    (workflowType === "planning" || workflowType === "document") && selfReviewEnabled
      ? "Own-model review"
      : null,
    workflowType === "investigation" && investigationSelfReviewEnabled ? "Own-model review" : null,
    workflowType === "planning" ? `${plansDirectory.trim() || "plans"}/` : null,
    (workflowType === "codeReview" || workflowType === "investigation") && reviewBranch.trim()
      ? `vs ${reviewBranch.trim()}`
      : null,
    maxCostUsd.trim() ? `Limit $${maxCostUsd.trim()}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl" onKeyDownCapture={onDialogKeyDown}>
        <DialogHeader>
          <DialogTitle>New Workflow</DialogTitle>
          <DialogDescription>
            Create a feature workflow, code review, root-cause investigation, or document. The title
            will be generated from your prompt.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-x-6 gap-y-5 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <div className="flex min-w-0 flex-col gap-4">
              <ToggleGroup
                className="grid w-full grid-cols-2 gap-2"
                aria-label="Workflow type"
                value={[workflowType]}
                onKeyDown={onWorkflowTypeKeyDown}
                onValueChange={(value) => {
                  const next = value[0];
                  if (WORKFLOW_TYPE_ORDER.includes(next as WorkflowTypeValue)) {
                    setWorkflowType(next as WorkflowTypeValue);
                  }
                }}
              >
                {WORKFLOW_TYPE_ORDER.map((type) => {
                  const TypeIcon = WORKFLOW_TYPE_ICON[type];
                  return (
                    <Toggle
                      key={type}
                      value={type}
                      // The card's description is extra context; the name stays the type.
                      aria-label={WORKFLOW_TYPE_DIALOG_LABEL[type]}
                      aria-describedby={`workflow-type-description-${type}`}
                      className={cn(
                        "h-auto w-full flex-col items-start justify-start gap-1 whitespace-normal rounded-xl border-border p-3 text-start",
                        WORKFLOW_TYPE_TOGGLE_CLASS[type],
                        WORKFLOW_TYPE_CARD_PRESSED_BORDER_CLASS[type],
                      )}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {/* Follows the card's text colour, tinted only while selected. */}
                        <TypeIcon aria-hidden="true" className="size-4" />
                        {WORKFLOW_TYPE_DIALOG_LABEL[type]}
                      </span>
                      <span
                        id={`workflow-type-description-${type}`}
                        className="line-clamp-2 text-2xs font-normal text-muted-foreground"
                      >
                        {WORKFLOW_TYPE_DESCRIPTION[type]}
                      </span>
                    </Toggle>
                  );
                })}
              </ToggleGroup>
              <div className="space-y-2">
                <label className="block text-ui font-medium text-foreground">
                  {workflowType === "document"
                    ? "Brief"
                    : workflowType === "planning"
                      ? "Requirement"
                      : workflowType === "investigation"
                        ? "Problem to investigate"
                        : "Review instructions"}
                </label>
                <div
                  className={cn(
                    "space-y-3 rounded-lg border bg-background px-3 py-2 transition-colors",
                    isDragOverPrompt
                      ? "border-primary/70 ring-2 ring-primary/15"
                      : "border-input focus-within:border-ring/60",
                  )}
                  onPaste={onPromptPaste}
                  onDragEnter={onPromptDragEnter}
                  onDragOver={onPromptDragOver}
                  onDragLeave={onPromptDragLeave}
                  onDrop={onPromptDrop}
                  onDragEnterCapture={onPromptFileMentionDragEnterCapture}
                  onDragOverCapture={onPromptFileMentionDragOverCapture}
                  onDragLeaveCapture={onPromptFileMentionDragLeaveCapture}
                  onDropCapture={onPromptFileMentionDropCapture}
                >
                  {attachedFilePaths.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {attachedFilePaths.map((filePath) => {
                        const displayPath = relativePathForDisplay(filePath, project?.cwd);
                        return (
                          <FileChip
                            key={filePath}
                            path={filePath}
                            label={basenameOfPath(displayPath)}
                            title={displayPath}
                            theme={resolvedTheme}
                            className="max-w-60"
                            onRemove={() => removeAttachedFilePath(filePath)}
                            removeDisabled={submitting}
                            removeLabel={`Remove ${displayPath}`}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                  <ComposerPromptEditor
                    ref={promptEditorRef}
                    className="min-h-32 text-sm"
                    value={requirementPrompt}
                    mentions={requirementDraft.mentions}
                    cursor={requirementDraft.cursor}
                    terminalContexts={[]}
                    disabled={submitting}
                    onRemoveTerminalContext={() => {}}
                    onPaste={() => {}}
                    onChange={(text, cursor, _expanded, _adjacent, _contexts, mentions) =>
                      setRequirementDraft({ text, cursor, mentions })
                    }
                    placeholder={
                      workflowType === "document"
                        ? documentProfile.placeholder
                        : workflowType === "planning"
                          ? "Describe the feature or requirement to plan."
                          : workflowType === "investigation"
                            ? "Describe the problem, symptoms, suspected regression, or evidence to investigate."
                            : "Describe what the reviewers should inspect and how they should review it."
                    }
                  />
                </div>
              </div>
              {workflowType === "document" ? (
                <div className="space-y-2">
                  <p className="text-2xs text-muted-foreground tabular-nums">
                    {submittedBriefLength.toLocaleString()} / 24,000
                  </p>
                  <label className="block text-ui font-medium">
                    Document type
                    <Select
                      value={documentType}
                      onValueChange={(value) => {
                        if (value) setDocumentType(value as WorkflowDocumentType);
                      }}
                    >
                      <SelectTrigger aria-label="Document type">
                        <SelectValue>{documentProfile.label}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start">
                        {WORKFLOW_DOCUMENT_TYPE_ORDER.map((type) => (
                          <SelectItem key={type} value={type}>
                            {WORKFLOW_DOCUMENT_PROFILES[type].label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </label>
                  <p className="text-ui text-muted-foreground">{documentProfile.description}</p>
                  <p className="text-2xs text-muted-foreground">
                    Sections:{" "}
                    {documentProfile.sections.map((section) => section.heading).join(" · ") ||
                      "As specified in the brief"}
                  </p>
                  {sameDocumentAuthors ? (
                    <p role="alert" className="text-ui text-destructive-foreground">
                      Document workflows need two different author models.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <section aria-label="Models" className="flex flex-col gap-2">
                <SectionLabel as="h3">Models</SectionLabel>
                <SlotRow
                  label={
                    workflowType === "planning" || workflowType === "document"
                      ? "Author A"
                      : workflowType === "investigation"
                        ? "Investigator A"
                        : "Reviewer A"
                  }
                  provider={branchAProvider}
                  model={branchASelection}
                  modelOptions={branchAModelOptions}
                  modelOptionsByProvider={modelOptionsByProvider}
                  onProviderModelChange={(provider, model) => {
                    setBranchAProvider(provider);
                    setBranchAModel(model);
                    setBranchAModelOptions(undefined);
                    useModelPreferencesStore
                      .getState()
                      .setLastWorkflowProvider("branchA", provider);
                    recordModelSelection(provider, model, undefined);
                  }}
                  onModelOptionsChange={(modelOptions) => {
                    setBranchAModelOptions(modelOptions);
                    recordModelSelection(
                      branchAProvider,
                      branchASelection,
                      normalizeWorkflowSlotModelOptions(
                        branchAProvider,
                        branchASelection,
                        modelOptions,
                      ),
                    );
                  }}
                />
                <SlotRow
                  label={
                    workflowType === "planning" || workflowType === "document"
                      ? "Author B"
                      : workflowType === "investigation"
                        ? "Investigator B"
                        : "Reviewer B"
                  }
                  provider={branchBProvider}
                  model={branchBSelection}
                  modelOptions={branchBModelOptions}
                  modelOptionsByProvider={modelOptionsByProvider}
                  onProviderModelChange={(provider, model) => {
                    setBranchBProvider(provider);
                    setBranchBModel(model);
                    setBranchBModelOptions(undefined);
                    useModelPreferencesStore
                      .getState()
                      .setLastWorkflowProvider("branchB", provider);
                    recordModelSelection(provider, model, undefined);
                  }}
                  onModelOptionsChange={(modelOptions) => {
                    setBranchBModelOptions(modelOptions);
                    recordModelSelection(
                      branchBProvider,
                      branchBSelection,
                      normalizeWorkflowSlotModelOptions(
                        branchBProvider,
                        branchBSelection,
                        modelOptions,
                      ),
                    );
                  }}
                />
                <SlotRow
                  label={
                    workflowType === "document"
                      ? "Merge model"
                      : workflowType === "planning"
                        ? "Merge"
                        : workflowType === "investigation"
                          ? "Synthesis"
                          : "Consolidation"
                  }
                  provider={mergeProvider}
                  model={mergeSelection}
                  modelOptions={mergeModelOptions}
                  modelOptionsByProvider={modelOptionsByProvider}
                  onProviderModelChange={(provider, model) => {
                    setMergeProvider(provider);
                    setMergeModel(model);
                    setMergeModelOptions(undefined);
                    useModelPreferencesStore.getState().setLastWorkflowProvider("merge", provider);
                    recordModelSelection(provider, model, undefined);
                  }}
                  onModelOptionsChange={(modelOptions) => {
                    setMergeModelOptions(modelOptions);
                    recordModelSelection(
                      mergeProvider,
                      mergeSelection,
                      normalizeWorkflowSlotModelOptions(
                        mergeProvider,
                        mergeSelection,
                        modelOptions,
                      ),
                    );
                  }}
                />
              </section>
              {workflowType === "document" ? (
                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                  <WorkflowOptionCheckbox
                    checked={readerReviewEnabled}
                    onCheckedChange={setReaderReviewEnabled}
                    label="Reader review of the final document"
                    description="After merging, a simulated reader from the target audience reads the document and reports where they got lost. The merge model then polishes the document to address it."
                  />
                  {readerReviewEnabled ? (
                    <>
                      <label className="block text-ui font-medium">
                        Reader persona (optional)
                        <textarea
                          aria-label="Reader persona (optional)"
                          maxLength={500}
                          value={readerPersona}
                          onChange={(event) => setReaderPersona(event.target.value)}
                          placeholder={documentProfile.readerPersona}
                          className="mt-1.5 min-h-20 w-full rounded-lg border border-input bg-background p-2 text-sm font-normal outline-none transition-colors focus-visible:border-ring/60"
                        />
                      </label>
                      <p className="text-2xs text-muted-foreground tabular-nums">
                        {readerPersona.length} / 500
                      </p>
                      <SlotRow
                        label="Reader model"
                        provider={effectiveReaderSlot.provider}
                        model={readerSelection}
                        modelOptions={effectiveReaderSlot.modelOptions}
                        modelOptionsByProvider={modelOptionsByProvider}
                        onProviderModelChange={(provider, model) =>
                          setReaderSlot({ provider, model })
                        }
                        onModelOptionsChange={(modelOptions) =>
                          setReaderSlot({
                            ...effectiveReaderSlot,
                            ...(modelOptions ? { modelOptions } : { modelOptions: undefined }),
                          })
                        }
                      />
                      {effectiveReaderSlot.provider === mergeProvider &&
                      readerSelection === mergeSelection ? (
                        <p className="text-2xs text-muted-foreground">
                          The reader is the model that writes the final document; a different model
                          usually catches more gaps.
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
              <WorkflowOptions summary={optionsSummary}>
                {workflowType === "planning" || workflowType === "document" ? (
                  <WorkflowOptionCheckbox
                    checked={selfReviewEnabled}
                    onCheckedChange={setSelfReviewEnabled}
                    label="Own-model review"
                    description={`Alongside cross-review, each author reviews its own ${
                      workflowType === "document" ? "draft" : "plan"
                    } in a separate clean chat.`}
                  />
                ) : null}
                {workflowType === "planning" ? (
                  <WorkflowOptionField label="Plans directory">
                    <input
                      className={cn(WORKFLOW_OPTION_INPUT_CLASS_NAME, "font-mono")}
                      value={plansDirectory}
                      onChange={(event) => setPlansDirectory(event.target.value)}
                    />
                  </WorkflowOptionField>
                ) : null}
                {workflowType === "codeReview" || workflowType === "investigation" ? (
                  <WorkflowOptionField
                    label={
                      workflowType === "investigation"
                        ? "Compare against branch (optional)"
                        : "Compare against branch"
                    }
                  >
                    <input
                      className={cn(WORKFLOW_OPTION_INPUT_CLASS_NAME, "font-mono")}
                      value={reviewBranch}
                      onChange={(event) => setReviewBranch(event.target.value)}
                      placeholder="main"
                    />
                  </WorkflowOptionField>
                ) : null}
                {workflowType === "investigation" ? (
                  <WorkflowOptionCheckbox
                    checked={investigationSelfReviewEnabled}
                    onCheckedChange={setInvestigationSelfReviewEnabled}
                    label="Own-model review"
                    description="After investigation, each model audits its own RCA in a separate clean chat."
                  />
                ) : null}
                <WorkflowOptionField
                  label="Run cost limit in USD (optional)"
                  hint="F5 checks the limit before launching each subsequent workflow node."
                >
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    className={WORKFLOW_OPTION_INPUT_CLASS_NAME}
                    value={maxCostUsd}
                    onChange={(event) => setMaxCostUsd(event.target.value)}
                    placeholder="No limit"
                  />
                </WorkflowOptionField>
              </WorkflowOptions>
              {sameInvestigationInvestigatorModel ? (
                <p className="text-ui text-destructive-foreground">
                  Investigation workflows require two different investigator models.
                </p>
              ) : null}
              {!validMaxCostUsd ? (
                <p className="text-ui text-destructive-foreground">
                  Cost limit must be greater than zero.
                </p>
              ) : null}
              <p className="text-2xs text-muted-foreground">
                Workflow titles are generated automatically using the thread title model.
              </p>
              {error ? <p className="text-ui text-destructive-foreground">{error}</p> : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onSubmit()} disabled={submitting || !canSubmit}>
            {submitting ? (
              "Starting..."
            ) : (
              <>
                <span>Start workflow</span>
                {primaryActionShortcutLabel ? (
                  <Kbd
                    aria-hidden="true"
                    className="hidden bg-primary-foreground/15 text-primary-foreground/80 sm:inline-flex"
                  >
                    {primaryActionShortcutLabel}
                  </Kbd>
                ) : null}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
