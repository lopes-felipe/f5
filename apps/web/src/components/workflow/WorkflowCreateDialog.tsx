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
  ClaudeCodeEffort,
  CodexReasoningEffort,
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
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
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
  reconcileComposerMentions,
  type ComposerMention,
} from "../../composer-editor-mentions";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import {
  WORKFLOW_TYPE_DIALOG_LABEL,
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
import { Kbd } from "../ui/kbd";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
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
import { ChevronDownIcon, XIcon } from "lucide-react";

const CODEX_REASONING_LABELS: Record<CodexReasoningEffort, string> = {
  ultra: "Ultra",
  max: "Max",
  xhigh: "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
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
    const options = getReasoningEffortOptions("codex", props.model);
    const defaultEffort = getDefaultReasoningEffort("codex", props.model);
    const selectedEffort = resolveCodexReasoningEffortForModel(
      props.model,
      props.modelOptions?.codex?.reasoningEffort,
    );
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
                  codex: normalizeCodexModelOptions(props.model, {
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

  if (props.provider !== "claudeAgent") {
    return null;
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
  }>({ text: "", mentions: [] });
  const requirementPrompt = requirementDraft.text;
  const requirementEditRef = useRef<{ start: number; end: number } | undefined>(undefined);
  const captureRequirementSelection = (element: HTMLTextAreaElement) => {
    requirementEditRef.current = { start: element.selectionStart, end: element.selectionEnd };
  };
  const setRequirementPrompt = (text: string) => {
    const edit = requirementEditRef.current;
    requirementEditRef.current = undefined;
    setRequirementDraft((current) => ({
      text,
      mentions: reconcileComposerMentions(current.text, text, current.mentions, edit),
    }));
  };
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
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
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
    promptTextareaRef.current?.focus();
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
          return {
            text: prefix + mention + " ",
            mentions: [...current.mentions, createComposerMention(relativePath, prefix.length)],
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
                    resolveWorkflowModelSelection(
                      effectiveReaderSlot.provider,
                      effectiveReaderSlot.model,
                    ),
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

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl" onKeyDown={onDialogKeyDown}>
        <DialogHeader>
          <DialogTitle>New Workflow</DialogTitle>
          <DialogDescription>
            Create a feature workflow, code review, root-cause investigation, or document. The title
            will be generated from your prompt.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <ToggleGroup
            variant="outline"
            className="grid w-full grid-cols-4"
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
            {WORKFLOW_TYPE_ORDER.map((type) => (
              <Toggle
                key={type}
                value={type}
                className={cn("w-full justify-center", WORKFLOW_TYPE_TOGGLE_CLASS[type])}
              >
                {WORKFLOW_TYPE_DIALOG_LABEL[type]}
              </Toggle>
            ))}
          </ToggleGroup>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              {workflowType === "document"
                ? "Brief"
                : workflowType === "planning"
                  ? "Requirement"
                  : workflowType === "investigation"
                    ? "Problem to investigate"
                    : "Review instructions"}
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
                onBeforeInput={(event) => captureRequirementSelection(event.currentTarget)}
                onPasteCapture={(event) => captureRequirementSelection(event.currentTarget)}
                onCutCapture={(event) => captureRequirementSelection(event.currentTarget)}
                onChange={(event) => setRequirementPrompt(event.target.value)}
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
              <p className="text-xs text-muted-foreground">
                {submittedBriefLength.toLocaleString()} / 24,000
              </p>
              <label className="block text-sm font-medium">
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
              <p className="text-sm text-muted-foreground">{documentProfile.description}</p>
              <p className="text-xs text-muted-foreground">
                Sections:{" "}
                {documentProfile.sections.map((section) => section.heading).join(" · ") ||
                  "As specified in the brief"}
              </p>
              {sameDocumentAuthors ? (
                <p role="alert" className="text-sm text-destructive">
                  Document workflows need two different author models.
                </p>
              ) : null}
            </div>
          ) : null}
          <ProviderFields
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
                normalizeWorkflowSlotModelOptions(mergeProvider, mergeSelection, modelOptions),
              );
            }}
          />
          {workflowType === "planning" || workflowType === "document" ? (
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
                      Alongside cross-review, each author reviews its own{" "}
                      {workflowType === "document" ? "draft" : "plan"} in a separate clean chat.
                    </span>
                  </span>
                </label>
              </div>
              {workflowType === "planning" ? (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-foreground">
                    Plans directory
                  </label>
                  <input
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={plansDirectory}
                    onChange={(event) => setPlansDirectory(event.target.value)}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground">
                  {workflowType === "investigation"
                    ? "Compare against branch (optional)"
                    : "Compare against branch"}
                </label>
                <input
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={reviewBranch}
                  onChange={(event) => setReviewBranch(event.target.value)}
                  placeholder="main"
                />
              </div>
              {workflowType === "investigation" ? (
                <div className="space-y-2 rounded-md border border-input bg-background px-3 py-3">
                  <label className="flex items-start gap-3">
                    <Checkbox
                      checked={investigationSelfReviewEnabled}
                      onCheckedChange={(checked) =>
                        setInvestigationSelfReviewEnabled(checked === true)
                      }
                    />
                    <span className="space-y-1">
                      <span className="block text-sm font-medium text-foreground">
                        Own-model review
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        After investigation, each model audits its own RCA in a separate clean chat.
                      </span>
                    </span>
                  </label>
                </div>
              ) : null}
            </>
          )}
          {workflowType === "document" ? (
            <div className="space-y-3 rounded-md border border-input p-3">
              <label className="flex items-start gap-3">
                <Checkbox
                  checked={readerReviewEnabled}
                  onCheckedChange={(checked) => setReaderReviewEnabled(checked === true)}
                />
                <span>
                  <span className="block text-sm font-medium">
                    Reader review of the final document
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    After merging, a simulated reader from the target audience reads the document
                    and reports where they got lost. The merge model then polishes the document to
                    address it.
                  </span>
                </span>
              </label>
              {readerReviewEnabled ? (
                <>
                  <label className="block text-sm font-medium">
                    Reader persona (optional)
                    <textarea
                      aria-label="Reader persona (optional)"
                      maxLength={500}
                      value={readerPersona}
                      onChange={(event) => setReaderPersona(event.target.value)}
                      placeholder={documentProfile.readerPersona}
                      className="mt-2 min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm"
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">{readerPersona.length} / 500</p>
                  <ProviderFields
                    label="Reader model"
                    provider={effectiveReaderSlot.provider}
                    model={effectiveReaderSlot.model as ModelSlug}
                    modelOptions={effectiveReaderSlot.modelOptions}
                    modelOptionsByProvider={modelOptionsByProvider}
                    onProviderModelChange={(provider, model) => setReaderSlot({ provider, model })}
                    onModelOptionsChange={(modelOptions) =>
                      setReaderSlot({
                        ...effectiveReaderSlot,
                        ...(modelOptions ? { modelOptions } : { modelOptions: undefined }),
                      })
                    }
                  />
                  {effectiveReaderSlot.provider === mergeProvider &&
                  effectiveReaderSlot.model === mergeSelection ? (
                    <p className="text-xs text-muted-foreground">
                      The reader is the model that writes the final document; a different model
                      usually catches more gaps.
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Run cost limit in USD (optional)
            </label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={maxCostUsd}
              onChange={(event) => setMaxCostUsd(event.target.value)}
              placeholder="No limit"
            />
            <p className="text-xs text-muted-foreground">
              F5 checks the limit before launching each subsequent workflow node.
            </p>
          </div>
          {sameInvestigationInvestigatorModel ? (
            <p className="text-sm text-red-500">
              Investigation workflows require two different investigator models.
            </p>
          ) : null}
          {!validMaxCostUsd ? (
            <p className="text-sm text-red-500">Cost limit must be greater than zero.</p>
          ) : null}
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
