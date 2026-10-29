import { DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import {
  CLAUDE_SUBAGENT_MODEL_INHERIT,
  DEFAULT_CLAUDE_PROJECT_SETTINGS,
  getAppModelOptions,
  resolveAuxiliaryAppModelSelection,
} from "../../../appSettings";
import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { serverConfigQueryOptions } from "../../../lib/serverReactQuery";
import { resolveClaudeSubagentModel } from "../../ChatView.logic";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { SettingsCard, SettingsRow } from "../SettingsCard";
import { SessionNotesSettings } from "../SessionNotesSettings";
import { SnoozePresetsSettings } from "../SnoozePresetsSettings";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";

export { THREADS_SETTINGS_DESCRIPTORS } from "./ThreadsSettings.descriptors";

export const RUNTIME_MODE_LABELS = {
  "full-access": "Full access",
  "approval-required": "Ask for approval",
  "auto-accept-edits": "Accept edits",
  auto: "Auto",
} as const;
type RuntimeModeOption = keyof typeof RUNTIME_MODE_LABELS;
const RUNTIME_MODE_OPTIONS = Object.keys(RUNTIME_MODE_LABELS) as RuntimeModeOption[];
const isRuntimeModeOption = (value: unknown): value is RuntimeModeOption =>
  typeof value === "string" && value in RUNTIME_MODE_LABELS;

export const THREAD_ENV_MODE_LABELS = {
  local: "Local",
  worktree: "New worktree",
} as const;

const FOLLOW_UP_BEHAVIOR_LABELS = {
  queue: "Queue",
  steer: "Steer the active turn",
} as const;

export function ThreadsSettings() {
  return (
    <>
      <NewThreadDefaults />
      <SnoozePresetsSettings />
      <RuntimeSettings />
      <HelperSettings />
    </>
  );
}

function NewThreadDefaults() {
  const { settings, defaults, updateSettings } = useSettingsRouteContext();
  const changed =
    settings.defaultRuntimeMode !== defaults.defaultRuntimeMode ||
    settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ||
    settings.followUpBehavior !== defaults.followUpBehavior;

  return (
    <SettingsCard
      title="New thread defaults"
      description="Defaults for new threads. Existing threads keep their own. Projects can override permissions and workspace."
      actions={
        changed ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              updateSettings({
                defaultRuntimeMode: defaults.defaultRuntimeMode,
                defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                followUpBehavior: defaults.followUpBehavior,
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
        title="Default workspace"
        description="Whether new threads run in the project folder or in a new git worktree."
        control={
          <Select
            value={settings.defaultThreadEnvMode}
            onValueChange={(value) => {
              if (value === "local" || value === "worktree")
                updateSettings({ defaultThreadEnvMode: value });
            }}
          >
            <SelectTrigger className="w-56" aria-label="Default workspace">
              <SelectValue>{THREAD_ENV_MODE_LABELS[settings.defaultThreadEnvMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              <SelectItem value="local">{THREAD_ENV_MODE_LABELS.local}</SelectItem>
              <SelectItem value="worktree">{THREAD_ENV_MODE_LABELS.worktree}</SelectItem>
            </SelectPopup>
          </Select>
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
            <SelectTrigger className="w-56" aria-label="Follow-up behavior">
              <SelectValue>{FOLLOW_UP_BEHAVIOR_LABELS[settings.followUpBehavior]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              <SelectItem value="queue">{FOLLOW_UP_BEHAVIOR_LABELS.queue}</SelectItem>
              <SelectItem value="steer">{FOLLOW_UP_BEHAVIOR_LABELS.steer}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsCard>
  );
}

function RuntimeSettings() {
  const resumeActiveTurnsAfterRestart = useSettings(
    (settings) => settings.resumeActiveTurnsAfterRestart,
  );
  const autoResumeUsageLimitedThreads = useSettings(
    (settings) => settings.autoResumeUsageLimitedThreads,
  );
  const usageBackgroundSampling = useSettings((settings) => settings.usageBackgroundSampling);
  const { updateSettings: updateServerSettings } = useUpdateSettings();

  return (
    <SettingsCard
      title="Runtime"
      description="What happens to running turns when F5 restarts or a provider limit is hit."
    >
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
        title="Sample account limits in the background"
        description="Periodically read account limits, even with the Usage page closed, to keep quota history and forecasts. Off: limits refresh only while you view them."
        control={
          <Switch
            aria-label="Sample account limits in the background"
            checked={usageBackgroundSampling}
            onCheckedChange={(value) =>
              void updateServerSettings({ usageBackgroundSampling: value })
            }
          />
        }
      />
    </SettingsCard>
  );
}

function HelperSettings() {
  const { settings, updateSettings } = useSettingsRouteContext();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const liveProviders = serverConfigQuery.data?.providers ?? [];
  const threadTitleModelOptions = getAppModelOptions(
    "codex",
    settings.customCodexModels,
    settings.codexThreadTitleModel,
  );
  const effectiveThreadTitleModel = resolveAuxiliaryAppModelSelection(
    "codex",
    settings.customCodexModels,
    settings.codexThreadTitleModel,
    DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
  );

  return (
    <>
      <SessionNotesSettings providers={liveProviders} />
      <SettingsCard
        title="Thread titles"
        description="The Codex model that names a thread after its first message."
      >
        <label className="block space-y-1">
          <span className="text-xs font-medium text-foreground">Thread title model</span>
          <Input
            aria-label="Thread title model"
            list="thread-title-model-options"
            value={settings.codexThreadTitleModel}
            onChange={(event) => updateSettings({ codexThreadTitleModel: event.target.value })}
            placeholder={DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex}
            spellCheck={false}
          />
          <datalist id="thread-title-model-options">
            {threadTitleModelOptions.map((option) => (
              <option key={option.slug} value={option.slug}>
                {option.name}
              </option>
            ))}
          </datalist>
          <span className="block text-xs text-muted-foreground">
            Enter any model slug or pick a suggestion. Invalid or removed slugs fall back to{" "}
            <code>{DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex}</code>. Effective model:{" "}
            <code>{effectiveThreadTitleModel}</code>
          </span>
        </label>
      </SettingsCard>
      <ClaudeSubagentSettings />
    </>
  );
}

/**
 * Sub-agent controls for one layer: the global defaults, or a project's override.
 * Exported for the project-scope Threads page.
 */
export function ClaudeSubagentControls({
  value,
  onChange,
}: {
  readonly value: typeof DEFAULT_CLAUDE_PROJECT_SETTINGS;
  readonly onChange: (patch: Partial<typeof DEFAULT_CLAUDE_PROJECT_SETTINGS>) => void;
}) {
  const { claudeSubagentModelOptions, claudeSubagentModelLabel } = useSettingsRouteContext();
  const effectiveModel = resolveClaudeSubagentModel(
    value.subagentModel,
    claudeSubagentModelOptions,
  );
  return (
    <>
      <SettingsRow
        title="Enable Claude sub-agents"
        description="Allow Claude to spawn helper agents for broad exploration and post-change verification."
        control={
          <Switch
            checked={value.subagentsEnabled}
            onCheckedChange={(checked) => onChange({ subagentsEnabled: checked })}
            aria-label="Enable Claude sub-agents"
          />
        }
      />
      <SettingsRow
        title="Claude sub-agent model"
        description={
          <>
            <span className="font-mono">Inherit</span> keeps sub-agents on the thread model. Any
            other choice overrides <span className="font-mono">CLAUDE_CODE_SUBAGENT_MODEL</span>.
          </>
        }
        control={
          <Select
            value={effectiveModel}
            onValueChange={(model) => (model ? onChange({ subagentModel: model }) : undefined)}
          >
            <SelectTrigger className="w-56" aria-label="Claude sub-agent model">
              <SelectValue>{claudeSubagentModelLabel(value.subagentModel)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              <SelectItem value={CLAUDE_SUBAGENT_MODEL_INHERIT}>Inherit from parent</SelectItem>
              {claudeSubagentModelOptions
                .filter((option) => option.slug !== CLAUDE_SUBAGENT_MODEL_INHERIT)
                .map((option) => (
                  <SelectItem key={option.slug} value={option.slug}>
                    {option.name}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

function ClaudeSubagentSettings() {
  const { claudeSubagentDefaults, updateClaudeSubagentDefaults } = useSettingsRouteContext();
  const changed =
    claudeSubagentDefaults.subagentsEnabled !== DEFAULT_CLAUDE_PROJECT_SETTINGS.subagentsEnabled ||
    claudeSubagentDefaults.subagentModel !== DEFAULT_CLAUDE_PROJECT_SETTINGS.subagentModel;
  return (
    <SettingsCard
      title="Claude sub-agents"
      description="Defaults for Claude exploration and verification agents. Projects can override them."
      actions={
        changed ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => updateClaudeSubagentDefaults(DEFAULT_CLAUDE_PROJECT_SETTINGS)}
          >
            Restore defaults
          </Button>
        ) : null
      }
    >
      <ClaudeSubagentControls
        value={claudeSubagentDefaults}
        onChange={updateClaudeSubagentDefaults}
      />
    </SettingsCard>
  );
}
