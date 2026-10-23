import { ThreadSettlementSettings } from "../ThreadSettlementSettings";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL, type ServerSettings } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Equal } from "effect";
import { useEffect, useRef, useState } from "react";

import {
  GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_DEFAULT,
  GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_ENABLED_MIN,
  GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_MAX,
  buildAppSettingsPatch,
} from "../../../appSettings";
import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { serverConfigQueryOptions, serverQueryKeys } from "../../../lib/serverReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { SettingsCard, SettingsRow } from "../SettingsCard";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { ReviewGuideSettings } from "../ReviewGuideSettings";
import { WorktreeDisposablePathsEditor } from "../WorktreeDisposablePathsEditor";

export { GIT_SETTINGS_DESCRIPTORS } from "./GitSettings.descriptors";

const PR_HUB_POLL_INTERVAL_SECONDS_DEFAULT = 180;
const PR_HUB_POLL_INTERVAL_SECONDS_ENABLED_MIN = 60;
const PR_HUB_POLL_INTERVAL_SECONDS_MAX = 3600;

const GIT_REFRESH_KEYS = [
  "enableGitStatusAutoRefresh",
  "gitStatusAutoRefreshIntervalSeconds",
] as const;
const GIT_TEXT_KEYS = ["textGenerationModel"] as const;

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

const MERGE_METHOD_LABELS = {
  "last-used": "Last used for the repository",
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GitSettings() {
  return (
    <>
      <WorktreeSettings />
      <SyncSettings />
      <WritingSettings />
      <PullRequestSettings />
      <ReviewGuideSettings />
      <ThreadSettlementSettings />
    </>
  );
}

function WorktreeSettings() {
  const { settings, defaults, updateSettings } = useSettingsRouteContext();
  return (
    <SettingsCard
      title="Worktrees"
      description="How F5 creates and removes git worktrees for threads."
      actions={
        settings.worktreeSubmodules !== defaults.worktreeSubmodules ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => updateSettings({ worktreeSubmodules: defaults.worktreeSubmodules })}
          >
            Restore default
          </Button>
        ) : null
      }
    >
      <SettingsRow
        title="Manage worktrees"
        searchTarget="git.manage-worktrees"
        description="Browse checkouts for each project, see which conversations use them, and switch or remove them."
        control={
          <Button size="xs" variant="outline" render={<Link to="/worktrees" />}>
            Open worktrees
          </Button>
        }
      />
      <SettingsRow
        title="Worktree submodules"
        description="Which git submodules a new worktree checks out."
        control={
          <Select
            value={settings.worktreeSubmodules}
            onValueChange={(value) => {
              if (isWorktreeSubmodulesOption(value)) updateSettings({ worktreeSubmodules: value });
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
      <SettingsRow
        title="Automatic worktree cleanup"
        searchTarget="git.worktree-cleanup"
        description="Idle worktrees are removed by the cleanup rules in Storage, which share one preview and activity history with log and thread retention."
        control={
          <Button
            size="xs"
            variant="outline"
            render={
              <Link to="/settings" search={{ category: "storage", item: "storage.automation" }} />
            }
          >
            Open cleanup rules
          </Button>
        }
      />
      <SettingsRow
        title="Disposable worktree changes"
        searchTarget="git.worktree-disposable-paths"
        description="Uncommitted changes Storage cleanup may discard, such as regenerated files. Projects can override this list."
      >
        <WorktreeDisposablePathsEditor
          value={settings.worktreeDisposablePaths}
          onSave={(paths) => updateSettings({ worktreeDisposablePaths: paths })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}

function SyncSettings() {
  const { settings, defaults, updateSettings } = useSettingsRouteContext();
  const autoPullDefaultBranch = useSettings((unified) => unified.autoPullDefaultBranch);
  const { updateSettings: updateServerSettings } = useUpdateSettings();
  const gitAutoRefreshEnabled = settings.enableGitStatusAutoRefresh;

  return (
    <SettingsCard
      title="Sync"
      description="Background git status refreshes and default-branch pulls."
      actions={
        settings.enableGitStatusAutoRefresh !== defaults.enableGitStatusAutoRefresh ||
        settings.gitStatusAutoRefreshIntervalSeconds !==
          defaults.gitStatusAutoRefreshIntervalSeconds ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => updateSettings(buildAppSettingsPatch(GIT_REFRESH_KEYS, defaults))}
          >
            Restore default
          </Button>
        ) : null
      }
    >
      <SettingsRow
        title="Auto-refresh git status"
        description={
          gitAutoRefreshEnabled
            ? `Keeps local git status refreshed every ${settings.gitStatusAutoRefreshIntervalSeconds} seconds.`
            : "Stops background refreshes, but git status still loads when opened and after explicit git actions."
        }
        control={
          <div className="flex items-center gap-3">
            <Input
              className="h-8 w-20"
              type="number"
              min={GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_ENABLED_MIN}
              max={GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_MAX}
              step={5}
              value={settings.gitStatusAutoRefreshIntervalSeconds}
              disabled={!gitAutoRefreshEnabled}
              onChange={(event) => {
                const value = Math.max(
                  GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_ENABLED_MIN,
                  Math.min(
                    GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_MAX,
                    Math.round(Number(event.currentTarget.value) || 0),
                  ),
                );
                updateSettings({ gitStatusAutoRefreshIntervalSeconds: value });
              }}
              aria-label="Git auto-refresh interval in seconds"
            />
            <Switch
              checked={gitAutoRefreshEnabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  gitStatusAutoRefreshIntervalSeconds: checked
                    ? GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_DEFAULT
                    : 0,
                })
              }
              aria-label="Auto-refresh git status"
            />
          </div>
        }
      />
      <SettingsRow
        title="Auto-pull default branches"
        description="Every 15 minutes, fast-forwards a project root that has its default branch checked out, a clean tree and no agent working in it. Never merges or rebases. Pulls appear in the Storage cleanup activity."
        control={
          <Switch
            aria-label="Auto-pull default branches"
            checked={autoPullDefaultBranch}
            onCheckedChange={(value) =>
              void updateServerSettings({ autoPullDefaultBranch: value }).catch((error: unknown) =>
                toastManager.add({
                  type: "error",
                  title: "Could not save auto-pull",
                  description: errorMessage(error),
                }),
              )
            }
          />
        }
      />
    </SettingsCard>
  );
}

