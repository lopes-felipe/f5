import { useState } from "react";
import type {
  ServerSettingsPatch,
  StorageAutomationAuditEntry,
  StorageAutomationTarget,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";

import { Link } from "@tanstack/react-router";

import { useSettings } from "../../hooks/useSettings";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { rpcQueryContext, rpcQueryMeta } from "../../lib/rpcQueryContext";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { RetentionDaysInput, WorktreeCleanupRulesEditor } from "./WorktreeCleanupRulesEditor";

const auditQueryKey = ["storage", "automation-audit"] as const;

const JOB_LABELS = {
  "worktree-cleanup": "Worktree",
  "provider-logs": "Provider logs",
  "auto-pull": "Auto-pull",
  "codex-marketplace-staging": "Codex marketplace staging",
  "event-compaction": "Event compaction",
  "thread-purge": "Thread purge",
  "database-vacuum": "Database space",
} as const satisfies Record<StorageAutomationTarget["job"], string>;

const ACTION_LABELS = {
  remove: "Would remove",
  pull: "Would pull",
  skip: "Skipped",
} as const satisfies Record<StorageAutomationTarget["action"], string>;

const RESULT_LABELS = {
  removed: "Removed",
  pulled: "Pulled",
  skipped: "Skipped",
  failed: "Failed",
} as const satisfies Record<StorageAutomationAuditEntry["result"], string>;

export function describeAutomationTarget(target: StorageAutomationTarget): string {
  return `${ACTION_LABELS[target.action]}: ${target.reason}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function StorageAutomationSettings() {
  const scheduledBackupsEnabled = useSettings((settings) => settings.scheduledBackupsEnabled);
  const storageCleanup = useSettings((settings) => settings.storageCleanup);
  const autoPullDefaultBranch = useSettings((settings) => settings.autoPullDefaultBranch);
  const queryClient = useQueryClient();
  const saveScheduledBackups = (enabled: boolean) =>
    void ensureNativeApi()
      .server.updateSettings({ scheduledBackupsEnabled: enabled })
      .then((settings) =>
        queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
          existing ? { ...existing, settings } : existing,
        ),
      )
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not save scheduled backups",
          description: errorMessage(error),
        }),
      );

  // Send only the changed fields; the server deep-merges them. Spreading the
  // rendered `storageCleanup` would let a second quick edit revert the first.
  const saveCleanup = (next: NonNullable<ServerSettingsPatch["storageCleanup"]>) =>
    void ensureNativeApi()
      .server.updateSettings({ storageCleanup: next })
      .then((settings) =>
        queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
          existing ? { ...existing, settings } : existing,
        ),
      )
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not save storage automation",
          description: errorMessage(error),
        }),
      );

  const dryRun = useMutation({
    mutationFn: () => ensureNativeApi().storage.automationDryRun(),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not preview automatic cleanup",
        description: errorMessage(error),
      }),
  });
  const [activityLimit, setActivityLimit] = useState(10);
  const [activitySource, setActivitySource] = useState<"automatic" | "manual" | "all">("all");
  const audit = useQuery({
    queryKey: [...auditQueryKey, activityLimit, activitySource],
    queryFn: (context) =>
      ensureNativeApi().storage.automationAudit(
        {
          limit: activityLimit,
          ...(activitySource !== "all" ? { source: activitySource } : {}),
        },
        rpcQueryContext(context),
      ),
    meta: rpcQueryMeta("refresh-background"),
    refetchInterval: 30_000,
  });

  const rulesDisabled = !storageCleanup.enabled;

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-5"
      data-settings-search-target="storage.automation"
    >
      <div>
        <h2 className="text-sm font-medium text-foreground">Automatic cleanup</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Removes idle F5 worktrees by the rules below, hourly and at startup. A worktree is kept
          when it has uncommitted changes, ignored files other than <code>node_modules/</code>, an
          open terminal or agent session, queued turns, or another thread using it. The branch is
          always kept, and the thread recreates its worktree on the next message.
        </p>
      </div>

      <label className="flex items-center justify-between gap-4 py-2 text-sm">
        <span>Automatic storage cleanup</span>
        <Switch
          aria-label="Automatic storage cleanup"
          checked={storageCleanup.enabled}
          onCheckedChange={(enabled) => saveCleanup({ enabled })}
        />
      </label>

      <label className="flex items-center justify-between gap-4 py-2 text-sm">
        <span>
          Daily backups
          <span className="block text-xs text-muted-foreground">
            Retain seven successful archives in this profile’s backups folder. Credentials are
            excluded. Runs while F5 is open.
          </span>
        </span>
        <Switch
          aria-label="Daily backups"
          checked={scheduledBackupsEnabled}
          onCheckedChange={saveScheduledBackups}
        />
      </label>
      <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
        <p>
          Last successful daily backup:{" "}
          {audit.data?.scheduledBackupStatus?.lastSuccessAt
            ? new Date(audit.data.scheduledBackupStatus.lastSuccessAt).toLocaleString()
            : "None recorded"}
        </p>
        {audit.data?.scheduledBackupStatus?.lastAttemptAt && (
          <p>
            Last attempt:{" "}
            {new Date(audit.data.scheduledBackupStatus.lastAttemptAt).toLocaleString()}
          </p>
        )}
        {audit.data?.scheduledBackupStatus?.lastError && (
          <p role="alert" className="whitespace-pre-wrap text-destructive">
            Daily backup failed: {audit.data.scheduledBackupStatus.lastError}
          </p>
        )}
        {audit.isError && (
          <p role="alert">
            Could not load daily backup status.{" "}
            <Button size="xs" onClick={() => void audit.refetch()}>
              Try again
            </Button>
          </p>
        )}
      </div>
      <fieldset disabled={rulesDisabled} className="space-y-1 disabled:opacity-60">
        <legend className="text-xs font-medium text-muted-foreground">
          Remove a worktree when any rule matches (projects can override these)
        </legend>
        <WorktreeCleanupRulesEditor
          rules={storageCleanup.worktree}
          disabled={rulesDisabled}
          onChange={(worktree) => saveCleanup({ worktree })}
        />
        <label className="flex items-center justify-between gap-4 py-2 text-sm">
          <span>
            Remove inactive F5 worktrees and prune missing entries hourly
            <span className="block text-xs text-muted-foreground">
              Runs the Storage cleanup below for merged or pushed worktrees that are orphaned or
              used only by archived threads. Build output and each project's disposable paths are
              discarded, and a merged branch is deleted unless an archived thread uses it. Worktrees
              outside F5's worktrees folder are never removed automatically.
            </span>
          </span>
          <Switch
            aria-label="Remove inactive F5 worktrees hourly"
            checked={storageCleanup.inactiveWorktrees}
            disabled={rulesDisabled}
            onCheckedChange={(inactiveWorktrees) => saveCleanup({ inactiveWorktrees })}
          />
        </label>
        <label className="flex items-center justify-between gap-4 py-2 text-sm">
          <span>
            Delete provider logs after
            <span className="block text-xs text-muted-foreground">
              Per-thread agent logs and rotated event logs.
            </span>
          </span>
          <RetentionDaysInput
            label="Delete provider logs after"
            value={storageCleanup.providerLogsAfterDays}
            disabled={rulesDisabled}
            onCommit={(providerLogsAfterDays) => saveCleanup({ providerLogsAfterDays })}
          />
        </label>
        <label className="flex items-center justify-between gap-4 py-2 text-sm">
          <span>
            Permanently delete archived threads after
            <span className="block text-xs text-muted-foreground">
              Days since archiving. Empty keeps archived threads.
            </span>
          </span>
          <RetentionDaysInput
            label="Permanently delete archived threads after"
            value={storageCleanup.archivedThreadsPurgeAfterDays}
            disabled={rulesDisabled}
            onCommit={(archivedThreadsPurgeAfterDays) =>
              saveCleanup({ archivedThreadsPurgeAfterDays })
            }
          />
        </label>
      </fieldset>

      <div className="space-y-1 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">
          These run hourly even when automatic cleanup is off: they remove only what no thread can
          open again. F5 also compacts finished threads' event history and returns free database
          space to the disk.
        </p>
        <label className="flex items-center justify-between gap-4 py-2 text-sm">
          <span>
            Purge deleted threads after
            <span className="block text-xs text-muted-foreground">
              Days since deletion. Empty never purges.
            </span>
          </span>
          <RetentionDaysInput
            label="Purge deleted threads after"
            value={storageCleanup.deletedThreadsPurgeAfterDays}
            onCommit={(deletedThreadsPurgeAfterDays) =>
              saveCleanup({ deletedThreadsPurgeAfterDays })
            }
          />
        </label>
        <label className="flex items-center justify-between gap-4 py-2 text-sm">
          <span>
            Delete logs of deleted threads after
            <span className="block text-xs text-muted-foreground">
              Days since the log was last written. With automatic cleanup on, archived threads' logs
              go too. Empty keeps them.
            </span>
          </span>
          <RetentionDaysInput
            label="Delete logs of deleted threads after"
            value={storageCleanup.terminalThreadLogsAfterDays}
            onCommit={(terminalThreadLogsAfterDays) => saveCleanup({ terminalThreadLogsAfterDays })}
          />
        </label>
      </div>

      <label className="flex items-center justify-between gap-4 py-2 text-sm">
        <span>
          Keep preview screenshots and recordings for
          <span className="block text-xs text-muted-foreground">
            Desktop app only. Empty keeps the 7-day default.
          </span>
        </span>
        <RetentionDaysInput
          label="Keep preview screenshots and recordings for"
          value={storageCleanup.previewArtifactRetentionDays}
          placeholder="7"
          onCommit={(previewArtifactRetentionDays) => saveCleanup({ previewArtifactRetentionDays })}
        />
      </label>

      <p className="border-t border-border pt-4 text-xs text-muted-foreground">
        Auto-pull of default branches is set in{" "}
        <Link
          to="/settings"
          search={{ category: "git", item: "git.auto-pull" }}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Git &amp; GitHub
        </Link>
        . Its pulls appear in the preview and activity below.
      </p>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={dryRun.isPending}
          onClick={() => dryRun.mutate()}
        >
          {dryRun.isPending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          Preview what would run
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void audit.refetch()}>
          Refresh activity
        </Button>
      </div>

      {dryRun.data ? (
        <div aria-label="Automatic cleanup preview" className="space-y-1">
          {dryRun.data.targets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {dryRun.data.storageCleanupEnabled || autoPullDefaultBranch
                ? "Nothing matches right now."
                : "Automatic cleanup and auto-pull are off."}
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {dryRun.data.targets.map((target) => (
                <li
                  key={`${target.job}:${target.target}:${target.threadId ?? ""}`}
                  className="flex gap-2"
                >
                  <span className="shrink-0 font-medium">{JOB_LABELS[target.job]}</span>
                  <span className="truncate font-mono">{target.target}</span>
                  <span className="text-muted-foreground">{describeAutomationTarget(target)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <details>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Activity
        </summary>
        <label className="mt-2 block text-xs text-muted-foreground">
          Source{" "}
          <select
            aria-label="Activity source"
            value={activitySource}
            onChange={(event) =>
              setActivitySource(event.currentTarget.value as typeof activitySource)
            }
          >
            <option value="all">All</option>
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        {audit.data && audit.data.entries.length > 0 ? (
          <ul aria-label="Automatic cleanup activity" className="mt-1 space-y-1 text-xs">
            {audit.data.entries.map((entry) => (
              <li key={entry.auditId} className="flex gap-2">
                <time className="shrink-0 text-muted-foreground" dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleString()}
                </time>
                <span className="shrink-0 font-medium">
                  {entry.source === "manual" ? entry.target : JOB_LABELS[entry.job]}:{" "}
                  {RESULT_LABELS[entry.result]}
                </span>
                <span className="truncate font-mono">{entry.target}</span>
                {entry.reason ? (
                  <details className="min-w-0 text-muted-foreground">
                    <summary className="line-clamp-2 cursor-pointer">{entry.reason}</summary>
                    <p>{entry.reason}</p>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {audit.isError ? errorMessage(audit.error) : "No automatic cleanup or pulls yet."}
          </p>
        )}
        {activityLimit < 200 ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setActivityLimit(activityLimit === 10 ? 50 : 200)}
          >
            Show more activity
          </Button>
        ) : null}
      </details>
    </section>
  );
}
