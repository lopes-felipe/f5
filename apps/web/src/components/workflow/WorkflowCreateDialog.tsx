import { ProviderDriverKind } from "@t3tools/contracts";
import { getWorkflowModelCapabilities } from "../../providerModels";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import {
  DOCUMENT_WORKFLOW_TEMPLATE_ID,
  DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS,
  ThreadId,
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
import { flushSync } from "react-dom";
import { PlusIcon, XIcon } from "lucide-react";
import type {
  ModelSlug,
  ProjectId,
  ProviderKind,
  ProviderModelOptions,
  WorkflowModelSlot,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { detectCodeReviewPullRequestTarget } from "@t3tools/shared/codeReviewPullRequest";
import { isScratchProject } from "@t3tools/shared/scratchProject";

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
import { uploadAttachment } from "../../lib/attachmentUploadQueue";
import { getServerHttpOrigin } from "../../lib/serverHttpOrigin";
import {
  collectComposerMentionPaths,
  createComposerMention,
  type ComposerMention,
} from "../../composer-editor-mentions";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ProjectPicker } from "../ProjectPicker";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import { fieldSurfaceClassName } from "../ui/input";
import {
  WORKFLOW_TYPE_DESCRIPTION,
  WORKFLOW_TYPE_DIALOG_LABEL,
  WORKFLOW_TYPE_ICON,
  WORKFLOW_TYPE_ORDER,
  WORKFLOW_TYPE_TOGGLE_CLASS,
  type WorkflowTypeValue,
} from "../../lib/workflowType";
import { recordModelSelection, useModelPreferencesStore } from "../../modelPreferencesStore";
import {
  type SavedWorkflowSetup,
  type SavedWorkflowSlot,
  useWorkflowCreatePreferencesStore,
} from "../../workflowCreatePreferencesStore";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import {
  getWorkflowSlotDefaults,
  getWorkflowSlotDefaultsForProvider,
  normalizeWorkflowSlotModelOptions,
  makeWorkflowSlotBuilder,
  workflowModelOptionsByProvider,
} from "./workflowSlots";
import { useSettings } from "../../hooks/useSettings";
import { selectModelCatalogSettings } from "../chat/composer/useComposerDispatchSettings";
import {
  firstUsableWorkflowProvider,
  formatWorkflowTurnEstimate,
  pickNewWorkflowActorProvider,
  workflowActorDuplicateIndexes,
  workflowActorDuplicateMessage,
  workflowActorLimitMessage,
  workflowActorMax,
  workflowActorRowLabel,
  workflowAddActorLabel,
  type WorkflowActorRow,
} from "./workflowActorRows";
import { readOnlyWorkflowUnsupportedReason } from "@t3tools/shared/workflowProviders";
import { basenameOfPath } from "../../vscode-icons";
import {
  createCachedAbsolutePathComparisonNormalizer,
  getComposerModelOptionsByInstance,
  getProviderDispatchModelsByProvider,
  identityAbsolutePathNormalizer,
  partitionAttachedFiles,
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
import { Spinner } from "../ui/spinner";
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

let actorRowKeySequence = 0;
function nextActorRowKey(): string {
  actorRowKeySequence += 1;
  return `actor-${actorRowKeySequence}`;
}

function actorRow(defaults: {
  provider: ProviderKind;
  model: string;
  modelOptions: ProviderModelOptions | undefined;
}): WorkflowActorRow {
  return {
    key: nextActorRowKey(),
    provider: defaults.provider,
    model: defaults.model,
    modelOptions: defaults.modelOptions,
  };
}

/**
 * A workflow type's own options in dialog-state form. Options another type uses are absent and
 * leave the dialog's current value alone when applied.
 */
interface WorkflowTypeOptions {
  selfReviewEnabled?: boolean;
  investigationSelfReviewEnabled?: boolean;
  documentType?: WorkflowDocumentType;
  readerReviewEnabled?: boolean;
  readerSlot?: WorkflowModelSlot | null;
}

/** One workflow type's models and own options in dialog-state form. */
interface WorkflowDialogSetup extends WorkflowTypeOptions {
  actors: WorkflowActorRow[];
  merge: {
    provider: ProviderKind;
    model: string;
    modelOptions: ProviderModelOptions | undefined;
  };
}

/**
 * The options a type starts with when nothing was saved or edited for it. Feature and Document
 * share the own-model review state, so a switch must set it rather than carry the other's value.
 * Auto-post is per project and the plans directory is per repository, so neither is here.
 */
const WORKFLOW_TYPE_OPTION_DEFAULTS: Record<WorkflowTypeValue, WorkflowTypeOptions> = {
  planning: { selfReviewEnabled: true },
  document: {
    selfReviewEnabled: true,
    documentType: DEFAULT_WORKFLOW_DOCUMENT_TYPE,
    readerReviewEnabled: true,
    readerSlot: null,
  },
  codeReview: {},
  investigation: { investigationSelfReviewEnabled: false },
};

/** Whether the user last chose to auto-post code reviews in this project. */
function savedAutoPostReview(projectId: ProjectId): boolean {
  return useWorkflowCreatePreferencesStore.getState().autoPostProjectIds.includes(projectId);
}

function savedSlot(slot: WorkflowModelSlot): SavedWorkflowSlot {
  return {
    provider: slot.provider,
    model: slot.model,
    ...(slot.modelOptions ? { modelOptions: slot.modelOptions } : {}),
  };
}

/** The setup last submitted for `type`, with fresh row keys; `null` when it was never submitted. */
function savedWorkflowSetup(type: WorkflowTypeValue): WorkflowDialogSetup | null {
  const saved = useWorkflowCreatePreferencesStore.getState().setupsByType[type];
  if (!saved) return null;
  // Starts from the type's defaults, so an option that was not saved never keeps another
  // type's value.
  const setup: WorkflowDialogSetup = {
    ...WORKFLOW_TYPE_OPTION_DEFAULTS[type],
    actors: saved.actors.map((slot) =>
      actorRow({ provider: slot.provider, model: slot.model, modelOptions: slot.modelOptions }),
    ),
    merge: {
      provider: saved.merge.provider,
      model: saved.merge.model,
      modelOptions: saved.merge.modelOptions,
    },
  };
  if (saved.selfReviewEnabled !== undefined) {
    if (type === "investigation") setup.investigationSelfReviewEnabled = saved.selfReviewEnabled;
    else if (type === "planning" || type === "document") {
      setup.selfReviewEnabled = saved.selfReviewEnabled;
    }
  }
  if (type === "document") {
    if (saved.documentType !== undefined) setup.documentType = saved.documentType;
    if (saved.readerReviewEnabled !== undefined) {
      setup.readerReviewEnabled = saved.readerReviewEnabled;
    }
    if (saved.reader !== undefined) setup.readerSlot = saved.reader;
  }
  return setup;
}

interface WorkflowCreateDialogProps {
  open: boolean;
  projectId: ProjectId;
  onOpenChange: (open: boolean) => void;
  onWorkflowCreated?: (workflowId: string) => void;
  /** Retargets the open dialog; the typed brief and settings are kept. */
  onProjectChange?: (projectId: ProjectId) => void;
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
  const allProjects = useStore((store) => store.projects);
  // Workflows need a real workspace, so the scratch project is not offered.
  const pickerProjects = useMemo(
    () => allProjects.filter((entry) => !isScratchProject(entry)),
    [allProjects],
  );
  const catalogSettings = useSettings(selectModelCatalogSettings);
  // The composer's picker options, so workflow slots list exactly what threads list.
  const modelOptionsByInstance = useMemo(
    () =>
      getComposerModelOptionsByInstance(
        settings,
        catalogSettings,
        serverConfigQuery.data?.providers,
        serverConfigQuery.data?.settings,
      ),
    [
      catalogSettings,
      settings,
      serverConfigQuery.data?.providers,
      serverConfigQuery.data?.settings,
    ],
  );
  const modelOptionsByProvider = useMemo(
    () =>
      workflowModelOptionsByProvider(
        modelOptionsByInstance,
        serverConfigQuery.data?.providers ?? [],
      ),
    [modelOptionsByInstance, serverConfigQuery.data?.providers],
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
  // Each open starts on the last submitted type with the setup submitted for it, or with the
  // remembered A/B/merge providers when that type was never submitted.
  const initialSetup = (): WorkflowDialogSetup & { type: WorkflowTypeValue } => {
    const type = useWorkflowCreatePreferencesStore.getState().lastWorkflowType ?? "planning";
    const setup: WorkflowDialogSetup = savedWorkflowSetup(type) ?? {
      actors: [
        actorRow(
          getWorkflowSlotDefaults(
            "branchA",
            "codex",
            modelOptionsByProvider,
            serverConfigQuery.data?.providers,
          ),
        ),
        actorRow(
          getWorkflowSlotDefaults(
            "branchB",
            "claudeAgent",
            modelOptionsByProvider,
            serverConfigQuery.data?.providers,
          ),
        ),
      ],
      merge: getWorkflowSlotDefaults(
        "merge",
        "codex",
        modelOptionsByProvider,
        serverConfigQuery.data?.providers,
      ),
    };
    return { type, ...setup };
  };
  const [initial] = useState(initialSetup);
  const [workflowType, setWorkflowType] = useState<WorkflowTypeValue>(initial.type);
  const [requirementDraft, setRequirementDraft] = useState<{
    text: string;
    mentions: readonly ComposerMention[];
    cursor: number;
  }>({ text: "", mentions: [], cursor: 0 });
  const requirementPrompt = requirementDraft.text;
  const [documentType, setDocumentType] = useState<WorkflowDocumentType>(
    initial.documentType ?? DEFAULT_WORKFLOW_DOCUMENT_TYPE,
  );
  const [readerReviewEnabled, setReaderReviewEnabled] = useState(
    initial.readerReviewEnabled ?? true,
  );
  const [readerPersona, setReaderPersona] = useState("");
  const [readerSlot, setReaderSlot] = useState<WorkflowModelSlot | null>(
    initial.readerSlot ?? null,
  );
  const documentProfile = WORKFLOW_DOCUMENT_PROFILES[documentType];

  const [attachedFilePaths, setAttachedFilePaths] = useState<string[]>([]);
  /** What a project change dropped; cleared once new references are added. */
  const [projectChangeNote, setProjectChangeNote] = useState<string | null>(null);
  /** Bumped on every project change so late file-tree authorizations can tell they are stale. */
  const projectGenerationRef = useRef(0);
  /** Path-less files still uploading; the workflow cannot start until they land as paths. */
  const [pendingAttachmentCount, setPendingAttachmentCount] = useState(0);
  /** Bumped on reset, project change and close so late uploads can tell they are stale. */
  const attachmentGenerationRef = useRef(0);
  /** Draft owner for path-less file uploads; one per dialog session. */
  const attachmentDraftIdRef = useRef<ThreadId | null>(null);
  /**
   * Server copies of path-less files by chip path. Copies nothing will reference (removed
   * chip, project change, dialog closed without starting) are discarded; a started
   * workflow keeps its copies.
   */
  const materializedUploadIdsRef = useRef(new Map<string, string>());
  const [reviewBranch, setReviewBranch] = useState("");
  const [plansDirectory, setPlansDirectory] = useState("plans");
  // A type switch loads that type's saved or stashed setup; with neither, the rows stay.
  const [actors, setActors] = useState<WorkflowActorRow[]>(initial.actors);
  const [mergeProvider, setMergeProvider] = useState<ProviderKind>(initial.merge.provider);
  const [mergeModel, setMergeModel] = useState(initial.merge.model);
  const [mergeModelOptions, setMergeModelOptions] = useState<ProviderModelOptions | undefined>(
    initial.merge.modelOptions,
  );
  const [selfReviewEnabled, setSelfReviewEnabled] = useState(initial.selfReviewEnabled ?? true);
  const [investigationSelfReviewEnabled, setInvestigationSelfReviewEnabled] = useState(
    initial.investigationSelfReviewEnabled ?? false,
  );
  // Restored only for the project the user opted in from, since it posts publicly.
  const [autoPostReview, setAutoPostReview] = useState(() => savedAutoPostReview(props.projectId));
  /** Each type's in-dialog setup from before switching away, for this dialog session only. */
  const stashedSetupsRef = useRef(new Map<WorkflowTypeValue, WorkflowDialogSetup>());
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

  const actorSelections = actors.map((row) =>
    resolveWorkflowModelSelection(row.provider, row.model),
  );
  // Keyed by row so a resolved selection is applied to the row it was resolved for. JSON keeps
  // slugs that contain delimiters intact.
  const actorSelectionsKey = JSON.stringify(
    actors.map((row, index) => [row.key, actorSelections[index]!] as const),
  );
  const mergeSelection = resolveWorkflowModelSelection(mergeProvider, mergeModel);
  useEffect(() => {
    if (!serverConfigQuery.data) return;

    const selections = new Map(
      JSON.parse(actorSelectionsKey) as ReadonlyArray<readonly [string, string]>,
    );
    setActors((current) => {
      let changed = false;
      const next = current.map((row) => {
        const selection = selections.get(row.key);
        if (selection === undefined || row.model === selection) return row;
        changed = true;
        const preservesOptions = normalizeModelSlug(row.model, row.provider) === selection;
        return {
          ...row,
          model: selection,
          modelOptions: preservesOptions ? row.modelOptions : undefined,
        };
      });
      return changed ? next : current;
    });
    if (mergeModel !== mergeSelection) {
      const preservesOptions = normalizeModelSlug(mergeModel, mergeProvider) === mergeSelection;
      setMergeModel(mergeSelection);
      if (!preservesOptions) setMergeModelOptions(undefined);
    }
  }, [actorSelectionsKey, mergeModel, mergeProvider, mergeSelection, serverConfigQuery.data]);
  const actorSlots = actors.map((row, index) => ({
    provider: row.provider,
    model: actorSelections[index]!,
    ...(row.modelOptions ? { modelOptions: row.modelOptions } : {}),
  }));
  const providers = serverConfigQuery.data?.providers ?? [];
  const actorCount = actors.length;
  const actorMax = workflowActorMax(workflowType);
  const actorsOverMax = actorCount > actorMax;
  const duplicateActorIndexes = workflowActorDuplicateIndexes(workflowType, actorSlots);
  const actorProviderErrors = actorSlots.map((slot) =>
    serverConfigQuery.data ? readOnlyWorkflowUnsupportedReason(slot.provider, providers) : null,
  );
  const workflowProviderUnavailableReason = (provider: ProviderKind) =>
    readOnlyWorkflowUnsupportedReason(provider, providers);
  const effectiveReaderSlot =
    readerSlot ??
    defaultDocumentReaderSlot(actorSlots, { provider: mergeProvider, model: mergeSelection });
  // Resolved like the other slots so the picker shows what gets submitted.
  const readerSelection = resolveWorkflowModelSelection(
    effectiveReaderSlot.provider,
    effectiveReaderSlot.model,
  );
  // A remembered reader model can fall back like the other slots; keep the chosen reader on the
  // model that gets submitted, dropping options that belonged to the old model.
  useEffect(() => {
    if (!serverConfigQuery.data || !readerSlot || readerSlot.model === readerSelection) return;
    const preservesOptions =
      normalizeModelSlug(readerSlot.model, readerSlot.provider) === readerSelection;
    setReaderSlot({
      provider: readerSlot.provider,
      model: readerSelection,
      ...(preservesOptions && readerSlot.modelOptions
        ? { modelOptions: readerSlot.modelOptions }
        : {}),
    });
  }, [readerSelection, readerSlot, serverConfigQuery.data]);
  // A remembered final-stage provider can lose support after it was picked; the picker only
  // stops new picks. The Reader counts only while reader review is on.
  const mergeProviderError = serverConfigQuery.data
    ? readOnlyWorkflowUnsupportedReason(mergeProvider, providers)
    : null;
  const readerProviderError =
    serverConfigQuery.data && workflowType === "document" && readerReviewEnabled
      ? readOnlyWorkflowUnsupportedReason(effectiveReaderSlot.provider, providers)
      : null;
  const sameDocumentAuthors = workflowType === "document" && duplicateActorIndexes.size > 0;
  const titleGenerationModel = resolveThreadTitleModel(settings);
  const workspaceRoots = [project?.cwd];
  const sameInvestigationInvestigatorModel =
    workflowType === "investigation" && duplicateActorIndexes.size > 0;
  const reviewPullRequestTarget = useMemo(
    () =>
      workflowType === "codeReview" ? detectCodeReviewPullRequestTarget(requirementPrompt) : null,
    [requirementPrompt, workflowType],
  );
  const canAutoPostReview =
    reviewPullRequestTarget !== null &&
    (reviewPullRequestTarget.kind === "number" ||
      reviewPullRequestTarget.ref.provider === "github");
  const autoPostReviewEffective = autoPostReview && canAutoPostReview;
  const autoPostReviewTarget =
    reviewPullRequestTarget === null
      ? "Add a GitHub PR link or PR #number to the review instructions."
      : reviewPullRequestTarget.kind === "number"
        ? `PR #${reviewPullRequestTarget.number} in this project's GitHub repo.`
        : reviewPullRequestTarget.ref.provider === "github"
          ? `Will post to ${reviewPullRequestTarget.ref.repository}#${reviewPullRequestTarget.ref.number}.`
          : "Posting supports GitHub pull requests only.";
  const autoPostReviewDescription = canAutoPostReview
    ? `${autoPostReviewTarget} It posts from your GitHub account without a review step, and the review can quote text from the PR.`
    : autoPostReview
      ? `${autoPostReviewTarget} Nothing is posted until then; untick to turn auto-post off.`
      : autoPostReviewTarget;
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
    pendingAttachmentCount === 0 &&
    !sameInvestigationInvestigatorModel &&
    !sameDocumentAuthors &&
    !actorsOverMax &&
    actorProviderErrors.every((reason) => reason === null) &&
    mergeProviderError === null &&
    readerProviderError === null &&
    (workflowType !== "document" || submittedBriefLength <= DOCUMENT_WORKFLOW_BRIEF_MAX_CHARS) &&
    validMaxCostUsd;
  const primaryActionShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "dialog.primaryAction"),
    [keybindings],
  );

  const updateActor = (key: string, patch: Partial<Omit<WorkflowActorRow, "key">>) => {
    setActors((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  // Removing a middle row relabels the later ones; their selections are kept.
  const removeActor = (key: string) => {
    if (submittingRef.current) return;
    setActors((current) =>
      current.length > 2 ? current.filter((row, index) => index < 2 || row.key !== key) : current,
    );
  };

  // A new row starts on the first usable provider no other row uses. Feature and Code Review
  // may repeat a model, so they copy the last row when every provider is taken.
  const addActor = () => {
    if (submittingRef.current) return;
    setActors((current) => {
      if (current.length >= actorMax) return current;
      const unused = pickNewWorkflowActorProvider(current, providers);
      const last = current[current.length - 1]!;
      if (unused === null && (workflowType === "planning" || workflowType === "codeReview")) {
        return [...current, actorRow(last)];
      }
      const provider = unused ?? firstUsableWorkflowProvider(providers) ?? last.provider;
      return [
        ...current,
        actorRow(
          getWorkflowSlotDefaultsForProvider(
            provider,
            modelOptionsByProvider,
            serverConfigQuery.data?.providers,
          ),
        ),
      ];
    });
  };

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
    switchWorkflowType(nextType);
    const toggles = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-slot="toggle"]'),
    );
    queueMicrotask(() => {
      toggles[nextIndex]?.focus();
    });
  };

  /** Applies only the options present, leaving other types' options alone. */
  const applyTypeOptions = (options: WorkflowTypeOptions) => {
    if (options.selfReviewEnabled !== undefined) setSelfReviewEnabled(options.selfReviewEnabled);
    if (options.investigationSelfReviewEnabled !== undefined) {
      setInvestigationSelfReviewEnabled(options.investigationSelfReviewEnabled);
    }
    if (options.documentType !== undefined) setDocumentType(options.documentType);
    if (options.readerReviewEnabled !== undefined) {
      setReaderReviewEnabled(options.readerReviewEnabled);
    }
    if (options.readerSlot !== undefined) setReaderSlot(options.readerSlot);
  };

  const applySetup = (setup: WorkflowDialogSetup) => {
    setActors(setup.actors);
    setMergeProvider(setup.merge.provider);
    setMergeModel(setup.merge.model);
    setMergeModelOptions(setup.merge.modelOptions);
    applyTypeOptions(setup);
  };

  /** The current rows, merge and the options `type` uses, as the dialog shows them. */
  const captureSetup = (type: WorkflowTypeValue): WorkflowDialogSetup => ({
    actors,
    merge: { provider: mergeProvider, model: mergeModel, modelOptions: mergeModelOptions },
    ...(type === "planning" ? { selfReviewEnabled } : {}),
    ...(type === "document"
      ? { selfReviewEnabled, documentType, readerReviewEnabled, readerSlot }
      : {}),
    ...(type === "investigation" ? { investigationSelfReviewEnabled } : {}),
  });

  // Switching keeps the edits made to the type being left for a later switch back, then loads
  // the next type's edits or its saved setup. With neither, the rows stay and the type's
  // options start from their defaults.
  const switchWorkflowType = (next: WorkflowTypeValue) => {
    if (next === workflowType) return;
    stashedSetupsRef.current.set(workflowType, captureSetup(workflowType));
    const setup = stashedSetupsRef.current.get(next) ?? savedWorkflowSetup(next);
    if (setup) applySetup(setup);
    else applyTypeOptions(WORKFLOW_TYPE_OPTION_DEFAULTS[next]);
    setWorkflowType(next);
  };

  const reset = () => {
    const { type, ...setup } = initialSetup();
    stashedSetupsRef.current.clear();
    setWorkflowType(type);
    // Every type's options go back to their defaults before the starting setup applies.
    for (const options of Object.values(WORKFLOW_TYPE_OPTION_DEFAULTS)) applyTypeOptions(options);
    setPlansDirectory("plans");
    setAutoPostReview(savedAutoPostReview(props.projectId));
    applySetup(setup);
    setReaderPersona("");
    setRequirementDraft({ text: "", mentions: [], cursor: 0 });
    setAttachedFilePaths([]);
    setProjectChangeNote(null);
    setReviewBranch("");
    setMaxCostUsd("");
    setError(null);
    setIsDragOverPrompt(false);
    dragDepthRef.current = 0;
    attachmentGenerationRef.current += 1;
    attachmentDraftIdRef.current = null;
    // Reset runs after a workflow started, and that workflow's prompt references the copies.
    materializedUploadIdsRef.current.clear();
    setPendingAttachmentCount(0);
    submittingRef.current = false;
    setSubmitting(false);
  };

  const discardMaterializedUploads = (uploadIds: ReadonlyArray<string>) => {
    if (uploadIds.length === 0) return;
    void readNativeApi()
      ?.attachments.discardMaterialized({ uploadIds: [...uploadIds] })
      .catch(() => undefined);
  };

  const discardAllMaterializedUploads = () => {
    const uploadIds = [...materializedUploadIdsRef.current.values()];
    materializedUploadIdsRef.current.clear();
    discardMaterializedUploads(uploadIds);
  };

  // The host unmounts the dialog on close. Copies of files that were never submitted are
  // not referenced anywhere, and uploads still in flight must not land afterwards.
  const discardOnUnmountRef = useRef(discardAllMaterializedUploads);
  discardOnUnmountRef.current = discardAllMaterializedUploads;
  useEffect(
    () => () => {
      attachmentGenerationRef.current += 1;
      // A submission in flight may still create a workflow whose prompt references them.
      if (!submittingRef.current) discardOnUnmountRef.current();
    },
    [],
  );

  const changeProject = (projectId: ProjectId) => {
    if (projectId === props.projectId || submittingRef.current) return;
    // A file-tree drop still authorizing against the old project must not land afterwards.
    projectGenerationRef.current += 1;
    attachmentGenerationRef.current += 1;
    // File chips, @-mentions and the review branch belong to the old project's repository.
    // A file still attaching is dropped too, so it counts toward the note.
    const dropsFiles =
      attachedFilePaths.length > 0 ||
      pendingAttachmentCount > 0 ||
      requirementDraft.mentions.length > 0;
    setPendingAttachmentCount(0);
    discardAllMaterializedUploads();
    const dropsBranch = reviewBranch.trim().length > 0;
    if (requirementDraft.mentions.length > 0) {
      setRequirementDraft((current) => ({ ...current, mentions: [] }));
    }
    setAttachedFilePaths([]);
    setReviewBranch("");
    // Auto-post is opted into per project, so the new project's own choice applies.
    setAutoPostReview(savedAutoPostReview(projectId));
    setProjectChangeNote(
      dropsFiles && dropsBranch
        ? "File references and the review branch were cleared for the new project."
        : dropsFiles
          ? "File references were cleared for the new project."
          : dropsBranch
            ? "The review branch was cleared for the new project."
            : null,
    );
    setError(null);
    props.onProjectChange?.(projectId);
  };

  /**
   * Clipboard screenshots and browser-mode drops have no filesystem path. Upload them,
   * have the server copy them to durable storage, and reference the returned absolute
   * paths like any dragged file.
   */
  const attachPathlessFiles = async (files: File[]) => {
    const api = readNativeApi();
    const generation = attachmentGenerationRef.current;
    const threadId = (attachmentDraftIdRef.current ??= ThreadId.makeUnsafe(
      `workflow-draft-${crypto.randomUUID()}`,
    ));
    const isCurrent = () => generation === attachmentGenerationRef.current;
    const uploadIds: string[] = [];
    let uploadsReleased = false;
    setPendingAttachmentCount((count) => count + files.length);
    try {
      if (!api) throw new Error("Native API is unavailable.");
      const results = await Promise.allSettled(
        files.map((file) => uploadAttachment(getServerHttpOrigin(), threadId, file)),
      );
      for (const result of results) {
        if (result.status === "fulfilled") uploadIds.push(result.value.uploadId);
      }
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      const saved = await api.attachments.materializeUploads({ threadId, uploadIds });
      // The server released the uploads once the copies were complete.
      uploadsReleased = true;
      if (!isCurrent()) {
        discardMaterializedUploads(saved.files.map((file) => file.uploadId));
        return;
      }
      for (const file of saved.files) {
        materializedUploadIdsRef.current.set(file.path, file.uploadId);
      }
      setAttachedFilePaths((current) =>
        normalizeAttachedFilePaths([...current, ...saved.files.map((file) => file.path)]),
      );
      setProjectChangeNote(null);
      setError(null);
    } catch (cause) {
      if (api && !uploadsReleased && uploadIds.length > 0) {
        void api.attachments.releaseUploads({ threadId, uploadIds }).catch(() => undefined);
      }
      if (!isCurrent()) return;
      toastManager.add({
        type: "error",
        title: files.length === 1 ? "Couldn't attach the file." : "Couldn't attach the files.",
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      if (isCurrent()) setPendingAttachmentCount((count) => Math.max(0, count - files.length));
    }
  };

  const addAttachedFiles = (allFiles: File[]) => {
    const { withPath: files, pathless } = partitionAttachedFiles(allFiles, {
      isElectron,
      desktopBridge: window.desktopBridge,
    });
    // Browsers report a dropped folder as an empty file; neither can be uploaded.
    const uploadable = pathless.filter((file) => file.size > 0);
    if (uploadable.length < pathless.length) {
      toastManager.add({
        type: "warning",
        title: "Empty files and folders can't be attached.",
      });
    }
    if (uploadable.length > 0) {
      void attachPathlessFiles(uploadable);
    }
    if (files.length === 0) {
      return;
    }

    const normalizeAbsolutePathForComparison = createCachedAbsolutePathComparisonNormalizer(
      window.desktopBridge?.resolveRealPath ?? identityAbsolutePathNormalizer,
    );
    const { filePaths, invalidPathCount } = resolveAttachedFileReferencePaths({
      files,
      isElectron,
      desktopBridge: window.desktopBridge,
      workspaceRoots,
      normalizeAbsolutePathForComparison,
    });

    if (filePaths.length > 0) {
      setAttachedFilePaths((current) => normalizeAttachedFilePaths([...current, ...filePaths]));
      setProjectChangeNote(null);
      setError(null);
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
    const uploadId = materializedUploadIdsRef.current.get(filePath);
    if (uploadId !== undefined) {
      materializedUploadIdsRef.current.delete(filePath);
      discardMaterializedUploads([uploadId]);
    }
  };

  const onPromptPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    // In a browser, copied spreadsheet cells or rich text carry a rendered image next to the
    // text; paste the text as the composer does. The desktop app keeps attaching files, since
    // a Finder copy also carries the file name as text.
    if (!isElectron && event.clipboardData.getData("text/plain").trim().length > 0) {
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
    const projectGeneration = projectGenerationRef.current;
    void authorizeFileTreeMention({
      api,
      payload,
      expectedProjectId: project.id,
      expectedWorkspaceIdentity: workspaceIdentityForRoot(project.id, project.cwd),
      workspaceRoot: project.cwd,
    })
      .then((relativePath) => {
        // The project changed while authorizing: the path belongs to the old workspace.
        if (projectGeneration !== projectGenerationRef.current) return;
        setProjectChangeNote(null);
        const mention = composerFileMention(relativePath);
        if (mention === null) throw new Error("The file path is invalid.");
        // Focusing publishes the editor's snapshot back to this controlled
        // draft. Commit the mention first so an early frame cannot overwrite
        // the new draft with the snapshot from before the drop.
        flushSync(() => {
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
      const buildSlot = makeWorkflowSlotBuilder({
        providers: serverConfigQuery.data?.providers ?? [],
        settings,
        projectId: props.projectId,
        dispatchModelsByProvider,
      });
      const [branchASlot, branchBSlot, ...extraActorSlots] = actors.map((row, index) =>
        buildSlot(row.provider, actorSelections[index]!, row.modelOptions),
      );
      if (!branchASlot || !branchBSlot) throw new Error("A workflow needs at least two models.");
      // Extras are sent only for runs with more than two actors.
      const extras = <K extends string>(key: K) =>
        (extraActorSlots.length > 0 ? { [key]: extraActorSlots } : {}) as Partial<
          Record<K, WorkflowModelSlot[]>
        >;
      const mergeSlot = buildSlot(mergeProvider, mergeSelection, mergeModelOptions);
      // The models as submitted (resolved and normalized) and this type's options.
      // A reader the user picked, built once so the run and the saved setup agree. Without
      // one, the reader follows the authors and merge model and is saved as `null`.
      const pickedReaderSlot = readerSlot
        ? buildSlot(readerSlot.provider, readerSelection, readerSlot.modelOptions)
        : null;
      const submittedSetup: SavedWorkflowSetup = {
        actors: [branchASlot, branchBSlot, ...extraActorSlots].map(savedSlot),
        merge: savedSlot(mergeSlot),
        ...(workflowType === "planning" ? { selfReviewEnabled } : {}),
        ...(workflowType === "document"
          ? {
              selfReviewEnabled,
              documentType,
              readerReviewEnabled,
              reader: pickedReaderSlot ? savedSlot(pickedReaderSlot) : null,
            }
          : {}),
        ...(workflowType === "investigation"
          ? { selfReviewEnabled: investigationSelfReviewEnabled }
          : {}),
      };
      // Saved only once the run exists, so a cancelled or failed start changes nothing.
      const onCreated = (workflowId: string) => {
        const preferences = useWorkflowCreatePreferencesStore.getState();
        preferences.recordSubmitted(workflowType, submittedSetup);
        // Only a review that will actually post keeps auto-post on for this project.
        if (workflowType === "codeReview") {
          preferences.recordAutoPost(props.projectId, autoPostReviewEffective);
        }
        props.onWorkflowCreated?.(workflowId);
      };
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
            ...extras("additionalBranches"),
            merge: mergeSlot,
          },
        });
        onCreated(result.workflowId);
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
                  reader:
                    pickedReaderSlot ??
                    buildSlot(
                      effectiveReaderSlot.provider,
                      readerSelection,
                      effectiveReaderSlot.modelOptions,
                    ),
                }
              : {}),
            branchA: branchASlot,
            branchB: branchBSlot,
            ...extras("additionalBranches"),
            merge: mergeSlot,
          },
        });
        onCreated(result.workflowId);
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
            ...(autoPostReviewEffective ? { autoPost: true } : {}),
            reviewerA: branchASlot,
            reviewerB: branchBSlot,
            ...extras("additionalReviewers"),
            consolidation: mergeSlot,
          },
        });
        onCreated(result.workflowId);
      } else if (workflowType === "investigation") {
        if (sameInvestigationInvestigatorModel) {
          setError(
            actors.length === 2
              ? "Choose two different investigator models for Investigation workflows."
              : workflowActorDuplicateMessage("investigation"),
          );
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
            ...extras("additionalInvestigators"),
            synthesis: mergeSlot,
          },
        });
        onCreated(result.workflowId);
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
    workflowType === "codeReview" && autoPostReviewEffective ? "Auto-post" : null,
    (workflowType === "codeReview" || workflowType === "investigation") && reviewBranch.trim()
      ? `vs ${reviewBranch.trim()}`
      : null,
    maxCostUsd.trim() ? `Limit $${maxCostUsd.trim()}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-4xl" onKeyDownCapture={onDialogKeyDown}>
        <DialogHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <DialogTitle>New Workflow</DialogTitle>
            {props.onProjectChange ? (
              <ProjectPicker
                projects={pickerProjects}
                selection={{ kind: "project", projectId: props.projectId }}
                onSelect={(selection) => {
                  if (selection.kind === "project") changeProject(selection.projectId);
                }}
                allowNone={false}
                trigger="crumb"
                disabled={submitting}
                className="max-w-64"
              />
            ) : null}
          </div>
          <DialogDescription>
            Create a feature workflow, code review, root-cause investigation, or document. The title
            will be generated from your prompt.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-x-6 gap-y-5 md:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
            <div className="flex min-w-0 flex-col gap-4">
              <ToggleGroup
                className="grid w-full grid-cols-2 gap-2"
                aria-label="Workflow type"
                value={[workflowType]}
                onKeyDown={onWorkflowTypeKeyDown}
                onValueChange={(value) => {
                  const next = value[0];
                  if (WORKFLOW_TYPE_ORDER.includes(next as WorkflowTypeValue)) {
                    switchWorkflowType(next as WorkflowTypeValue);
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
                        // `sm:` too: the toggle's default size pins `sm:h-8`.
                        "h-auto w-full flex-col items-start justify-start gap-1 whitespace-normal rounded-xl border-border p-3 text-start sm:h-auto",
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
                  {attachedFilePaths.length > 0 || pendingAttachmentCount > 0 ? (
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
                      {pendingAttachmentCount > 0 ? (
                        <span
                          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 text-ui text-muted-foreground"
                          role="status"
                        >
                          <Spinner className="size-3.5" />
                          {pendingAttachmentCount === 1
                            ? "Attaching…"
                            : `Attaching ${pendingAttachmentCount} files…`}
                        </span>
                      ) : null}
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
                {projectChangeNote ? (
                  <p className="text-2xs text-muted-foreground" role="status">
                    {projectChangeNote}
                  </p>
                ) : null}
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
                  {sameDocumentAuthors && actorCount === 2 ? (
                    <p role="alert" className="text-ui text-destructive-foreground">
                      Document workflows need two different author models.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              {/* A container, so the indents below follow SlotRow's own label breakpoint. */}
              <section aria-label="Models" className="@container/models flex flex-col gap-2">
                <SectionLabel as="h3">Models</SectionLabel>
                {actors.map((row, index) => {
                  const selection = actorSelections[index]!;
                  const preferenceSlot = index === 0 ? "branchA" : index === 1 ? "branchB" : null;
                  const rowError =
                    actorProviderErrors[index] ??
                    (actorCount > 2 && duplicateActorIndexes.has(index)
                      ? workflowActorDuplicateMessage(workflowType)
                      : null);
                  return (
                    <SlotRow
                      key={row.key}
                      providers={serverConfigQuery.data?.providers}
                      label={workflowActorRowLabel(workflowType, index)}
                      provider={row.provider}
                      model={selection}
                      modelOptions={row.modelOptions}
                      modelOptionsByInstance={modelOptionsByInstance}
                      providerUnavailableReason={workflowProviderUnavailableReason}
                      error={rowError}
                      reserveTraitsColumn
                      // Always reserved, so adding a removable author never shifts the fields.
                      reserveTrailing
                      onProviderModelChange={(provider, model) => {
                        updateActor(row.key, { provider, model, modelOptions: undefined });
                        if (preferenceSlot) {
                          useModelPreferencesStore
                            .getState()
                            .setLastWorkflowProvider(preferenceSlot, provider);
                        }
                        recordModelSelection(provider, model, undefined);
                      }}
                      onModelOptionsChange={(modelOptions) => {
                        updateActor(row.key, { modelOptions });
                        recordModelSelection(
                          row.provider,
                          selection,
                          normalizeWorkflowSlotModelOptions(
                            row.provider,
                            selection,
                            modelOptions,
                            getWorkflowModelCapabilities(
                              serverConfigQuery.data?.providers ?? [],
                              ProviderDriverKind.make(row.provider),
                              selection,
                            ),
                          ),
                        );
                      }}
                      trailing={
                        index >= 2 ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Remove ${workflowActorRowLabel(workflowType, index)}`}
                            disabled={submitting}
                            onClick={() => removeActor(row.key)}
                          >
                            <XIcon aria-hidden="true" className="size-3.5" />
                          </Button>
                        ) : null
                      }
                    />
                  );
                })}
                <div className="flex min-w-0 items-center @sm/models:ps-26">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={submitting || actorCount >= actorMax}
                    onClick={addActor}
                  >
                    <PlusIcon aria-hidden="true" className="size-3.5" />
                    {workflowAddActorLabel(workflowType)}
                  </Button>
                </div>
                {actorsOverMax ? (
                  <p role="alert" className="text-ui text-destructive-foreground">
                    {workflowActorLimitMessage(workflowType)}
                  </p>
                ) : null}
                <SlotRow
                  providers={serverConfigQuery.data?.providers}
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
                  modelOptionsByInstance={modelOptionsByInstance}
                  // The merge is a read-only turn for every workflow type.
                  providerUnavailableReason={workflowProviderUnavailableReason}
                  error={mergeProviderError}
                  reserveTraitsColumn
                  reserveTrailing
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
                        getWorkflowModelCapabilities(
                          serverConfigQuery.data?.providers ?? [],
                          ProviderDriverKind.make(mergeProvider),
                          mergeSelection,
                        ),
                      ),
                    );
                  }}
                />
                {actorCount > 2 ? (
                  // The estimate covers the whole run, merge included, so it closes the
                  // section as a footer. It spans the full section width: indented to the
                  // field column it wraps and leaves "merge" on a line of its own.
                  <p data-slot="workflow-turn-estimate" className="text-2xs text-muted-foreground">
                    {formatWorkflowTurnEstimate(
                      workflowType,
                      actorCount,
                      workflowType === "investigation"
                        ? investigationSelfReviewEnabled
                        : selfReviewEnabled,
                      readerReviewEnabled,
                    )}
                  </p>
                ) : null}
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
                          className={cn(
                            fieldSurfaceClassName,
                            "mt-1.5 min-h-20 w-full p-2 text-sm font-normal",
                          )}
                        />
                      </label>
                      <p className="text-2xs text-muted-foreground tabular-nums">
                        {readerPersona.length} / 500
                      </p>
                      <SlotRow
                        providers={serverConfigQuery.data?.providers}
                        label="Reader model"
                        provider={effectiveReaderSlot.provider}
                        model={readerSelection}
                        modelOptions={effectiveReaderSlot.modelOptions}
                        modelOptionsByInstance={modelOptionsByInstance}
                        providerUnavailableReason={workflowProviderUnavailableReason}
                        error={readerProviderError}
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
              {workflowType === "codeReview" ? (
                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                  <WorkflowOptionCheckbox
                    // A remembered opt-in shows as checked before a PR is named, and stays
                    // enabled so it can be turned off.
                    disabled={!canAutoPostReview && !autoPostReview}
                    checked={autoPostReview}
                    onCheckedChange={setAutoPostReview}
                    label="Post merged review to the PR when it finishes"
                    description={autoPostReviewDescription}
                  />
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
              {sameInvestigationInvestigatorModel && actorCount === 2 ? (
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