function WritingSettings() {
  const {
    settings,
    defaults,
    updateSettings,
    gitTextGenerationModelOptions,
    selectedGitTextGenerationModelLabel,
  } = useSettingsRouteContext();
  const unifiedSettings = useSettings();
  const { updateSettings: updateUnifiedSettings } = useUpdateSettings();
  const writingPreferences = unifiedSettings.sourceControlWriting;
  const writingPreferencesRef = useRef(writingPreferences);
  const writingPreferencesUpdatesRef = useRef(0);
  useEffect(() => {
    if (writingPreferencesUpdatesRef.current === 0) {
      writingPreferencesRef.current = writingPreferences;
    }
  }, [writingPreferences]);
  const updateWritingPreferences = (patch: Partial<ServerSettings["sourceControlWriting"]>) => {
    const next = { ...writingPreferencesRef.current, ...patch };
    writingPreferencesRef.current = next;
    writingPreferencesUpdatesRef.current += 1;
    void updateUnifiedSettings({ sourceControlWriting: next }).finally(() => {
      writingPreferencesUpdatesRef.current = Math.max(0, writingPreferencesUpdatesRef.current - 1);
    });
  };

  return (
    <SettingsCard
      title="Writing"
      searchTarget="git.writing"
      description="The model and conventions used for generated commit messages, PR content, and branch names."
      actions={
        settings.textGenerationModel !== defaults.textGenerationModel ||
        !Equal.equals(writingPreferences, DEFAULT_UNIFIED_SETTINGS.sourceControlWriting) ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              updateSettings(buildAppSettingsPatch(GIT_TEXT_KEYS, defaults));
              void updateUnifiedSettings({
                sourceControlWriting: DEFAULT_UNIFIED_SETTINGS.sourceControlWriting,
              });
            }}
          >
            Restore defaults
          </Button>
        ) : null
      }
    >
      <SettingsRow
        title="Text generation model"
        searchTarget="git.text-model"
        description="Model used for auto-generated git content."
        control={
          <Select
            value={settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL}
            onValueChange={(value) => {
              if (value) updateSettings({ textGenerationModel: value });
            }}
          >
            <SelectTrigger className="w-48" aria-label="Git text generation model">
              <SelectValue>{selectedGitTextGenerationModelLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {gitTextGenerationModelOptions.map((option) => (
                <SelectItem key={option.slug} value={option.slug}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <div className="mt-3 space-y-3 rounded-lg border border-border bg-background p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Commit message style</span>
            <Select
              value={writingPreferences.commitMessageStyle}
              onValueChange={(value) => {
                if (value === "plain" || value === "conventional") {
                  updateWritingPreferences({ commitMessageStyle: value });
                }
              }}
            >
              <SelectTrigger aria-label="Commit message style">
                <SelectValue>
                  {writingPreferences.commitMessageStyle === "conventional"
                    ? "Conventional commits"
                    : "Plain language"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="plain">Plain language</SelectItem>
                <SelectItem value="conventional">Conventional commits</SelectItem>
              </SelectPopup>
            </Select>
          </label>
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Branch prefix</span>
            <Input
              key={writingPreferences.branchNamePrefix}
              aria-label="Generated branch prefix"
              defaultValue={writingPreferences.branchNamePrefix}
              placeholder="team or username"
              onBlur={(event) => updateWritingPreferences({ branchNamePrefix: event.target.value })}
            />
          </label>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <span className="text-xs text-foreground">Generate commit messages</span>
            <Switch
              checked={writingPreferences.generateCommitMessages}
              onCheckedChange={(checked) =>
                updateWritingPreferences({ generateCommitMessages: checked })
              }
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <span className="text-xs text-foreground">Include commit body</span>
            <Switch
              checked={writingPreferences.commitMessageIncludeBody}
              onCheckedChange={(checked) =>
                updateWritingPreferences({ commitMessageIncludeBody: checked })
              }
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
            <span className="text-xs text-foreground">Generate pull request content</span>
            <Switch
              checked={writingPreferences.generatePrContent}
              onCheckedChange={(checked) =>
                updateWritingPreferences({ generatePrContent: checked })
              }
            />
          </label>
        </div>

        <label className="block space-y-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Pull request body template</span>
          <Textarea
            key={writingPreferences.prBodyTemplate}
            aria-label="Pull request body template"
            defaultValue={writingPreferences.prBodyTemplate}
            onBlur={(event) => updateWritingPreferences({ prBodyTemplate: event.target.value })}
          />
          <span>
            Use {"{{summary}}"} and {"{{testing}}"} where generated content belongs.
          </span>
        </label>

        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <span className="text-xs text-foreground">
            Use repository writing guidance (AGENTS.md / CLAUDE.md)
          </span>
          <Switch
            aria-label="Use repository writing guidance"
            checked={writingPreferences.useRepositoryInstructions ?? false}
            onCheckedChange={(checked) =>
              updateWritingPreferences({ useRepositoryInstructions: checked })
            }
          />
        </label>

        <label className="block space-y-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Additional writing instructions</span>
          <Textarea
            key={writingPreferences.customInstructions}
            aria-label="Source control writing instructions"
            defaultValue={writingPreferences.customInstructions}
            placeholder="Tone, terminology, or repository conventions"
            onBlur={(event) => updateWritingPreferences({ customInstructions: event.target.value })}
          />
        </label>
      </div>
    </SettingsCard>
  );
}

function PullRequestSettings() {
  const { settings, updateSettings } = useSettingsRouteContext();
  const defaultMergeMethod = useSettings((unified) => unified.prHubDefaultMergeMethod);
  const removeAgentCredits = useSettings((unified) => unified.removeAgentCreditsOnMerge);
  const { updateSettings: updateServerSettings } = useUpdateSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const queryClient = useQueryClient();
  const prHubSettings = serverConfigQuery.data?.settings?.prHub ?? {
    pollIntervalSeconds: PR_HUB_POLL_INTERVAL_SECONDS_DEFAULT,
    excludeRepos: [],
  };
  const prHubRefreshEnabled = prHubSettings.pollIntervalSeconds !== 0;
  const [excludeReposDraft, setExcludeReposDraft] = useState(prHubSettings.excludeRepos.join("\n"));
  const mergeMethodValue = defaultMergeMethod ?? "last-used";

  useEffect(() => {
    setExcludeReposDraft(prHubSettings.excludeRepos.join("\n"));
  }, [prHubSettings.excludeRepos]);

  const setDefaultMergeMethod = (value: "merge" | "squash" | "rebase" | null) => {
    void updateServerSettings({ prHubDefaultMergeMethod: value }).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not save merge method",
        description: errorMessage(error),
      }),
    );
  };

  const updatePrHubSettings = async (patch: Partial<typeof prHubSettings>) => {
    const nextSettings = await ensureNativeApi().server.updateSettings({
      prHub: { ...prHubSettings, ...patch },
    });
    queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
      existing ? { ...existing, settings: nextSettings } : existing,
    );
  };

  const saveExcludeRepos = () => {
    const excludeRepos = excludeReposDraft
      .split(/[\n,]/)
      .map((repo) => repo.trim())
      .filter(Boolean);
    void updatePrHubSettings({ excludeRepos });
  };

  return (
    <SettingsCard
      title="Pull requests"
      description="Merge defaults and how PR Hub polls GitHub. Your choice in a merge dialog takes precedence."
    >
      <SettingsRow
        title="Default merge method"
        description="Used when the repository allows it."
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
      <SettingsRow
        title="Remove agent credits when merging"
        description="Remove recognized agent co-author and generated-by lines from GitHub merge and squash messages. Keeps human credits and original commits. Includes auto-merge; excludes merge queues and stack merges."
        control={
          <Switch
            aria-label="Remove agent credits when merging"
            checked={removeAgentCredits}
            onCheckedChange={(enabled) =>
              void updateServerSettings({ removeAgentCreditsOnMerge: enabled }).catch(
                (error: unknown) =>
                  toastManager.add({
                    type: "error",
                    title: "Could not save merge-message setting",
                    description: errorMessage(error),
                  }),
              )
            }
          />
        }
      />
      <SettingsRow
        title="Auto-refresh PR Hub"
        description={
          prHubRefreshEnabled
            ? `Checks GitHub every ${prHubSettings.pollIntervalSeconds} seconds.`
            : "Stops scheduled GitHub polling. Manual refresh still works."
        }
        control={
          <div className="flex items-center gap-3">
            <Input
              className="h-8 w-20"
              type="number"
              min={PR_HUB_POLL_INTERVAL_SECONDS_ENABLED_MIN}
              max={PR_HUB_POLL_INTERVAL_SECONDS_MAX}
              step={30}
              value={
                prHubSettings.pollIntervalSeconds === 0
                  ? PR_HUB_POLL_INTERVAL_SECONDS_DEFAULT
                  : prHubSettings.pollIntervalSeconds
              }
              disabled={!prHubRefreshEnabled}
              onChange={(event) => {
                const value = Math.max(
                  PR_HUB_POLL_INTERVAL_SECONDS_ENABLED_MIN,
                  Math.min(
                    PR_HUB_POLL_INTERVAL_SECONDS_MAX,
                    Math.round(Number(event.currentTarget.value) || 0),
                  ),
                );
                void updatePrHubSettings({ pollIntervalSeconds: value });
              }}
              aria-label="PR Hub refresh interval in seconds"
            />
            <Switch
              checked={prHubRefreshEnabled}
              onCheckedChange={(checked) =>
                void updatePrHubSettings({
                  pollIntervalSeconds: checked ? PR_HUB_POLL_INTERVAL_SECONDS_DEFAULT : 0,
                })
              }
              aria-label="Auto-refresh PR Hub"
            />
          </div>
        }
      />
      <SettingsRow
        title="Discover PRs from GitHub notifications"
        description="Include notification subjects, including mentions. Never marks GitHub notifications as read."
        control={
          <Switch
            aria-label="Discover PRs from GitHub notifications"
            checked={prHubSettings.discoverNotifications ?? false}
            onCheckedChange={(checked) =>
              void updatePrHubSettings({ discoverNotifications: checked })
            }
          />
        }
      />
      <SettingsRow
        title="Flag my PRs as stalled after"
        description="Hours waiting; 0 disables. Filters and sorts only, without notifications."
        control={
          <Input
            className="h-8 w-20"
            type="number"
            min={0}
            max={720}
            step={1}
            aria-label="Flag my PRs as stalled after"
            value={settings.prHubStalledAfterHours}
            onChange={(event) =>
              void updateSettings({
                prHubStalledAfterHours: Math.max(
                  0,
                  Math.min(720, Math.round(Number(event.currentTarget.value) || 0)),
                ),
              })
            }
          />
        }
      />
      <div className="space-y-2 border-b border-border py-3 last:border-b-0">
        <div>
          <p className="text-sm font-medium text-foreground">Excluded repositories</p>
          <p className="text-ui text-muted-foreground">
            One <code>owner/repo</code> per line. Excluded PRs are dropped before persistence.
          </p>
        </div>
        <Textarea
          aria-label="Excluded repositories"
          className="min-h-24 font-mono text-xs"
          value={excludeReposDraft}
          onChange={(event) => setExcludeReposDraft(event.currentTarget.value)}
          onBlur={saveExcludeRepos}
          placeholder="owner/repo"
        />
      </div>
      <SettingsRow
        title="Clear PR Hub data"
        description="Clears monitoring records for the selected GitHub account. Drafts, operations and manually tracked PRs are retained."
        control={
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => {
              if (
                !window.confirm(
                  "Clear monitoring data for the selected GitHub account? Saved review work and manually tracked PRs will remain.",
                )
              )
                return;
              void ensureNativeApi()
                .prHub.clearData({})
                .then(() => {
                  void queryClient.invalidateQueries({ queryKey: ["prHub"] });
                  toastManager.add({ type: "success", title: "PR Hub data cleared" });
                })
                .catch((error) => {
                  toastManager.add({
                    type: "error",
                    title: "Could not clear PR Hub data",
                    description: errorMessage(error),
                  });
                });
            }}
          >
            Clear data
          </Button>
        }
      />
    </SettingsCard>
  );
}
