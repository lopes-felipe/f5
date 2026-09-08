import { useEffect, useState } from "react";
import { type ProfileSummary } from "@t3tools/contracts";
import { ensureNativeApi } from "../../../nativeApi";
import { useProfileState, refreshProfiles, profileBrowserUrl } from "../../../profileState";
import { PROVIDER_ACCENT_SWATCHES } from "../../../providerInstances";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ProviderAccountPanel } from "../ProviderAccountPanel";
import { StorageActionConfirmDialog } from "../StorageActionConfirmDialog";

function ProfileRow({ profile, disabled }: { profile: ProfileSummary; disabled: boolean }) {
  const [name, setName] = useState(profile.name);
  const [port, setPort] = useState(String(profile.port));
  const [accentColor, setAccent] = useState(profile.accentColor ?? PROVIDER_ACCENT_SWATCHES[0]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const api = ensureNativeApi().profiles!;
  const run = async (operation: () => Promise<unknown>) => {
    setError("");
    setPending(true);
    try {
      await operation();
      await refreshProfiles();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">
        {profile.name}
        {profile.isActive ? " (active)" : ""}
      </h3>
      <p className="break-all font-mono text-xs text-muted-foreground">{profile.stateDir}</p>
      <p className="text-xs text-muted-foreground">
        {profile.slug} / {profile.status} / port {profile.port}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={`Name for ${profile.name}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          aria-label={`Port for ${profile.name}`}
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(event) => setPort(event.target.value)}
        />
        <select
          aria-label={`Accent for ${profile.name}`}
          value={accentColor}
          onChange={(event) => setAccent(event.target.value)}
        >
          {PROVIDER_ACCENT_SWATCHES.map((color) => (
            <option key={color} value={color}>
              {color}
            </option>
          ))}
        </select>
        <Button
          disabled={disabled || pending}
          onClick={() =>
            void run(() =>
              api.update({ profileId: profile.id, name, port: Number(port), accentColor }),
            )
          }
        >
          Save
        </Button>
        {!profile.isActive &&
          (window.desktopBridge?.switchProfile ? (
            <Button
              onClick={() => void run(() => window.desktopBridge!.switchProfile!(profile.id))}
            >
              Open
            </Button>
          ) : (
            <a href={profileBrowserUrl(profile)} target="_blank" rel="noreferrer">
              Open
            </a>
          ))}
        <Button onClick={() => void navigator.clipboard.writeText(`t3 --profile ${profile.slug}`)}>
          Copy launch command
        </Button>
        {window.desktopBridge?.stopProfile && (
          <Button
            disabled={pending}
            onClick={() => void run(() => window.desktopBridge!.stopProfile!(profile.id))}
          >
            Stop
          </Button>
        )}
        {!profile.isDefault && (
          <Button disabled={disabled || pending} onClick={() => setConfirm(true)}>
            Remove
          </Button>
        )}
      </div>
      {profile.invalidDirectories?.map((entry) => (
        <p key={entry.directory} role="alert" className="text-sm text-amber-600">
          {entry.directory}: {entry.reason} Update the project folder or worktree before running
          commands.
        </p>
      ))}
      {profile.sharedRepositories?.map((repository) => (
        <p key={repository.workspaceRoot} role="alert" className="text-sm text-amber-600">
          {repository.workspaceRoot} shares Git metadata with {repository.otherProfiles.join(", ")}.
          Changes to this checkout can affect both profiles.
        </p>
      ))}
      {profile.isActive && (
        <div className="space-y-3">
          <p>Sign in to the accounts this profile should use.</p>
          {profile.providerAccounts.map((account) => (
            <div key={account.instanceId}>
              <h4>
                {account.displayName}: {account.status}
                {account.identity ? ` (${account.identity})` : ""}
              </h4>
              {account.reason && <p>{account.reason}</p>}
              {account.status !== "unsupported-isolation" && (
                <ProviderAccountPanel instanceId={account.instanceId} />
              )}
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <StorageActionConfirmDialog
        action={
          confirm
            ? {
                title: `${window.desktopBridge?.stopProfile && !profile.isActive ? "Stop and remove" : "Remove"} ${profile.name}`,
                categories: [],
                description:
                  "Profile data and provider logins are moved to .trash, not deleted. Git worktrees stay registered until git worktree prune. Stop the profile before removing it.",
              }
            : null
        }
        open={confirm}
        pending={pending}
        lastResult={null}
        onOpenChange={setConfirm}
        onConfirm={() => {
          void run(async () => {
            if (window.desktopBridge?.stopProfile && !profile.isActive)
              await window.desktopBridge.stopProfile(profile.id);
            await api.remove({ profileId: profile.id });
            setConfirm(false);
          });
        }}
      />
    </section>
  );
}
export function ProfilesSettings() {
  const { profiles, diagnostic, active } = useProfileState();
  const metadataRoot = active
    ? active.isDefault
      ? `${active.stateDir}-profiles`
      : active.stateDir.replace(/[\\/][^\\/]+$/, "")
    : null;
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    void refreshProfiles().catch((cause) => setError(String(cause)));
  }, []);
  return (
    <div data-settings-search-target="profiles.manage" className="space-y-4 p-4">
      <h2 className="text-lg font-semibold">Profiles</h2>
      <p className="text-sm text-muted-foreground">
        Separate accounts, projects, chat history, and settings. Browser profiles each use their own
        port. Start another profile with its copied launch command.
      </p>
      {diagnostic && (
        <div role="alert" className="rounded border border-destructive p-3">
          {diagnostic.message}
          <p className="break-all">{diagnostic.path}</p>Registry changes are disabled until this is
          fixed.
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError("");
          void ensureNativeApi()
            .profiles!.create({ name })
            .then(async () => {
              setName("");
              await refreshProfiles();
            })
            .catch((cause) => setError(String(cause)))
            .finally(() => setPending(false));
        }}
      >
        <Input
          aria-label="New profile name"
          placeholder="Work or Personal"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={pending || !!diagnostic || !name.trim()}>
          Create profile
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      {metadataRoot && (
        <p className="break-all text-xs text-muted-foreground">
          Removed profiles are retained in {metadataRoot}/.trash
        </p>
      )}
      {profiles.map((profile) => (
        <ProfileRow key={profile.id} profile={profile} disabled={!!diagnostic} />
      ))}
    </div>
  );
}
