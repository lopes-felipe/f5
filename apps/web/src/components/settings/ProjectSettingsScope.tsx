import { projectProviderSnapshots } from "@t3tools/shared/serverSettings";
import { ThreadSettlementFields } from "./ThreadSettlementSettings";
import { pickPreferredModel } from "@t3tools/shared/model";
import { useComputerStatus, computerSettingsCanEnable } from "../../hooks/useComputerStatus";
import { RememberedComputerApps } from "./RememberedComputerApps";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { WorktreeCleanupRulesEditor } from "./WorktreeCleanupRulesEditor";
import { WorktreeDisposablePathsEditor } from "./WorktreeDisposablePathsEditor";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isKnownProviderKind,
  type ProjectSettingsResult,
  type ProviderKind,
} from "@t3tools/contracts";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  ComboboxEmpty,
} from "../ui/combobox";
import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  pendingLegacyThreadEnvMode,
  readLegacyClientSetting,
  subscribePendingClientSettings,
} from "../../hooks/useMigrateClientSettings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, ChevronsUpDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsCard } from "./SettingsCard";
import {
  ProjectId,
  type ProjectSettingsOverrides,
  type ProjectScopedServerSettingKey,
} from "@t3tools/contracts";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { PreviewExternalHostsEditor } from "./PreviewExternalHostsEditor";
import { McpServersSettings } from "./McpServersSettings";
import { useSettingsRouteContext } from "./SettingsRouteContext";
import { ClaudeSubagentControls } from "./categories/ThreadsSettings";

