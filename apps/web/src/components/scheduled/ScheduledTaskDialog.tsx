import { normalizeCron, previewCronSchedule, SCHEDULE_PRESETS } from "@t3tools/shared/cronSchedule";
import { CronScheduleEditor, inspectCronInput } from "./CronScheduleEditor";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type ModelSlug,
  ProviderInstanceId,
  ProviderDriverKind,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskConfiguration,
  type ProjectId,
  isKnownProviderKind,
} from "@t3tools/contracts";
import { createModelSelection, getDefaultModel } from "@t3tools/shared/model";
import { buildSlashComposerMenuItems } from "@t3tools/shared/slashCommands";
import type { Project } from "../../types";
import { useStore } from "../../store";
import { useSettings, type UnifiedWebSettings } from "../../hooks/useSettings";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { resolveNewThreadPreferences } from "../../newThreadPreferences";
import { getModelPreferences } from "../../modelPreferencesStore";
import {
  resolveAppModelSelectionForInstance,
  getCustomModelOptionsByInstance,
} from "../../modelSelection";
import { providerModelOptionsToSelections } from "../../providerModelOptions";
import { ensureNativeApi } from "../../nativeApi";
import { useTheme } from "../../hooks/useTheme";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "../chat/ComposerCommandMenu";
import { ProviderInstanceModelPicker } from "../chat/ProviderInstanceModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { getComposerProviderState } from "../chat/composerProviderState";
import { RuntimeModePicker } from "../chat/RuntimeModePicker";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  isMetadataOnlyScheduleEdit,
  confirmedSchedule,
  validateScheduledDraft,
  type PreviewState,
} from "./schedulePreview";

