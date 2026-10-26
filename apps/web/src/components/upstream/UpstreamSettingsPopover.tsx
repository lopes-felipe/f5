import type { ProjectId, ServerProvider, UpstreamOverview, UpstreamPortsSettings } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { projectSettingsQueryOptions, PROJECT_SETTINGS_QUERY_KEY } from "../../lib/projectSettingsQuery";
import { invalidateUpstreamPorts } from "../../lib/upstreamPortsReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { modelOptions, selectionKey } from "./UpstreamDialogs";
import { upstreamSettingsOverrides } from "./upstreamPage.logic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SCHEDULE_LABELS: Record<UpstreamPortsSettings["schedule"]["mode"], string> = {
  off: "Off",
  daily: "Daily",
  weekly: "Weekly",
};
const formatHour = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

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

export function UpstreamSettingsPopover(props: {
  readonly projectId: ProjectId;
  readonly overview: UpstreamOverview;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const projectSettings = useQuery(projectSettingsQueryOptions(props.projectId));
  const [saving, setSaving] = useState(false);
  const loaded = projectSettings.data;
  // Shown while loading only; saving waits for the real settings so it never writes these defaults.
  const current: UpstreamPortsSettings = loaded?.settings.upstreamPorts ?? {
    schedule: props.overview.schedule,
    triageModelSelection: null,
    portModelSelection: null,
  };
  const triageModels = modelOptions(props.providers, isTriageCapable);
  const portModels = modelOptions(props.providers);
  const save = async (patch: Partial<UpstreamPortsSettings>) => {
    if (!loaded) return;
    setSaving(true);
    try {
      await ensureNativeApi().server.updateSettings({
        projectSettingsOverrides: {
          [props.projectId]: upstreamSettingsOverrides(loaded.overrides, current, patch),
        },
      });
      await queryClient.invalidateQueries({ queryKey: PROJECT_SETTINGS_QUERY_KEY });
      await invalidateUpstreamPorts(queryClient);
    } catch (error) {
      toastManager.add({ type: "error", title: "Could not save upstream settings", description: String(error) });
    } finally {
      setSaving(false);
    }
  };
  const disabled = saving || props.readOnly || !loaded;
  const triageKey = selectionKey(current.triageModelSelection);
  const portKey = selectionKey(current.portModelSelection);
  return (
    <Popover>
      <PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Upstream settings" />}>
        <SettingsIcon />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80 space-y-3 text-sm">
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
              void save({ schedule: { ...current.schedule, mode: mode as UpstreamPortsSettings["schedule"]["mode"] } })
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
              options={Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: formatHour(hour) }))}
              onChange={(hour) => void save({ schedule: { ...current.schedule, hour: Number(hour) } })}
            />
          </div>
        )}
        <div className="space-y-1">
          <span className="font-medium">Triage model</span>
          <SettingSelect
            label="Triage model"
            value={triageKey}
            display={triageModels.find((option) => option.key === triageKey)?.label ?? "Automatic (first Claude instance)"}
            disabled={disabled}
            options={[
              { value: "", label: "Automatic (first Claude instance)" },
              ...triageModels.map((option) => ({ value: option.key, label: option.label })),
            ]}
            onChange={(key) =>
              void save({ triageModelSelection: triageModels.find((option) => option.key === key)?.selection ?? null })
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
            display={portModels.find((option) => option.key === portKey)?.label ?? "Ask each time"}
            disabled={disabled}
            options={[
              { value: "", label: "Ask each time" },
              ...portModels.map((option) => ({ value: option.key, label: option.label })),
            ]}
            onChange={(key) =>
              void save({ portModelSelection: portModels.find((option) => option.key === key)?.selection ?? null })
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Automatic skips need confidence of at least {Math.round(props.overview.autoSkipConfidence * 100)}% (set in{" "}
          <code>upstream/rules.json</code>).
        </p>
      </PopoverPopup>
    </Popover>
  );
}
