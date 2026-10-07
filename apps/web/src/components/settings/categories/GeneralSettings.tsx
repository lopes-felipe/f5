import { useServerCapability } from "../../../protocolState";
import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { toastManager } from "../../ui/toast";
import { buildAppSettingsPatch } from "../../../appSettings";
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

const MERGE_METHOD_LABELS = {
  "last-used": "Last used for the repository",
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
} as const;

const FOLLOW_UP_BEHAVIOR_LABELS = {
  queue: "Queue",
  steer: "Steer the active turn",
} as const;

const SEND_SHORTCUT_LABELS = {
  enter: "Enter",
  "mod-enter": "Command/Ctrl+Enter",
  "mod-enter-multiline": "Command/Ctrl+Enter for multiline prompts",
} as const;

const RUNTIME_MODE_LABELS = {
  "full-access": "Full access",
  "approval-required": "Ask for approval",
  "auto-accept-edits": "Accept edits",
  auto: "Auto",
} as const;
type RuntimeModeOption = keyof typeof RUNTIME_MODE_LABELS;
const RUNTIME_MODE_OPTIONS = Object.keys(RUNTIME_MODE_LABELS) as RuntimeModeOption[];
const isRuntimeModeOption = (value: unknown): value is RuntimeModeOption =>
  typeof value === "string" && value in RUNTIME_MODE_LABELS;

const WORKTREE_SUBMODULES_LABELS = {
  none: "None",
  shallow: "Top level",
  recursive: "Recursive",
} as const;
type WorktreeSubmodulesOption = keyof typeof WORKTREE_SUBMODULES_LABELS;
const WORKTREE_SUBMODULES_OPTIONS = Object.keys(
  WORKTREE_SUBMODULES_LABELS,
) as WorktreeSubmodulesOption[];
const isWorktreeSubmodulesOption = (value: unknown): value is WorktreeSubmodulesOption =>
  typeof value === "string" && value in WORKTREE_SUBMODULES_LABELS;

const SAFETY_KEYS = ["confirmThreadDelete"] as const;

