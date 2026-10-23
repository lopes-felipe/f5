import {
  DISPLAY_PROFILE_KEYS,
  RUNTIME_WARNING_VISIBILITY_OPTIONS,
  WORK_LOG_FILTER_OPTIONS,
  WORK_LOG_MODE_OPTIONS,
  type AppSettings,
  buildAppSettingsPatch,
  parsePersistedAppSettings,
} from "../../../appSettings";
import { useServerCapability } from "../../../protocolState";
import { DisplayProfileSelector } from "../DisplayProfileSelector";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { SettingsCard, SettingsRow } from "../SettingsCard";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";

export { CONVERSATION_SETTINGS_DESCRIPTORS } from "./ConversationSettings.descriptors";

const SEND_SHORTCUT_LABELS = {
  enter: "Enter",
  "mod-enter": "Command/Ctrl+Enter",
  "mod-enter-multiline": "Command/Ctrl+Enter for multiline prompts",
} as const;
const RUNTIME_WARNING_VISIBILITY_LABELS = {
  hidden: "Hidden",
  summarized: "Compact",
  full: "Full",
} as const;
const WORK_LOG_MODE_LABELS = {
  essential: "Essential",
  diagnostics: "Diagnostics",
} as const;
const WORK_LOG_FILTER_LABELS = {
  all: "All activity",
  tools: "Tools",
  hooks: "Hooks",
  issues: "Issues",
} as const;

const COMPOSER_KEYS = [
  "sendShortcut",
  "composerRichTextEnabled",
  "composerCollapseOnScroll",
  "compactChatLayout",
] as const;
const MESSAGE_KEYS = [
  "enableAssistantStreaming",
  "loadRemoteImagesInChat",
  "diffWordWrap",
  "diffFileDefaultState",
] as const;
const WORK_LOG_KEYS = ["workLogMode", "workLogFilter"] as const;

function hasSettingsChanges<K extends keyof AppSettings>(
  keys: readonly K[],
  current: Pick<AppSettings, K>,
  baseline: Pick<AppSettings, K>,
) {
  return keys.some((key) => current[key] !== baseline[key]);
}

function isRuntimeWarningVisibility(
  value: string | null,
): value is AppSettings["runtimeWarningVisibility"] {
  return RUNTIME_WARNING_VISIBILITY_OPTIONS.some((option) => option === value);
}

function isWorkLogMode(value: string | null): value is AppSettings["workLogMode"] {
  return WORK_LOG_MODE_OPTIONS.some((option) => option === value);
}

function isWorkLogFilter(value: string | null): value is AppSettings["workLogFilter"] {
  return WORK_LOG_FILTER_OPTIONS.some((option) => option === value);
}

function RestoreDefaultsButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <Button size="xs" variant="outline" onClick={onClick}>
      Restore defaults
    </Button>
  );
}

