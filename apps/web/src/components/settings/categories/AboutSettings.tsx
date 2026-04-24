import { useNavigate } from "@tanstack/react-router";

import { APP_VERSION } from "../../../branding";
import { Button } from "../../ui/button";
import { useSettingsRouteContext } from "../SettingsRouteContext";

export function AboutSettings() {
  const navigate = useNavigate();
  const { settings, updateSettings } = useSettingsRouteContext();
  const showResetOnboardingButton =
    settings.onboardingLiteStatus !== "eligible" && settings.onboardingLiteStatus !== "reopened";

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">About</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Application version and environment information.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
        <div>
          <p className="text-sm font-medium text-foreground">Version</p>
          <p className="text-xs text-muted-foreground">Current version of the application.</p>
        </div>
        <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
      </div>

      {showResetOnboardingButton ? (
        <div className="mt-4 flex justify-end">
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
