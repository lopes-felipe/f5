import { buildAppSettingsPatch } from "../../../appSettings";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const THREAD_KEYS = ["defaultThreadEnvMode", "tasksPanelAutoOpen"] as const;
const SAFETY_KEYS = ["confirmThreadDelete"] as const;

export function GeneralSettings() {
  const { theme, setTheme, resolvedTheme, settings, defaults, updateSettings } =
    useSettingsRouteContext();

  return (
    <>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Appearance</h2>
          <p className="mt-1 text-xs text-muted-foreground">Choose how F5 looks across the app.</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
            {THEME_OPTIONS.map((option) => {
              const selected = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? "border-primary/60 bg-primary/8 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-accent"
                  }`}
                  onClick={() => setTheme(option.value)}
                >
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{option.label}</span>
                    <span className="text-xs">{option.description}</span>
                  </span>
                  {selected ? (
                    <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                      Selected
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <p className="text-xs text-muted-foreground">
            Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
          </p>

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
