import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
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
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ProjectId,
  type ProjectSettingsOverrides,
  type ProjectScopedServerSettingKey,
} from "@t3tools/contracts";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";

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
    <div className="flex shrink-0 items-center gap-2 border-b p-4">
      <button onClick={() => onChange(undefined)}>Global</button>
      <span aria-hidden>›</span>
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
          className="rounded-md border px-3 py-2 text-sm"
        >
          {projects.find((p) => p.id === projectId)?.name ?? "Global settings"}
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
  const client = useQueryClient();
  const query = useQuery(projectSettingsQueryOptions(projectId));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const providerQuery = useQuery(serverConfigQueryOptions());
  const providers = (providerQuery.data?.providers ?? []).filter((provider) => provider.enabled);
  if (query.isPending) return <p className="p-6">Loading project settings…</p>;
  if (!query.data)
    return (
      <div className="p-6" role="alert">
        Could not load project settings. <button onClick={() => void query.refetch()}>Retry</button>
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
    <span className="text-xs text-muted-foreground">
      {sources[key] === "project" ? (
        <>
          Project override ·{" "}
          <button
            disabled={saving}
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
    <div className="space-y-5 overflow-auto p-6">
      <h1 className="text-lg font-semibold">Project settings</h1>
      <p>
        Override defaults for this project. Existing threads keep their selected permissions and
        workspace.
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={saving} className="space-y-5">
        <div className="block">
          Default permissions {badge("defaultRuntimeMode")}
          <select
            className="mt-2 block rounded-md border border-input bg-background px-3 py-2 text-sm"
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
        </div>
        <div className="block">
          Default workspace {badge("defaultThreadEnvMode")}
          <select
            className="mt-2 block rounded-md border border-input bg-background px-3 py-2 text-sm"
            aria-label="Default workspace"
            value={settings.defaultThreadEnvMode}
            onChange={(e) => set("defaultThreadEnvMode", e.target.value as "local" | "worktree")}
          >
            <option value="local">Local</option>
            <option value="worktree">Worktree</option>
          </select>
        </div>
        <div className="block">
          Worktree submodules {badge("worktreeSubmodules")}
          <select
            className="mt-2 block rounded-md border border-input bg-background px-3 py-2 text-sm"
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
        </div>
        <label className="block">
          <input
            type="checkbox"
            checked={settings.enableAssistantStreaming}
            onChange={(e) => set("enableAssistantStreaming", e.target.checked)}
          />{" "}
          Stream assistant replies
        </label>
        {badge("enableAssistantStreaming")}
        <label className="flex items-center justify-between gap-4 py-2">
          <span>Resume active turns after restart</span>
          <input
            type="checkbox"
            checked={settings.resumeActiveTurnsAfterRestart}
            onChange={(event) => set("resumeActiveTurnsAfterRestart", event.target.checked)}
          />
        </label>
        {badge("resumeActiveTurnsAfterRestart")}
        <div className="block">
          Default merge method {badge("prHubDefaultMergeMethod")}
          <select
            className="mt-2 block rounded-md border border-input bg-background px-3 py-2 text-sm"
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
        </div>
        <div>
          Text generation model {badge("textGenerationModelSelection")}
          <select
            className="mt-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
            aria-label="Text generation provider"
            value={settings.textGenerationModelSelection.instanceId}
            onChange={(e) => {
              const provider = providers.find((entry) => entry.instanceId === e.target.value);
              if (!provider) return;
              const model =
                provider.models[0]?.slug ??
                (isKnownProviderKind(provider.driver)
                  ? DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider.driver as ProviderKind]
                  : undefined);
              if (model)
                set("textGenerationModelSelection", { instanceId: provider.instanceId, model });
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
            className="ml-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
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
        </div>
        <div className="space-y-3">
          Source control writing {badge("sourceControlWriting")}
          {(
            [
              "generateCommitMessages",
              "generatePrContent",
              "commitMessageIncludeBody",
              "useRepositoryInstructions",
            ] as const
          ).map((key) => (
            <label className="block" key={key}>
              <input
                type="checkbox"
                checked={settings.sourceControlWriting[key] ?? false}
                onChange={(e) =>
                  set("sourceControlWriting", {
                    ...overrides.sourceControlWriting,
                    [key]: e.target.checked,
                  })
                }
              />
              {
                {
                  generateCommitMessages: "Generate commit messages",
                  generatePrContent: "Generate PR descriptions",
                  commitMessageIncludeBody: "Include commit body",
                  useRepositoryInstructions: "Use repository instructions",
                }[key]
              }
            </label>
          ))}
          <label className="block">
            Commit style
            <select
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
          </label>
          {(["branchNamePrefix", "customInstructions", "prBodyTemplate"] as const).map((key) => (
            <label className="block" key={key}>
              {
                {
                  branchNamePrefix: "Branch prefix",
                  customInstructions: "Writing instructions",
                  prBodyTemplate: "PR body template",
                }[key]
              }
              <textarea
                className="block w-full border p-2"
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
            </label>
          ))}
        </div>
        <button onClick={() => void save(null)}>Reset all project overrides</button>
      </fieldset>
    </div>
  );
}
