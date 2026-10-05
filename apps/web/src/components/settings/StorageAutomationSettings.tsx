import type {
  ServerSettingsPatch,
  StorageAutomationAuditEntry,
  StorageAutomationTarget,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { RetentionDaysInput, WorktreeCleanupRulesEditor } from "./WorktreeCleanupRulesEditor";

const auditQueryKey = ["storage", "automation-audit"] as const;

const JOB_LABELS = {
  "worktree-cleanup": "Worktree",
  "provider-logs": "Provider logs",
  "auto-pull": "Auto-pull",
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
  const storageCleanup = useSettings((settings) => settings.storageCleanup);
  const autoPullDefaultBranch = useSettings((settings) => settings.autoPullDefaultBranch);
  const { updateSettings } = useUpdateSettings();
  const queryClient = useQueryClient();

  const save = (patch: Parameters<typeof updateSettings>[0]) =>
    void updateSettings(patch).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not save storage automation",
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
  const audit = useQuery({
    queryKey: auditQueryKey,
    queryFn: () => ensureNativeApi().storage.automationAudit({ limit: 50 }),
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

      <label className="flex items-center justify-between gap-4 py-2">
        <span>Automatic storage cleanup</span>
        <Switch
          aria-label="Automatic storage cleanup"
          checked={storageCleanup.enabled}
          onCheckedChange={(enabled) => saveCleanup({ enabled })}
        />
      </label>

      <fieldset disabled={rulesDisabled} className="space-y-1 disabled:opacity-60">
        <legend className="text-xs font-medium text-muted-foreground">
          Remove a worktree when any rule matches (projects can override these)
        </legend>
        <WorktreeCleanupRulesEditor
          rules={storageCleanup.worktree}
          disabled={rulesDisabled}
          onChange={(worktree) => saveCleanup({ worktree })}
        />
        <label className="flex items-center justify-between gap-4 py-2">
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
      </fieldset>

      <label className="flex items-center justify-between gap-4 py-2">
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

      <label
        className="flex items-center justify-between gap-4 border-t border-border pt-4"
        data-settings-search-target="storage.auto-pull"
      >
        <span>
          Auto-pull default branches
          <span className="block text-xs text-muted-foreground">
            Every 15 minutes, fast-forwards a project root that has its default branch checked out,
            a clean tree and no agent working in it. Never merges or rebases.
          </span>
        </span>
        <Switch
          aria-label="Auto-pull default branches"
          checked={autoPullDefaultBranch}
          onCheckedChange={(value) => save({ autoPullDefaultBranch: value })}
        />
      </label>

      <div className="flex items-center gap-2 border-t border-border pt-4">
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

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">Recent activity</h3>
        {audit.data && audit.data.entries.length > 0 ? (
          <ul aria-label="Automatic cleanup activity" className="mt-1 space-y-1 text-xs">
            {audit.data.entries.map((entry) => (
              <li key={entry.auditId} className="flex gap-2">
                <time className="shrink-0 text-muted-foreground" dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleString()}
                </time>
                <span className="shrink-0 font-medium">
                  {JOB_LABELS[entry.job]}: {RESULT_LABELS[entry.result]}
                </span>
                <span className="truncate font-mono">{entry.target}</span>
                {entry.reason ? (
                  <span className="text-muted-foreground">{entry.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {audit.isError ? errorMessage(audit.error) : "No automatic cleanup or pulls yet."}
          </p>
        )}
      </div>
    </section>
  );
}
