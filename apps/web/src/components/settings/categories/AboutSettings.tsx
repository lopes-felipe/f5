import { CliCommandSettings } from "../CliCommandSettings";
import { useDesktopUpdate } from "../../sidebar/useDesktopUpdate";
import {
  getDesktopUpdateStatusSummary,
  isAboutUpdateActionDisabled,
  resolveAboutUpdateAction,
} from "../../desktopUpdate.logic";
import { Switch } from "../../ui/switch";
import { useNavigate } from "@tanstack/react-router";

import { APP_VERSION } from "../../../branding";
import { Button } from "../../ui/button";
import { useSettingsRouteContext } from "../SettingsRouteContext";

export { ABOUT_SETTINGS_DESCRIPTORS } from "./AboutSettings.descriptors";

export function AboutSettings() {
  const navigate = useNavigate();
  const updates = useDesktopUpdate();
  const state = updates.state;
  const canCheck = typeof window.desktopBridge?.checkForUpdates === "function";
  const canSetChannel = typeof window.desktopBridge?.setUpdateChannel === "function";
  const action = state ? resolveAboutUpdateAction(state) : "none";
  const { settings, updateSettings } = useSettingsRouteContext();
  const showResetOnboardingButton =
    settings.onboardingLiteStatus !== "eligible" && settings.onboardingLiteStatus !== "reopened";

  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      data-settings-search-target="about.version"
    >
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">About</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Application version and environment information.
        </p>
      </div>

      <div className="flex items-center justify-between border-b border-border py-2 last:border-b-0">
        <div>
          <p className="text-sm font-medium text-foreground">Version</p>
          <p className="text-xs text-muted-foreground">Current version of the application.</p>
        </div>
        <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
      </div>

      {state && canCheck ? (
        <div className="border-b border-border py-3" data-settings-search-target="about.updates">
          <p className="text-sm font-medium">Updates</p>
          <p className="text-xs text-muted-foreground" role="status">
            {getDesktopUpdateStatusSummary(state)}
          </p>
          {state.availableVersion && state.releaseNotes ? (
            <p className="my-2 whitespace-pre-wrap text-xs">{state.releaseNotes}</p>
          ) : null}
          <Button
            className="mt-2"
            size="xs"
            variant="outline"
            disabled={isAboutUpdateActionDisabled(state)}
            onClick={updates.handleAboutAction}
          >
            {state.status === "preparing"
              ? "Preparing update…"
              : state.status === "checking"
                ? "Checking…"
                : state.status === "downloading"
                  ? "Downloading…"
                  : action === "download"
                    ? "Download update"
                    : action === "install"
                      ? "Restart to update"
                      : "Check for updates"}
          </Button>
        </div>
      ) : null}
      {state && canSetChannel ? (
        <div
          className="flex items-center justify-between gap-4 py-3"
          data-settings-search-target="about.betaUpdates"
        >
          <div>
            <p className="text-sm font-medium">Beta updates</p>
            <p className="text-xs text-muted-foreground">
              Receive pre-release builds. Turning this off keeps your current version until a newer
              stable release ships.
            </p>
          </div>
          <Switch
            aria-label="Beta updates"
            checked={state.channel === "beta"}
            disabled={
              updates.channelPending ||
              state.status === "checking" ||
              state.status === "preparing" ||
              state.status === "downloading"
            }
            onCheckedChange={(checked) => {
              void updates.setChannel(checked ? "beta" : "stable");
            }}
          />
        </div>
      ) : null}

      <CliCommandSettings />

      {showResetOnboardingButton ? (
        <div className="mt-4 flex justify-end" data-settings-search-target="about.onboarding">
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              updateSettings({ onboardingLiteStatus: "reopened" });
              void navigate({ to: "/" });
            }}
          >
            Show onboarding again
          </Button>
        </div>
      ) : null}
    </section>
  );
}
