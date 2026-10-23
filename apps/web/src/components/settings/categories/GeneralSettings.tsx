import { DiagnosticsSettings } from "../DiagnosticsSettings";
import {
  SIDEBAR_THREAD_PREVIEW_COUNT_MAX,
  SIDEBAR_THREAD_PREVIEW_COUNT_MIN,
  WORKSPACE_FILE_TREE_ENTRY_LIMIT_MAX,
  WORKSPACE_FILE_TREE_ENTRY_LIMIT_MIN,
  WORKSPACE_FILE_TREE_ENTRY_LIMIT_OPTIONS,
  buildAppSettingsPatch,
} from "../../../appSettings";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { SettingsCard, SettingsRow } from "../SettingsCard";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";

export { GENERAL_SETTINGS_DESCRIPTORS } from "./GeneralSettings.descriptors";

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const WINDOW_TITLE_DETAIL_LABELS = {
  project: "Project name",
  thread: "Thread title",
} as const;

const SIDEBAR_THREAD_PREVIEW_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15] as const;

const SIDEBAR_AND_PANEL_KEYS = [
  "sidebarThreadPreviewCount",
  "tasksPanelAutoOpen",
  "workspaceFileTreeEntryLimit",
  "openFileLinksInPanel",
] as const;
const TIME_AND_TITLE_KEYS = ["timestampFormat", "windowTitleDetail"] as const;
const SAFETY_KEYS = ["confirmThreadDelete"] as const;

export function GeneralSettings() {
  const { settings, defaults, updateSettings } = useSettingsRouteContext();

  return (
    <>
      <SettingsCard
        title="Sidebar & panels"
        description="What the sidebar and side panels show and when they open."
        actions={
          SIDEBAR_AND_PANEL_KEYS.some((key) => settings[key] !== defaults[key]) ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                updateSettings(buildAppSettingsPatch(SIDEBAR_AND_PANEL_KEYS, defaults))
              }
            >
              Restore defaults
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title="Sidebar thread preview count"
          description='How many threads to show before "Show more" collapses the rest.'
          control={
            <Select
              value={String(settings.sidebarThreadPreviewCount)}
              onValueChange={(value) => {
                if (value === null) return;
                const next = Number.parseInt(value, 10);
                if (
                  Number.isFinite(next) &&
                  next >= SIDEBAR_THREAD_PREVIEW_COUNT_MIN &&
                  next <= SIDEBAR_THREAD_PREVIEW_COUNT_MAX
                ) {
                  updateSettings({ sidebarThreadPreviewCount: next });
                }
              }}
            >
              <SelectTrigger className="w-24" aria-label="Sidebar thread preview count">
                <SelectValue>{settings.sidebarThreadPreviewCount}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {SIDEBAR_THREAD_PREVIEW_COUNT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Open task sidebar automatically"
          description="Show task and plan sidebars automatically when a thread starts tracking steps."
          control={
            <Switch
              checked={settings.tasksPanelAutoOpen}
              onCheckedChange={(checked) =>
                updateSettings({ tasksPanelAutoOpen: Boolean(checked) })
              }
              aria-label="Open task sidebar automatically"
            />
          }
        />
        <SettingsRow
          title="File tree entry limit"
          description="Maximum entries loaded for the Files panel tree. Search still uses backend ranking."
          control={
            <Select
              value={String(settings.workspaceFileTreeEntryLimit)}
              onValueChange={(value) => {
                if (value === null) return;
                const next = Number.parseInt(value, 10);
                if (
                  Number.isFinite(next) &&
                  next >= WORKSPACE_FILE_TREE_ENTRY_LIMIT_MIN &&
                  next <= WORKSPACE_FILE_TREE_ENTRY_LIMIT_MAX
                ) {
                  updateSettings({ workspaceFileTreeEntryLimit: next });
                }
              }}
            >
              <SelectTrigger className="w-28" aria-label="File tree entry limit">
                <SelectValue>{settings.workspaceFileTreeEntryLimit.toLocaleString()}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {WORKSPACE_FILE_TREE_ENTRY_LIMIT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option.toLocaleString()}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Open file links in code panel"
          description="Open clicked file links in the side panel instead of the external editor."
          control={
            <Switch
              checked={settings.openFileLinksInPanel}
              onCheckedChange={(checked) =>
                updateSettings({ openFileLinksInPanel: Boolean(checked) })
              }
              aria-label="Open file links in code panel"
            />
          }
        />
      </SettingsCard>

      <SettingsCard
        title="Time & titles"
        description="Choose how times and window titles appear across the app."
        actions={
          TIME_AND_TITLE_KEYS.some((key) => settings[key] !== defaults[key]) ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(TIME_AND_TITLE_KEYS, defaults))}
            >
              Restore defaults
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title="Timestamp format"
          description={
            <>
              System default follows your browser or OS time format. <code>12-hour</code> and{" "}
              <code>24-hour</code> force the hour cycle.
            </>
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value !== "locale" && value !== "12-hour" && value !== "24-hour") return;
                updateSettings({ timestampFormat: value });
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
          }
        />
        <SettingsRow
          title="Window title"
          description="What window and tab titles show for threads and workflows. Thread titles can appear in screen shares and window switchers."
          control={
            <Select
              value={settings.windowTitleDetail}
              onValueChange={(value) => {
                if (value !== "project" && value !== "thread") return;
                updateSettings({ windowTitleDetail: value });
              }}
            >
              <SelectTrigger className="w-40" aria-label="Window title">
                <SelectValue>{WINDOW_TITLE_DETAIL_LABELS[settings.windowTitleDetail]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="project">{WINDOW_TITLE_DETAIL_LABELS.project}</SelectItem>
                <SelectItem value="thread">{WINDOW_TITLE_DETAIL_LABELS.thread}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsCard>

      {typeof window !== "undefined" && window.desktopBridge && (
        <SettingsCard title="Desktop">
          <SettingsRow
            title="Quit shortcut"
            description="How the quit shortcut confirms before closing the app."
            control={
              <Select
                value={settings.quitShortcutMode}
                onValueChange={(value) => {
                  if (value === "hold" || value === "double-click" || value === "direct")
                    updateSettings({ quitShortcutMode: value });
                }}
              >
                <SelectTrigger className="w-56" aria-label="Quit shortcut">
                  <SelectValue>
                    {settings.quitShortcutMode === "hold"
                      ? "Hold or press twice"
                      : settings.quitShortcutMode === "double-click"
                        ? "Press twice"
                        : "Quit immediately"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  <SelectItem value="hold">Hold or press twice</SelectItem>
                  <SelectItem value="double-click">Press twice</SelectItem>
                  <SelectItem value="direct">Quit immediately</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsCard>
      )}

      <SettingsCard
        title="Safety"
        description="Additional guardrails for destructive local actions."
        actions={
          settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(SAFETY_KEYS, defaults))}
            >
              Restore default
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title="Confirm thread deletion"
          description="Ask for confirmation before deleting a thread and its chat history."
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />
      </SettingsCard>
      <DiagnosticsSettings />
    </>
  );
}
