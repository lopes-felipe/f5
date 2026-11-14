import {
  type ModelSlug,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ProviderKind,
  type RuntimeMode,
  type ServerProvider,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import {
  getMessageTextLengthIssue,
  getThreadReferenceLimitIssue,
} from "@t3tools/shared/providerInput";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { projectProviderSnapshots } from "@t3tools/shared/serverSettings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { FolderIcon, GitForkIcon } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useMemo, useState } from "react";

import { useAppSettingsSelector } from "../../appSettings";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { seedDraftThreadFromModelPreferences } from "../../hooks/useCreateProjectBackedDraftThread";
import { selectServerSettings, useSettings } from "../../hooks/useSettings";
import { buildLocalDraftThread } from "../../lib/draftThreads";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { waitForProjectInStore } from "../../lib/projectArrival";
import { resolveProjectThreadEnvMode } from "../../lib/projectConfigReactQuery";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import {
  type BackgroundThreadStartResult,
  startThreadInBackground,
} from "../../lib/startThreadInBackground";
import { recordModelSelection } from "../../modelPreferencesStore";
import { ensureNativeApi } from "../../nativeApi";
import { getServerSendLimits } from "../../protocolState";
import { useStore } from "../../store";
import { DEFAULT_INTERACTION_MODE, type Project } from "../../types";
import { ClaudeTraitsPicker } from "../chat/ClaudeTraitsPicker";
import { CodexTraitsPicker } from "../chat/CodexTraitsPicker";
import { ComposerInteractionModeToggle } from "../chat/composer/ComposerFooterControls";
import {
  selectComposerDispatchAppSettings,
  selectModelCatalogSettings,
  useComposerDispatchSettings,
} from "../chat/composer/useComposerDispatchSettings";
import { ProviderInstanceModelPicker } from "../chat/ProviderInstanceModelPicker";
import { RuntimeModePicker } from "../chat/RuntimeModePicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  HOME_COMPOSER_DRAFT_ID,
  homeComposerDraft,
  type HomeComposerSettings,
  homeSelectionKey,
  readHomeComposerSettings,
} from "./homeComposerDraft";
import type { HomeProjectSelection } from "./HomeProjectPickerPlaceholder";

const EMPTY_PROVIDER_STATUSES: ReadonlyArray<ServerProvider> = [];
// The stand-in thread is never shown or sent; a fixed time keeps it stable across renders.
const DRAFT_CREATED_AT = new Date(0).toISOString();

const ENV_MODE_ITEMS = [
  { value: "local", label: "Local" },
  { value: "worktree", label: "New worktree" },
] as const;

export interface HomeComposerHandle {
  /**
   * Starts a thread with `text` and the settings on screen. Rejects with a message to
   * show when nothing was sent.
   */
  readonly start: (text: string) => Promise<BackgroundThreadStartResult>;
  /**
   * The model, effort and modes on screen, for the full composer. The modes are the ones
   * shown, a project default included. Null until they have loaded for this selection.
   */
  readonly settings: () => HomeComposerSettings | null;
}

async function ensureScratchProject(): Promise<Project | undefined> {
  const existing = useStore.getState().projects.find(isScratchProject);
  if (existing) return existing;
  const { projectId } = await ensureNativeApi().projects.ensureScratch();
  await waitForProjectInStore(projectId);
  return useStore.getState().projects.find((project) => project.id === projectId);
}

/**
 * The model, effort, mode, access and workspace for the thread Home starts, and the send
 * itself. It loads after Home's first paint: the pickers are too heavy for startup.
 */
