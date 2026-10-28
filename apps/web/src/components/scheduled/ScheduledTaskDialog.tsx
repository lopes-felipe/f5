import {
  fixedTimeCron,
  normalizeCron,
  parseFixedTimeCron,
  previewCronSchedule,
  validateTimezone,
  type FixedTimeCronDraft,
} from "@t3tools/shared/cronSchedule";
import { CronScheduleEditor, inspectCronInput } from "./CronScheduleEditor";
import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type ModelSelection,
  type ModelSlug,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type RuntimeMode,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskConfiguration,
  type ScheduledWorkspace,
  type ProjectId,
  type ThreadId,
  isKnownProviderKind,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { buildSlashComposerMenuItems } from "@t3tools/shared/slashCommands";
import { useStore } from "../../store";
import { useSettings } from "../../hooks/useSettings";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { getModelPreferences } from "../../modelPreferencesStore";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
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
import {
  pickedModelSelection,
  resolveNewThreadModelSelection,
} from "../chat/newThreadModelSelection";
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
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  isMetadataOnlyScheduleEdit,
  confirmedSchedule,
  validateScheduledDraft,
  type PreviewState,
} from "./schedulePreview";

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const;
const DEFAULT_FIXED: FixedTimeCronDraft = { timeOfDay: "09:00", weekdays: EVERY_DAY };
/** Monday-first, as people read a week; cron numbering stays Sunday = 0. */
const WEEKDAYS = [
  [1, "Mon", "Monday"],
  [2, "Tue", "Tuesday"],
  [3, "Wed", "Wednesday"],
  [4, "Thu", "Thursday"],
  [5, "Fri", "Friday"],
  [6, "Sat", "Saturday"],
  [0, "Sun", "Sunday"],
] as const;
const sameFixed = (a: FixedTimeCronDraft, b: FixedTimeCronDraft) =>
  a.timeOfDay === b.timeOfDay &&
  a.weekdays.length === b.weekdays.length &&
  [...a.weekdays].toSorted().every((day, i) => day === [...b.weekdays].toSorted()[i]);

/**
 * Execution fields left `null` are untouched: they re-resolve from the current
 * project, so switching project never carries the previous project's defaults.
 */
interface Draft {
  name: string;
  prompt: string;
  timezone: string;
  notify: ScheduledTaskConfiguration["notify"];
  enabled: boolean;
  maxRuns: number | null;
  oneShotAt: string | null;
  workspaceKind: ScheduledWorkspace["kind"];
  baseBranch: string | null;
  modelSelection: ModelSelection | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}
function initialDraft(task: ScheduledTask | undefined, boundThreadId: ThreadId | undefined): Draft {
  if (!task)
    return {
      name: "",
      prompt: "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      notify: "all",
      enabled: true,
      maxRuns: null,
      oneShotAt: null,
      workspaceKind: boundThreadId ? "thread" : "projectRoot",
      baseBranch: null,
      modelSelection: null,
      runtimeMode: null,
      interactionMode: null,
    };
  // A bound task's stored settings mirror its conversation, so they are not explicit choices.
  const explicit = task.workspace.kind !== "thread";
  return {
    name: task.name,
    prompt: task.prompt,
    timezone: task.timezone,
    notify: task.notify,
    enabled: task.enabled,
    maxRuns: task.maxRuns,
    oneShotAt: task.oneShotAt,
    workspaceKind: task.workspace.kind,
    baseBranch: task.workspace.kind === "worktree" ? task.workspace.baseBranch : null,
    modelSelection: explicit ? task.modelSelection : null,
    runtimeMode: explicit ? task.runtimeMode : null,
    interactionMode: explicit ? task.interactionMode : null,
  };
}
type EffectiveSchedule =
  | { readonly kind: "valid"; readonly cron: string; readonly normalizedCron: string }
  | { readonly kind: "invalid"; readonly message: string };

