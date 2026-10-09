import { useComputerStatus, computerSettingsCanEnable } from "../../hooks/useComputerStatus";
import { RememberedComputerApps } from "./RememberedComputerApps";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { WorktreeCleanupRulesEditor } from "./WorktreeCleanupRulesEditor";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isKnownProviderKind,
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
import { useState, type ReactNode } from "react";
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
            {projects.find((p) => p.id === projectId)?.name ?? "Global settings"}
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

export function ProjectSettingsScope({ projectId }: { projectId: ProjectId }) {
  const { status: computerStatus } = useComputerStatus();
  const client = useQueryClient();
  const query = useQuery(projectSettingsQueryOptions(projectId));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const providerQuery = useQuery(serverConfigQueryOptions());
  const providers = (providerQuery.data?.providers ?? []).filter((provider) => provider.enabled);
  if (query.isPending)
    return <p className="p-6 text-ui text-muted-foreground">Loading project settings…</p>;
  if (!query.data)
    return (
      <div className="flex items-center gap-3 p-6 text-sm" role="alert">
        Could not load project settings.
        <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  const { settings, overrides, sources } = query.data;
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
  const set = <K extends ProjectScopedServerSettingKey>(
    key: K,
    value: ProjectSettingsOverrides[K],
  ) => void save({ ...overrides, [key]: value });
  const badge = (key: ProjectScopedServerSettingKey) => (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-normal",
        sources[key] === "project" ? "text-info-foreground" : "text-muted-foreground",
      )}
    >
      {sources[key] === "project" ? (
        <>
          Project override ·
          <button
            type="button"
            disabled={saving}
            className="rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => {
              const next = { ...overrides };
              delete next[key];
              void save(next);
            }}
          >
            Reset
          </button>
        </>
      ) : sources[key] === "legacy-project" ? (
        "From legacy project default"
      ) : (
        `From ${sources[key]}`
      )}
    </span>
  );
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Project settings</h1>
          <p className="text-ui text-muted-foreground">
            Override defaults for this project. Existing threads keep their selected permissions and
            workspace.
          </p>
        </div>
        <Button size="xs" variant="outline" disabled={saving} onClick={() => void save(null)}>
          Reset all project overrides
        </Button>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <fieldset disabled={saving} className="min-w-0 space-y-6">
        <SettingsCard title="New threads">
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
            source={badge("defaultThreadEnvMode")}
            control={
              <select
                className={cn(NATIVE_CONTROL_CLASS, "w-48")}
                aria-label="Default workspace"
                value={settings.defaultThreadEnvMode}
                onChange={(e) =>
                  set("defaultThreadEnvMode", e.target.value as "local" | "worktree")
                }
              >
                <option value="local">Local</option>
                <option value="worktree">Worktree</option>
              </select>
            }
          />
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
        </SettingsCard>
        <SettingsCard title="Conversation">
          <ProjectSettingRow
            title="Stream assistant replies"
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
            title="Enable agent browser access"
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
        <SettingsCard title="Git and worktrees">
          <ProjectSettingRow
            title="Default merge method"
            source={badge("prHubDefaultMergeMethod")}
            control={
              <select
                className={cn(NATIVE_CONTROL_CLASS, "w-48")}
                aria-label="Default merge method"
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
          <ProjectSettingRow
            title="Automatic worktree cleanup"
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
            title="Auto-pull the default branch"
            source={badge("autoPullDefaultBranch")}
            control={
              <Switch
                aria-label="Auto-pull the default branch"
                disabled={saving}
                checked={settings.autoPullDefaultBranch}
                onCheckedChange={(checked) => set("autoPullDefaultBranch", checked)}
              />
            }
          />
        </SettingsCard>
        <SettingsCard title="Text generation">
          <ProjectSettingRow
            title="Text generation model"
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
                      provider.models[0]?.slug ??
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
        </SettingsCard>
        <SettingsCard title="Source control writing" actions={badge("sourceControlWriting")}>
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
      </fieldset>
      <RememberedComputerApps projectId={projectId} />
    </div>
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

/** A settings row with the setting's source (global or project override) beside its title. */
const UNCERTIFIED_CAPABILITY_DESCRIPTION = "Not available in F5 yet.";

function ProjectSettingRow({
  title,
  source,
  description,
  control,
  children,
}: {
  readonly title: ReactNode;
  readonly source?: ReactNode;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0">
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
