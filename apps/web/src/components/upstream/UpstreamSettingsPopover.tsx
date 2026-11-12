import {
  UPSTREAM_EXPIRE_AFTER_DAYS_OPTIONS,
  type ProjectId,
  type ServerProvider,
  type UpstreamAreaPolicy,
  type UpstreamAutoPortMode,
  type UpstreamOverview,
  type UpstreamPortsSettings,
} from "@t3tools/contracts";
import { SettingsIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { modelOptions, selectionKey } from "./UpstreamDialogs";
import { useSaveUpstreamSettings } from "./useSaveUpstreamSettings";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SCHEDULE_LABELS: Record<UpstreamPortsSettings["schedule"]["mode"], string> = {
  off: "Off",
  daily: "Daily",
  weekly: "Weekly",
};
const formatHour = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const SHORTLIST_SIZES = [5, 10, 15, 20, 30, 50];
const KEEP_SCORES = [50, 60, 70, 80, 90, 100];
const AUTO_PORT_LABELS: Record<UpstreamAutoPortMode, string> = {
  off: "Off",
  security: "Security fixes",
  "security-and-bugs": "Security + high-impact bugs",
};
const AREA_POLICY_LABELS: Record<UpstreamAreaPolicy, string> = {
  follow: "Follow",
  "fixes-only": "Fixes only",
  ignore: "Ignore",
};
const expireLabel = (days: number | null) => (days === null ? "Never" : `${days} days`);
/** Keeps a saved value listed even when it is not one of the presets. */
const withCurrent = (presets: ReadonlyArray<number>, value: number) =>
  presets.includes(value) ? presets : [...presets, value].toSorted((a, b) => a - b);
/** `fixes-only` is the default, so it is dropped from the map instead of stored. */
export function withAreaPolicy(
  policy: Readonly<Record<string, UpstreamAreaPolicy>>,
  area: string,
  value: string,
): Record<string, UpstreamAreaPolicy> {
  const { [area]: _previous, ...rest } = policy;
  return value === "follow" || value === "ignore" ? { ...rest, [area]: value } : rest;
}

/** Triage runs without tools or a workspace; only Claude instances guarantee that today. */
export const isTriageCapable = (provider: ServerProvider) => provider.driver === "claudeAgent";

/** A labelled Select over string values; `""` is a real option (Automatic, Ask each time). */
function SettingSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly display: ReactNode;
  readonly disabled: boolean;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null && value !== props.value) props.onChange(value);
      }}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue>{props.display}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Options for a model setting. A saved selection the providers no longer offer
 * stays listed as unavailable rather than reading as the empty default.
 */
function modelSettingOptions(models: ReturnType<typeof modelOptions>, key: string, emptyLabel: string) {
  const options = [
    { value: "", label: emptyLabel },
    ...models.map((option) => ({ value: option.key, label: option.label })),
  ];
  if (key && !models.some((option) => option.key === key)) {
    options.push({ value: key, label: `${key.replace("::", " · ")} (unavailable)` });
  }
  return { options, display: options.find((option) => option.value === key)?.label ?? emptyLabel };
}

