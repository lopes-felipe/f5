import { useEffect, useState } from "react";
import type {
  DesktopBrowserProfile,
  DesktopBrowserImportSource,
  DesktopBrowserImportProgress,
} from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
export function BrowserSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const preview = window.desktopBridge?.preview,
    snapShot = window.desktopBridge?.snapShot;
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
    <section className="space-y-3 rounded border p-4">
      <h3>Browser and capture</h3>
      <label>
        Open links in{" "}
        <select
          value={settings.linkOpenTarget}
          onChange={(event) =>
            updateSettings({ linkOpenTarget: event.target.value as "system" | "preview" })
          }
        >
          <option value="system">System browser</option>
          <option value="preview" disabled={!preview}>
            F5 preview
          </option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={settings.enableAgentBrowserAccess}
          onChange={(event) => updateSettings({ enableAgentBrowserAccess: event.target.checked })}
        />
        Enable agent browser access
      </label>
      {preview?.profiles ? (
        <>
          <p>Choose a profile for new tabs. Existing tabs keep their profile.</p>
          {profiles.map((profile) => (
            <div key={profile.id}>
              {profile.name}
              {!profile.persistent ? " (incognito)" : ""}{" "}
              <button onClick={() => run(() => preview.profiles!.select(profile.id))}>
                Use for new tabs
              </button>
              {profile.id !== "default" ? (
                <button
                  onClick={() =>
                    run(async () => {
                      await preview.profiles!.delete(profile.id);
                      await refresh();
                    })
                  }
                >
                  Delete profile and storage
                </button>
              ) : null}
            </div>
          ))}
          <label>
            Profile name{" "}
            <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </label>
          <button
            onClick={() =>
              run(async () => {
                await preview.profiles!.create(name, true);
                await refresh();
              })
            }
          >
            Create profile
          </button>
          <button
            onClick={() =>
              run(async () => {
                await preview.profiles!.create(name, false);
                await refresh();
              })
            }
          >
            Create incognito profile
          </button>
          <label>
            Default zoom{" "}
            <input
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
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.previewDefaults.muted}
              onChange={(event) =>
                updateSettings({
                  previewDefaults: { ...settings.previewDefaults, muted: event.target.checked },
                })
              }
            />
            Mute new tabs
          </label>
          <label>
            Default color scheme{" "}
            <select
              value={settings.previewDefaults.colorScheme}
              onChange={(event) =>
                updateSettings({
                  previewDefaults: {
                    ...settings.previewDefaults,
                    colorScheme: event.target.value as "system" | "light" | "dark",
                  },
                })
              }
            >
              <option>system</option>
              <option>light</option>
              <option>dark</option>
            </select>
          </label>
        </>
      ) : null}
      {preview?.browserImport ? (
        <>
          <h4>Import browser cookies</h4>
          <p>
            Close the source browser. Import creates a new profile; existing profiles are untouched.
          </p>
          <select
            aria-label="Import source"
            value={source}
            disabled={Boolean(job)}
            onChange={(event) => {
              setSource(event.target.value);
              setSourceProfile("");
            }}
          >
            <option value="">Choose browser</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id} disabled={!source.available}>
                {source.name}
                {!source.available ? " (not installed)" : ""}
              </option>
            ))}
          </select>
          <select
            aria-label="Source profile"
            value={sourceProfile}
            disabled={Boolean(job)}
            onChange={(event) => setSourceProfile(event.target.value)}
          >
            <option value="">Choose source profile</option>
            {chosen?.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
          <p>{chosen?.remediation}</p>
          {chosen?.id === "safari" && preview.browserImport.openPermissions ? (
            <button onClick={() => run(() => preview.browserImport!.openPermissions!())}>
              Open Full Disk Access settings
            </button>
          ) : null}
          <button
            disabled={!source || !sourceProfile || Boolean(job)}
            onClick={() =>
              run(async () => {
                setProgress(undefined);
                setJob(await preview.browserImport!.start(source, sourceProfile, name));
              })
            }
          >
            Import into new profile
          </button>
          {job ? (
            <button onClick={() => run(() => preview.browserImport!.cancel(job))}>
              Cancel import
            </button>
          ) : null}
          {progress ? (
            <p role="status">
              {progress.status}: {progress.imported} imported, {progress.skipped} skipped,{" "}
              {progress.failed} failed. {progress.error}
            </p>
          ) : null}
          <button onClick={() => run(refresh)}>Recheck prerequisites / retry</button>
        </>
      ) : null}
      {snapShot && permissions?.supported ? (
        <>
          <h4>SnapShot</h4>
          <p>
            Capture the frontmost other window and its accessibility text into your current
            composer.
          </p>
          <p>
            Screen Recording: {permissions.screen ? "granted" : "required"}. Accessibility:{" "}
            {permissions.accessibility ? "granted" : "required"}.
          </p>
          <button onClick={() => run(() => snapShot.openPermissions())}>
            Open capture permissions
          </button>
          <label>
            Capture shortcut{" "}
            <input
              value={settings.snapShotShortcut}
              onChange={(event) => updateSettings({ snapShotShortcut: event.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.snapShotEnabled}
              onChange={(event) =>
                run(async () => {
                  await snapShot.configure(settings.snapShotShortcut, event.target.checked);
                  updateSettings({ snapShotEnabled: event.target.checked });
                })
              }
            />
            Enable global capture shortcut
          </label>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