export function GeneralSettings() {
  const composerRedesign = useServerCapability("composer-redesign");
  const { settings, defaults, updateSettings } = useSettingsRouteContext();
  const resumeActiveTurnsAfterRestart = useSettings(
    (settings) => settings.resumeActiveTurnsAfterRestart,
  );
  const autoResumeUsageLimitedThreads = useSettings(
    (settings) => settings.autoResumeUsageLimitedThreads,
  );
  const defaultMergeMethod = useSettings((settings) => settings.prHubDefaultMergeMethod);
  const { updateSettings: updateServerSettings } = useUpdateSettings();
  const setDefaultMergeMethod = (value: "merge" | "squash" | "rebase" | null) => {
    void updateServerSettings({ prHubDefaultMergeMethod: value }).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not save merge method",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  const mergeMethodValue = defaultMergeMethod ?? "last-used";

  return (
    <>
      <SettingsCard
        title="New threads"
        description="Defaults for new threads. Existing threads keep their own."
        actions={
          settings.defaultRuntimeMode !== defaults.defaultRuntimeMode ||
          settings.worktreeSubmodules !== defaults.worktreeSubmodules ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                updateSettings({
                  defaultRuntimeMode: defaults.defaultRuntimeMode,
                  worktreeSubmodules: defaults.worktreeSubmodules,
                })
              }
            >
              Restore defaults
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title="Default permissions"
          description="What agents may do without asking first."
          control={
            <Select
              value={settings.defaultRuntimeMode}
              onValueChange={(value) => {
                if (isRuntimeModeOption(value)) updateSettings({ defaultRuntimeMode: value });
              }}
            >
              <SelectTrigger className="w-56" aria-label="Default permissions">
                <SelectValue>{RUNTIME_MODE_LABELS[settings.defaultRuntimeMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {RUNTIME_MODE_OPTIONS.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {RUNTIME_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Worktree submodules"
          description="Which git submodules a new worktree checks out."
          control={
            <Select
              value={settings.worktreeSubmodules}
              onValueChange={(value) => {
                if (isWorktreeSubmodulesOption(value))
                  updateSettings({ worktreeSubmodules: value });
              }}
            >
              <SelectTrigger className="w-56" aria-label="Worktree submodules">
                <SelectValue>{WORKTREE_SUBMODULES_LABELS[settings.worktreeSubmodules]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {WORKTREE_SUBMODULES_OPTIONS.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {WORKTREE_SUBMODULES_LABELS[mode]}
                  </SelectItem>
                ))}
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
        title="Pull requests"
        description="Used when the repository allows it. Your choice in a merge dialog takes precedence."
      >
        <SettingsRow
          title="Default merge method"
          control={
            <Select
              value={mergeMethodValue}
              onValueChange={(value) => {
                if (value === "last-used") setDefaultMergeMethod(null);
                else if (value === "merge" || value === "squash" || value === "rebase")
                  setDefaultMergeMethod(value);
              }}
            >
              <SelectTrigger className="w-56" aria-label="Default PR merge method">
                <SelectValue>{MERGE_METHOD_LABELS[mergeMethodValue]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="last-used">{MERGE_METHOD_LABELS["last-used"]}</SelectItem>
                <SelectItem value="squash">{MERGE_METHOD_LABELS.squash}</SelectItem>
                <SelectItem value="merge">{MERGE_METHOD_LABELS.merge}</SelectItem>
                <SelectItem value="rebase">{MERGE_METHOD_LABELS.rebase}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsCard>

      <SettingsCard title="Composer" description="How the message composer behaves.">
        <div className="space-y-3">
          {composerRedesign && (
            <SettingsRow
              title="Collapse composer while scrolling"
              description="Make room for the conversation when you scroll. Typing or clicking the editor expands it; leaving the editor never collapses it."
              control={
                <Switch
                  aria-label="Collapse composer while scrolling"
                  checked={settings.composerCollapseOnScroll}
                  onCheckedChange={(checked) =>
                    updateSettings({ composerCollapseOnScroll: checked })
                  }
                />
              }
            />
          )}
          <SettingsRow
            title="Rich text editor"
            description="Style Markdown while keeping its source editable. Turn off for plain text."
            control={
              <Switch
                aria-label="Rich text editor"
                checked={settings.composerRichTextEnabled}
                onCheckedChange={(checked) => updateSettings({ composerRichTextEnabled: checked })}
              />
            }
          />
          <SettingsRow
            title="Load remote images in chat"
            description="Allow HTTPS images from external websites."
            control={
              <Switch
                aria-label="Load remote images in chat"
                checked={settings.loadRemoteImagesInChat}
                onCheckedChange={(checked) => updateSettings({ loadRemoteImagesInChat: checked })}
              />
            }
          />
          <SettingsRow
            title="Resume active turns after restart"
            description="Continue turns that were running when the app restarted."
            control={
              <Switch
                aria-label="Resume active turns after restart"
                checked={resumeActiveTurnsAfterRestart}
                onCheckedChange={(value) =>
                  void updateServerSettings({ resumeActiveTurnsAfterRestart: value })
                }
              />
            }
          />
          <SettingsRow
            title="Auto-continue after usage limits"
            description="When a Codex or Claude usage limit stops a thread, send continue automatically after the limit resets."
            control={
              <Switch
                aria-label="Auto-continue after usage limits"
                checked={autoResumeUsageLimitedThreads}
                onCheckedChange={(value) =>
                  void updateServerSettings({ autoResumeUsageLimitedThreads: value })
                }
              />
            }
          />
          <SettingsRow
            title="Follow-up behavior"
            description="What sending a message does while a turn is running."
            control={
              <Select
                value={settings.followUpBehavior}
                onValueChange={(value) => {
                  if (value === "queue" || value === "steer")
                    updateSettings({ followUpBehavior: value });
                }}
              >
                <SelectTrigger className="w-48" aria-label="Follow-up behavior">
                  <SelectValue>{FOLLOW_UP_BEHAVIOR_LABELS[settings.followUpBehavior]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  <SelectItem value="queue">{FOLLOW_UP_BEHAVIOR_LABELS.queue}</SelectItem>
                  <SelectItem value="steer">{FOLLOW_UP_BEHAVIOR_LABELS.steer}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Send shortcut"
            description="Shift+Enter always inserts a new line."
            control={
              <Select
                value={settings.sendShortcut}
                onValueChange={(value) => {
                  if (value === "enter" || value === "mod-enter" || value === "mod-enter-multiline")
                    updateSettings({ sendShortcut: value });
                }}
              >
                <SelectTrigger className="w-48" aria-label="Send shortcut">
                  <SelectValue>{SEND_SHORTCUT_LABELS[settings.sendShortcut]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  <SelectItem value="enter">{SEND_SHORTCUT_LABELS.enter}</SelectItem>
                  <SelectItem value="mod-enter">{SEND_SHORTCUT_LABELS["mod-enter"]}</SelectItem>
                  <SelectItem value="mod-enter-multiline">
                    {SEND_SHORTCUT_LABELS["mod-enter-multiline"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Time & locale"
        description="Choose how dates and times appear across the app."
      >
        <div className="space-y-4">
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
            }
          />

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
      </SettingsCard>

      <SettingsCard
        title="Threads"
        description="Choose the default workspace mode for newly created draft threads."
      >
        <div className="space-y-3">
          <SettingsRow
            title="Default to New worktree"
            description="New threads start in New worktree mode instead of Local."
            control={
              <Switch
                checked={settings.defaultThreadEnvMode === "worktree"}
                onCheckedChange={(checked) =>
                  updateSettings({
                    defaultThreadEnvMode: checked ? "worktree" : "local",
                  })
                }
                aria-label="Default new threads to New worktree mode"
              />
            }
          />
          <SettingsRow
            title="Open task sidebar automatically"
            description="Show task and plan sidebars automatically when a thread starts tracking steps."
            control={
              <Switch
                checked={settings.tasksPanelAutoOpen}
                onCheckedChange={(checked) =>
                  updateSettings({
                    tasksPanelAutoOpen: Boolean(checked),
                  })
                }
                aria-label="Open task sidebar automatically"
              />
            }
          />
        </div>

        {settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ||
        settings.tasksPanelAutoOpen !== defaults.tasksPanelAutoOpen ? (
          <div className="mt-3 flex justify-end">
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                updateSettings({
                  defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                  tasksPanelAutoOpen: defaults.tasksPanelAutoOpen,
                })
              }
            >
              Restore default
            </Button>
          </div>
        ) : null}
      </SettingsCard>

      <SettingsCard
        title="Safety"
        description="Additional guardrails for destructive local actions."
      >
        <SettingsRow
          title="Confirm thread deletion"
          description="Ask for confirmation before deleting a thread and its chat history."
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({
                  confirmThreadDelete: Boolean(checked),
                })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

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
      </SettingsCard>
    </>
  );
}
