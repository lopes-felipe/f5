import {
  DISPLAY_PROFILE_KEYS,
  RUNTIME_WARNING_VISIBILITY_OPTIONS,
  type AppSettings,
  buildAppSettingsPatch,
  parsePersistedAppSettings,
} from "../../../appSettings";
import { DisplayProfileSelector } from "../DisplayProfileSelector";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";

const RESPONSE_AUXILIARY_KEYS = ["enableAssistantStreaming", "openFileLinksInPanel"] as const;
const RUNTIME_WARNING_VISIBILITY_LABELS = {
  hidden: "Hidden",
  summarized: "Compact",
  full: "Full",
} as const;

function hasSettingsChanges<K extends keyof AppSettings>(
  keys: readonly K[],
  current: Pick<AppSettings, K>,
  baseline: Pick<AppSettings, K>,
) {
  return keys.some((key) => current[key] !== baseline[key]);
}

function isRuntimeWarningVisibility(
  value: string | null,
): value is (typeof RUNTIME_WARNING_VISIBILITY_OPTIONS)[number] {
  return RUNTIME_WARNING_VISIBILITY_OPTIONS.some((option) => option === value);
}

export function DisplaySettings() {
  const { settings, defaults, updateSettings } = useSettingsRouteContext();
  const defaultDisplaySettings = parsePersistedAppSettings(null);

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">Responses</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Control how assistant output is rendered during a turn.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
          <div>
            <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
            <p className="text-xs text-muted-foreground">
              Show token-by-token output while a response is in progress.
            </p>
          </div>
          <Switch
            checked={settings.enableAssistantStreaming}
            onCheckedChange={(checked) =>
              updateSettings({
                enableAssistantStreaming: Boolean(checked),
              })
            }
            aria-label="Stream assistant messages"
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
          <div>
            <p className="text-sm font-medium text-foreground">Open file links in code panel</p>
            <p className="text-xs text-muted-foreground">
              Open clicked file links in the side panel instead of the external editor.
            </p>
          </div>
          <Switch
            checked={settings.openFileLinksInPanel}
            onCheckedChange={(checked) =>
              updateSettings({
                openFileLinksInPanel: Boolean(checked),
              })
            }
            aria-label="Open file links in code panel"
          />
        </div>

        <DisplayProfileSelector settings={settings} updateSettings={updateSettings}>
          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">
                Auto-expand workflows in sidebar
              </p>
              <p className="text-xs text-muted-foreground">
                Show subthreads nested under each workflow without clicking to open.
              </p>
            </div>
            <Switch
              checked={settings.expandWorkflowThreadsByDefault}
              onCheckedChange={(checked) =>
                updateSettings({
                  expandWorkflowThreadsByDefault: Boolean(checked),
                })
              }
              aria-label="Auto-expand workflows in sidebar"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Show command output in thread</p>
              <p className="text-xs text-muted-foreground">
                Display the commands agents run and their output inline. When off, only a summary
                appears in the work log.
              </p>
            </div>
            <Switch
              checked={settings.showAgentCommandTranscripts}
              onCheckedChange={(checked) =>
                updateSettings({
                  showAgentCommandTranscripts: Boolean(checked),
                })
              }
              aria-label="Show command output in thread"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Auto-expand command output</p>
              <p className="text-xs text-muted-foreground">
                Open command output automatically instead of requiring a click.
                {!settings.showAgentCommandTranscripts
                  ? " Enable \u201CShow command output in thread\u201D first."
                  : ""}
              </p>
            </div>
            <Switch
              checked={settings.alwaysExpandAgentCommandTranscripts}
              disabled={!settings.showAgentCommandTranscripts}
              onCheckedChange={(checked) =>
                updateSettings({
                  alwaysExpandAgentCommandTranscripts: Boolean(checked),
                })
              }
              aria-label="Auto-expand command output"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Show MCP tool call details</p>
              <p className="text-xs text-muted-foreground">
                Display inputs and results as expandable cards. When off, only the server and tool
                name appear.
              </p>
            </div>
            <Switch
              checked={settings.expandMcpToolCalls}
              onCheckedChange={(checked) =>
                updateSettings({
                  expandMcpToolCalls: Boolean(checked),
                })
              }
              aria-label="Show MCP tool call details"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Auto-expand MCP cards</p>
              <p className="text-xs text-muted-foreground">
                Open MCP cards automatically when they appear.
                {!settings.expandMcpToolCalls
                  ? " Enable \u201CShow MCP tool call details\u201D first."
                  : ""}
              </p>
            </div>
            <Switch
              checked={settings.expandMcpToolCallCardsByDefault}
              disabled={!settings.expandMcpToolCalls}
              onCheckedChange={(checked) =>
                updateSettings({
                  expandMcpToolCallCardsByDefault: Boolean(checked),
                })
              }
              aria-label="Auto-expand MCP cards"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Auto-expand reasoning</p>
              <p className="text-xs text-muted-foreground">
                Show the model&apos;s thinking inline instead of collapsed.
              </p>
            </div>
            <Switch
              checked={settings.showReasoningExpanded}
              onCheckedChange={(checked) =>
                updateSettings({
                  showReasoningExpanded: Boolean(checked),
                })
              }
              aria-label="Auto-expand reasoning"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Show file diffs inline</p>
              <p className="text-xs text-muted-foreground">
                Display the full diff for each file change. When off, only the file name and line
                counts appear.
              </p>
            </div>
            <Switch
              checked={settings.showFileChangeDiffsInline}
              onCheckedChange={(checked) =>
                updateSettings({
                  showFileChangeDiffsInline: Boolean(checked),
                })
              }
              aria-label="Show file diffs inline"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Runtime warnings</p>
              <p className="text-xs text-muted-foreground">
                Choose how much detail to show for runtime warnings from providers.
              </p>
            </div>
            <Select
              value={settings.runtimeWarningVisibility}
              onValueChange={(value) => {
                if (!isRuntimeWarningVisibility(value)) {
                  return;
                }
                updateSettings({
                  runtimeWarningVisibility: value,
                });
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
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Show provider metadata</p>
              <p className="text-xs text-muted-foreground">
                Display the active model, CLI version, and session details above the thread.
              </p>
            </div>
            <Switch
              checked={settings.showProviderRuntimeMetadata}
              onCheckedChange={(checked) =>
                updateSettings({
                  showProviderRuntimeMetadata: Boolean(checked),
                })
              }
              aria-label="Show provider metadata"
            />
          </div>
        </DisplayProfileSelector>
      </div>

      {hasSettingsChanges(RESPONSE_AUXILIARY_KEYS, settings, defaults) ||
      hasSettingsChanges(DISPLAY_PROFILE_KEYS, settings, defaultDisplaySettings) ? (
        <div className="mt-3 flex justify-end">
          <div className="flex flex-wrap gap-2">
            {hasSettingsChanges(RESPONSE_AUXILIARY_KEYS, settings, defaults) ||
            hasSettingsChanges(DISPLAY_PROFILE_KEYS, settings, defaultDisplaySettings) ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  updateSettings({
                    ...buildAppSettingsPatch(DISPLAY_PROFILE_KEYS, defaultDisplaySettings),
                    ...buildAppSettingsPatch(RESPONSE_AUXILIARY_KEYS, defaults),
                  })
                }
              >
                Restore default
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
