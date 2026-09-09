import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";

import { useProfileState } from "../profileState";
import { ProfileAvatar } from "./profiles/ProfileAvatar";
import { ProfileLaunchCommandButton } from "./profiles/ProfileLaunchCommandButton";
import { ProfileOpenButton } from "./profiles/ProfileOpenButton";
import { profileLocationLabel, profileStatusPresentation } from "./profiles/profileStatus";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Separator } from "./ui/separator";

export function ProfileSwitcher() {
  const { active, profiles, mismatch } = useProfileState();

  if (mismatch)
    return (
      <Alert variant="warning" className="no-drag max-w-sm">
        <TriangleAlertIcon />
        <AlertTitle>Profile changed</AlertTitle>
        <AlertDescription>This server is now serving a different profile.</AlertDescription>
        <AlertAction>
          <Button size="xs" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </AlertAction>
      </Alert>
    );

  if (!active) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="xs" className="no-drag gap-1.5" aria-label="Switch profile">
            <ProfileAvatar profile={active} size="sm" />
            <span className="max-w-28 truncate">{active.name}</span>
            <ChevronsUpDownIcon className="size-3 opacity-60" />
          </Button>
        }
      />
      <PopoverPopup className="w-80 p-0" align="start">
        <p className="px-3 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Profiles
        </p>
        <div className="px-1 pb-1">
          {profiles.map((profile) => {
            const status = profileStatusPresentation(profile);
            const ready = profile.status === "ready";
            return (
              <div
                key={profile.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent"
              >
                <ProfileAvatar profile={profile} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{profile.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {profile.slug} · {profileLocationLabel(profile)}
                  </p>
                </div>
                {profile.isActive ? (
                  <CheckIcon
                    className="size-3.5 shrink-0 text-primary"
                    aria-label="Active profile"
                  />
                ) : null}
                {!ready ? (
                  <Badge variant={status.badge} size="sm">
                    {status.label}
                  </Badge>
                ) : null}
                {!profile.isActive && ready ? (
                  <ProfileOpenButton profile={profile} variant="outline" />
                ) : null}
                {ready ? <ProfileLaunchCommandButton profile={profile} /> : null}
              </div>
            );
          })}
        </div>
        <Separator />
        <div className="flex items-center justify-between gap-2 p-2">
          <Button
            variant="ghost"
            size="xs"
            render={<Link to="/settings" search={{ category: "profiles" }} />}
          >
            Manage profiles
          </Button>
          <Button size="xs" render={<Link to="/settings" search={{ category: "profiles" }} />}>
            <PlusIcon className="size-3" />
            New profile
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
