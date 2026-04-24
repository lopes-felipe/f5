import { buildAppSettingsPatch } from "../../../appSettings";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";

const NOTIFICATION_KEYS = ["enableThreadStatusNotifications"] as const;
const GIT_REFRESH_KEYS = ["enableGitStatusAutoRefresh"] as const;

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
                  disabled={
                    !settings.enableThreadStatusNotifications || isRequestingNotificationPermission
                  }
                >
                  {isRequestingNotificationPermission ? "Requesting..." : "Enable notifications"}
                </Button>
                {!settings.enableThreadStatusNotifications ? (
                  <span className="text-xs text-muted-foreground">
                    Turn the feature on before requesting permission.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {settings.enableThreadStatusNotifications !== defaults.enableThreadStatusNotifications ? (
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
            Control background git status and PR refresh behavior.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
          <div>
            <p className="text-sm font-medium text-foreground">Auto-refresh git status</p>
            <p className="text-xs text-muted-foreground">
              {settings.enableGitStatusAutoRefresh
                ? "Keeps git status and PR state refreshed automatically."
                : "Stops background refreshes, but git status still loads when opened and after explicit git actions."}
            </p>
          </div>
          <Switch
            checked={settings.enableGitStatusAutoRefresh}
            onCheckedChange={(checked) =>
              updateSettings({
                enableGitStatusAutoRefresh: Boolean(checked),
              })
            }
            aria-label="Auto-refresh git status"
          />
        </div>

        {settings.enableGitStatusAutoRefresh !== defaults.enableGitStatusAutoRefresh ? (
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
    </>
  );
}
