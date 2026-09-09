import type { ProfileSummary } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { canSwitchProfile } from "../../profileActions";
import { profileBrowserUrl } from "../../profileState";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Opens a profile, hiding the desktop-bridge-vs-browser fork behind one
 * component. In the desktop app this switches the current window; in a browser
 * the profile is served on its own port, so it opens as a real link.
 */
export function ProfileOpenButton({
  profile,
  variant = "default",
  disabled = false,
}: {
  readonly profile: ProfileSummary;
  readonly variant?: "default" | "outline" | "ghost";
  readonly disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const label = `Open ${profile.name}`;

  if (!canSwitchProfile()) {
    return (
      <Button
        size="xs"
        variant={variant}
        aria-label={label}
        disabled={disabled}
        render={<a href={profileBrowserUrl(profile)} target="_blank" rel="noreferrer" />}
      >
        Open
        <ExternalLinkIcon className="size-3" />
      </Button>
    );
  }

  return (
    <Button
      size="xs"
      variant={variant}
      aria-label={label}
      disabled={disabled || pending}
      onClick={() => {
        setPending(true);
        void window.desktopBridge!.switchProfile!(profile.id)
          .catch((cause: unknown) =>
            toastManager.add({
              type: "error",
              title: "Could not open profile",
              description: cause instanceof Error ? cause.message : String(cause),
            }),
          )
          .finally(() => setPending(false));
      }}
    >
      Open
    </Button>
  );
}
