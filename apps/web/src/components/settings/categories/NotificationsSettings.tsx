import {
  GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_DEFAULT,
  GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_ENABLED_MIN,
  GIT_STATUS_AUTO_REFRESH_INTERVAL_SECONDS_MAX,
  buildAppSettingsPatch,
} from "../../../appSettings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { prHubQueryKeys } from "../../../lib/prHubReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "../../../lib/serverReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";

export { NOTIFICATIONS_SETTINGS_DESCRIPTORS } from "./NotificationsSettings.descriptors";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";

const PR_HUB_POLL_INTERVAL_SECONDS_DEFAULT = 180;
const PR_HUB_POLL_INTERVAL_SECONDS_ENABLED_MIN = 60;
const PR_HUB_POLL_INTERVAL_SECONDS_MAX = 3600;

const NOTIFICATION_KEYS = [
  "enableThreadStatusNotifications",
  "enablePrAttentionNotifications",
] as const;
const GIT_REFRESH_KEYS = [
  "enableGitStatusAutoRefresh",
  "gitStatusAutoRefreshIntervalSeconds",
] as const;

export function NotificationsSettings() {
  const {
    settings,
    defaults,
    updateSettings,
    notificationPermission,
    notificationPermissionSummary,
    isRequestingNotificationPermission,
    requestNotificationPermission,
  } = useSettingsRouteContext();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const queryClient = useQueryClient();
  const gitAutoRefreshEnabled = settings.enableGitStatusAutoRefresh;
  const prHubSettings = serverConfigQuery.data?.settings?.prHub ?? {
    pollIntervalSeconds: PR_HUB_POLL_INTERVAL_SECONDS_DEFAULT,
    excludeRepos: [],
  };
  const prHubRefreshEnabled = prHubSettings.pollIntervalSeconds !== 0;
  const [excludeReposDraft, setExcludeReposDraft] = useState(prHubSettings.excludeRepos.join("\n"));
  const notificationsEnabled =
    settings.enableThreadStatusNotifications || settings.enablePrAttentionNotifications;

  useEffect(() => {
    setExcludeReposDraft(prHubSettings.excludeRepos.join("\n"));
  }, [prHubSettings.excludeRepos]);

  const updatePrHubSettings = async (patch: Partial<typeof prHubSettings>) => {
    const nextPrHubSettings = {
      ...prHubSettings,
      ...patch,
    };
    const nextSettings = await ensureNativeApi().server.updateSettings({
      prHub: nextPrHubSettings,
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
    <>
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Notifications</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Local browser notifications while F5 is open but not focused.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Thread status notifications</p>
              <p className="text-xs text-muted-foreground">
                Notify when a thread reaches a sidebar status such as pending approval, awaiting
                input, plan ready, or completed.
              </p>
            </div>
            <Switch
              checked={settings.enableThreadStatusNotifications}
              onCheckedChange={(checked) =>
                updateSettings({
                  enableThreadStatusNotifications: Boolean(checked),
                })
              }
              aria-label="Thread status notifications"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">PR attention notifications</p>
              <p className="text-xs text-muted-foreground">
                Notify when PR Hub finds a pull request that needs your action.
              </p>
            </div>
            <Switch
              checked={settings.enablePrAttentionNotifications}
              onCheckedChange={(checked) =>
                updateSettings({
                  enablePrAttentionNotifications: Boolean(checked),
                })
              }
              aria-label="PR attention notifications"
            />
          </div>

          <div className="rounded-lg border border-border bg-background px-3 py-3">
            <p className="text-xs font-medium text-foreground">Permission status</p>
            <p className="mt-1 text-xs text-muted-foreground capitalize">
              {notificationPermissionSummary}
            </p>
            {notificationPermission === "unsupported" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Notifications are unavailable in this environment.
              </p>
            ) : null}
            {notificationPermission === "denied" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Permission is currently denied in the browser. Re-enable it in your browser or
                desktop shell settings to resume notifications.
              </p>
            ) : null}
            {notificationPermission === "default" ? (
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="xs"
                  onClick={requestNotificationPermission}
                  disabled={!notificationsEnabled || isRequestingNotificationPermission}
                >
                  {isRequestingNotificationPermission ? "Requesting..." : "Enable notifications"}
                </Button>
                {!notificationsEnabled ? (
                  <span className="text-xs text-muted-foreground">
                    Turn a notification feature on before requesting permission.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {settings.enableThreadStatusNotifications !== defaults.enableThreadStatusNotifications ||
        settings.enablePrAttentionNotifications !== defaults.enablePrAttentionNotifications ? (
          <div className="mt-3 flex justify-end">
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(NOTIFICATION_KEYS, defaults))}
            >
              Restore default
            </Button>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Git</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Control background git status refresh behavior.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background px-3 py-2">
          <div>
            <p className="text-sm font-medium text-foreground">Auto-refresh git status</p>
            <p className="text-xs text-muted-foreground">
              {gitAutoRefreshEnabled
                ? `Keeps local git status refreshed every ${settings.gitStatusAutoRefreshIntervalSeconds} seconds.`
                : "Stops background refreshes, but git status still loads when opened and after explicit git actions."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
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
                updateSettings({
                  gitStatusAutoRefreshIntervalSeconds: value,
                });
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
        </div>

        {settings.enableGitStatusAutoRefresh !== defaults.enableGitStatusAutoRefresh ||
        settings.gitStatusAutoRefreshIntervalSeconds !==
          defaults.gitStatusAutoRefreshIntervalSeconds ? (
          <div className="mt-3 flex justify-end">
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(GIT_REFRESH_KEYS, defaults))}
            >
              Restore default
            </Button>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">PR Hub</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Control GitHub polling, privacy exclusions, and stored PR Hub data.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Auto-refresh PR Hub</p>
              <p className="text-xs text-muted-foreground">
                {prHubRefreshEnabled
                  ? `Checks GitHub every ${prHubSettings.pollIntervalSeconds} seconds.`
                  : "Stops scheduled GitHub polling. Manual refresh still works."}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
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
          </div>

          <div className="rounded-lg border border-border bg-background px-3 py-3">
            <div className="mb-2">
              <p className="text-sm font-medium text-foreground">Excluded repositories</p>
              <p className="text-xs text-muted-foreground">
                One `owner/repo` per line. Excluded PRs are dropped before persistence.
              </p>
            </div>
            <Textarea
              className="min-h-24 font-mono text-xs"
              value={excludeReposDraft}
              onChange={(event) => setExcludeReposDraft(event.currentTarget.value)}
              onBlur={saveExcludeRepos}
              placeholder="owner/repo"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background px-3 py-2">
            <div>
              <p className="text-sm font-medium text-foreground">Clear PR Hub data</p>
              <p className="text-xs text-muted-foreground">
                Removes persisted PR Hub rows, snoozes, and notification fingerprints.
              </p>
            </div>
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => {
                if (!window.confirm("Clear all persisted PR Hub data?")) return;
                void ensureNativeApi()
                  .prHub.clearData({})
                  .then((snapshot) => {
                    queryClient.setQueryData(prHubQueryKeys.snapshot, snapshot);
                    toastManager.add({ type: "success", title: "PR Hub data cleared" });
                  })
                  .catch((error) => {
                    toastManager.add({
                      type: "error",
                      title: "Could not clear PR Hub data",
                      description: error instanceof Error ? error.message : String(error),
                    });
                  });
              }}
            >
              Clear data
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
