import type { ProfileSummary } from "@t3tools/contracts";
import { useState } from "react";

import { updateProfile } from "../../profileActions";
import { AccentColorPicker } from "../settings/AccentColorPicker";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { ProfilePortField } from "./ProfilePortField";

/**
 * The collapsible editing surface for a profile.
 *
 * Name and accent commit on blur — a rename does not change the slug, so
 * `t3 --profile <slug>` keeps working and nothing restarts. Port is the one
 * field that earns an explicit action; see `ProfilePortField`.
 */
export function ProfileEditPanel({
  profile,
  profiles,
  disabled,
  onRequestRemove,
}: {
  readonly profile: ProfileSummary;
  readonly profiles: readonly ProfileSummary[];
  readonly disabled: boolean;
  readonly onRequestRemove: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const commit = (patch: { name?: string; accentColor?: string }) => {
    setError(null);
    void updateProfile(profile, patch).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  const removeBlockedReason = profile.isDefault
    ? "The default profile cannot be removed."
    : profile.isActive
      ? "Switch to another profile before removing this one."
      : null;

  return (
    <div className="border-t border-border/60 bg-background/40">
      <div className="border-b border-border/60 px-4 py-3 sm:px-5">
        <label htmlFor={`profile-${profile.id}-name`} className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Name</span>
          <DraftInput
            id={`profile-${profile.id}-name`}
            className="max-w-sm"
            value={profile.name}
            disabled={disabled}
            spellCheck={false}
            onCommit={(next) => {
              const trimmed = next.trim();
              if (trimmed.length === 0 || trimmed === profile.name) return;
              commit({ name: trimmed });
            }}
          />
          <span className="text-[11px] text-muted-foreground">
            Renaming does not change the launch command — the{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 text-[10px]">{profile.slug}</code> slug
            stays the same.
          </span>
        </label>
      </div>

      <div className="border-b border-border/60 px-4 py-3 sm:px-5">
        <AccentColorPicker
          ariaLabel={`Accent color for ${profile.name}`}
          description="Used to tell this profile apart in the switcher."
          value={profile.accentColor}
          disabled={disabled}
          allowClear={false}
          onCommit={(next) => {
            if (!next || next === profile.accentColor) return;
            commit({ accentColor: next });
          }}
        />
      </div>

      <div className="border-b border-border/60 px-4 py-3 sm:px-5">
        <ProfilePortField profile={profile} profiles={profiles} disabled={disabled} />
      </div>

      {error ? (
        <div className="px-4 py-3 sm:px-5">
          <Alert variant="error" className="text-xs">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Remove profile</p>
          <p className="text-xs text-muted-foreground">
            {removeBlockedReason ?? "Moves this profile's data to .trash."}
          </p>
        </div>
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={disabled || removeBlockedReason !== null}
          onClick={onRequestRemove}
        >
          Remove profile
        </Button>
      </div>
    </div>
  );
}
