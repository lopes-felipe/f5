import type { ProjectId, ServerProvider, UpstreamOverview, UpstreamPortsSettings } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";

import { projectSettingsQueryOptions, PROJECT_SETTINGS_QUERY_KEY } from "../../lib/projectSettingsQuery";
import { invalidateUpstreamPorts } from "../../lib/upstreamPortsReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { modelOptions, selectionKey } from "./UpstreamDialogs";
import { upstreamSettingsOverrides } from "./upstreamPage.logic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const selectClassName = "w-full rounded border bg-background p-1.5 text-sm";

/** Triage runs without tools or a workspace; only Claude instances guarantee that today. */
export const isTriageCapable = (provider: ServerProvider) => provider.driver === "claudeAgent";

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
  return (
    <Popover>
      <PopoverTrigger render={<Button size="sm" variant="ghost" aria-label="Upstream settings" />}>
        <SettingsIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup className="w-80 space-y-3 text-sm">
        {projectSettings.isError && (
          <p className="text-xs text-destructive">
            Could not load this project's settings.{" "}
            <button type="button" className="underline" onClick={() => void projectSettings.refetch()}>
              Retry
            </button>
          </p>
        )}
        <label className="block space-y-1">
          <span className="font-medium">Schedule</span>
          <select
            aria-label="Schedule"
            className={selectClassName}
            disabled={disabled}
            value={current.schedule.mode}
            onChange={(e) =>
              void save({ schedule: { ...current.schedule, mode: e.target.value as UpstreamPortsSettings["schedule"]["mode"] } })
            }
          >
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        {current.schedule.mode !== "off" && (
          <div className="flex gap-2">
            {current.schedule.mode === "weekly" && (
              <select
                aria-label="Weekday"
                className={selectClassName}
                disabled={disabled}
                value={current.schedule.weekday}
                onChange={(e) => void save({ schedule: { ...current.schedule, weekday: Number(e.target.value) } })}
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="Hour"
              className={selectClassName}
              disabled={disabled}
              value={current.schedule.hour}
              onChange={(e) => void save({ schedule: { ...current.schedule, hour: Number(e.target.value) } })}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="block space-y-1">
          <span className="font-medium">Triage model</span>
          <select
            aria-label="Triage model"
            className={selectClassName}
            disabled={disabled}
            value={selectionKey(current.triageModelSelection)}
            onChange={(e) =>
              void save({
                triageModelSelection: triageModels.find((option) => option.key === e.target.value)?.selection ?? null,
              })
            }
          >
            <option value="">Automatic (first Claude instance)</option>
            {triageModels.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="block text-xs text-muted-foreground">
            Triage runs with no tools and no repository access, which only Claude guarantees.
          </span>
        </label>
        <label className="block space-y-1">
          <span className="font-medium">Port model</span>
          <select
            aria-label="Port model default"
            className={selectClassName}
            disabled={disabled}
            value={selectionKey(current.portModelSelection)}
            onChange={(e) =>
              void save({
                portModelSelection: portModels.find((option) => option.key === e.target.value)?.selection ?? null,
              })
            }
          >
            <option value="">Ask each time</option>
            {portModels.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          Automatic skips need confidence of at least {props.overview.autoSkipConfidence.toFixed(2)} (set in{" "}
          <code>upstream/rules.json</code>).
        </p>
      </PopoverPopup>
    </Popover>
  );
}