export function ScheduledTaskDialog(props: {
  projectId: ProjectId;
  task?: ScheduledTask;
  onClose: () => void;
  onSaved: () => void;
  onProjectChange?: (id: ProjectId) => void;
}) {
  const project = useStore((s) => s.projects.find((p) => p.id === props.projectId));
  const config = useQuery(serverConfigQueryOptions());
  const settings = useSettings(undefined, props.projectId);
  const projectSettings = useQuery(projectSettingsQueryOptions(props.projectId));
  const branches = useQuery(
    gitBranchesQueryOptions({ cwd: project?.cwd ?? null, autoRefresh: false }),
  );
  if (!project || !config.data || branches.isPending || projectSettings.isPending)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <DialogPopup className="[-webkit-app-region:no-drag]">
          <DialogHeader>
            <DialogTitle>Scheduled task</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p role="status">Loading execution settings…</p>
            <Button onClick={props.onClose}>Cancel</Button>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    );
  return (
    <Editor
      {...props}
      project={project}
      settings={settings}
      providers={config.data.providers}
      branches={branches.data}
    />
  );
}
function Editor(
  props: Parameters<typeof ScheduledTaskDialog>[0] & {
    project: Project;
    settings: UnifiedWebSettings;
    providers: ReadonlyArray<import("@t3tools/contracts").ServerProvider>;
    branches: import("@t3tools/contracts").GitListBranchesResult | undefined;
  },
) {
  const preferences = resolveNewThreadPreferences(
    props.project,
    props.settings,
    getModelPreferences(),
  );
  const preferredProvider = props.providers.find(
    (p) => p.instanceId === (preferences.instanceId ?? preferences.provider),
  );
  const initialProvider =
    preferredProvider?.enabled &&
    preferredProvider.installed &&
    preferredProvider.status !== "error" &&
    preferredProvider.status !== "disabled"
      ? preferredProvider
      : props.providers.find(
          (p) => p.enabled && p.installed && p.status !== "error" && p.status !== "disabled",
        );
  const initialDriver =
    initialProvider && isKnownProviderKind(initialProvider.driver)
      ? initialProvider.driver
      : "codex";
  const keptPreference = initialProvider === preferredProvider;
  const initialModel =
    (initialProvider
      ? resolveAppModelSelectionForInstance(
          initialProvider.instanceId,
          props.settings,
          props.providers,
          keptPreference ? preferences.model : null,
        )
      : null) ?? getDefaultModel(initialDriver);
  const [value, setValue] = useState<ScheduledTaskConfiguration>(
    () =>
      props.task ?? {
        name: "",
        prompt: "",
        modelSelection: createModelSelection(
          initialProvider?.instanceId ?? ProviderInstanceId.make("codex"),
          initialModel,
          getComposerProviderState({
            provider: ProviderDriverKind.make(initialDriver),
            model: initialModel,
            models: initialProvider?.models ?? [],
            modelOptions: providerModelOptionsToSelections(
              initialDriver,
              keptPreference ? preferences.options : undefined,
            ),
          }).modelOptionsForDispatch,
        ),
        runtimeMode: props.settings.defaultRuntimeMode,
        workspace: { kind: "projectRoot" },
        cron: SCHEDULE_PRESETS.daily,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scheduleSource: "",
        maxRuns: null,
        oneShotAt: null,
        notify: "all",
        enabled: true,
      },
  );
  const [mode, setMode] = useState<"preset" | "cron">(props.task ? "cron" : "preset");
  const [schedule, setSchedule] = useState(() =>
    props.task ? normalizeCron(props.task.cron) : "daily",
  );
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: "unpreviewed" });
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(value.prompt.length);
  const skillListId = useId();
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const taskId = useRef(props.task?.id ?? ScheduledTaskId.makeUnsafe(crypto.randomUUID()));
  const requestedAt = useRef<string | null>(null);
  const key = JSON.stringify([props.projectId, value.timezone, mode, schedule]);
  const provider = props.providers.find((p) => p.instanceId === value.modelSelection.instanceId);
  const driver = provider?.driver ?? ProviderDriverKind.make("codex");
  const options = getCustomModelOptionsByInstance(props.settings, props.providers);
  const update = (patch: Partial<ScheduledTaskConfiguration>) =>
    setValue((v) => ({ ...v, ...patch }));
  const invocation = /^\s*\/([^\s]*)$/.exec(value.prompt.slice(0, cursor));
  const items = invocation
    ? buildSlashComposerMenuItems({
        query: invocation[1] ?? "",
        provider: isKnownProviderKind(driver) ? driver : undefined,
        projectSkills: props.project.skills,
        providerSkills: provider?.skills,
        runtimeSlashCommands: provider?.slashCommands?.map((c) => ({
          name: c.name,
          description: c.description ?? c.name,
        })),
        runtimeSlashCommandsSource: "instance",
      }).filter((i) => i.type === "skill")
    : [];
  const activeSkillId = items.find((item) => item.id === highlighted)?.id ?? items[0]?.id;
  const chooseSkill = (item: ComposerCommandItem) => {
    if (item.type !== "skill") return;
    const next = `/${item.name} ${value.prompt.slice(cursor)}`;
    update({ prompt: next });
    setCursor(item.name.length + 2);
  };
  const cron =
    mode === "preset" ? SCHEDULE_PRESETS[schedule as keyof typeof SCHEDULE_PRESETS] : schedule;
  const cronValidation = useMemo(() => inspectCronInput(cron), [cron]);
  const invalidCron = !!cronValidation.error;
  useEffect(() => {
    const refresh = () => {
      try {
        const candidate = previewCronSchedule(cron, value.timezone);
        setPreview({ kind: "ready", key, preview: candidate });
        const first = candidate.nextFireTimes[0];
        if (first)
          timer = setTimeout(
            refresh,
            Math.min(2_147_483_647, Math.max(1, Date.parse(first) - Date.now() + 1)),
          );
      } catch (error) {
        setPreview({
          kind: "error",
          key,
          message: error instanceof Error ? error.message : "Invalid schedule.",
        });
      }
    };
    // Avoid evaluating future dates for every keystroke. Cleanup fences changed inputs.
    let timer = setTimeout(refresh, 180);
    return () => clearTimeout(timer);
  }, [key, cron, value.timezone]);
  const metadataOnly =
    isMetadataOnlyScheduleEdit(props.task, value) &&
    mode === "cron" &&
    schedule === props.task?.cron;
  const metadataPreview =
    metadataOnly && preview.kind === "ready" && preview.key === key ? preview.preview : null;
  const candidate = confirmedSchedule(preview, key) ?? metadataPreview;
  const save = async () => {
    if (!confirmedSchedule(preview, key) && !metadataPreview) {
      setError("The schedule is updating or has expired. Check its next run times.");
      return;
    }
    if (!candidate || invalidCron) return;
    const configuration = {
      ...value,
      cron: candidate.cron,
      timezone: candidate.timezone,
      scheduleSource: metadataOnly ? props.task!.scheduleSource : schedule,
      oneShotAt: metadataOnly ? props.task!.oneShotAt : candidate.oneShotAt,
      maxRuns: metadataOnly ? props.task!.maxRuns : candidate.oneShotAt ? 1 : value.maxRuns,
    };
    const problem = validateScheduledDraft(configuration);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const api = ensureNativeApi().scheduledTasks;
      const result = props.task
        ? await api.update({
            id: props.task.id,
            expectedVersion: props.task.version,
            configuration,
          })
        : await api.create({
            id: taskId.current,
            projectId: props.projectId,
            requestedAt: (requestedAt.current ??= new Date(Date.now()).toISOString()),
            configuration,
          });
      for (const warning of result.warnings) toastManager.add({ type: "warning", title: warning });
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="h-[min(48rem,calc(100dvh-4rem))] max-w-2xl [-webkit-app-region:no-drag]">
        <DialogHeader className="shrink-0">
          <DialogTitle>{props.task ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
          <DialogDescription>
            Runs on this F5 server while it is running. Project: {props.project.name}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            {props.onProjectChange && (
              <label>
                Project
                <NativeSelect
                  value={props.projectId}
                  onChange={(e) => props.onProjectChange?.(e.target.value as ProjectId)}
                >
                  {useStore.getState().projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            <label className="block">
              Name
              <Input
                aria-label="Task name"
                value={value.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </label>
            <div>
              <p>Prompt</p>
              <ComposerPromptEditor
                value={value.prompt}
                cursor={cursor}
                terminalContexts={[]}
                suggestionListId={skillListId}
                activeSuggestionId={
                  activeSkillId ? composerSuggestionOptionId(skillListId, activeSkillId) : undefined
                }
                disabled={saving}
                placeholder="Describe the work, or /skill-name args"
                className="min-h-24 rounded-md border p-3"
                onRemoveTerminalContext={() => {}}
                onPaste={() => {}}
                onChange={(prompt, cursor) => {
                  update({ prompt });
                  setCursor(cursor);
                }}
                onCommandKeyDown={(key) => {
                  const index = items.findIndex((i) => i.id === highlighted);
                  if (key === "ArrowDown" || key === "ArrowUp") {
                    if (!items.length) return false;
                    setHighlighted(
                      items[(index + (key === "ArrowDown" ? 1 : items.length - 1)) % items.length]!
                        .id,
                    );
                    return true;
                  }
                  if ((key === "Enter" || key === "Tab") && items.length) {
                    chooseSkill(items[index >= 0 ? index : 0]!);
                    return true;
                  }
                  return false;
                }}
              />
              {items.length > 0 && (
                <ComposerCommandMenu
                  listId={skillListId}
                  items={items}
                  resolvedTheme={resolvedTheme}
                  isLoading={false}
                  triggerKind="slash-command"
                  activeItemId={activeSkillId ?? null}
                  onHighlightedItemChange={setHighlighted}
                  onSelect={chooseSkill}
                />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <ProviderInstanceModelPicker
                instanceId={value.modelSelection.instanceId}
                model={value.modelSelection.model as ModelSlug}
                lockedInstanceId={null}
                providers={props.providers}
                modelOptionsByInstance={options}
                onInstanceModelChange={(instanceId, driver, model) =>
                  update({
                    modelSelection: createModelSelection(
                      instanceId,
                      model,
                      getComposerProviderState({
                        provider: driver,
                        model,
                        models:
                          props.providers.find((p) => p.instanceId === instanceId)?.models ?? [],
                        modelOptions: undefined,
                      }).modelOptionsForDispatch,
                    ),
                  })
                }
              />
              <TraitsPicker
                provider={driver}
                model={value.modelSelection.model}
                models={provider?.models ?? []}
                modelOptions={value.modelSelection.options}
                onModelOptionsChange={(options) =>
                  update({
                    modelSelection: createModelSelection(
                      value.modelSelection.instanceId,
                      value.modelSelection.model,
                      options,
                    ),
                  })
                }
              />
              {isKnownProviderKind(driver) && (
                <RuntimeModePicker
                  provider={driver}
                  value={value.runtimeMode}
                  onValueChange={(runtimeMode) => update({ runtimeMode })}
                />
              )}
            </div>
            <label className="block">
              Workspace
              <NativeSelect
                aria-label="Workspace"
                value={value.workspace.kind}
                onChange={(e) =>
                  update({
                    workspace:
                      e.target.value === "worktree"
                        ? {
                            kind: "worktree",
                            baseBranch:
                              props.branches?.branches.find((b) => b.current)?.name ??
                              props.branches?.branches.find((b) => b.isDefault)?.name ??
                              "",
                          }
                        : { kind: "projectRoot" },
                  })
                }
              >
                <option value="projectRoot">Project root (shared filesystem)</option>
                <option value="worktree">New worktree for every run</option>
              </NativeSelect>
            </label>
            {value.workspace.kind === "worktree" && (
              <label className="block">
                Base branch
                <Input
                  list="schedule-branches"
                  aria-label="Base branch"
                  value={value.workspace.baseBranch}
                  onChange={(e) =>
                    update({ workspace: { kind: "worktree", baseBranch: e.target.value } })
                  }
                />
                <datalist id="schedule-branches">
                  {props.branches?.branches.map((b) => (
                    <option key={b.name} value={b.name} />
                  ))}
                </datalist>
                <p className="text-xs text-muted-foreground">
                  A Git project and a base branch are required. Preparation never falls back to the
                  root.
                </p>
              </label>
            )}
            <label className="block">
              Timezone
              <Input
                aria-label="Timezone"
                value={value.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
              />
            </label>
            <label className="block">
              Notify
              <NativeSelect
                aria-label="Notification policy"
                value={value.notify}
                onChange={(e) => update({ notify: e.target.value as typeof value.notify })}
              >
                <option value="all">Every outcome</option>
                <option value="failures_and_attention">Failures and attention</option>
                <option value="none">None</option>
              </NativeSelect>
            </label>
            <label className="block">
              Schedule format
              <NativeSelect
                value={mode}
                onChange={(e) => {
                  const nextMode = e.target.value as "preset" | "cron";
                  setMode(nextMode);
                  setSchedule(
                    nextMode === "preset"
                      ? "daily"
                      : (SCHEDULE_PRESETS[schedule as keyof typeof SCHEDULE_PRESETS] ?? value.cron),
                  );
                }}
              >
                <option value="preset">Preset</option>
                <option value="cron">Cron</option>
              </NativeSelect>
            </label>
            {mode === "preset" ? (
              <NativeSelect
                aria-label="Preset"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
              >
                {["hourly", "daily", "weekdays", "weekly"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </NativeSelect>
            ) : (
              <CronScheduleEditor
                value={schedule}
                onChange={setSchedule}
                validation={cronValidation}
              />
            )}
            <div
              data-testid="schedule-summary"
              className="min-h-28 space-y-2 text-center"
              aria-live="polite"
              aria-busy={
                preview.kind !== "error" && (preview.kind !== "ready" || preview.key !== key)
              }
            >
              {preview.kind === "error" && preview.key === key && !invalidCron && (
                <p role="alert">{preview.message}</p>
              )}
              {preview.kind === "ready" && (
                <>
                  <p className="text-lg font-medium">{preview.preview.summary}</p>
                  {preview.preview.nextFireTimes[0] ? (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                        <span className="underline underline-offset-4">Next</span>{" "}
                        <time dateTime={preview.preview.nextFireTimes[0]}>
                          {new Date(preview.preview.nextFireTimes[0]).toLocaleString(undefined, {
                            timeZone: preview.preview.timezone,
                            timeZoneName: "short",
                          })}
                        </time>
                      </summary>
                      <ol aria-label="Next runs" className="mt-2 space-y-1">
                        {preview.preview.nextFireTimes.map((time) => (
                          <li key={time}>
                            {new Date(time).toLocaleString(undefined, {
                              timeZone: preview.preview.timezone,
                              timeZoneName: "short",
                            })}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No future runs for this schedule.
                    </p>
                  )}
                  {preview.preview.oneShotAt && (
                    <p className="text-xs text-muted-foreground">
                      Runs once, then disables itself.
                    </p>
                  )}
                </>
              )}
            </div>
            {error && <p role="alert">{error}</p>}
          </fieldset>
        </DialogPanel>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!candidate || invalidCron || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