export function SettingsScopePicker({
  projectId,
  onChange,
}: {
  projectId?: ProjectId | undefined;
  onChange: (id: ProjectId | undefined) => void;
}) {
  const projects = useStore((s) => s.projects);
  const [search, setSearch] = useState("");
  const items = [{ id: "global", name: "Global settings" }, ...projects];
  const filtered = items.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-4">
      <button
        type="button"
        onClick={() => onChange(undefined)}
        className="rounded-md px-1 py-0.5 text-ui text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Global
      </button>
      <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-faint-foreground" />
      <Combobox
        items={items.map((item) => item.id)}
        filteredItems={filtered.map((item) => item.id)}
        value={projectId ?? "global"}
        autoHighlight
        onOpenChange={(open) => {
          if (!open) setSearch("");
        }}
        onValueChange={(value) =>
          onChange(value && value !== "global" ? ProjectId.makeUnsafe(value) : undefined)
        }
      >
        <ComboboxTrigger
          aria-label="Settings scope"
          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="truncate">
            {projectId
              ? (projects.find((p) => p.id === projectId)?.name ?? "Unavailable project")
              : "Global settings"}
          </span>
          <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
        </ComboboxTrigger>
        <ComboboxPopup className="w-80">
          <div className="border-b p-2">
            <ComboboxInput
              aria-label="Search projects"
              placeholder="Search projects…"
              showTrigger={false}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <ComboboxEmpty>No projects found.</ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {filtered.map((item, index) => (
              <ComboboxItem key={item.id} index={index} value={item.id}>
                {item.name}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}

interface ProjectScopeValue {
  readonly projectId: ProjectId;
  readonly settings: ProjectSettingsResult["settings"];
  readonly overrides: ProjectSettingsOverrides;
  readonly sources: ProjectSettingsResult["sources"];
  readonly saving: boolean;
  readonly save: (patch: ProjectSettingsOverrides | null) => Promise<void>;
  readonly set: <K extends ProjectScopedServerSettingKey>(
    key: K,
    value: ProjectSettingsOverrides[K],
  ) => void;
  readonly badge: (key: ProjectScopedServerSettingKey) => ReactNode;
}

interface ProjectScopeState {
  /** Null until the project's resolved settings load. */
  readonly value: ProjectScopeValue | null;
  readonly pending: boolean;
  readonly retry: () => void;
}

const ProjectScopeContext = createContext<ProjectScopeState | null>(null);

function useProjectScopeState(): ProjectScopeState {
  const state = useContext(ProjectScopeContext);
  if (!state) throw new Error("useProjectScope must be used within ProjectScopeProvider.");
  return state;
}

function useProjectScope(): ProjectScopeValue {
  const { value } = useProjectScopeState();
  if (!value) throw new Error("useProjectScope must be used within ProjectScopeGate.");
  return value;
}

/**
 * Renders its children once the project's resolved settings load. Only the
 * override controls need them, so project features that read other data (icon,
 * memory) stay outside the gate and keep working when this query fails.
 */
export function ProjectScopeGate({ children }: { readonly children: ReactNode }) {
  const { value, pending, retry } = useProjectScopeState();
  // A stale link to a deleted project must not write overrides for it.
  const { selectedProjectUnavailable } = useSettingsRouteContext();
  if (selectedProjectUnavailable)
    return (
      <p className="text-ui text-muted-foreground" role="status">
        This project is unavailable or was deleted, so its overrides can't be edited.
      </p>
    );
  if (pending) return <p className="text-ui text-muted-foreground">Loading project settings…</p>;
  if (!value)
    return (
      <div className="flex items-center gap-3 text-sm" role="alert">
        Could not load project settings.
        <Button size="xs" variant="outline" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  return <>{children}</>;
}

/**
 * Loads one project's resolved settings and shares save state with every
 * project-scope page, so a save on one page disables controls on all of them.
 */
export function ProjectScopeProvider({
  projectId,
  children,
}: {
  readonly projectId: ProjectId;
  readonly children: ReactNode;
}) {
  const client = useQueryClient();
  const query = useQuery(projectSettingsQueryOptions(projectId));
  const pendingThreadEnvMode = useSyncExternalStore(
    subscribePendingClientSettings,
    readLegacyClientSetting,
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const retry = () => void query.refetch();
  const save = async (patch: ProjectSettingsOverrides | null) => {
    setSaving(true);
    setError(undefined);
    try {
      await ensureNativeApi().server.updateSettings({
        projectSettingsOverrides: { [projectId]: patch },
      });
      await client.invalidateQueries({ queryKey: ["server"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  let value: ProjectScopeValue | null = null;
  if (query.data) {
    const { overrides, sources } = query.data;
    // Show the global default new threads actually get while its migration is pending.
    const pending = pendingLegacyThreadEnvMode(
      query.data.settings,
      sources.defaultThreadEnvMode,
      pendingThreadEnvMode,
    );
    const settings = pending
      ? { ...query.data.settings, defaultThreadEnvMode: pending }
      : query.data.settings;
    const set = <K extends ProjectScopedServerSettingKey>(
      key: K,
      next: ProjectSettingsOverrides[K],
    ) => void save({ ...overrides, [key]: next });
    const badge = (key: ProjectScopedServerSettingKey) =>
      sources[key] === "project" ? (
        <OverrideBadge
          disabled={saving}
          onReset={() => {
            const next = { ...overrides };
            delete next[key];
            void save(next);
          }}
        />
      ) : (
        <SourceBadge>
          {sources[key] === "legacy-project"
            ? "From older project default"
            : `From ${sources[key]}`}
        </SourceBadge>
      );
    value = { projectId, settings, overrides, sources, saving, save, set, badge };
  }
  // One tree for every query state, so the ungated Project page never remounts.
  return (
    <ProjectScopeContext.Provider value={{ value, pending: query.isPending, retry }}>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {(query.data?.skillScanWarnings?.length ?? 0) > 0 && (
        <div role="status" className="rounded-lg border border-border p-3 text-sm">
          <p>Some project skills could not be loaded.</p>
          <ul>
            {query.data?.skillScanWarnings?.map((warning) => (
              <li key={`${warning.path}:${warning.reason}`} className="mt-1 break-all">
                <code>{warning.path}</code>: {warning.reason}
              </li>
            ))}
          </ul>
          <Button size="xs" variant="outline" onClick={retry}>
            Refresh diagnostics
          </Button>
        </div>
      )}
      {children}
    </ProjectScopeContext.Provider>
  );
}

function SourceBadge({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
      {children}
    </span>
  );
}

function OverrideBadge({
  disabled,
  onReset,
}: {
  readonly disabled: boolean;
  readonly onReset: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-normal text-info-foreground">
      Project override ·
      <button
        type="button"
        disabled={disabled}
        className="rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={onReset}
      >
        Reset
      </button>
    </span>
  );
}

/** Project page card that clears every override for the project. */
export function ProjectOverridesResetCard() {
  const { save, saving, overrides } = useProjectScope();
  const { selectedProjectHasClaudeOverride, updateSelectedProjectClaudeSettings } =
    useSettingsRouteContext();
  const count = Object.keys(overrides).length + (selectedProjectHasClaudeOverride ? 1 : 0);
  return (
    <SettingsCard
      title="Overrides"
      searchTarget="project.reset"
      description={
        count === 0
          ? "This project uses the global settings everywhere."
          : `This project overrides ${count} setting${count === 1 ? "" : "s"}. Each one shows a Project override badge on its page.`
      }
      actions={
        <Button
          size="xs"
          variant="outline"
          disabled={saving || count === 0}
          onClick={() => {
            void save(null);
            if (selectedProjectHasClaudeOverride) updateSelectedProjectClaudeSettings(null);
          }}
        >
          Reset all project overrides
        </Button>
      }
    />
  );
}

export function ProjectProviderControls() {
  const { projectId, settings, overrides, saving, set } = useProjectScope();
  const config = useQuery(serverConfigQueryOptions());
  const providers = projectProviderSnapshots(config.data?.providers ?? [], settings, projectId);
  return (
    <SettingsCard
      title="Providers"
      searchTarget="project.providers"
      description="Choose which configured agents this project can use. Other projects keep their own choices."
      actions={
        <Button
          size="xs"
          variant="outline"
          disabled={saving || !Object.keys(overrides.providerInstances ?? {}).length}
          onClick={() => set("providerInstances", {})}
        >
          Use global providers
        </Button>
      }
    >
      {config.isError ? (
        <p role="alert">Could not load providers.</p>
      ) : (
        providers.map((provider) => (
          <div
            key={provider.instanceId}
            className="flex items-center justify-between gap-4 py-2 text-sm"
          >
            <span>{provider.displayName ?? provider.instanceId}</span>
            <Switch
              aria-label={`Enable ${provider.displayName ?? provider.instanceId} for this project`}
              checked={provider.enabled}
              disabled={saving || provider.availability === "unavailable"}
              onCheckedChange={(enabled) =>
                set("providerInstances", {
                  ...overrides.providerInstances,
                  [provider.instanceId]: { enabled },
                })
              }
            />
          </div>
        ))
      )}
    </SettingsCard>
  );
}

export function ProjectThreadsOverrides() {
  const { settings, sources, saving, set, badge, projectId } = useProjectScope();
  const client = useQueryClient();
  const {
    selectedProjectClaudeSettings,
    selectedProjectHasClaudeOverride,
    updateSelectedProjectClaudeSettings,
    updateSelectedProjectMetadata,
    projectMetadataPending,
  } = useSettingsRouteContext();
  return (
    <fieldset disabled={saving} className="min-w-0 space-y-6">
      <SettingsCard
        title="New thread defaults"
        description="Existing threads keep their selected permissions and workspace."
      >
        <ProjectSettingRow
          title="Default permissions"
          source={badge("defaultRuntimeMode")}
          control={
            <select
              className={cn(NATIVE_CONTROL_CLASS, "w-48")}
              aria-label="Default permissions"
              value={settings.defaultRuntimeMode}
              onChange={(e) =>
                set("defaultRuntimeMode", e.target.value as typeof settings.defaultRuntimeMode)
              }
            >
              <option value="full-access">Full access</option>
              <option value="approval-required">Ask for approval</option>
              <option value="auto-accept-edits">Accept edits</option>
              <option value="auto">Auto</option>
            </select>
          }
        />
        <ProjectSettingRow
          title="Default workspace"
          source={
            <>
              {badge("defaultThreadEnvMode")}
              {sources.defaultThreadEnvMode === "legacy-project" ? (
                <button
                  type="button"
                  disabled={projectMetadataPending}
                  className="rounded-sm text-xs font-normal text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() =>
                    void updateSelectedProjectMetadata({ defaultEnvMode: null }).then(() =>
                      client.invalidateQueries({
                        queryKey: projectSettingsQueryOptions(projectId).queryKey,
                      }),
                    )
                  }
                >
                  Clear
                </button>
              ) : null}
            </>
          }
          description="Uses this project's override, then an older per-project default, then the repository's f5.json, then the global default."
          control={
            <select
              className={cn(NATIVE_CONTROL_CLASS, "w-48")}
              aria-label="Default workspace"
              value={settings.defaultThreadEnvMode}
              onChange={(e) => set("defaultThreadEnvMode", e.target.value as "local" | "worktree")}
            >
              <option value="local">Local</option>
              <option value="worktree">New worktree</option>
            </select>
          }
        />
      </SettingsCard>
      <SettingsCard title="Runtime">
        <ProjectSettingRow
          title="Resume active turns after restart"
          source={badge("resumeActiveTurnsAfterRestart")}
          control={
            <Switch
              aria-label="Resume active turns after restart"
              disabled={saving}
              checked={settings.resumeActiveTurnsAfterRestart}
              onCheckedChange={(checked) => set("resumeActiveTurnsAfterRestart", checked)}
            />
          }
        />
        <ProjectSettingRow
          title="Auto-continue after usage limits"
          source={badge("autoResumeUsageLimitedThreads")}
          control={
            <Switch
              aria-label="Auto-continue after usage limits"
              disabled={saving}
              checked={settings.autoResumeUsageLimitedThreads}
              onCheckedChange={(checked) => set("autoResumeUsageLimitedThreads", checked)}
            />
          }
        />
        <ProjectSettingRow
          title="Stream assistant replies"
          description="Whether the server streams partial replies for this project's threads."
          source={badge("enableAssistantStreaming")}
          control={
            <Switch
              aria-label="Stream assistant replies"
              disabled={saving}
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) => set("enableAssistantStreaming", checked)}
            />
          }
        />
        <ProjectSettingRow
          title="Claude prompt suggestions"
          description="Suggestions fill the composer without sending. Applies after the current turn."
          source={badge("enableClaudePromptSuggestions")}
          control={
            <Switch
              aria-label="Claude prompt suggestions"
              disabled={saving}
              checked={settings.enableClaudePromptSuggestions}
              onCheckedChange={(checked) => set("enableClaudePromptSuggestions", checked)}
            />
          }
        />
      </SettingsCard>
      <SettingsCard
        title="Claude sub-agents"
        actions={
          selectedProjectHasClaudeOverride ? (
            <OverrideBadge
              disabled={saving}
              onReset={() => updateSelectedProjectClaudeSettings(null)}
            />
          ) : (
            <SourceBadge>From global</SourceBadge>
          )
        }
      >
        <ClaudeSubagentControls
          value={selectedProjectClaudeSettings}
          onChange={(patch) => updateSelectedProjectClaudeSettings(patch)}
        />
      </SettingsCard>
    </fieldset>
  );
}

export function ProjectToolsOverrides() {
  const { selectedProjectSummary, hasProjects, settings } = useSettingsRouteContext();
  return (
    <McpServersSettings
      selectedProject={selectedProjectSummary}
      hasProjects={hasProjects}
      codexBinaryPath={settings.codexBinaryPath}
      codexHomePath={settings.codexHomePath}
      claudeBinaryPath={settings.claudeBinaryPath}
    />
  );
}

export function ProjectBrowserOverrides() {
  const { settings, saving, set, badge, projectId } = useProjectScope();
  const { status: computerStatus } = useComputerStatus();
  return (
    <>
      <fieldset disabled={saving} className="min-w-0 space-y-6">
        <SettingsCard title="Agent access">
          <ProjectSettingRow
            title="Agent browser access"
            source={badge("enableAgentBrowserAccess")}
            control={
              <Switch
                aria-label="Enable agent browser access"
                disabled={saving}
                checked={settings.enableAgentBrowserAccess}
                onCheckedChange={(checked) => set("enableAgentBrowserAccess", checked)}
              />
            }
          />
          <ProjectSettingRow
            title="Allowed external sites"
            searchTarget="browser.allowed-sites"
            source={badge("previewExternalHosts")}
            control={
              <PreviewExternalHostsEditor
                value={settings.previewExternalHosts}
                disabled={saving || !settings.enableAgentBrowserAccess}
                onSave={(hosts) => set("previewExternalHosts", hosts)}
              />
            }
          />
          {/* Not certified yet (docs/agent-browser.md): they can only be switched off. */}
          <ProjectSettingRow
            title="Claude in Chrome"
            searchTarget="browser.chrome"
            source={badge("enableClaudeInChrome")}
            description={UNCERTIFIED_CAPABILITY_DESCRIPTION}
            control={
              <Switch
                aria-label="Claude in Chrome"
                disabled={saving || !settings.enableClaudeInChrome}
                checked={settings.enableClaudeInChrome}
                onCheckedChange={(checked) => set("enableClaudeInChrome", checked)}
              />
            }
          />
        </SettingsCard>
        <SettingsCard title="Computer use" searchTarget="browser.computer-use">
          <ProjectSettingRow
            title="Computer use"
            source={badge("enableAgentComputerUse")}
            description="Let agents see and control the apps you approve for this project."
            control={
              <Switch
                aria-label="Computer use"
                disabled={
                  saving ||
                  (!settings.enableAgentComputerUse && !computerSettingsCanEnable(computerStatus))
                }
                checked={settings.enableAgentComputerUse}
                onCheckedChange={(checked) => set("enableAgentComputerUse", checked)}
              />
            }
          />
        </SettingsCard>
      </fieldset>
      <RememberedComputerApps projectId={projectId} />
    </>
  );
}

export function ProjectGitOverrides() {
  const { settings, overrides, saving, set, badge } = useProjectScope();
  const providerQuery = useQuery(serverConfigQueryOptions());
  const providers = (providerQuery.data?.providers ?? []).filter((provider) => provider.enabled);
  return (
    <fieldset disabled={saving} className="min-w-0 space-y-6">
      <SettingsCard title="Worktrees">
        <ProjectSettingRow
          title="Worktree submodules"
          source={badge("worktreeSubmodules")}
          control={
            <select
              className={cn(NATIVE_CONTROL_CLASS, "w-48")}
              aria-label="Worktree submodules"
              value={settings.worktreeSubmodules}
              onChange={(e) =>
                set("worktreeSubmodules", e.target.value as typeof settings.worktreeSubmodules)
              }
            >
              <option value="none">None</option>
              <option value="shallow">Top level</option>
              <option value="recursive">Recursive</option>
            </select>
          }
        />
        <ProjectSettingRow
          title="Automatic worktree cleanup"
          searchTarget="git.worktree-cleanup"
          source={badge("worktreeCleanup")}
          description={
            settings.storageCleanup.enabled
              ? undefined
              : "Automatic storage cleanup is off in Storage settings, so no rule runs."
          }
          control={
            <select
              className={cn(NATIVE_CONTROL_CLASS, "w-48")}
              aria-label="Automatic worktree cleanup"
              value={settings.worktreeCleanup?.mode ?? "global"}
              onChange={(event) =>
                set(
                  "worktreeCleanup",
                  event.target.value === "off"
                    ? { mode: "off" }
                    : event.target.value === "custom"
                      ? { mode: "custom", rules: settings.storageCleanup.worktree }
                      : null,
                )
              }
            >
              <option value="global">Use the global rules</option>
              <option value="off">Off for this project</option>
              <option value="custom">Custom rules</option>
            </select>
          }
        >
          {settings.worktreeCleanup?.mode === "custom" ? (
            <WorktreeCleanupRulesEditor
              rules={settings.worktreeCleanup.rules}
              onChange={(rules) => set("worktreeCleanup", { mode: "custom", rules })}
            />
          ) : null}
        </ProjectSettingRow>
        <ProjectSettingRow
          title="Disposable worktree changes"
          searchTarget="git.worktree-disposable-paths"
          source={badge("worktreeDisposablePaths")}
          description="Uncommitted changes Storage cleanup may discard, such as regenerated files."
          control={
            <WorktreeDisposablePathsEditor
              value={settings.worktreeDisposablePaths}
              disabled={saving}
              onSave={(paths) => set("worktreeDisposablePaths", paths)}
            />
          }
        />
      </SettingsCard>
      <SettingsCard title="Thread settlement">
        <ThreadSettlementFields
          settings={settings}
          disabled={saving}
          badge={badge}
          onChange={(patch) => {
            for (const [key, value] of Object.entries(patch)) set(key as keyof typeof patch, value);
          }}
        />
      </SettingsCard>
      <SettingsCard title="Sync">
        <ProjectSettingRow
          title="Auto-pull the default branch"
          source={badge("autoPullDefaultBranch")}
          control={
            <Switch
              aria-label="Auto-pull default branches"
              disabled={saving}
              checked={settings.autoPullDefaultBranch}
              onCheckedChange={(checked) => set("autoPullDefaultBranch", checked)}
            />
          }
        />
      </SettingsCard>
      <SettingsCard title="Writing" searchTarget="git.writing">
        <ProjectSettingRow
          title="Text generation model"
          searchTarget="git.text-model"
          source={badge("textGenerationModelSelection")}
          description="The provider and model that write git text for this project."
          control={
            <>
              <select
                className={cn(NATIVE_CONTROL_CLASS, "w-40")}
                aria-label="Text generation provider"
                value={settings.textGenerationModelSelection.instanceId}
                onChange={(e) => {
                  const provider = providers.find((entry) => entry.instanceId === e.target.value);
                  if (!provider) return;
                  const model =
                    pickPreferredModel(provider.models)?.slug ??
                    (isKnownProviderKind(provider.driver)
                      ? DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[
                          provider.driver as ProviderKind
                        ]
                      : undefined);
                  if (model)
                    set("textGenerationModelSelection", {
                      instanceId: provider.instanceId,
                      model,
                    });
                }}
              >
                {providers.map((provider) => (
                  <option key={provider.instanceId} value={provider.instanceId}>
                    {provider.displayName ?? provider.instanceId}
                  </option>
                ))}
                {!providers.some(
                  (provider) =>
                    provider.instanceId === settings.textGenerationModelSelection.instanceId,
                ) && (
                  <option value={settings.textGenerationModelSelection.instanceId}>
                    {settings.textGenerationModelSelection.instanceId}
                  </option>
                )}
              </select>
              <input
                className={cn(NATIVE_CONTROL_CLASS, "w-44")}
                aria-label="Text generation model"
                key={settings.textGenerationModelSelection.model}
                defaultValue={settings.textGenerationModelSelection.model}
                onBlur={(e) => {
                  const model = e.target.value.trim();
                  if (model && model !== settings.textGenerationModelSelection.model)
                    set("textGenerationModelSelection", {
                      ...settings.textGenerationModelSelection,
                      model,
                    });
                }}
              />
            </>
          }
        />
        <ProjectSettingRow title="Source control writing" source={badge("sourceControlWriting")} />
        {(
          [
            "generateCommitMessages",
            "generatePrContent",
            "commitMessageIncludeBody",
            "useRepositoryInstructions",
          ] as const
        ).map((key) => (
          <ProjectSettingRow
            key={key}
            title={SOURCE_CONTROL_TOGGLE_LABELS[key]}
            control={
              <Switch
                aria-label={SOURCE_CONTROL_TOGGLE_LABELS[key]}
                disabled={saving}
                checked={settings.sourceControlWriting[key] ?? false}
                onCheckedChange={(checked) =>
                  set("sourceControlWriting", {
                    ...overrides.sourceControlWriting,
                    [key]: checked,
                  })
                }
              />
            }
          />
        ))}
        <ProjectSettingRow
          title="Commit style"
          control={
            <select
              className={cn(NATIVE_CONTROL_CLASS, "w-48")}
              aria-label="Commit style"
              value={settings.sourceControlWriting.commitMessageStyle}
              onChange={(e) =>
                set("sourceControlWriting", {
                  ...overrides.sourceControlWriting,
                  commitMessageStyle: e.target.value as "plain" | "conventional",
                })
              }
            >
              <option value="plain">Plain</option>
              <option value="conventional">Conventional</option>
            </select>
          }
        />
        {(["branchNamePrefix", "customInstructions", "prBodyTemplate"] as const).map((key) => (
          <ProjectSettingRow key={key} title={SOURCE_CONTROL_TEXT_LABELS[key]}>
            <textarea
              aria-label={SOURCE_CONTROL_TEXT_LABELS[key]}
              className={cn(
                NATIVE_CONTROL_CLASS,
                "block h-auto w-full py-2",
                key === "branchNamePrefix" ? "min-h-8" : "min-h-20",
              )}
              rows={key === "branchNamePrefix" ? 1 : 3}
              key={settings.sourceControlWriting[key]}
              defaultValue={settings.sourceControlWriting[key]}
              onBlur={(e) => {
                if (e.target.value !== settings.sourceControlWriting[key])
                  set("sourceControlWriting", {
                    ...overrides.sourceControlWriting,
                    [key]: e.target.value,
                  });
              }}
            />
          </ProjectSettingRow>
        ))}
      </SettingsCard>
      <SettingsCard title="Pull requests">
        <ProjectSettingRow
          title="Default merge method"
          source={badge("prHubDefaultMergeMethod")}
          control={
            <select
              className={cn(NATIVE_CONTROL_CLASS, "w-48")}
              aria-label="Default PR merge method"
              value={settings.prHubDefaultMergeMethod ?? ""}
              onChange={(e) =>
                set(
                  "prHubDefaultMergeMethod",
                  e.target.value ? (e.target.value as "squash" | "merge" | "rebase") : null,
                )
              }
            >
              <option value="">Last used</option>
              <option value="squash">Squash</option>
              <option value="merge">Merge</option>
              <option value="rebase">Rebase</option>
            </select>
          }
        />
      </SettingsCard>
    </fieldset>
  );
}

const SOURCE_CONTROL_TOGGLE_LABELS = {
  generateCommitMessages: "Generate commit messages",
  generatePrContent: "Generate PR descriptions",
  commitMessageIncludeBody: "Include commit body",
  useRepositoryInstructions: "Use repository instructions",
} as const;

const SOURCE_CONTROL_TEXT_LABELS = {
  branchNamePrefix: "Branch prefix",
  customInstructions: "Writing instructions",
  prBodyTemplate: "PR body template",
} as const;

const NATIVE_CONTROL_CLASS =
  "h-8 rounded-md border border-input bg-background px-2.5 text-sm font-normal text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60";

const UNCERTIFIED_CAPABILITY_DESCRIPTION = "Not available in F5 yet.";

/** A settings row with the setting's source (global or project override) beside its title. */
function ProjectSettingRow({
  title,
  source,
  description,
  control,
  searchTarget,
  children,
}: {
  readonly title: ReactNode;
  readonly source?: ReactNode;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
  readonly searchTarget?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className="border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
      data-settings-search-target={searchTarget}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
            {title}
            {source}
          </p>
          {description ? <p className="text-ui text-muted-foreground">{description}</p> : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
