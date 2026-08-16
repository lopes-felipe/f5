import { buildAppSettingsPatch } from "../../../appSettings";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";

export { GENERAL_SETTINGS_DESCRIPTORS } from "./GeneralSettings.descriptors";

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const THREAD_KEYS = ["defaultThreadEnvMode", "tasksPanelAutoOpen"] as const;
const SAFETY_KEYS = ["confirmThreadDelete"] as const;

export function GeneralSettings() {
  const { settings, defaults, updateSettings } = useSettingsRouteContext();

  return (
    <>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Time & locale</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose how dates and times appear across the app.
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Timestamp format</p>
              <p className="text-xs text-muted-foreground">
                System default follows your browser or OS time format. <code>12-hour</code> and{" "}
                <code>24-hour</code> force the hour cycle.
              </p>
            </div>
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value !== "locale" && value !== "12-hour" && value !== "24-hour") {
                  return;
                }
                updateSettings({
                  timestampFormat: value,
                });
              }}
            >
              <SelectTrigger className="w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="locale">{TIMESTAMP_FORMAT_LABELS.locale}</SelectItem>
                <SelectItem value="12-hour">{TIMESTAMP_FORMAT_LABELS["12-hour"]}</SelectItem>
                <SelectItem value="24-hour">{TIMESTAMP_FORMAT_LABELS["24-hour"]}</SelectItem>
              </SelectPopup>
            </Select>
          </div>

          {settings.timestampFormat !== defaults.timestampFormat ? (
            <div className="flex justify-end">
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  updateSettings(
                    buildAppSettingsPatch(["timestampFormat"], {
                      timestampFormat: defaults.timestampFormat,
                    }),
                  )
                }
              >
                Restore default
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Threads</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose the default workspace mode for newly created draft threads.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Default to New worktree</p>
              <p className="text-xs text-muted-foreground">
                New threads start in New worktree mode instead of Local.
              </p>
            </div>
            <Switch
              checked={settings.defaultThreadEnvMode === "worktree"}
              onCheckedChange={(checked) =>
                updateSettings({
                  defaultThreadEnvMode: checked ? "worktree" : "local",
                })
              }
              aria-label="Default new threads to New worktree mode"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Open task sidebar automatically</p>
              <p className="text-xs text-muted-foreground">
                Show task and plan sidebars automatically when a thread starts tracking steps.
              </p>
            </div>
            <Switch
              checked={settings.tasksPanelAutoOpen}
              onCheckedChange={(checked) =>
                updateSettings({
                  tasksPanelAutoOpen: Boolean(checked),
                })
              }
              aria-label="Open task sidebar automatically"
            />
          </div>
        </div>

        {settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ||
        settings.tasksPanelAutoOpen !== defaults.tasksPanelAutoOpen ? (
          <div className="mt-3 flex justify-end">
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(THREAD_KEYS, defaults))}
            >
              Restore default
            </Button>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Safety</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Additional guardrails for destructive local actions.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
          <div>
            <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
            <p className="text-xs text-muted-foreground">
              Ask for confirmation before deleting a thread and its chat history.
            </p>
          </div>
          <Switch
            checked={settings.confirmThreadDelete}
            onCheckedChange={(checked) =>
              updateSettings({
                confirmThreadDelete: Boolean(checked),
              })
            }
            aria-label="Confirm thread deletion"
          />
        </div>

        {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
          <div className="mt-3 flex justify-end">
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(SAFETY_KEYS, defaults))}
            >
              Restore default
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}
