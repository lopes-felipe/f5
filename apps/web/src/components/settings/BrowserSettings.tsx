import { useEffect, useState } from "react";
import type {
  DesktopBrowserProfile,
  DesktopBrowserImportSource,
  DesktopBrowserImportProgress,
} from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { PreviewExternalHostsEditor } from "./PreviewExternalHostsEditor";
import { SettingsCard, SettingsRow } from "./SettingsCard";

const LINK_TARGET_LABELS = { system: "System browser", preview: "F5 preview" } as const;
const COLOR_SCHEME_LABELS = { system: "System", light: "Light", dark: "Dark" } as const;

export function BrowserSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const preview = window.desktopBridge?.preview,
    snapShot = window.desktopBridge?.snapShot;
  const [shortcut, setShortcut] = useState(settings.snapShotShortcut);
  useEffect(() => setShortcut(settings.snapShotShortcut), [settings.snapShotShortcut]);
  const [profiles, setProfiles] = useState<DesktopBrowserProfile[]>([]),
    [sources, setSources] = useState<DesktopBrowserImportSource[]>([]),
    [source, setSource] = useState(""),
    [sourceProfile, setSourceProfile] = useState(""),
    [name, setName] = useState("Imported browser"),
    [job, setJob] = useState<string>(),
    [progress, setProgress] = useState<DesktopBrowserImportProgress>(),
    [error, setError] = useState(""),
    [permissions, setPermissions] = useState<{
      supported: boolean;
      screen: boolean;
      accessibility: boolean;
    }>();
  const refresh = async () => {
    setProfiles((await preview?.profiles?.list()) ?? []);
    setSources((await preview?.browserImport?.sources()) ?? []);
    setPermissions(await snapShot?.permissions());
  };
  useEffect(() => {
    void refresh().catch(() => setError("Browser settings could not be read. Retry."));
  }, [preview, snapShot]);
  useEffect(() => {
    if (!job) return;
    let stopped = false;
    const tick = async () => {
      try {
        const result = await preview?.browserImport?.status(job);
        if (stopped) return;
        setProgress(result);
        if (result && ["completed", "failed", "canceled"].includes(result.status)) {
          setJob(undefined);
          void refresh();
        }
      } catch {
        if (!stopped) {
          setJob(undefined);
          setError("Import was interrupted. Retry into a new profile.");
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job, preview]);
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void Promise.resolve()
      .then(action)
      .catch((error) =>
        setError(error instanceof Error ? error.message : "The action failed. Retry."),
      );
  };
  const chosen = sources.find((s) => s.id === source);
  return (
    <>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      <SettingsCard
        title="Browser"
        searchTarget="integrations.browser"
        description="Where links open, and what agents may do in the F5 preview."
      >
        <SettingsRow
          title="Open links in"
          control={
            <Select
              value={settings.linkOpenTarget}
              onValueChange={(value) => {
                if (value === "system" || value === "preview")
                  updateSettings({ linkOpenTarget: value });
              }}
            >
              <SelectTrigger className="w-56" aria-label="Open links in">
                <SelectValue>{LINK_TARGET_LABELS[settings.linkOpenTarget]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value="system">{LINK_TARGET_LABELS.system}</SelectItem>
                <SelectItem value="preview" disabled={!preview}>
                  {LINK_TARGET_LABELS.preview}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Agent browser access"
          description="Let agents open, read, and drive pages in the F5 preview."
          control={
            <Switch
              aria-label="Enable agent browser access"
              checked={settings.enableAgentBrowserAccess}
              onCheckedChange={(checked) => updateSettings({ enableAgentBrowserAccess: checked })}
            />
          }
        />
        <div className="space-y-2 border-b border-border py-3 last:border-b-0">
          <div>
            <p className="text-sm font-medium text-foreground">Allowed external sites</p>
            <p className="text-ui text-muted-foreground">
              Sites besides local servers that the preview, and agents using it, may load.
            </p>
          </div>
          <PreviewExternalHostsEditor
            value={settings.previewExternalHosts ?? []}
            disabled={!settings.enableAgentBrowserAccess}
            onSave={(hosts) => updateSettings({ previewExternalHosts: hosts })}
          />
        </div>
        {/* Not certified yet (docs/agent-browser.md): they can only be switched off. */}
        <SettingsRow
          title="Claude in Chrome"
          description="Let Claude use Google Chrome through its extension. Not available in F5 yet."
          control={
            <Switch
              aria-label="Let Claude use Google Chrome"
              checked={settings.enableClaudeInChrome ?? false}
              disabled={!settings.enableClaudeInChrome}
              onCheckedChange={(checked) => updateSettings({ enableClaudeInChrome: checked })}
            />
          }
        />
        <SettingsRow
          title="Computer use"
          description="Let agents control this computer. Not available in F5 yet."
          control={
            <Switch
              aria-label="Let agents control this computer"
              checked={settings.enableAgentComputerUse ?? false}
              disabled={!settings.enableAgentComputerUse}
              onCheckedChange={(checked) => updateSettings({ enableAgentComputerUse: checked })}
            />
          }
        />
      </SettingsCard>

      {preview?.profiles ? (
        <SettingsCard
          title="Browser profiles"
          description="Choose a profile for new preview tabs. Existing tabs keep their profile."
        >
          {profiles.map((profile) => (
            <SettingsRow
              key={profile.id}
              title={
                <span className="flex items-center gap-2">
                  {profile.name}
                  {!profile.persistent ? <Badge variant="outline">Incognito</Badge> : null}
                  {profile.selected ? <Badge variant="secondary">Used for new tabs</Badge> : null}
                </span>
              }
              control={
                <div className="flex items-center gap-2">
                  {!profile.selected ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        run(async () => {
                          await preview.profiles!.select(profile.id);
                          await refresh();
                        })
                      }
                    >
                      Use for new tabs
                    </Button>
                  ) : null}
                  {profile.id !== "default" ? (
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      onClick={() =>
                        run(async () => {
                          await preview.profiles!.delete(profile.id);
                          await refresh();
                        })
                      }
                    >
                      Delete profile and storage
                    </Button>
                  ) : null}
                </div>
              }
            />
          ))}
          <SettingsRow
            title="New profile"
            description="Also names profiles created by a cookie import."
            control={
              <div className="flex items-center gap-2">
                <Input
                  size="sm"
                  className="w-40"
                  aria-label="Profile name"
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    run(async () => {
                      await preview.profiles!.create(name, true);
                      await refresh();
                    })
                  }
                >
                  Create profile
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    run(async () => {
                      await preview.profiles!.create(name, false);
                      await refresh();
                    })
                  }
                >
                  Create incognito profile
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Default zoom"
            description="Zoom for new tabs, from 0.25 to 3."
            control={
              <Input
                size="sm"
                className="w-24"
                aria-label="Default zoom"
                type="number"
                min={0.25}
                max={3}
                step={0.1}
                value={settings.previewDefaults.zoomFactor}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (value >= 0.25 && value <= 3)
                    updateSettings({
                      previewDefaults: { ...settings.previewDefaults, zoomFactor: value },
                    });
                }}
              />
            }
          />
          <SettingsRow
            title="Mute new tabs"
            control={
              <Switch
                aria-label="Mute new tabs"
                checked={settings.previewDefaults.muted}
                onCheckedChange={(checked) =>
                  updateSettings({
                    previewDefaults: { ...settings.previewDefaults, muted: checked },
                  })
                }
              />
            }
          />
          <SettingsRow
            title="Default color scheme"
            control={
              <Select
                value={settings.previewDefaults.colorScheme}
                onValueChange={(value) => {
                  if (value === "system" || value === "light" || value === "dark")
                    updateSettings({
                      previewDefaults: { ...settings.previewDefaults, colorScheme: value },
                    });
                }}
              >
                <SelectTrigger className="w-56" aria-label="Default color scheme">
                  <SelectValue>
                    {COLOR_SCHEME_LABELS[settings.previewDefaults.colorScheme]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {(["system", "light", "dark"] as const).map((scheme) => (
                    <SelectItem key={scheme} value={scheme}>
                      {COLOR_SCHEME_LABELS[scheme]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsCard>
      ) : null}

      {preview?.browserImport ? (
        <SettingsCard
          title="Import browser cookies"
          description="Close the source browser first. Import creates a new profile; existing profiles are untouched."
          actions={
            <Button size="xs" variant="ghost" onClick={() => run(refresh)}>
              Recheck prerequisites / retry
            </Button>
          }
        >
          <SettingsRow
            title="Source"
            description={chosen?.remediation}
            control={
              <div className="flex items-center gap-2">
                <Select
                  value={source}
                  disabled={Boolean(job)}
                  onValueChange={(value) => {
                    setSource(String(value ?? ""));
                    setSourceProfile("");
                  }}
                >
                  <SelectTrigger className="w-44" aria-label="Import source">
                    <SelectValue>{chosen?.name ?? "Choose browser"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {sources.map((candidate) => (
                      <SelectItem
                        key={candidate.id}
                        value={candidate.id}
                        disabled={!candidate.available}
                      >
                        {candidate.name}
                        {!candidate.available ? " (not installed)" : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Select
                  value={sourceProfile}
                  disabled={Boolean(job) || !chosen}
                  onValueChange={(value) => setSourceProfile(String(value ?? ""))}
                >
                  <SelectTrigger className="w-44" aria-label="Source profile">
                    <SelectValue>
                      {chosen?.profiles.find((profile) => profile.id === sourceProfile)?.name ??
                        "Choose profile"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    {chosen?.profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
          <div className="flex flex-wrap items-center gap-2 pt-3">
            {chosen?.id === "safari" && preview.browserImport.openPermissions ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => run(() => preview.browserImport!.openPermissions!())}
              >
                Open Full Disk Access settings
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={!source || !sourceProfile || Boolean(job)}
              onClick={() =>
                run(async () => {
                  setProgress(undefined);
                  setJob(await preview.browserImport!.start(source, sourceProfile, name));
                })
              }
            >
              Import into new profile
            </Button>
            {job ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => run(() => preview.browserImport!.cancel(job))}
              >
                Cancel import
              </Button>
            ) : null}
          </div>
          {progress ? (
            <p role="status" className="pt-2 text-xs text-muted-foreground">
              {progress.status}: {progress.imported} imported, {progress.skipped} skipped,{" "}
              {progress.failed} failed. {progress.error}
            </p>
          ) : null}
        </SettingsCard>
      ) : null}

      {snapShot && permissions?.supported ? (
        <SettingsCard
          title="SnapShot"
          description="Capture the frontmost other window and its accessibility text into your current composer."
        >
          <SettingsRow
            title="Capture permissions"
            description={`Screen Recording: ${permissions.screen ? "granted" : "required"}. Accessibility: ${permissions.accessibility ? "granted" : "optional for text"}.`}
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={() => run(() => snapShot.openPermissions())}
              >
                Open capture permissions
              </Button>
            }
          />
          <SettingsRow
            title="Capture shortcut"
            control={
              <Input
                size="sm"
                className="w-56 font-mono"
                aria-label="Capture shortcut"
                value={shortcut}
                onChange={(event) => setShortcut(event.target.value)}
                onBlur={() =>
                  run(async () => {
                    await snapShot.configure(shortcut, settings.snapShotEnabled);
                    updateSettings({ snapShotShortcut: shortcut });
                  })
                }
              />
            }
          />
          <SettingsRow
            title="Global capture shortcut"
            description="Capture from anywhere, even when F5 is not focused."
            control={
              <Switch
                aria-label="Enable global capture shortcut"
                checked={settings.snapShotEnabled}
                onCheckedChange={(checked) =>
                  run(async () => {
                    await snapShot.configure(settings.snapShotShortcut, checked);
                    updateSettings({ snapShotEnabled: checked });
                  })
                }
              />
            }
          />
        </SettingsCard>
      ) : null}
    </>
  );
}