export function ScheduledTaskDialog(props: {
  projectId: ProjectId;
  task?: ScheduledTask;
  /** Opens a new task that sends its runs into this conversation. */
  boundThreadId?: ThreadId;
  /** New tasks may move between projects; the draft is kept. */
  allowProjectChange?: boolean;
  onClose: () => void;
  onSaved: (projectId: ProjectId) => void;
}) {
  const { task } = props;
  const boundThreadId =
    task?.workspace.kind === "thread" ? task.workspace.threadId : props.boundThreadId;
  const boundThread = useStore((s) =>
    boundThreadId ? s.threads.find((t) => t.id === boundThreadId) : undefined,
  );
  const projects = useStore((s) => s.projects);
  const [draft, setDraft] = useState(() => initialDraft(task, props.boundThreadId));
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const [creationProjectId, setCreationProjectId] = useState<ProjectId>(
    task?.projectId ?? boundThread?.projectId ?? props.projectId,
  );
  const threadMode = draft.workspaceKind === "thread";
  const projectId =
    task?.projectId ?? (threadMode && boundThread ? boundThread.projectId : creationProjectId);
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const config = useQuery(serverConfigQueryOptions());
  const settings = useSettings(undefined, projectId);
  const projectSettings = useQuery(projectSettingsQueryOptions(projectId));
  const branches = useQuery(
    gitBranchesQueryOptions({ cwd: project?.cwd ?? null, autoRefresh: false }),
  );
  const providers = useMemo(() => config.data?.providers ?? [], [config.data]);
  const loading = !project || !config.data || branches.isPending || projectSettings.isPending;
  const loadError = config.error ?? projectSettings.error;

  // Schedule editor. Fixed time is the default for anything it can represent.
  const originalFixed = useMemo(
    () => (task && !task.oneShotAt ? parseFixedTimeCron(task.cron) : null),
    [task],
  );
  const [mode, setMode] = useState<"fixed" | "cron">(!task || originalFixed ? "fixed" : "cron");
  const [fixed, setFixed] = useState<FixedTimeCronDraft>(originalFixed ?? DEFAULT_FIXED);
  const [cronText, setCronText] = useState(() => {
    if (!task) return fixedTimeCron(DEFAULT_FIXED);
    try {
      return normalizeCron(task.cron);
    } catch {
      return task.cron;
    }
  });
  const [replacing, setReplacing] = useState(false);
  const cronValidation = useMemo(() => inspectCronInput(cronText), [cronText]);
  const effective = useMemo((): EffectiveSchedule => {
    if (replacing) return { kind: "invalid", message: "Choose how to replace this schedule." };
    if (mode === "cron")
      return cronValidation.error
        ? { kind: "invalid", message: cronValidation.error.message }
        : { kind: "valid", cron: cronText, normalizedCron: cronValidation.cron! };
    try {
      const generated = fixedTimeCron(fixed);
      // An unchanged time and day set keeps the task's own cron string and authority.
      const cron = task && originalFixed && sameFixed(originalFixed, fixed) ? task.cron : generated;
      return { kind: "valid", cron, normalizedCron: normalizeCron(cron) };
    } catch (error) {
      return { kind: "invalid", message: error instanceof Error ? error.message : "Invalid time." };
    }
  }, [replacing, mode, cronValidation, cronText, fixed, task, originalFixed]);
  const timezone = useMemo(() => {
    try {
      return { valid: validateTimezone(draft.timezone), error: null };
    } catch (error) {
      return {
        valid: null,
        error: error instanceof Error ? error.message : "Select a valid IANA timezone.",
      };
    }
  }, [draft.timezone]);

  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: "unpreviewed" });
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(draft.prompt.length);
  const skillListId = useId();
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const taskId = useRef(task?.id ?? ScheduledTaskId.makeUnsafe(crypto.randomUUID()));
  const requestedAt = useRef<string | null>(null);
  // The editor mode is not part of the key: equivalent expressions share one preview.
  const key =
    effective.kind === "valid" ? JSON.stringify([effective.normalizedCron, draft.timezone]) : null;
  useEffect(() => {
    if (!key) return;
    const [cron, zone] = JSON.parse(key) as [string, string];
    const refresh = () => {
      try {
        const candidate = previewCronSchedule(cron, zone);
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
  }, [key]);

  // Effective execution settings: the conversation's for thread mode, otherwise
  // explicit choices or the current project's defaults.
  const resolvedModel = useMemo(
    () =>
      project && config.data
        ? resolveNewThreadModelSelection({
            project,
            settings,
            providers,
            preferences: getModelPreferences(),
          })
        : null,
    [project, config.data, settings, providers],
  );
  const boundSource =
    task?.workspace.kind === "thread" && task.workspace.threadId === boundThreadId
      ? task
      : boundThread;
  const threadError = !threadMode
    ? null
    : !boundThreadId || (!boundThread && !task)
      ? "This conversation is no longer available."
      : !boundSource?.modelSelection
        ? "Send a message in this conversation before scheduling into it."
        : null;
  const modelSelection = threadMode
    ? (boundSource?.modelSelection ?? null)
    : (draft.modelSelection ?? resolvedModel);
  const runtimeMode = threadMode
    ? (boundSource?.runtimeMode ?? settings.defaultRuntimeMode)
    : (draft.runtimeMode ?? settings.defaultRuntimeMode);
  const interactionMode = threadMode
    ? (boundSource?.interactionMode ?? "default")
    : (draft.interactionMode ?? "default");
  const baseBranch =
    draft.baseBranch ??
    branches.data?.branches.find((b) => b.current)?.name ??
    branches.data?.branches.find((b) => b.isDefault)?.name ??
    "";
  const workspace: ScheduledWorkspace =
    threadMode && boundThreadId
      ? { kind: "thread", threadId: boundThreadId }
      : draft.workspaceKind === "worktree"
        ? { kind: "worktree", baseBranch }
        : { kind: "projectRoot" };
  const provider = providers.find((p) => p.instanceId === modelSelection?.instanceId);
  const driver = provider?.driver ?? ProviderDriverKind.make("codex");
  const options = getCustomModelOptionsByInstance(settings, providers);
  const invocation = /^\s*\/([^\s]*)$/.exec(draft.prompt.slice(0, cursor));
  const items =
    invocation && project
      ? buildSlashComposerMenuItems({
          query: invocation[1] ?? "",
          provider: isKnownProviderKind(driver) ? driver : undefined,
          projectSkills: project.skills,
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
    const next = `/${item.name} ${draft.prompt.slice(cursor)}`;
    update({ prompt: next });
    setCursor(item.name.length + 2);
  };

  const effectiveConfig: ScheduledTaskConfiguration | null =
    modelSelection && effective.kind === "valid"
      ? {
          name: draft.name,
          prompt: draft.prompt,
          modelSelection,
          runtimeMode,
          interactionMode,
          workspace,
          cron: effective.cron,
          timezone: draft.timezone,
          scheduleSource: task?.scheduleSource ?? "",
          maxRuns: draft.maxRuns,
          oneShotAt: draft.oneShotAt,
          notify: draft.notify,
          enabled: draft.enabled,
        }
      : null;
  const metadataOnly =
    !!task &&
    !!effectiveConfig &&
    effectiveConfig.cron === task.cron &&
    isMetadataOnlyScheduleEdit(task, effectiveConfig);
  const keyedPreview = preview.kind === "ready" && preview.key === key ? preview.preview : null;
  const candidate = key
    ? (confirmedSchedule(preview, key) ?? (metadataOnly ? keyedPreview : null))
    : null;
  const saveDisabled =
    saving ||
    loading ||
    !!loadError ||
    !!threadError ||
    !!timezone.error ||
    !effectiveConfig ||
    !candidate;
  const save = async () => {
    if (!effectiveConfig || effective.kind !== "valid" || !key) return;
    // Recheck at save time: a one-shot can expire while the dialog is open.
    const confirmed = confirmedSchedule(preview, key);
    if (
      metadataOnly ? !keyedPreview : !confirmed || confirmed.cron !== normalizeCron(effective.cron)
    ) {
      setError("The schedule is updating or has expired. Check its next run times.");
      return;
    }
    const configuration: ScheduledTaskConfiguration =
      task && metadataOnly
        ? {
            ...effectiveConfig,
            cron: task.cron,
            timezone: task.timezone,
            scheduleSource: task.scheduleSource,
            oneShotAt: task.oneShotAt,
            maxRuns: task.maxRuns,
          }
        : {
            ...effectiveConfig,
            cron: confirmed!.cron,
            timezone: confirmed!.timezone,
            scheduleSource: confirmed!.cron,
            oneShotAt: confirmed!.oneShotAt,
            maxRuns: confirmed!.oneShotAt ? 1 : draft.maxRuns,
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
      const result = task
        ? await api.update({ id: task.id, expectedVersion: task.version, configuration })
        : await api.create({
            id: taskId.current,
            projectId,
            requestedAt: (requestedAt.current ??= new Date(Date.now()).toISOString()),
            configuration,
          });
      for (const warning of result.warnings) toastManager.add({ type: "warning", title: warning });
      props.onSaved(projectId);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const oneShotDraft = cronText.trim().split(/\s+/).length === 7 || draft.oneShotAt !== null;
  const changeFormat = (next: "fixed" | "cron") => {
    setReplacing(false);
    if (next === "cron") {
      if (effective.kind !== "valid") return;
      setCronText(effective.normalizedCron);
      setMode("cron");
      return;
    }
    const parsed = parseFixedTimeCron(cronText);
    if (parsed && !oneShotDraft) {
      setFixed(parsed);
      setMode("fixed");
    } else setReplacing(true);
  };
  const acceptReplacement = () => {
    setFixed(DEFAULT_FIXED);
    setMode("fixed");
    setReplacing(false);
    if (oneShotDraft) update({ oneShotAt: null, maxRuns: null });
  };
  const shownPreview = preview.kind === "ready" ? preview : null;
  const previewCurrent = shownPreview?.key === key;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="h-[min(48rem,calc(100dvh-4rem))] max-w-2xl [-webkit-app-region:no-drag]">
        <DialogHeader className="shrink-0">
          <DialogTitle>{task ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
          <DialogDescription>
            Runs on this F5 server while it is running.
            {project ? ` Project: ${project.name}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            <label className="block">
              Name
              <Input
                aria-label="Task name"
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </label>
            {props.allowProjectChange && !task && !threadMode && (
              <label className="block">
                Project
                <NativeSelect
                  aria-label="Project"
                  value={projectId}
                  onChange={(e) => setCreationProjectId(e.target.value as ProjectId)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            <div>
              <p>Prompt</p>
              <ComposerPromptEditor
                value={draft.prompt}
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
            {loading && !loadError && <p role="status">Loading execution settings…</p>}
            {loadError && (
              <p role="alert">Unable to load this project's settings. {loadError.message}</p>
            )}
            {threadMode ? (
              <p className="text-sm text-muted-foreground">
                Runs are sent to this conversation when it is idle and use its current model, mode
                and access.
              </p>
            ) : (
              !loading &&
              modelSelection && (
                <div className="flex flex-wrap items-center gap-2">
                  <ProviderInstanceModelPicker
                    instanceId={modelSelection.instanceId}
                    model={modelSelection.model as ModelSlug}
                    lockedInstanceId={null}
                    providers={providers}
                    modelOptionsByInstance={options}
                    onInstanceModelChange={(instanceId, driver, model) =>
                      update({
                        modelSelection: pickedModelSelection(providers, instanceId, driver, model),
                      })
                    }
                  />
                  <TraitsPicker
                    provider={driver}
                    model={modelSelection.model}
                    models={provider?.models ?? []}
                    modelOptions={modelSelection.options}
                    onModelOptionsChange={(options) =>
                      update({
                        modelSelection: createModelSelection(
                          modelSelection.instanceId,
                          modelSelection.model,
                          options,
                        ),
                      })
                    }
                  />
                  {isKnownProviderKind(driver) && (
                    <RuntimeModePicker
                      provider={driver}
                      value={runtimeMode}
                      onValueChange={(runtimeMode) => update({ runtimeMode })}
                    />
                  )}
                  <NativeSelect
                    aria-label="Interaction mode"
                    value={interactionMode}
                    onChange={(e) =>
                      update({ interactionMode: e.target.value as ProviderInteractionMode })
                    }
                  >
                    <option value="default">Default</option>
                    <option value="plan">Plan</option>
                  </NativeSelect>
                </div>
              )
            )}
            {threadError && <p role="alert">{threadError}</p>}
            <label className="block">
              Workspace
              <NativeSelect
                aria-label="Workspace"
                value={draft.workspaceKind}
                onChange={(e) =>
                  update({ workspaceKind: e.target.value as ScheduledWorkspace["kind"] })
                }
              >
                <option value="projectRoot">Project root (shared filesystem)</option>
                <option value="worktree">New worktree for every run</option>
                {boundThreadId && (
                  <option value="thread">
                    {boundThread ? `Conversation: ${boundThread.title}` : "This conversation"}
                  </option>
                )}
              </NativeSelect>
            </label>
            {draft.workspaceKind === "worktree" && (
              <label className="block">
                Base branch
                <Input
                  list="schedule-branches"
                  aria-label="Base branch"
                  value={baseBranch}
                  onChange={(e) => update({ baseBranch: e.target.value })}
                />
                <datalist id="schedule-branches">
                  {branches.data?.branches.map((b) => (
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
                value={draft.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
              />
            </label>
            {timezone.error && <p role="alert">{timezone.error}</p>}
            <label className="block">
              Notify
              <NativeSelect
                aria-label="Notification policy"
                value={draft.notify}
                onChange={(e) => update({ notify: e.target.value as Draft["notify"] })}
              >
                <option value="all">Every outcome</option>
                <option value="failures_and_attention">Failures and attention</option>
                <option value="none">None</option>
              </NativeSelect>
            </label>
            <label className="block">
              Schedule format
              <NativeSelect
                value={replacing ? "fixed" : mode}
                onChange={(e) => changeFormat(e.target.value as "fixed" | "cron")}
              >
                <option value="fixed">Fixed time</option>
                <option value="cron" disabled={mode === "fixed" && effective.kind !== "valid"}>
                  Cron
                </option>
              </NativeSelect>
            </label>
            {replacing ? (
              <div
                role="group"
                aria-label="Replace schedule"
                className="space-y-2 rounded-md border p-3"
              >
                <p className="text-sm">
                  {oneShotDraft
                    ? "This one-time schedule cannot be shown as a fixed time. Replacing it makes the task recurring, daily at 09:00."
                    : "This cron expression cannot be shown as a fixed time. Replacing it sets the schedule to daily at 09:00."}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={acceptReplacement}>
                    Replace with daily at 09:00
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : mode === "fixed" ? (
              <div className="space-y-2">
                <label className="block">
                  {timezone.valid ? `Time (${timezone.valid})` : "Time"}
                  <Input
                    type="time"
                    step={60}
                    value={fixed.timeOfDay}
                    aria-invalid={effective.kind === "invalid" || undefined}
                    onChange={(e) => setFixed((f) => ({ ...f, timeOfDay: e.target.value }))}
                  />
                </label>
                <ToggleGroup
                  multiple
                  variant="outline"
                  size="sm"
                  aria-label="Days"
                  value={fixed.weekdays.map(String)}
                  onValueChange={(value) => {
                    // The last selected day stays selected.
                    if (!value.length) return;
                    setFixed((f) => ({ ...f, weekdays: value.map(Number) }));
                  }}
                >
                  {WEEKDAYS.map(([day, short, long]) => (
                    <ToggleGroupItem key={day} value={String(day)} aria-label={long}>
                      {short}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {effective.kind === "invalid" && <p role="alert">{effective.message}</p>}
              </div>
            ) : (
              <CronScheduleEditor
                value={cronText}
                onChange={setCronText}
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
              {preview.kind === "error" &&
                preview.key === key &&
                mode === "cron" &&
                !cronValidation.error &&
                !timezone.error && <p role="alert">{preview.message}</p>}
              {/* A stale calculation keeps the layout stable but is never shown as current. */}
              {shownPreview && (
                <div
                  className={previewCurrent ? "space-y-2" : "invisible space-y-2"}
                  aria-hidden={!previewCurrent}
                >
                  <p className="text-lg font-medium">{shownPreview.preview.summary}</p>
                  {shownPreview.preview.nextFireTimes[0] ? (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                        <span className="underline underline-offset-4">Next</span>{" "}
                        <time dateTime={shownPreview.preview.nextFireTimes[0]}>
                          {new Date(shownPreview.preview.nextFireTimes[0]).toLocaleString(
                            undefined,
                            { timeZone: shownPreview.preview.timezone, timeZoneName: "short" },
                          )}
                        </time>
                      </summary>
                      <ol aria-label="Next runs" className="mt-2 space-y-1">
                        {shownPreview.preview.nextFireTimes.map((time) => (
                          <li key={time}>
                            {new Date(time).toLocaleString(undefined, {
                              timeZone: shownPreview.preview.timezone,
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
                  {shownPreview.preview.oneShotAt && (
                    <p className="text-xs text-muted-foreground">
                      Runs once, then disables itself.
                    </p>
                  )}
                </div>
              )}
            </div>
            {error && <p role="alert">{error}</p>}
          </fieldset>
        </DialogPanel>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={saveDisabled} onClick={() => void save()}>
            {saving ? "Saving…" : "Save task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
