import { unlockThreadNotificationSound } from "../../../threadAttention";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { buildAppSettingsPatch } from "../../../appSettings";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { SettingsCard, SettingsRow } from "../SettingsCard";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import {
  describeDoNotDisturb,
  DO_NOT_DISTURB_SNOOZE_LABELS,
  doNotDisturbUntilFor,
  NOTIFICATION_SOURCE_DESCRIPTIONS,
  NOTIFICATION_SOURCE_LABELS,
  NOTIFICATION_SOURCES,
  type DoNotDisturbSnooze,
  type NotificationChannelPreference,
  type NotificationSource,
} from "../../../notificationCenter/preferences";

export { NOTIFICATIONS_SETTINGS_DESCRIPTORS } from "./NotificationsSettings.descriptors";

const NOTIFICATION_KEYS = [
  "notificationPreferences",
  "showAttentionBadge",
  "doNotDisturbUntil",
  "dndAllowUrgent",
  "toastPosition",
] as const;

const SOURCE_SEARCH_TARGETS: Partial<Record<NotificationSource, string>> = {
  thread: "notifications.thread-status",
  pr: "notifications.pr-attention",
};

const CHANNELS = [
  { key: "inApp", label: "In-app" },
  { key: "system", label: "System" },
  { key: "sound", label: "Sound" },
  { key: "inbox", label: "Inbox" },
] as const satisfies ReadonlyArray<{ key: keyof NotificationChannelPreference; label: string }>;

const POSITION_LABELS = { "top-right": "Top right", "bottom-right": "Bottom right" } as const;

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
  const preferences = settings.notificationPreferences;
  const systemWanted = NOTIFICATION_SOURCES.some((source) => preferences[source].system);
  const dndSummary = describeDoNotDisturb(settings.doNotDisturbUntil, new Date());

  const setChannel = (
    source: NotificationSource,
    channel: keyof NotificationChannelPreference,
    value: boolean,
  ) => {
    // Browsers only allow audio after a gesture; this click is that gesture.
    if (channel === "sound" && value) unlockThreadNotificationSound();
    updateSettings({
      notificationPreferences: {
        ...preferences,
        [source]: { ...preferences[source], [channel]: value },
      },
    });
  };

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Notifications"
        description="In-app shows a toast while F5 is focused. System uses your OS notifications while it is in the background. Inbox keeps it in the bell's notification inbox; turning it off also hides what that source already recorded."
        searchTarget="notifications.in-app"
        actions={
          NOTIFICATION_KEYS.some(
            (key) => JSON.stringify(settings[key]) !== JSON.stringify(defaults[key]),
          ) ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(NOTIFICATION_KEYS, defaults))}
            >
              Restore defaults
            </Button>
          ) : null
        }
      >
        <div role="table" aria-label="Notification sources" className="text-sm">
          <div
            role="row"
            className="grid grid-cols-[minmax(0,1fr)_repeat(4,--spacing(16))] items-center gap-2 border-b border-border pb-2 text-xs text-muted-foreground"
          >
            <span role="columnheader">Source</span>
            {CHANNELS.map((channel) => (
              <span key={channel.key} role="columnheader" className="text-center">
                {channel.label}
              </span>
            ))}
          </div>
          {NOTIFICATION_SOURCES.map((source) => (
            <div
              key={source}
              role="row"
              className="grid grid-cols-[minmax(0,1fr)_repeat(4,--spacing(16))] items-center gap-2 border-b border-border py-2.5 last:border-b-0"
              data-settings-search-target={SOURCE_SEARCH_TARGETS[source]}
            >
              <div role="cell" className="min-w-0">
                <p className="font-medium text-foreground">{NOTIFICATION_SOURCE_LABELS[source]}</p>
                <p className="text-ui text-muted-foreground">
                  {NOTIFICATION_SOURCE_DESCRIPTIONS[source]}
                </p>
              </div>
              {CHANNELS.map((channel) => (
                <div key={channel.key} role="cell" className="flex justify-center">
                  <Switch
                    aria-label={`${NOTIFICATION_SOURCE_LABELS[source]}: ${channel.label}`}
                    checked={preferences[source][channel.key]}
                    onCheckedChange={(checked) => setChannel(source, channel.key, Boolean(checked))}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title="Delivery">
        <SettingsRow
          title="Do Not Disturb"
          description={
            dndSummary
              ? `${dndSummary}. Notifications still go to the inbox when its switch is on.`
              : "Pause toasts, system notifications and sounds. Notifications still go to the inbox when its switch is on."
          }
          control={
            <Select
              value={dndSummary ? "on" : "off"}
              onValueChange={(value) => {
                if (value === "off") updateSettings({ doNotDisturbUntil: null });
                else if (value === "1h" || value === "tomorrow" || value === "forever")
                  updateSettings({
                    doNotDisturbUntil: doNotDisturbUntilFor(
                      value as DoNotDisturbSnooze,
                      new Date(),
                    ),
                  });
              }}
            >
              <SelectTrigger className="w-56" aria-label="Do Not Disturb">
                <SelectValue>{dndSummary ?? "Off"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="off">Off</SelectItem>
                {(Object.keys(DO_NOT_DISTURB_SNOOZE_LABELS) as DoNotDisturbSnooze[]).map(
                  (snooze) => (
                    <SelectItem key={snooze} value={snooze}>
                      {DO_NOT_DISTURB_SNOOZE_LABELS[snooze]}
                    </SelectItem>
                  ),
                )}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Let approvals through"
          description="During Do Not Disturb, still notify when a thread needs approval or input."
          control={
            <Switch
              aria-label="Let approvals through"
              checked={settings.dndAllowUrgent}
              onCheckedChange={(checked) => updateSettings({ dndAllowUrgent: Boolean(checked) })}
            />
          }
        />
        <SettingsRow
          title="Toast position"
          description="Where in-app notifications appear."
          control={
            <Select
              value={settings.toastPosition}
              onValueChange={(value) => {
                if (value === "top-right" || value === "bottom-right")
                  updateSettings({ toastPosition: value });
              }}
            >
              <SelectTrigger className="w-56" aria-label="Toast position">
                <SelectValue>{POSITION_LABELS[settings.toastPosition]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="top-right">{POSITION_LABELS["top-right"]}</SelectItem>
                <SelectItem value="bottom-right">{POSITION_LABELS["bottom-right"]}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Show attention badge"
          description="Count threads needing attention on the app icon and window title."
          control={
            <Switch
              aria-label="Show attention badge"
              checked={settings.showAttentionBadge}
              onCheckedChange={(checked) =>
                updateSettings({ showAttentionBadge: Boolean(checked) })
              }
            />
          }
        />
        <div className="mt-3 rounded-lg border border-border bg-background px-3 py-3">
          <p className="text-xs font-medium text-foreground">System notification permission</p>
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
              Permission is currently denied in the browser. Re-enable it in your browser or desktop
              shell settings to resume notifications.
            </p>
          ) : null}
          {notificationPermission === "default" ? (
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="xs"
                onClick={requestNotificationPermission}
                disabled={!systemWanted || isRequestingNotificationPermission}
              >
                {isRequestingNotificationPermission ? "Requesting..." : "Enable notifications"}
              </Button>
              {!systemWanted ? (
                <span className="text-xs text-muted-foreground">
                  Turn on a System notification above before requesting permission.
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsCard>
    </div>
  );
}
