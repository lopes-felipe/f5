import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ClaudeCodeEffort,
  CodexReasoningEffort,
  ModelSlug,
  ProjectId,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";
import {
  getDefaultModel,
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  resolveReasoningEffortForProvider,
  supportsClaudeFastMode,
  supportsClaudeThinkingToggle,
} from "@t3tools/shared/model";

import {
  resolveAppModelSelection,
  resolveThreadTitleModel,
  useAppSettings,
} from "../../appSettings";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import {
  appendAttachedFilesToPrompt,
  normalizeAttachedFilePaths,
  relativePathForDisplay,
  sanitizeAttachedFileReferencePaths,
} from "../../lib/attachedFiles";
import {
  getModelPreferences,
  recordModelSelection,
  type WorkflowCreatePreferenceSlot,
  useModelPreferencesStore,
} from "../../modelPreferencesStore";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { basenameOfPath } from "../../vscode-icons";
import {
  createCachedAbsolutePathComparisonNormalizer,
  getCustomModelOptionsByProvider,
  identityAbsolutePathNormalizer,
  resolveAttachedFileReferencePaths,
} from "../ChatView.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { ChevronDownIcon, XIcon } from "lucide-react";

const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const CLAUDE_REASONING_LABELS: Record<Exclude<ClaudeCodeEffort, "ultrathink">, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function WorkflowReasoningPicker(props: {
  provider: ProviderKind;
  model: string;
  modelOptions: ProviderModelOptions | undefined;
  onChange: (modelOptions: ProviderModelOptions | undefined) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  if (props.provider === "codex") {
    const options = getReasoningEffortOptions("codex");
    const defaultEffort = getDefaultReasoningEffort("codex");
    const selectedEffort =
      resolveReasoningEffortForProvider("codex", props.modelOptions?.codex?.reasoningEffort) ??
      defaultEffort;
    return (
      <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <MenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            />
          }
        >
          <span>{CODEX_REASONING_LABELS[selectedEffort]}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning</div>
            <MenuRadioGroup
              value={selectedEffort}
              onValueChange={(value) => {
                const nextEffort = options.find((option) => option === value);
                if (!nextEffort) return;
                props.onChange({
                  ...props.modelOptions,
                  codex: normalizeCodexModelOptions({
                    ...props.modelOptions?.codex,
                    reasoningEffort: nextEffort,
                  }),
                });
                setIsMenuOpen(false);
              }}
            >
              {options.map((option) => (
                <MenuRadioItem key={option} value={option}>
                  {CODEX_REASONING_LABELS[option]}
                  {option === defaultEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
    );
  }

  const options = getReasoningEffortOptions("claudeAgent", props.model).filter(
    (option): option is Exclude<ClaudeCodeEffort, "ultrathink"> => option !== "ultrathink",
  );
  const supportsThinking = supportsClaudeThinkingToggle(props.model);
  const supportsFast = supportsClaudeFastMode(props.model);
  const defaultEffort = getDefaultReasoningEffort("claudeAgent", props.model);
  const fallbackEffort = options.includes(defaultEffort as Exclude<ClaudeCodeEffort, "ultrathink">)
    ? (defaultEffort as Exclude<ClaudeCodeEffort, "ultrathink">)
    : options[0]!;
  const resolvedEffort = resolveReasoningEffortForProvider(
    "claudeAgent",
    props.modelOptions?.claudeAgent?.effort,
  );
  const selectedEffort: Exclude<ClaudeCodeEffort, "ultrathink"> =
    resolvedEffort && resolvedEffort !== "ultrathink" && options.includes(resolvedEffort)
      ? resolvedEffort
      : fallbackEffort;
  const thinkingEnabled = supportsThinking
    ? (props.modelOptions?.claudeAgent?.thinking ?? true)
    : null;
  const fastModeEnabled = supportsFast && props.modelOptions?.claudeAgent?.fastMode === true;
  const triggerLabel =
    options.length > 0
      ? CLAUDE_REASONING_LABELS[selectedEffort]
      : thinkingEnabled !== null
        ? `Thinking ${thinkingEnabled ? "On" : "Off"}`
        : fastModeEnabled
          ? "Fast"
          : null;
  if (triggerLabel === null) {
    return null;
  }

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
          />
        }
      >
        <span>{triggerLabel}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        {options.length > 0 ? (
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning</div>
            <MenuRadioGroup
              value={selectedEffort}
              onValueChange={(value) => {
                const nextEffort = options.find((option) => option === value);
                if (!nextEffort) return;
                props.onChange({
                  ...props.modelOptions,
                  claudeAgent: normalizeClaudeModelOptions(props.model, {
                    ...props.modelOptions?.claudeAgent,
                    effort: nextEffort,
                  }),
                });
                setIsMenuOpen(false);
              }}
            >
              {options.map((option) => (
                <MenuRadioItem key={option} value={option}>
                  {CLAUDE_REASONING_LABELS[option]}
                  {option === defaultEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {thinkingEnabled !== null ? (
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
            <MenuRadioGroup
              value={thinkingEnabled ? "on" : "off"}
              onValueChange={(value) => {
                props.onChange({
                  ...props.modelOptions,
                  claudeAgent: normalizeClaudeModelOptions(props.model, {
                    ...props.modelOptions?.claudeAgent,
                    thinking: value === "on",
                  }),
                });
                setIsMenuOpen(false);
              }}
            >
              <MenuRadioItem value="on">On (default)</MenuRadioItem>
              <MenuRadioItem value="off">Off</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {supportsFast ? (
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                props.onChange({
                  ...props.modelOptions,
                  claudeAgent: normalizeClaudeModelOptions(props.model, {
                    ...props.modelOptions?.claudeAgent,
                    fastMode: value === "on",
                  }),
                });
                setIsMenuOpen(false);
              }}
            >
              <MenuRadioItem value="off">Off</MenuRadioItem>
              <MenuRadioItem value="on">On</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function normalizeWorkflowSlotModelOptions(
  provider: ProviderKind,
  model: string,
  modelOptions: ProviderModelOptions | undefined,
): ProviderModelOptions | undefined {
  if (provider === "codex") {
    const effort = resolveReasoningEffortForProvider("codex", modelOptions?.codex?.reasoningEffort);
    const codex = {
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(modelOptions?.codex?.fastMode === true ? { fastMode: true } : {}),
    };
    if (Object.keys(codex).length === 0) {
      return undefined;
    }
    return codex ? { codex } : undefined;
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
  const providerModelOptions = modelOptions?.[provider];
  if (!providerModelOptions) {
    return undefined;
  }
  return provider === "codex"
    ? { codex: providerModelOptions }
    : { claudeAgent: providerModelOptions };
}

function getWorkflowSlotDefaults(
  slot: WorkflowCreatePreferenceSlot,
  fallbackProvider: ProviderKind,
): {
  provider: ProviderKind;
  model: string;
  modelOptions: ProviderModelOptions | undefined;
} {
  const preferences = getModelPreferences();
  const provider = preferences.lastWorkflowProviderBySlot[slot] ?? fallbackProvider;
  return {
    provider,
    model: preferences.lastModelByProvider[provider] ?? getDefaultModel(provider),
    modelOptions: getSingleProviderModelOptions(provider, preferences.lastModelOptions),
  };
}

interface WorkflowCreateDialogProps {
  open: boolean;
  projectId: ProjectId;
  onOpenChange: (open: boolean) => void;
  onWorkflowCreated?: (workflowId: string) => void;
}

export function ProviderFields(props: {
  label: string;
  provider: ProviderKind;
  model: ModelSlug;
  modelOptions: ProviderModelOptions | undefined;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  onModelOptionsChange: (modelOptions: ProviderModelOptions | undefined) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-foreground">{props.label}</label>
      <div className="flex h-10 items-center rounded-md border border-input bg-background px-2">
        <ProviderModelPicker
          provider={props.provider}
          model={props.model}
          lockedProvider={null}
          modelOptionsByProvider={props.modelOptionsByProvider}
          onProviderModelChange={props.onProviderModelChange}
        />
        <WorkflowReasoningPicker
          provider={props.provider}
          model={props.model}
          modelOptions={props.modelOptions}
          onChange={props.onModelOptionsChange}
        />
      </div>
    </div>
  );
}

export function WorkflowCreateDialog(props: WorkflowCreateDialogProps) {
  const { settings } = useAppSettings();
  const { resolvedTheme } = useTheme();
  const project = useStore(
    (store) => store.projects.find((entry) => entry.id === props.projectId) ?? null,
  );
  const initialBranchADefaults = getWorkflowSlotDefaults("branchA", "codex");
  const initialBranchBDefaults = getWorkflowSlotDefaults("branchB", "claudeAgent");
  const initialMergeDefaults = getWorkflowSlotDefaults("merge", "codex");
  const [workflowType, setWorkflowType] = useState<"planning" | "codeReview">("planning");
  const [requirementPrompt, setRequirementPrompt] = useState("");
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOverPrompt, setIsDragOverPrompt] = useState(false);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragDepthRef = useRef(0);
  const modelOptionsByProvider = useMemo(
    () => getCustomModelOptionsByProvider(settings),
    [settings],
  );

  const resolveWorkflowModelSelection = (provider: ProviderKind, model: string): ModelSlug =>
    resolveAppModelSelection(
      provider,
      provider === "codex" ? settings.customCodexModels : settings.customClaudeModels,
      model,
    ) as ModelSlug;

  const branchASelection = resolveWorkflowModelSelection(branchAProvider, branchAModel);
  const branchBSelection = resolveWorkflowModelSelection(branchBProvider, branchBModel);
  const mergeSelection = resolveWorkflowModelSelection(mergeProvider, mergeModel);
  const titleGenerationModel = resolveThreadTitleModel(settings);
  const workspaceRoots = [project?.cwd];
  const canSubmit = requirementPrompt.trim().length > 0 || attachedFilePaths.length > 0;

  const focusPromptEditor = () => {
    promptTextareaRef.current?.focus();
  };

  const reset = () => {
    const branchADefaults = getWorkflowSlotDefaults("branchA", "codex");
    const branchBDefaults = getWorkflowSlotDefaults("branchB", "claudeAgent");
    const mergeDefaults = getWorkflowSlotDefaults("merge", "codex");

    setWorkflowType("planning");
    setRequirementPrompt("");
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
    setError(null);
    setIsDragOverPrompt(false);
    dragDepthRef.current = 0;
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
    const api = readNativeApi();
    if (!api) {
      setError("Native API is unavailable.");
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
        setSubmitting(false);
        return;
      }
      const promptForSubmission = appendAttachedFilesToPrompt(
        requirementPrompt,
        attachedFilePathsSnapshot,
      );
      if (workflowType === "planning") {
        const result = await api.orchestration.createWorkflow({
          projectId: props.projectId,
          requirementPrompt: promptForSubmission,
          titleGenerationModel,
          plansDirectory: plansDirectory.trim() || "plans",
          selfReviewEnabled,
          branchA: {
            provider: branchAProvider,
            model: branchASelection,
            ...(normalizeWorkflowSlotModelOptions(
              branchAProvider,
              branchASelection,
              branchAModelOptions,
            )
              ? {
                  modelOptions: normalizeWorkflowSlotModelOptions(
                    branchAProvider,
                    branchASelection,
                    branchAModelOptions,
                  ),
                }
              : {}),
          },
          branchB: {
            provider: branchBProvider,
            model: branchBSelection,
            ...(normalizeWorkflowSlotModelOptions(
              branchBProvider,
              branchBSelection,
              branchBModelOptions,
            )
              ? {
                  modelOptions: normalizeWorkflowSlotModelOptions(
                    branchBProvider,
                    branchBSelection,
                    branchBModelOptions,
                  ),
                }
              : {}),
          },
          merge: {
            provider: mergeProvider,
            model: mergeSelection,
            ...(normalizeWorkflowSlotModelOptions(mergeProvider, mergeSelection, mergeModelOptions)
              ? {
                  modelOptions: normalizeWorkflowSlotModelOptions(
                    mergeProvider,
                    mergeSelection,
                    mergeModelOptions,
                  ),
                }
              : {}),
          },
        });
        props.onWorkflowCreated?.(result.workflowId);
      } else {
        const result = await api.orchestration.createCodeReviewWorkflow({
          projectId: props.projectId,
          reviewPrompt: promptForSubmission,
          titleGenerationModel,
          ...(reviewBranch.trim() ? { branch: reviewBranch.trim() } : {}),
          reviewerA: {
            provider: branchAProvider,
            model: branchASelection,
            ...(normalizeWorkflowSlotModelOptions(
              branchAProvider,
              branchASelection,
              branchAModelOptions,
            )
              ? {
                  modelOptions: normalizeWorkflowSlotModelOptions(
                    branchAProvider,
                    branchASelection,
                    branchAModelOptions,
                  ),
                }
              : {}),
          },
          reviewerB: {
            provider: branchBProvider,
            model: branchBSelection,
            ...(normalizeWorkflowSlotModelOptions(
              branchBProvider,
              branchBSelection,
              branchBModelOptions,
            )
              ? {
                  modelOptions: normalizeWorkflowSlotModelOptions(
                    branchBProvider,
                    branchBSelection,
                    branchBModelOptions,
                  ),
                }
              : {}),
          },
          consolidation: {
            provider: mergeProvider,
            model: mergeSelection,
            ...(normalizeWorkflowSlotModelOptions(mergeProvider, mergeSelection, mergeModelOptions)
              ? {
                  modelOptions: normalizeWorkflowSlotModelOptions(
                    mergeProvider,
                    mergeSelection,
                    mergeModelOptions,
                  ),
                }
              : {}),
          },
        });
        props.onWorkflowCreated?.(result.workflowId);
      }
      reset();
      props.onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Workflow</DialogTitle>
          <DialogDescription>
            Create either a feature workflow or a standalone code review workflow. The title will be
            generated from your prompt.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-md border border-input bg-background p-1">
            <button
              type="button"
              className={`rounded-sm px-3 py-2 text-sm ${
                workflowType === "planning"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground"
              }`}
              onClick={() => setWorkflowType("planning")}
            >
              Feature
            </button>
            <button
              type="button"
              className={`rounded-sm px-3 py-2 text-sm ${
                workflowType === "codeReview"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground"
              }`}
              onClick={() => setWorkflowType("codeReview")}
            >
              Code Review
            </button>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              {workflowType === "planning" ? "Requirement" : "Review instructions"}
            </label>
            <div
              className={`space-y-3 rounded-md border bg-background px-3 py-2 ${
                isDragOverPrompt ? "border-primary/70 ring-2 ring-primary/15" : "border-input"
              }`}
              onPaste={onPromptPaste}
              onDragEnter={onPromptDragEnter}
              onDragOver={onPromptDragOver}
              onDragLeave={onPromptDragLeave}
              onDrop={onPromptDrop}
            >
              {attachedFilePaths.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {attachedFilePaths.map((filePath) => {
                    const displayPath = relativePathForDisplay(filePath, project?.cwd);
                    return (
                      <span
                        key={filePath}
                        className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-accent/40 px-1.5 py-1 text-[12px] text-foreground"
                        title={displayPath}
                      >
                        <VscodeEntryIcon
                          pathValue={filePath}
                          kind="file"
                          theme={resolvedTheme}
                          className="size-3.5"
                        />
                        <span className="max-w-[200px] truncate">
                          {basenameOfPath(displayPath)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeAttachedFilePath(filePath)}
                          disabled={submitting}
                          aria-label={`Remove ${displayPath}`}
                        >
                          <XIcon className="size-3" />
                        </Button>
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <textarea
                ref={promptTextareaRef}
                className="min-h-32 w-full resize-y bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
                value={requirementPrompt}
                onChange={(event) => setRequirementPrompt(event.target.value)}
                placeholder={
                  workflowType === "planning"
                    ? "Describe the feature or requirement to plan."
                    : "Describe what the reviewers should inspect and how they should review it."
                }
              />
            </div>
          </div>
          <ProviderFields
            label={workflowType === "planning" ? "Author A" : "Reviewer A"}
            provider={branchAProvider}
            model={branchASelection}
            modelOptions={branchAModelOptions}
            modelOptionsByProvider={modelOptionsByProvider}
            onProviderModelChange={(provider, model) => {
              setBranchAProvider(provider);
              setBranchAModel(model);
              setBranchAModelOptions(undefined);
              useModelPreferencesStore.getState().setLastWorkflowProvider("branchA", provider);
              recordModelSelection(provider, model, undefined);
            }}
            onModelOptionsChange={(modelOptions) => {
              setBranchAModelOptions(modelOptions);
              recordModelSelection(
                branchAProvider,
                branchASelection,
                normalizeWorkflowSlotModelOptions(branchAProvider, branchASelection, modelOptions),
              );
            }}
          />
          <ProviderFields
            label={workflowType === "planning" ? "Author B" : "Reviewer B"}
            provider={branchBProvider}
            model={branchBSelection}
            modelOptions={branchBModelOptions}
            modelOptionsByProvider={modelOptionsByProvider}
            onProviderModelChange={(provider, model) => {
              setBranchBProvider(provider);
              setBranchBModel(model);
              setBranchBModelOptions(undefined);
              useModelPreferencesStore.getState().setLastWorkflowProvider("branchB", provider);
              recordModelSelection(provider, model, undefined);
            }}
            onModelOptionsChange={(modelOptions) => {
              setBranchBModelOptions(modelOptions);
              recordModelSelection(
                branchBProvider,
                branchBSelection,
                normalizeWorkflowSlotModelOptions(branchBProvider, branchBSelection, modelOptions),
              );
            }}
          />
          <ProviderFields
            label={workflowType === "planning" ? "Merge" : "Consolidation"}
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
                normalizeWorkflowSlotModelOptions(mergeProvider, mergeSelection, modelOptions),
              );
            }}
          />
          {workflowType === "planning" ? (
            <>
              <div className="space-y-2 rounded-md border border-input bg-background px-3 py-3">
                <label className="flex items-start gap-3">
                  <Checkbox
                    checked={selfReviewEnabled}
                    onCheckedChange={(checked) => setSelfReviewEnabled(checked === true)}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium text-foreground">
                      Own-model review
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      After cross-review, each author also reviews its own plan in a separate clean
                      chat.
                    </span>
                  </span>
                </label>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground">Plans directory</label>
                <input
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={plansDirectory}
                  onChange={(event) => setPlansDirectory(event.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">
                Compare against branch
              </label>
              <input
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={reviewBranch}
                onChange={(event) => setReviewBranch(event.target.value)}
                placeholder="main"
              />
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Workflow titles are generated automatically using the thread title model.
          </p>
          {error ? <p className="text-sm text-red-500">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onSubmit()} disabled={submitting || !canSubmit}>
            {submitting ? "Starting..." : "Start workflow"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