export function UpstreamSettingsPopover(props: {
  readonly projectId: ProjectId;
  readonly overview: UpstreamOverview;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const { projectSettings, saving, save: saveSettings } = useSaveUpstreamSettings(props.projectId);
  const loaded = projectSettings.data;
  // Shown while loading only; saving waits for the real settings so it never writes these defaults.
  const current: UpstreamPortsSettings = loaded?.settings.upstreamPorts ?? {
    portConcurrency: 5,
    autoRecordOutcomes: true,
    schedule: props.overview.schedule,
    triageModelSelection: null,
    portModelSelection: null,
    portReview: { enabled: true, reviewerA: null, reviewerB: null, consolidation: null },
    budget: { shortlistSize: 15, expireAfterDays: null, keepScore: 70 },
    areaPolicy: {},
    autoPort: { mode: "off", dailyLimit: 5 },
  };
  const triageModels = modelOptions(props.providers, isTriageCapable);
  const portModels = modelOptions(props.providers);
  const save = async (patch: Partial<UpstreamPortsSettings>) => {
    try {
      await saveSettings(patch);
    } catch (error) {
      toastManager.add({ type: "error", title: "Could not save upstream settings", description: String(error) });
    }
  };
  const disabled = saving || props.readOnly || !loaded;
  const triageKey = selectionKey(current.triageModelSelection);
  const portKey = selectionKey(current.portModelSelection);
  const triageSetting = modelSettingOptions(triageModels, triageKey, "Automatic (first Claude instance)");
  const portSetting = modelSettingOptions(portModels, portKey, "Ask each time");
  return (
    <Popover>
      <PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Upstream settings" />}>
        <SettingsIcon />
      </PopoverTrigger>
      <PopoverPopup align="end" className="max-h-[80vh] w-80 space-y-3 overflow-y-auto text-sm">
        {projectSettings.isError && (
          <p className="text-xs text-destructive">
            Could not load this project's settings.{" "}
            <button type="button" className="underline" onClick={() => void projectSettings.refetch()}>
              Retry
            </button>
          </p>
        )}
        <div className="space-y-1">
          <span className="font-medium">Schedule</span>
          <SettingSelect
            label="Schedule"
            value={current.schedule.mode}
            display={SCHEDULE_LABELS[current.schedule.mode]}
            disabled={disabled}
            options={Object.entries(SCHEDULE_LABELS).map(([value, label]) => ({ value, label }))}
            onChange={(mode) =>
              void save({
                schedule: {
                  ...current.schedule,
                  mode: mode as UpstreamPortsSettings["schedule"]["mode"],
                },
              })
            }
          />
        </div>
        {current.schedule.mode !== "off" && (
          <div className="flex gap-2">
            {current.schedule.mode === "weekly" && (
              <SettingSelect
                label="Weekday"
                value={String(current.schedule.weekday)}
                display={WEEKDAYS[current.schedule.weekday]}
                disabled={disabled}
                options={WEEKDAYS.map((day, index) => ({ value: String(index), label: day }))}
                onChange={(weekday) => void save({ schedule: { ...current.schedule, weekday: Number(weekday) } })}
              />
            )}
            <SettingSelect
              label="Hour"
              value={String(current.schedule.hour)}
              display={formatHour(current.schedule.hour)}
              disabled={disabled}
              options={Array.from({ length: 24 }, (_, hour) => ({
                value: String(hour),
                label: formatHour(hour),
              }))}
              onChange={(hour) => void save({ schedule: { ...current.schedule, hour: Number(hour) } })}
            />
          </div>
        )}
        <div className="space-y-1">
          <span className="font-medium">Triage model</span>
          <SettingSelect
            label="Triage model"
            value={triageKey}
            display={triageSetting.display}
            disabled={disabled}
            options={triageSetting.options}
            onChange={(key) =>
              void save({
                triageModelSelection: triageModels.find((option) => option.key === key)?.selection ?? null,
              })
            }
          />
          <span className="block text-xs text-muted-foreground">
            Triage runs with no tools and no repository access, which only Claude guarantees.
          </span>
        </div>
        <div className="space-y-1">
          <span className="font-medium">Port model</span>
          <SettingSelect
            label="Port model default"
            value={portKey}
            display={portSetting.display}
            disabled={disabled}
            options={portSetting.options}
            onChange={(key) =>
              void save({
                portModelSelection: portModels.find((option) => option.key === key)?.selection ?? null,
              })
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Automatic skips need confidence of at least {Math.round(props.overview.autoSkipConfidence * 100)}% (set in{" "}
          <code>upstream/rules.json</code>).
        </p>
        <SettingSelect
          label="Port threads at once"
          value={String(current.portConcurrency)}
          display={String(current.portConcurrency)}
          disabled={disabled}
          options={Array.from({ length: 10 }, (_, i) => ({
            value: String(i + 1),
            label: String(i + 1),
          }))}
          onChange={(value) => void save({ portConcurrency: Number(value) })}
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            role="switch"
            checked={current.autoRecordOutcomes}
            disabled={disabled}
            onChange={(event) => void save({ autoRecordOutcomes: event.target.checked })}
          />
          Record equivalent / not-applicable outcomes automatically
        </label>
        <div className="space-y-1 border-t pt-3">
          <span className="font-medium">Budget</span>
          <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5">
            <span className="text-muted-foreground">Shortlist size</span>
            <SettingSelect
              label="Shortlist size"
              value={String(current.budget.shortlistSize)}
              display={String(current.budget.shortlistSize)}
              disabled={disabled}
              options={withCurrent(SHORTLIST_SIZES, current.budget.shortlistSize).map((size) => ({
                value: String(size),
                label: String(size),
              }))}
              onChange={(size) => void save({ budget: { ...current.budget, shortlistSize: Number(size) } })}
            />
            <span className="text-muted-foreground">Expire after</span>
            <SettingSelect
              label="Expire after"
              value={String(current.budget.expireAfterDays ?? "")}
              display={expireLabel(current.budget.expireAfterDays)}
              disabled={disabled}
              options={[
                { value: "", label: expireLabel(null) },
                ...UPSTREAM_EXPIRE_AFTER_DAYS_OPTIONS.map((days) => ({ value: String(days), label: expireLabel(days) })),
              ]}
              onChange={(value) =>
                void save({
                  budget: {
                    ...current.budget,
                    expireAfterDays:
                      UPSTREAM_EXPIRE_AFTER_DAYS_OPTIONS.find((days) => String(days) === value) ?? null,
                  },
                })
              }
            />
            <span className="text-muted-foreground">Keep longer from score</span>
            <SettingSelect
              label="Keep longer from score"
              value={String(current.budget.keepScore)}
              display={String(current.budget.keepScore)}
              disabled={disabled}
              options={withCurrent(KEEP_SCORES, current.budget.keepScore).map((score) => ({
                value: String(score),
                label: String(score),
              }))}
              onChange={(score) => void save({ budget: { ...current.budget, keepScore: Number(score) } })}
            />
          </div>
          <span className="block text-xs text-muted-foreground">
            Unreviewed Inbox topics move to Skipped as "Expired unreviewed" after this long, or twice as long from the
            keep score. Security topics never expire.
          </span>
        </div>
        <div className="space-y-1 border-t pt-3">
          <span className="font-medium">Auto-port</span>
          <div className="flex gap-2">
            <SettingSelect
              label="Auto-port"
              value={current.autoPort.mode}
              display={AUTO_PORT_LABELS[current.autoPort.mode]}
              disabled={disabled}
              options={Object.entries(AUTO_PORT_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={(mode) =>
                void save({ autoPort: { ...current.autoPort, mode: mode as UpstreamAutoPortMode } })
              }
            />
            {current.autoPort.mode !== "off" && (
              <SettingSelect
                label="Auto-ports per day"
                value={String(current.autoPort.dailyLimit)}
                display={`${current.autoPort.dailyLimit} a day`}
                disabled={disabled}
                options={Array.from({ length: 20 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} a day` }))}
                onChange={(limit) => void save({ autoPort: { ...current.autoPort, dailyLimit: Number(limit) } })}
              />
            )}
          </div>
          <span className="block text-xs text-muted-foreground">
            {current.autoPort.mode !== "off" && !current.portModelSelection
              ? "Choose a port model above; auto-port waits for one."
              : "Queues confident high/critical security fixes (and high-impact bug fixes in code f5 has) after each run. PRs still need your merge."}
          </span>
        </div>
        {props.overview.areas.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <span className="font-medium">Areas</span>
            <span className="block text-xs text-muted-foreground">
              Followed areas put features on the shortlist. Others reach the weekly feature digest; ignored areas
              skip their features.
            </span>
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
              {props.overview.areas.map((area) => {
                const policy = current.areaPolicy[area.key] ?? "fixes-only";
                return (
                  <Fragment key={area.key}>
                    <span className="truncate">{area.label}</span>
                    <SettingSelect
                      label={`${area.label} features`}
                      value={policy}
                      display={AREA_POLICY_LABELS[policy]}
                      disabled={disabled}
                      options={Object.entries(AREA_POLICY_LABELS).map(([value, label]) => ({ value, label }))}
                      onChange={(value) => void save({ areaPolicy: withAreaPolicy(current.areaPolicy, area.key, value) })}
                    />
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
