import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../nativeApi";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

export function StorageDiscoverySettings() {
  const settings = useSettings((s) => s.storageDiscovery);
  const client = useQueryClient();
  const [roots, setRoots] = useState(settings.repositoryRoots.join("\n"));
  const [enabled, setEnabled] = useState(settings.machineCleanupEnabled);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setRoots(settings.repositoryRoots.join("\n"));
    setEnabled(settings.machineCleanupEnabled);
  }, [settings]);
  const save = async () => {
    setPending(true);
    try {
      const repositoryRoots = [
        ...new Set(
          roots
            .split("\n")
            .map((root) => root.trim())
            .filter(Boolean),
        ),
      ];
      await ensureNativeApi().server.updateSettings({
        storageDiscovery: { machineCleanupEnabled: enabled, repositoryRoots },
      });
      await client.invalidateQueries({ queryKey: serverQueryKeys.config() });
      await ensureNativeApi().storage.getUsage({ force: true });
      await client.invalidateQueries({ queryKey: ["storage", "usage"] });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update storage discovery",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-medium">Storage discovery</h2>
      <p className="text-xs text-muted-foreground">
        These folders and caches belong to the F5 server machine. Machine cleanup always requires
        manual selection.
      </p>
      <label className="flex items-center justify-between gap-3 text-sm">
        Scan developer caches, Chrome caches, and BambuStudio logs
        <Switch
          aria-label="Scan machine cleanup candidates"
          checked={enabled}
          disabled={pending}
          onCheckedChange={setEnabled}
        />
      </label>
      <label className="block space-y-2 text-xs">
        <span>Repository search folders (one absolute path per line)</span>
        <textarea
          className="min-h-20 w-full rounded border border-border bg-background p-2 font-mono"
          aria-label="Repository search folders"
          value={roots}
          onChange={(event) => setRoots(event.target.value)}
          disabled={pending}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Repositories are discovered without adding projects. Scans skip dependencies, build output,
        symlinks, and other mounted volumes. Prefer specific source-code folders: selecting an
        entire home folder or filesystem root can include many unrelated repositories.
      </p>
      <Button size="sm" onClick={() => void save()} disabled={pending}>
        {pending ? "Saving…" : "Save and rescan"}
      </Button>
    </section>
  );
}