export function ConversationSettings() {
  const composerRedesign = useServerCapability("composer-redesign");
  const { settings, defaults, updateSettings } = useSettingsRouteContext();
  const defaultDisplaySettings = parsePersistedAppSettings(null);
  const activityChanged =
    hasSettingsChanges(WORK_LOG_KEYS, settings, defaults) ||
    hasSettingsChanges(DISPLAY_PROFILE_KEYS, settings, defaultDisplaySettings);

  return (
    <>
      <SettingsCard
        title="Composer"
        description="How the message composer behaves."
        actions={
          hasSettingsChanges(COMPOSER_KEYS, settings, defaults) ? (
            <RestoreDefaultsButton
              onClick={() => updateSettings(buildAppSettingsPatch(COMPOSER_KEYS, defaults))}
            />
          ) : null
        }
      >
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
        {composerRedesign && (
          <SettingsRow
            title="Collapse composer while scrolling"
            description="Make room for the conversation when you scroll. Typing or clicking the editor expands it; leaving the editor never collapses it."
            control={
              <Switch
                aria-label="Collapse composer while scrolling"
                checked={settings.composerCollapseOnScroll}
                onCheckedChange={(checked) => updateSettings({ composerCollapseOnScroll: checked })}
              />
            }
          />
        )}
        <SettingsRow
          title="Compact chat layout"
          description="Show tasks, queued turns and non-critical notices as chips above the composer, and runtime info in the header."
          control={
            <Switch
              aria-label="Compact chat layout"
              checked={settings.compactChatLayout}
              onCheckedChange={(checked) => updateSettings({ compactChatLayout: checked })}
            />
          }
        />
      </SettingsCard>

      <SettingsCard
        title="Messages"
        description="How assistant replies, code, and diffs render."
        actions={
          MESSAGE_KEYS.some((key) => settings[key] !== defaults[key]) ? (
            <RestoreDefaultsButton
              onClick={() =>
                updateSettings({
                  enableAssistantStreaming: defaults.enableAssistantStreaming,
                  loadRemoteImagesInChat: defaults.loadRemoteImagesInChat,
                  diffWordWrap: defaults.diffWordWrap,
                  diffFileDefaultState: defaults.diffFileDefaultState,
                })
              }
            />
          ) : null
        }
      >
        <SettingsRow
          title="Stream assistant messages"
          description="Show token-by-token output while a response is in progress."
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />
        <SettingsRow
          title="Load remote images in chat"
          description="Allow HTTPS images from external websites, and HTTPS images and scripts in HTML pages agents show. Even when off, an HTML page opened in a web browser rather than the desktop app can still navigate away, taking what it shows with it."
          control={
            <Switch
              aria-label="Load remote images in chat"
              checked={settings.loadRemoteImagesInChat}
              onCheckedChange={(checked) => updateSettings({ loadRemoteImagesInChat: checked })}
            />
          }
        />
        <SettingsRow
          title="Wrap long code and table lines"
          description="Wrap chat code blocks, tables, diffs, and file previews instead of scrolling sideways."
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap long code and table lines"
            />
          }
        />
        <SettingsRow
          title="Default diff file state"
          description="Whether files in a diff start expanded, collapsed, or sized automatically."
          control={
            <Select
              value={settings.diffFileDefaultState}
              onValueChange={(value) => {
                if (value === "auto" || value === "expanded" || value === "collapsed")
                  updateSettings({ diffFileDefaultState: value });
              }}
            >
              <SelectTrigger className="w-36" aria-label="Default diff file state">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="auto">Automatic</SelectItem>
                <SelectItem value="expanded">Expanded</SelectItem>
                <SelectItem value="collapsed">Collapsed</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="Activity detail"
        searchTarget="conversation.display-density"
        description="How much of the agent's work appears in each thread."
        actions={
          activityChanged ? (
            <RestoreDefaultsButton
              onClick={() =>
                updateSettings({
                  ...buildAppSettingsPatch(DISPLAY_PROFILE_KEYS, defaultDisplaySettings),
                  ...buildAppSettingsPatch(WORK_LOG_KEYS, defaults),
                })
              }
            />
          ) : null
        }
      >
        <div className="space-y-4">
          <div>
            <SettingsRow
              title="Work log detail level"
              description="Essential hides successful hooks and reviews. Diagnostics shows the full activity history."
              control={
                <Select
                  value={settings.workLogMode}
                  onValueChange={(value) => {
                    if (isWorkLogMode(value)) updateSettings({ workLogMode: value });
                  }}
                >
                  <SelectTrigger className="w-36" aria-label="Work log detail level">
                    <SelectValue>{WORK_LOG_MODE_LABELS[settings.workLogMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {WORK_LOG_MODE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {WORK_LOG_MODE_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Work log category"
              description="Show all work-log entries or limit every chat to one category."
              control={
                <Select
                  value={settings.workLogFilter}
                  onValueChange={(value) => {
                    if (isWorkLogFilter(value)) updateSettings({ workLogFilter: value });
                  }}
                >
                  <SelectTrigger className="w-36" aria-label="Work log category">
                    <SelectValue>{WORK_LOG_FILTER_LABELS[settings.workLogFilter]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {WORK_LOG_FILTER_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {WORK_LOG_FILTER_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          </div>

          <DisplayProfileSelector settings={settings} updateSettings={updateSettings}>
            <SettingsRow
              title="Auto-expand workflows in sidebar"
              description="Show subthreads nested under each workflow without clicking to open."
              control={
                <Switch
                  checked={settings.expandWorkflowThreadsByDefault}
                  onCheckedChange={(checked) =>
                    updateSettings({ expandWorkflowThreadsByDefault: Boolean(checked) })
                  }
                  aria-label="Auto-expand workflows in sidebar"
                />
              }
            />
            <SettingsRow
              title="Show command output in thread"
              description="Display the commands agents run and their output inline. When off, only a summary appears in the work log."
              control={
                <Switch
                  checked={settings.showAgentCommandTranscripts}
                  onCheckedChange={(checked) =>
                    updateSettings({ showAgentCommandTranscripts: Boolean(checked) })
                  }
                  aria-label="Show command output in thread"
                />
              }
            />
            <SettingsRow
              title="Auto-expand command output"
              description={`Open command output automatically instead of requiring a click.${
                !settings.showAgentCommandTranscripts
                  ? " Enable “Show command output in thread” first."
                  : ""
              }`}
              control={
                <Switch
                  checked={settings.alwaysExpandAgentCommandTranscripts}
                  disabled={!settings.showAgentCommandTranscripts}
                  onCheckedChange={(checked) =>
                    updateSettings({ alwaysExpandAgentCommandTranscripts: Boolean(checked) })
                  }
                  aria-label="Auto-expand command output"
                />
              }
            />
            <SettingsRow
              title="Show MCP tool call details"
              description="Display inputs and results as expandable cards. When off, only the server and tool name appear."
              control={
                <Switch
                  checked={settings.expandMcpToolCalls}
                  onCheckedChange={(checked) =>
                    updateSettings({ expandMcpToolCalls: Boolean(checked) })
                  }
                  aria-label="Show MCP tool call details"
                />
              }
            />
            <SettingsRow
              title="Auto-expand MCP cards"
              description={`Open MCP cards automatically when they appear.${
                !settings.expandMcpToolCalls ? " Enable “Show MCP tool call details” first." : ""
              }`}
              control={
                <Switch
                  checked={settings.expandMcpToolCallCardsByDefault}
                  disabled={!settings.expandMcpToolCalls}
                  onCheckedChange={(checked) =>
                    updateSettings({ expandMcpToolCallCardsByDefault: Boolean(checked) })
                  }
                  aria-label="Auto-expand MCP cards"
                />
              }
            />
            <SettingsRow
              title="Auto-expand reasoning"
              description="Show the model's thinking inline instead of collapsed."
              control={
                <Switch
                  checked={settings.showReasoningExpanded}
                  onCheckedChange={(checked) =>
                    updateSettings({ showReasoningExpanded: Boolean(checked) })
                  }
                  aria-label="Auto-expand reasoning"
                />
              }
            />
            <SettingsRow
              title="Collapse finished work logs"
              description="Fold a turn's tool calls into a one-line summary once you send the next message. The latest turn always stays open."
              control={
                <Switch
                  checked={settings.collapseCompletedWorkLogs}
                  onCheckedChange={(checked) =>
                    updateSettings({ collapseCompletedWorkLogs: Boolean(checked) })
                  }
                  aria-label="Collapse finished work logs"
                />
              }
            />
            <SettingsRow
              title="Show file diffs inline"
              description="Display the full diff for each file change. When off, only the file name and line counts appear."
              control={
                <Switch
                  checked={settings.showFileChangeDiffsInline}
                  onCheckedChange={(checked) =>
                    updateSettings({ showFileChangeDiffsInline: Boolean(checked) })
                  }
                  aria-label="Show file diffs inline"
                />
              }
            />
            <SettingsRow
              title="Runtime warnings"
              description="Choose how much detail to show for runtime warnings from providers."
              control={
                <Select
                  value={settings.runtimeWarningVisibility}
                  onValueChange={(value) => {
                    if (isRuntimeWarningVisibility(value))
                      updateSettings({ runtimeWarningVisibility: value });
                  }}
                >
                  <SelectTrigger className="w-40" aria-label="Runtime warnings">
                    <SelectValue>
                      {RUNTIME_WARNING_VISIBILITY_LABELS[settings.runtimeWarningVisibility]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {RUNTIME_WARNING_VISIBILITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {RUNTIME_WARNING_VISIBILITY_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Show provider metadata"
              description="Display the active model, CLI version, and session details above the thread."
              control={
                <Switch
                  checked={settings.showProviderRuntimeMetadata}
                  onCheckedChange={(checked) =>
                    updateSettings({ showProviderRuntimeMetadata: Boolean(checked) })
                  }
                  aria-label="Show provider metadata"
                />
              }
            />
          </DisplayProfileSelector>
        </div>
      </SettingsCard>
    </>
  );
}
