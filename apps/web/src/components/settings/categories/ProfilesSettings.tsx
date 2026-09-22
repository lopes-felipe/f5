import type { ProfileSummary } from "@t3tools/contracts";
import { PlusIcon, RotateCwIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { cn } from "../../../lib/utils";
import { removeProfile } from "../../../profileActions";
import { refreshProfiles, useProfileState } from "../../../profileState";
import { ProfileAccountsSection } from "../../profiles/ProfileAccountsSection";
import { ProfileCard } from "../../profiles/ProfileCard";
import { ProfileCreateDialog } from "../../profiles/ProfileCreateDialog";
import { ProfileRemoveDialog } from "../../profiles/ProfileRemoveDialog";
import { orderProfiles } from "../../profiles/profileStatus";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../ui/empty";
import { Skeleton } from "../../ui/skeleton";
import { toastManager } from "../../ui/toast";

export { PROFILES_SETTINGS_DESCRIPTORS } from "./ProfilesSettings.descriptors";

/** The registry keeps removed profiles under `<profiles root>/.trash`. */
function metadataRootFor(active: ProfileSummary | null): string | null {
  if (!active) return null;
  return active.isDefault
    ? `${active.stateDir}-profiles`
    : active.stateDir.replace(/[\\/][^\\/]+$/, "");
}

export function ProfilesSettings() {
  const { profiles, diagnostic, active, loadState, loadError, isRefreshing } = useProfileState();
  const [createOpen, setCreateOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProfileSummary | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  useEffect(() => {
    void refreshProfiles().catch(() => {});
  }, []);

  const metadataRoot = metadataRootFor(active);
  const ordered = orderProfiles(profiles);
  const locked = Boolean(diagnostic);

  const confirmRemove = () => {
    if (!removeTarget) return;
    setRemovePending(true);
    setRemoveError(null);
    void removeProfile(removeTarget)
      .then(() => {
        toastManager.add({ type: "success", title: "Profile removed" });
        setRemoveTarget(null);
      })
      .catch((cause: unknown) =>
        setRemoveError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setRemovePending(false));
  };

  return (
    <>
      {diagnostic ? (
        <Alert variant="error">
          <TriangleAlertIcon />
          <AlertTitle>Profile registry unavailable</AlertTitle>
          <AlertDescription>
            <p>{diagnostic.message}</p>
            <code className="break-all text-xs">{diagnostic.path}</code>
            <p>
              Creating, renaming, and removing profiles is disabled until this file is repaired.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <section
        className="rounded-2xl border border-border bg-card"
        data-settings-search-target="profiles.manage"
      >
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-foreground">Profiles</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Each profile keeps its own accounts, projects, chat history, and settings, and serves
              the app on its own port. Run another profile with its launch command.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={isRefreshing}
              onClick={() => void refreshProfiles().catch(() => {})}
            >
              <RotateCwIcon className={cn("size-3", isRefreshing && "animate-spin")} />
              Refresh
            </Button>
            <Button size="xs" disabled={locked} onClick={() => setCreateOpen(true)}>
              <PlusIcon className="size-3" />
              New profile
            </Button>
          </div>
        </div>

        {loadState === "unsupported" ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>Profiles are unavailable</EmptyTitle>
              <EmptyDescription>
                This server was started without a profiles directory.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : loadState === "error" && profiles.length === 0 ? (
          <div className="p-5">
            <Alert variant="error">
              <TriangleAlertIcon />
              <AlertTitle>Could not load profiles</AlertTitle>
              <AlertDescription>{loadError}</AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void refreshProfiles().catch(() => {})}
                >
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          </div>
        ) : loadState === "loading" ? (
          <div>
            {[0, 1, 2].map((row) => (
              <div key={row} className="border-t border-border px-5 py-4 first:border-t-0">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-2 h-3 w-64" />
              </div>
            ))}
          </div>
        ) : profiles.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>No profiles yet</EmptyTitle>
              <EmptyDescription>
                Create a profile to keep separate accounts, projects, and chat history.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="xs" disabled={locked} onClick={() => setCreateOpen(true)}>
                <PlusIcon className="size-3" />
                New profile
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div>
            {ordered.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                profiles={profiles}
                disabled={locked}
                onRequestRemove={(target) => {
                  setRemoveError(null);
                  setRemoveTarget(target);
                }}
              />
            ))}
          </div>
        )}
      </section>

      {active ? <ProfileAccountsSection profile={active} /> : null}

      {metadataRoot || active ? (
        <section
          className="rounded-2xl border border-border bg-card p-5"
          data-settings-search-target="profiles.storage"
        >
          <div className="mb-4">
            <h2 className="text-sm font-medium text-foreground">Profile storage</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Where this device keeps profile data on disk.
            </p>
          </div>
          <div className="space-y-3">
            {metadataRoot ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Removed profiles</p>
                  <p className="break-all font-mono text-[11px] text-muted-foreground">
                    {metadataRoot}/.trash
                  </p>
                </div>
              </div>
            ) : null}
            {active ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">This profile's data</p>
                  <p className="break-all font-mono text-[11px] text-muted-foreground">
                    {active.stateDir}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => copyToClipboard(active.stateDir, undefined)}
                >
                  {isCopied ? "Copied" : "Copy path"}
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <ProfileCreateDialog open={createOpen} onOpenChange={setCreateOpen} profiles={profiles} />
      <ProfileRemoveDialog
        profile={removeTarget}
        pending={removePending}
        error={removeError}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setRemoveError(null);
          }
        }}
        onConfirm={confirmRemove}
      />
    </>
  );
}
