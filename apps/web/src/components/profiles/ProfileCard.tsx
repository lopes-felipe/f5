import type { ProfileSummary } from "@t3tools/contracts";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { canStopProfile, stopProfile } from "../../profileActions";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ProfileAvatar } from "./ProfileAvatar";
import { ProfileEditPanel } from "./ProfileEditPanel";
import { ProfileLaunchCommandButton } from "./ProfileLaunchCommandButton";
import { ProfileOpenButton } from "./ProfileOpenButton";
import {
  isProfileEditable,
  profileLocationLabel,
  profileStatusPresentation,
  profileWarnings,
} from "./profileStatus";

export function ProfileCard({
  profile,
  profiles,
  disabled,
  onRequestRemove,
}: {
  readonly profile: ProfileSummary;
  readonly profiles: readonly ProfileSummary[];
  /** Registry-level lock (a diagnostic is present). */
  readonly disabled: boolean;
  readonly onRequestRemove: (profile: ProfileSummary) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const status = profileStatusPresentation(profile);
  const warnings = profileWarnings(profile);
  const editable = isProfileEditable(profile);
  // Stopping the active profile would kill the window the user is in.
  const showStop = canStopProfile() && !profile.isActive && profile.status === "ready";

  return (
    <div
      className={cn("border-t border-border first:border-t-0", profile.isActive && "bg-primary/4")}
      data-profile-id={profile.id}
    >
      <Collapsible open={isEditing} onOpenChange={setIsEditing}>
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-h-5 flex-wrap items-center gap-2">
              <ProfileAvatar profile={profile} />
              <h3 className="truncate text-sm font-medium text-foreground">{profile.name}</h3>
              {profile.isActive ? (
                <Badge variant="success" size="sm">
                  Active
                </Badge>
              ) : null}
              {profile.isDefault ? (
                <Badge variant="outline" size="sm">
                  Default
                </Badge>
              ) : null}
              {status.busy ? (
                <Badge variant={status.badge} size="sm">
                  <Spinner className="size-3" />
                  {status.label}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <code className="rounded bg-muted/60 px-1 py-0.5 text-[10px]">{profile.slug}</code>
              <span>{profileLocationLabel(profile)}</span>
              <span aria-hidden>·</span>
              <span className="max-w-full truncate font-mono text-[11px]" title={profile.stateDir}>
                {profile.stateDir}
              </span>
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {!profile.isActive && profile.status === "ready" ? (
              <ProfileOpenButton profile={profile} />
            ) : null}
            <ProfileLaunchCommandButton profile={profile} />
            {showStop ? (
              <Button
                size="xs"
                variant="outline"
                disabled={stopping}
                onClick={() => {
                  setStopping(true);
                  void stopProfile(profile)
                    .catch((cause: unknown) =>
                      toastManager.add({
                        type: "error",
                        title: "Could not stop profile",
                        description: cause instanceof Error ? cause.message : String(cause),
                      }),
                    )
                    .finally(() => setStopping(false));
                }}
              >
                Stop
              </Button>
            ) : null}
            <CollapsibleTrigger
              disabled={!editable}
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${profile.name}`}
                  aria-expanded={isEditing}
                  disabled={!editable}
                >
                  <ChevronDownIcon
                    className={cn("size-3.5 transition-transform", isEditing && "rotate-180")}
                  />
                </Button>
              }
            />
          </div>
        </div>

        {status.detail ? (
          <p className="px-5 pb-4 text-xs text-muted-foreground">{status.detail}</p>
        ) : null}

        {warnings.length > 0 ? (
          <div className="space-y-2 px-5 pb-4">
            {warnings.map((warning) => (
              <Alert key={warning.key} variant="warning" className="text-xs">
                <TriangleAlertIcon />
                <AlertTitle>{warning.title}</AlertTitle>
                <AlertDescription>
                  <span className="break-all">{warning.detail}</span>
                </AlertDescription>
              </Alert>
            ))}
          </div>
        ) : null}

        <CollapsibleContent>
          <ProfileEditPanel
            profile={profile}
            profiles={profiles}
            disabled={disabled || !editable}
            onRequestRemove={() => onRequestRemove(profile)}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