export default function HomeComposerControls(props: {
  readonly selection: HomeProjectSelection;
  /** The selected project; undefined for a thread without a project. */
  readonly project: Project | undefined;
  readonly disabled: boolean;
  readonly handleRef: Ref<HomeComposerHandle>;
}) {
  const draftId = HOME_COMPOSER_DRAFT_ID;
  const scratch = props.selection.kind === "none";
  const scratchProject = useStore((store) => store.projects.find(isScratchProject));
  const project = scratch ? scratchProject : props.project;
  const projectId = project?.id;
  const selectionKey = homeSelectionKey(props.selection);
  const queryClient = useQueryClient();

  const composerDraft = useComposerThreadDraft(draftId);
  const settings = useAppSettingsSelector(selectComposerDispatchAppSettings);
  const modelCatalogSettings = useSettings(selectModelCatalogSettings);
  const projectSettings = useSettings(selectServerSettings, projectId);
  const serverConfig = useQuery(serverConfigQueryOptions()).data;
  const providerStatuses = useMemo(
    () =>
      projectProviderSnapshots(
        serverConfig?.providers ?? EMPTY_PROVIDER_STATUSES,
        projectSettings,
        projectId,
      ),
    [serverConfig?.providers, projectSettings, projectId],
  );

  useEffect(() => {
    if (homeComposerDraft.seededFor() === selectionKey) return;
    // A project that has not loaded yet has no defaults to take.
    if (!scratch && projectId === undefined) return;
    homeComposerDraft.markSeeded(selectionKey);
    useComposerDraftStore.getState().clearThreadDraft(draftId);
    seedDraftThreadFromModelPreferences(draftId, projectId, projectSettings);
  }, [draftId, projectId, projectSettings, scratch, selectionKey]);

  const runtimeMode = composerDraft.runtimeMode ?? projectSettings.defaultRuntimeMode;
  const interactionMode = composerDraft.interactionMode ?? DEFAULT_INTERACTION_MODE;
  // The same stand-in thread a new draft gets, so both composers resolve the same model.
  const draftThread = useMemo(
    () =>
      project
        ? buildLocalDraftThread({
            threadId: draftId,
            draftThread: {
              projectId: project.id,
              createdAt: DRAFT_CREATED_AT,
              runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              envMode: "local",
            },
            projectModel: project.model,
          })
        : undefined,
    [draftId, interactionMode, project, runtimeMode],
  );
  const dispatch = useComposerDispatchSettings({
    threadId: draftId,
    composerDraft,
    serverThread: undefined,
    localDraftThread: draftThread,
    project,
    providerStatuses,
    serverConfig,
    settings,
    modelCatalogSettings,
    seedsModelOptions: true,
  });

  // Workspace: the project's default, as a new thread there would get, unless changed here.
  const hasGitProject = !scratch && project !== undefined;
  const branchesQuery = useQuery(
    gitBranchesQueryOptions({ cwd: hasGitProject ? project.cwd : null }),
  );
  const defaultEnvModeQuery = useQuery({
    queryKey: ["home-composer", "env-mode", projectId ?? null],
    queryFn: () => resolveProjectThreadEnvMode(queryClient, projectId!),
    enabled: hasGitProject,
    staleTime: 30_000,
  });
  // The choice lives outside the component so it survives a trip to another page.
  const [, rerender] = useState(0);
  const chosenEnvMode = homeComposerDraft.envMode(selectionKey);
  const isRepo = hasGitProject && branchesQuery.data?.isRepo === true;
  const currentBranch = branchesQuery.data?.branches.find((branch) => branch.current)?.name ?? null;
  const workspaceLoading =
    hasGitProject && (branchesQuery.isPending || defaultEnvModeQuery.isPending);
  // The branches could not be read, so there is no workspace picker to offer either.
  const branchLookupFailed = hasGitProject && !branchesQuery.isPending && !branchesQuery.data;
  // A worktree needs a repository Home has read. Without one the thread runs in the project
  // folder, whatever the project's default: Home must not ask for a worktree it shows no
  // picker for and has no branch to start from.
  const envMode: ThreadEnvMode = isRepo
    ? (chosenEnvMode ?? defaultEnvModeQuery.data ?? "local")
    : "local";

  // Until the server's provider list arrives there is nothing to pick from: that is
  // loading, not a setup with no provider.
  const providersLoading = serverConfig === undefined;
  const noProviderAvailable = !providersLoading && dispatch.noProviderAvailable;

  useImperativeHandle(
    props.handleRef,
    () => ({
      settings: () => readHomeComposerSettings(selectionKey, { runtimeMode, interactionMode }),
      start: async (text) => {
        if (providersLoading) {
          throw new Error("Still loading the providers. Try again in a moment.");
        }
        if (noProviderAvailable) {
          throw new Error("No provider is available. Enable one in Settings.");
        }
        if (workspaceLoading) {
          throw new Error("Still reading the project's workspace. Try again in a moment.");
        }
        if (envMode === "worktree" && !currentBranch) {
          throw new Error(
            "There is no branch to start the worktree from. Open the full composer to pick one.",
          );
        }
        const issue =
          getMessageTextLengthIssue(text, getServerSendLimits().maxInputChars) ??
          getThreadReferenceLimitIssue(text);
        if (issue) throw new Error(issue.message);
        const target = scratch ? await ensureScratchProject() : project;
        if (!target) throw new Error("Pick a project first.");
        return startThreadInBackground({
          project: target,
          text,
          provider: dispatch.selectedProvider,
          model: dispatch.selectedModel,
          modelSelection: dispatch.selectedModelSelectionForDispatch,
          modelOptions: dispatch.selectedModelOptionsForDispatch,
          providerOptions: dispatch.providerOptionsForDispatch,
          titleGenerationModel: dispatch.selectedThreadTitleModel,
          titleGenerationModelSelection: dispatch.selectedThreadTitleModelSelection,
          runtimeMode,
          interactionMode,
          assistantDeliveryMode: projectSettings.enableAssistantStreaming
            ? "streaming"
            : "buffered",
          worktreeBaseBranch: envMode === "worktree" ? currentBranch : null,
        });
      },
    }),
    [
      currentBranch,
      dispatch.providerOptionsForDispatch,
      dispatch.selectedModel,
      dispatch.selectedModelOptionsForDispatch,
      dispatch.selectedModelSelectionForDispatch,
      dispatch.selectedProvider,
      dispatch.selectedThreadTitleModel,
      dispatch.selectedThreadTitleModelSelection,
      envMode,
      interactionMode,
      noProviderAvailable,
      project,
      projectSettings.enableAssistantStreaming,
      providersLoading,
      runtimeMode,
      scratch,
      selectionKey,
      workspaceLoading,
    ],
  );

  const onModelSelect = (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    model: ModelSlug,
  ): ModelSlug | null => {
    if (!Schema.is(ProviderKind)(driver)) return null;
    const options = dispatch.modelOptionsByInstance.get(instanceId) ?? [];
    const resolved = resolveSelectableModel(driver, model, options) ?? options[0]?.slug;
    if (!resolved) return null;
    const drafts = useComposerDraftStore.getState();
    drafts.setProvider(draftId, driver);
    drafts.setProviderInstance(draftId, instanceId);
    drafts.setModel(draftId, resolved);
    recordModelSelection(driver, resolved, composerDraft.modelOptions);
    return resolved;
  };

  const onRuntimeModeChange = (mode: RuntimeMode) => {
    if (mode !== runtimeMode) useComposerDraftStore.getState().setRuntimeMode(draftId, mode);
  };

  const onEnvModeChange = (mode: ThreadEnvMode) => {
    homeComposerDraft.setEnvMode(selectionKey, mode);
    rerender((count) => count + 1);
  };

  return (
    // The chips wrap in the bar's own row, next to the project picker.
    <div data-slot="home-composer-controls" className="contents">
      {providersLoading ? (
        <span className="px-2 text-xs text-muted-foreground" role="status">
          Loading providers…
        </span>
      ) : noProviderAvailable ? (
        <span className="px-2 text-xs text-muted-foreground" role="status">
          No provider available
        </span>
      ) : (
        <ProviderInstanceModelPicker
          instanceId={dispatch.selectedProviderInstanceId}
          model={dispatch.selectedModelForPickerWithCustomFallback}
          lockedInstanceId={null}
          modelOptionsByInstance={dispatch.modelOptionsByInstance}
          ultrathinkActive={dispatch.isClaudeUltrathink}
          providers={providerStatuses}
          disabled={props.disabled}
          onInstanceModelChange={onModelSelect}
        />
      )}
      {dispatch.selectedProvider === "codex" ? (
        <CodexTraitsPicker
          threadId={draftId}
          model={dispatch.selectedModel}
          models={dispatch.selectedProviderModels}
        />
      ) : dispatch.showClaudeTraitsControls ? (
        <ClaudeTraitsPicker
          threadId={draftId}
          model={dispatch.selectedModel}
          models={dispatch.selectedProviderModels}
          modelOptions={dispatch.selectedProviderModelOptions}
        />
      ) : (
        (dispatch.genericProviderTraitsPicker ?? null)
      )}
      {dispatch.showInteractionModeToggle ? (
        <ComposerInteractionModeToggle
          value={interactionMode}
          disabled={props.disabled}
          onToggle={() =>
            useComposerDraftStore
              .getState()
              .setInteractionMode(draftId, interactionMode === "plan" ? "default" : "plan")
          }
        />
      ) : null}
      <RuntimeModePicker
        disabled={props.disabled}
        provider={dispatch.selectedProvider}
        value={runtimeMode}
        onValueChange={onRuntimeModeChange}
      />
      {isRepo ? (
        <>
          <Select
            value={envMode}
            onValueChange={(value) => onEnvModeChange(value as ThreadEnvMode)}
            items={ENV_MODE_ITEMS}
            disabled={props.disabled}
          >
            <SelectTrigger
              aria-label="Workspace"
              data-composer-control="envMode"
              variant="ghost"
              size="xs"
              className="h-7 min-h-7 w-auto text-ui font-normal text-muted-foreground hover:text-foreground sm:h-7 sm:min-h-7"
            >
              {envMode === "worktree" ? (
                <GitForkIcon className="size-3.5" />
              ) : (
                <FolderIcon className="size-3.5" />
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="worktree">New worktree</SelectItem>
            </SelectPopup>
          </Select>
          {envMode === "worktree" && currentBranch ? (
            <span
              className="min-w-0 truncate px-1 text-xs text-muted-foreground"
              title={`The worktree starts from ${currentBranch}`}
            >
              from {currentBranch}
            </span>
          ) : null}
        </>
      ) : branchLookupFailed ? (
        <span
          role="status"
          data-composer-control="envMode"
          className="inline-flex items-center gap-1 px-2 text-xs text-muted-foreground"
          title="The project's branches could not be read, so the thread starts in the project folder. Open the full composer to use a worktree."
        >
          <FolderIcon className="size-3.5" />
          Local
        </span>
      ) : null}
    </div>
  );
}
